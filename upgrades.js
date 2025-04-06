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
]
