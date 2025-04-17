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
]
