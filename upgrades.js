import {
	CreateConvertToBooleanFeedbackUpgradeScript,
	FixupNumericOrVariablesValueToExpressions,
} from '@companion-module/base'

// Companion passes every saved action and feedback option to upgrade scripts as { value, isExpression }
const fixed = (value) => ({ value, isExpression: false })

function redundantCores(_context, props) {
	const result = {
		updatedActions: [],
		updatedConfig: null,
		updatedFeedbacks: [],
	}

	result.updatedConfig = {
		...props.config,
		redundant: props.config.redundant ?? false,
		hostSecondary: props.config.hostSecondary ?? '',
		portSecondary: props.config.portSecondary ?? `1710`,
		verbose: props.config.verbose ?? false,
	}

	return result
}

export function relativeControlSet(_context, props) {
	const result = {
		updatedActions: [],
		updatedConfig: null,
		updatedFeedbacks: [],
	}

	for (const action of props.actions) {
		switch (action.actionId) {
			case 'control_set':
				action.options.relative ??= fixed(false)
				action.options.min ??= fixed('')
				action.options.max ??= fixed('')
				action.options.type ??= fixed('string')
				action.options.ramp ??= fixed('')
				result.updatedActions.push(action)
				break
		}
	}

	return result
}

export function loopPlayerStartSeek(_context, props) {
	const result = {
		updatedActions: [],
		updatedConfig: null,
		updatedFeedbacks: [],
	}

	for (const action of props.actions) {
		switch (action.actionId) {
			case 'loopPlayer_start':
				action.options.seek ??= fixed(0)
				action.options.refID ??= fixed('')
				result.updatedActions.push(action)
				break
		}
	}

	return result
}

export function fixBooleanValues(_context, props) {
	const result = {
		updatedActions: [],
		updatedConfig: null,
		updatedFeedbacks: [],
	}

	for (const action of props.actions) {
		switch (action.actionId) {
			case 'mixer_setCrossPointMute':
			case 'mixer_setCrossPointSolo':
			case 'mixer_setInputMute':
			case 'mixer_setInputSolo':
			case 'mixer_setOutputMute':
			case 'mixer_setCueMute':
			case 'mixer_setInputCueEnable':
			case 'mixer_setInputCueAfl':
				action.options.value = fixed(action.options.value?.value === 'true')
				result.updatedActions.push(action)
				break
			case 'loopPlayer_start':
				action.options.loop = fixed(action.options.loop?.value === 'true')
				result.updatedActions.push(action)
		}
	}

	return result
}

/** Action options converted from a true/false dropdown to a checkbox, by action id */
export const checkboxActionOptions = {
	mixer_setCrossPointMute: ['value'],
	mixer_setCrossPointSolo: ['value'],
	mixer_setInputMute: ['value'],
	mixer_setInputSolo: ['value'],
	mixer_setOutputMute: ['value'],
	mixer_setCueMute: ['value'],
	mixer_setInputCueEnable: ['value'],
	mixer_setInputCueAfl: ['value'],
	loopPlayer_start: ['loop'],
}

/** Number options that defaulted to '', with the number that replaces it, by action or feedback id */
export const numberActionOptions = {
	page_submit_message: { priority: 1 },
}
export const numberFeedbackOptions = {
	'control-threshold': { threshold: 0 },
	'control-fade': { low_threshold: 0, high_threshold: 0 },
}

function toNumber(value, fallback) {
	const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
	return typeof number === 'number' && Number.isFinite(number) ? number : fallback
}

function convertNumberOptions(options, defaults = {}) {
	let changed = false
	for (const [key, fallback] of Object.entries(defaults)) {
		const option = options[key]
		if (option?.isExpression || typeof option?.value === 'number') continue
		options[key] = fixed(toNumber(option?.value, fallback))
		changed = true
	}
	return changed
}

export function fixOptionTypes(_context, props) {
	const result = {
		updatedActions: [],
		updatedConfig: null,
		updatedFeedbacks: [],
	}

	for (const action of props.actions) {
		let changed = false
		for (const key of checkboxActionOptions[action.actionId] ?? []) {
			// fixBooleanValues converted saved values in v3.0.0, but the dropdown default stayed the string 'true'
			const option = action.options[key]
			if (option?.isExpression || typeof option?.value !== 'string') continue
			action.options[key] = fixed(option.value === 'true')
			changed = true
		}
		if (convertNumberOptions(action.options, numberActionOptions[action.actionId])) changed = true
		if (changed) result.updatedActions.push(action)
	}

	for (const feedback of props.feedbacks) {
		if (convertNumberOptions(feedback.options, numberFeedbackOptions[feedback.feedbackId])) {
			result.updatedFeedbacks.push(feedback)
		}
	}

	return result
}

/** Action options converted from a text input to a number field, with the number a blank value becomes, by action id */
export const textToNumberActionOptions = {
	control_set: { ramp: 0, min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER },
	component_set: { ramp: 0 },
	loopPlayer_start: { output: 1 },
}

export function textToNumberOptions(_context, props) {
	const result = {
		updatedActions: [],
		updatedConfig: null,
		updatedFeedbacks: [],
	}

	for (const action of props.actions) {
		let changed = false
		for (const [key, fallback] of Object.entries(textToNumberActionOptions[action.actionId] ?? {})) {
			const option = action.options[key]
			// A blank value had no effect, so it becomes the field's default rather than an expression of nothing
			const blank = option === undefined || (!option.isExpression && String(option.value ?? '').trim() === '')
			const converted = blank ? fixed(fallback) : FixupNumericOrVariablesValueToExpressions(option)
			// The helper always returns a new object, so compare what it holds
			if (converted.isExpression === option?.isExpression && converted.value === option?.value) continue
			action.options[key] = converted
			changed = true
		}
		if (changed) result.updatedActions.push(action)
	}

	return result
}

function makePasswordSecret(_context, props) {
	const result = {
		updatedActions: [],
		updatedConfig: null,
		updatedSecrets: null,
		updatedFeedbacks: [],
	}

	if (props.config?.pass && !props.secrets?.pass) {
		result.updatedSecrets = {
			pass: props.config.pass,
		}
		const config = props.config
		delete config.pass
		result.updatedConfig = config
	} else if (props.config?.pass && props.secrets?.pass) {
		// Shouldn't happen, but just in case
		// just remove from config, trust secrets
		const config = props.config
		delete config.pass
		result.updatedConfig = config
	} else if (props.secrets?.pass == undefined) {
		result.updatedSecrets = {
			pass: '',
		}
	}

	return result
}

export default [
	CreateConvertToBooleanFeedbackUpgradeScript({
		'control-boolean': {
			bg: 'bgcolor',
			fg: 'color',
		},
		'control-threshold': {
			bg: 'bgcolor',
			fg: 'color',
		},
	}),
	redundantCores,
	relativeControlSet,
	loopPlayerStartSeek,
	fixBooleanValues,
	makePasswordSecret,
	fixOptionTypes,
	textToNumberOptions,
]
