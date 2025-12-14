import { CreateConvertToBooleanFeedbackUpgradeScript } from '@companion-module/base'

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

function relativeControlSet(_context, props) {
	const result = {
		updatedActions: [],
		updatedConfig: null,
		updatedFeedbacks: [],
	}

	for (const action of props.actions) {
		switch (action.actionId) {
			case 'control_set':
				action.options.relative ??= false
				action.options.min ??= ''
				action.options.max ??= ''
				action.options.type ??= 'string'
				action.options.ramp ??= ''
				result.updatedActions.push(action)
				break
		}
	}

	return result
}

function loopPlayerStartSeek(_context, props) {
	const result = {
		updatedActions: [],
		updatedConfig: null,
		updatedFeedbacks: [],
	}

	for (const action of props.actions) {
		switch (action.actionId) {
			case 'loopPlayer_start':
				action.options.seek ??= 0
				action.options.refID ??= ''
				result.updatedActions.push(action)
				break
		}
	}

	return result
}

function fixBooleanValues(_context, props) {
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
				action.options.value = action.options.value === 'true'
				result.updatedActions.push(action)
				break
			case 'loopPlayer_start':
				action.options.loop = action.options.loop === 'true'
				result.updatedActions.push(action)
		}
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

	if (props.config.pass) {
		result.updatedSecrets = {
			pass: props.config.pass,
		}
		const config = props.config
		delete config.pass
		result.updatedConfig = config
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
]
