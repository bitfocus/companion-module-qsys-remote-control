import { Regex } from '@companion-module/base'

export const configFields = [
	{
		type: 'checkbox',
		id: 'redundant',
		label: 'Redundant Cores?',
		width: 6,
		default: false,
	},
	{
		type: 'static-text',
		id: 'filler1',
		label: '',
		width: 6,
		value: '',
	},
	{
		type: 'textinput',
		id: 'host',
		label: 'Primary Target IP',
		width: 6,
		regex: Regex.IP | Regex.HOSTNAME,
	},
	{
		type: 'textinput',
		id: 'port',
		label: 'Primary Target Port',
		width: 6,
		default: `1710`,
		regex: Regex.PORT,
		tooltip: 'Default: 1710',
	},
	{
		type: 'textinput',
		id: 'hostSecondary',
		label: 'Secondary Target IP',
		width: 6,
		regex: Regex.IP | Regex.HOSTNAME,
		isVisible: (options) => {
			return !!options.redundant
		},
	},
	{
		type: 'textinput',
		id: 'portSecondary',
		label: 'Secondary Target Port',
		width: 6,
		default: `1710`,
		regex: Regex.PORT,
		tooltip: 'Default: 1710',
		isVisible: (options) => {
			return !!options.redundant
		},
	},
	{
		type: 'static-text',
		id: 'filler2',
		label: '',
		width: 6,
		value: '',
		isVisible: (options) => {
			return !options.redundant
		},
	},
	{
		type: 'static-text',
		id: 'filler3',
		label: '',
		width: 6,
		value: '',
		isVisible: (options) => {
			return !options.redundant
		},
	},
	{
		type: 'static-text',
		id: 'info1',
		label: 'Login Information',
		width: 12,
		value: 'If you have login enabled, specify the creditials below.',
	},
	{
		type: 'textinput',
		id: 'user',
		label: 'Username',
		width: 6,
		default: '',
	},
	{
		type: 'textinput',
		id: 'pass',
		label: 'Password',
		width: 6,
		default: '',
	},
	{
		type: 'static-text',
		id: 'info2',
		label: 'Feedback and Variables',
		width: 12,
		value:
			'Feedback must be enabled to watch for variables and feedbacks. Bundling feedbacks will send every variable/feedback control in one request vs multiple. ' +
			'Depending on the amount of watched controls, this can add a lot of additional, unneccesary traffic to the device (polling interval &times; the number of named controls). ' +
			'However, if one control name is incorrect, all of the feedbacks and variables will fail to load. Therefore, it may be useful to keep this disabled while testing, ' +
			'and then enable it in a production environment.',
	},
	{
		type: 'checkbox',
		id: 'feedback_enabled',
		label: 'Feedback Enabled',
		width: 6,
		default: false,
	},
	{
		type: 'checkbox',
		id: 'bundle_feedbacks',
		label: 'Bundle Feedbacks?',
		width: 6,
		default: false,
		isVisible: (options) => {
			return options.feedback_enabled
		},
	},
	{
		type: 'number',
		id: 'poll_interval',
		label: 'Polling Interval (ms)',
		min: 30,
		max: 60000,
		width: 6,
		default: 100,
		isVisible: (options) => {
			return options.feedback_enabled
		},
	},
	{
		type: 'static-text',
		id: 'info3',
		label: 'Control Variables',
		width: 12,
		value:
			'Specify a list of named controls to add as Companion variables. Separated by commas. Any feedbacks used are automatically added to the variable list.',
		isVisible: (options) => {
			return options.feedback_enabled
		},
	},
	{
		type: 'textinput',
		id: 'variables',
		label: 'Variables',
		width: 12,
		default: '',
		isVisible: (options) => {
			return options.feedback_enabled
		},
	},
	{
		type: 'checkbox',
		id: 'verbose',
		label: 'Verbose Logs',
		width: 6,
		default: false,
	},
]
