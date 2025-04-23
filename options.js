import { Regex } from '@companion-module/base'

const name = {
	type: 'textinput',
	id: 'name',
	label: 'Name:',
	default: '',
	useVariables: { local: true },
	regex: Regex.SOMETHING,
}

const valueString = {
	type: 'textinput',
	id: 'value',
	label: 'Value:',
	default: '',
	useVariables: { local: true },
}

const mixerInputs = {
	type: 'textinput',
	id: 'inputs',
	label: 'Inputs',
	default: '1',
	useVariables: { local: true },
	tooltip: `User Mixer IO String Syntax`,
}
const mixerOutputs = {
	type: 'textinput',
	id: 'outputs',
	label: 'Outputs',
	default: '1',
	useVariables: { local: true },
	tooltip: `User Mixer IO String Syntax`,
}

const mixerCues = {
	type: 'textinput',
	id: 'cues',
	label: 'Cues',
	default: '1',
	useVariables: { local: true },
	tooltip: `User Mixer IO String Syntax`,
}

export const options = {
	actions: {
		controlSet: () => {
			return [
				name,
				valueString,
				{
					type: 'dropdown',
					id: 'type',
					label: 'Type',
					choices: [
						{ id: 'boolean', label: 'Boolean' },
						{ id: 'number', label: 'Number' },
						{ id: 'string', label: 'String' },
					],
					default: 'string',
					tooltip: `Data type to be sent`,
				},
				{
					type: 'textinput',
					id: 'ramp',
					label: 'Ramp:',
					default: '',
					useVariables: { local: true },
					isVisible: (options) => {
						return options.type == 'number'
					},
				},
				{
					type: 'checkbox',
					id: 'relative',
					label: 'Relative',
					default: false,
					tooltip: `Relative actions only work with numerical values. Resultant value = current value + new value`,
					isVisible: (options) => {
						return options.type == 'number'
					},
				},
				{
					type: 'textinput',
					id: 'min',
					label: 'Minimum:',
					default: '',
					useVariables: { local: true },
					tooltip: 'Relative action will be constrained to this lower limit',
					isVisible: (options) => {
						return options.relative && options.type == 'number'
					},
				},
				{
					type: 'textinput',
					id: 'max',
					label: 'Maximum:',
					default: '',
					useVariables: { local: true },
					tooltip: 'Relative action will be constrained to this upper limit',
					isVisible: (options) => {
						return options.relative && options.type == 'number'
					},
				},
				{
					type: 'static-text',
					id: 'filler2',
					label: 'Warning',
					width: 6,
					value: 'Relative actions require Number Type',
					isVisible: (options) => {
						return options.relative && options.type !== 'number'
					},
				},
			]
		},
		controlToggle: () => {
			return [
				{
					...name,
					tooltip: 'Only applies to controls with an on/off state.',
				},
			]
		},
		controlGet: () => {
			return [{ ...name, tooltip: `Comma seperated list of control names` }]
		},
		componentSet: () => {
			return [
				name,
				{
					type: 'textinput',
					id: 'control_name',
					label: 'Control Name:',
					default: '',
					useVariables: { local: true },
				},
				valueString,
				{
					type: 'textinput',
					id: 'ramp',
					label: 'Ramp:',
					default: '',
					useVariables: { local: true },
				},
			]
		},
		changeGroup_invalidate: (id) => {
			return [
				{
					type: 'static-text',
					id: 'info',
					label: '',
					width: 6,
					value: `This will invalidate change group ${id}, causing Qsys to send all values in the group`,
				},
			]
		},
		mixer_setCrossPointGain: () => {
			return [
				name,
				mixerInputs,
				mixerOutputs,
				{
					type: 'number',
					id: 'value',
					label: 'Value',
					default: 0,
					min: -100,
					max: 20,
					regex: Regex.NUMBER,
				},
				{
					type: 'number',
					id: 'ramp',
					label: 'Ramp',
					default: 0,
					min: 0,
					max: 100,
					regex: Regex.NUMBER,
				},
			]
		},
		mixer_setCrossPointDelay: () => {
			return [
				name,
				mixerInputs,
				mixerOutputs,
				{
					type: 'number',
					id: 'value',
					label: 'Value',
					default: 0,
					min: 0,
					max: 60,
					regex: Regex.NUMBER,
				},
				{
					type: 'number',
					id: 'ramp',
					label: 'Ramp',
					default: 0,
					min: 0,
					max: 100,
					regex: Regex.NUMBER,
				},
			]
		},
		mixer_setCrossPointMute: () => {
			return [
				name,
				mixerInputs,
				mixerOutputs,
				{
					type: 'dropdown',
					id: 'value',
					label: 'Value',
					default: 'true',
					choices: [
						{ id: true, label: 'True' },
						{ id: false, label: 'False' },
					],
				},
			]
		},
		mixer_setCrossPointSolo: () => {
			return [
				name,
				mixerInputs,
				mixerOutputs,
				{
					type: 'dropdown',
					id: 'value',
					label: 'Value',
					default: 'true',
					choices: [
						{ id: true, label: 'True' },
						{ id: false, label: 'False' },
					],
				},
			]
		},
		mixer_setInputGain: () => {
			return [
				name,
				mixerInputs,
				{
					type: 'number',
					id: 'value',
					label: 'Value',
					default: 0,
					min: -100,
					max: 20,
					regex: Regex.NUMBER,
				},
				{
					type: 'number',
					id: 'ramp',
					label: 'Ramp',
					default: 0,
					min: 0,
					max: 100,
					regex: Regex.NUMBER,
				},
			]
		},
		mixer_setInputMute: () => {
			return [
				name,
				mixerInputs,
				{
					type: 'dropdown',
					id: 'value',
					label: 'Value',
					default: 'true',
					choices: [
						{ id: true, label: 'True' },
						{ id: false, label: 'False' },
					],
				},
			]
		},
		mixer_setInputSolo: () => {
			return [
				name,
				mixerInputs,
				{
					type: 'dropdown',
					id: 'value',
					label: 'Value',
					default: 'true',
					choices: [
						{ id: true, label: 'True' },
						{ id: false, label: 'False' },
					],
				},
			]
		},
		mixer_setOutputGain: () => {
			return [
				name,
				mixerOutputs,
				{
					type: 'number',
					id: 'value',
					label: 'Value',
					default: 0,
					min: -100,
					max: 20,
					regex: Regex.NUMBER,
				},
				{
					type: 'number',
					id: 'ramp',
					label: 'Ramp',
					default: 0,
					min: 0,
					max: 100,
					regex: Regex.NUMBER,
				},
			]
		},
		mixer_setOutputMute: () => {
			return [
				name,
				mixerOutputs,
				{
					type: 'dropdown',
					id: 'value',
					label: 'Value',
					default: 'true',
					choices: [
						{ id: true, label: 'True' },
						{ id: false, label: 'False' },
					],
				},
			]
		},
		mixer_setCueMute: () => {
			return [
				name,
				mixerCues,
				{
					type: 'dropdown',
					id: 'value',
					label: 'Value',
					default: 'true',
					choices: [
						{ id: true, label: 'True' },
						{ id: false, label: 'False' },
					],
				},
			]
		},
		mixer_setCueGain: () => {
			return [
				name,
				mixerCues,
				{
					type: 'number',
					id: 'value',
					label: 'Value',
					default: 0,
					min: -100,
					max: 20,
					regex: Regex.NUMBER,
				},
				{
					type: 'number',
					id: 'ramp',
					label: 'Ramp',
					default: 0,
					min: 0,
					max: 100,
					regex: Regex.NUMBER,
				},
			]
		},
		mixer_setInputCueEnable: () => {
			return [
				name,
				mixerCues,
				mixerInputs,
				{
					type: 'dropdown',
					id: 'value',
					label: 'Value',
					default: 'true',
					choices: [
						{ id: true, label: 'True' },
						{ id: false, label: 'False' },
					],
				},
			]
		},
		mixer_setInputCueAfl: () => {
			return [
				name,
				mixerCues,
				mixerInputs,
				{
					type: 'dropdown',
					id: 'value',
					label: 'Value',
					default: 'true',
					choices: [
						{ id: true, label: 'True' },
						{ id: false, label: 'False' },
					],
				},
			]
		},
		loopPlayer_start: () => {
			return [
				{
					type: 'textinput',
					id: 'file_name',
					label: 'File Name:',
					default: '',
					useVariables: { local: true },
				},
				{
					type: 'dropdown',
					id: 'channel',
					label: 'Channel',
					default: 'stereo',
					choices: [
						{ id: 'mono', label: 'Mono' },
						{ id: 'stereo', label: 'Stereo' },
					],
				},
				{
					type: 'textinput',
					id: 'output',
					label: 'Output',
					default: '1',
					useVariables: { local: true },
					tooltip: ` The Loop Player output number for playback`,
				},
				name,
				{
					type: 'number',
					id: 'startTime',
					label: 'Start Time',
					default: 0,
					regex: Regex.NUMBER,
					tooltip: `The time of day, in seconds, to start the job`,
					min: 0,
				},
				{
					type: 'number',
					id: 'seek',
					label: 'Seek Time',
					default: 0,
					regex: Regex.NUMBER,
					tooltip: `The time, in seconds, to seek into each file before playback.`,
					min: 0,
				},
				{
					type: 'dropdown',
					id: 'loop',
					label: 'Loop',
					default: 'true',
					choices: [
						{ id: true, label: 'True' },
						{ id: false, label: 'False' },
					],
				},
				{
					type: 'textinput',
					id: 'refID',
					label: 'Reference ID',
					default: '',
					useVariables: { local: true },
					tooltip: `Reference ID returned in error messages. Auto-populated if left blank`,
				},
			]
		},
		loopPlayer_stop: () => {
			return [
				name,
				{
					type: 'textinput',
					id: 'output',
					label: 'Output',
					default: '1',
					useVariables: { local: true },
					tooltip: `Comma seperated list of outputs to cancel. Ie. 1, 2, 3, 4`,
				},
			]
		},
		loopPlayer_cancel: () => {
			return [
				name,
				{
					type: 'textinput',
					id: 'output',
					label: 'Output',
					default: '1',
					useVariables: { local: true },
					tooltip: `Comma seperated list of outputs to cancel. Ie. 1, 2, 3, 4`,
				},
			]
		},
		snapshot_load: () => {
			return [
				name,
				{
					type: 'number',
					id: 'bank',
					label: 'Bank:',
					default: 1,
					tooltip: 'Specific bank number to recall from the snapshot',
					min: 1,
				},
				{
					type: 'number',
					id: 'ramp',
					label: 'Ramp',
					tooltip: 'Time in seconds to ramp to banked snapshot',
					min: 0,
					default: 0,
				},
			]
		},
		snapshot_save: () => {
			return [
				name,
				{
					type: 'number',
					id: 'bank',
					label: 'Bank:',
					default: 1,
					tooltip: 'Specific bank number to save to within the snapshot',
					min: 1,
				},
			]
		},
		page_submit_message: () => {
			return [
				{
					type: 'textinput',
					id: 'zones',
					label: 'Zone Number(s):',
					tooltip: 'Comma-seperated for multiple zones',
					regex: Regex.SOMETHING,
					required: true,
					default: '',
					useVariables: { local: true },
				},
				{
					type: 'number',
					id: 'priority',
					label: 'Priority:',
					tooltip: '1 is highest',
					min: 1,
					required: true,
					default: '',
				},
				{
					type: 'textinput',
					id: 'preamble',
					label: 'Preamble:',
					tooltip: 'File name of the preamble',
					default: '',
					useVariables: { local: true },
				},
				{
					type: 'textinput',
					id: 'message',
					label: 'Message:',
					tooltip: 'File name of the message',
					default: '',
					useVariables: { local: true },
				},
			]
		},
		statusGet: () => {
			return [
				{
					type: 'static-text',
					id: 'info',
					label: '',
					width: 6,
					value: 'Manually update Engine variables. Full response written to logs',
				},
			]
		},
	},
	feedbacks: {
		coreState: (redundant) => {
			return [
				{
					type: 'dropdown',
					id: 'core',
					label: 'Core',
					choices: [
						{ id: 'pri', label: 'Primary' },
						{ id: 'sec', label: 'Secondary' },
					],
					default: 'pri',
					isVisible: (_options, isVisibleData) => {
						return isVisibleData.redundant
					},
					isVisibleData: { redundant: redundant },
				},
				{
					type: 'dropdown',
					id: 'state',
					label: 'State',
					choices: [
						{ id: 'Active', label: 'Active' },
						{ id: 'Standby', label: 'Standby' },
						{ id: 'Idle', label: 'Idle' },
					],
					default: 'Active',
				},
			]
		},
		controlString: () => {
			return [
				{
					type: 'static-text',
					id: 'filler1',
					label: 'Warning',
					width: 6,
					value: 'Feedback depreciated, use variables instead.',
				},
			]
		},
		controlBoolean: () => {
			return [
				name,
				{
					type: 'dropdown',
					id: 'value',
					label: 'Control value',
					choices: [
						{ id: 'true', label: 'True' },
						{ id: 'false', label: 'False' },
					],
					default: 'true',
				},
			]
		},
		controlThreshold: () => {
			return [
				name,
				{
					type: 'number',
					id: 'threshold',
					label: 'Threshold value',
					default: '',
					min: -10000,
					max: 10000,
					range: false,
				},
			]
		},
		controlFade: (colours) => {
			return [
				name,
				{
					type: 'number',
					id: 'low_threshold',
					label: 'Low threshold value',
					default: '',
					min: -10000,
					max: 10000,
					range: false,
				},
				{
					type: 'number',
					id: 'high_threshold',
					label: 'High threshold value',
					default: '',
					min: -10000,
					max: 10000,
					range: false,
				},
				{
					type: 'colorpicker',
					label: 'Low threshold color',
					id: 'low_bg',
					default: colours.black,
				},
				{
					type: 'colorpicker',
					label: 'High threshold color',
					id: 'high_bg',
					default: colours.red,
				},
			]
		},
	},
}
