import { CreateConvertToBooleanFeedbackUpgradeScript } from '@companion-module/base'

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
]
