import UpgradeScripts from './upgrades.js'

import { InstanceBase, Regex, combineRgb, runEntrypoint, TCPHelper } from '@companion-module/base'

class QsysRemoteControl extends InstanceBase {
	async init(config) {
		this.console_debug = false

		this.pollQRCTimer = undefined

		this.QRC_GET = 1
		this.QRC_SET = 2

		this.actions()
		await this.configUpdated(config)
	}

	async configUpdated(config) {
		if (this.socket !== undefined) {
			this.socket.destroy()
			delete this.socket
		}

		if (this.pollQRCTimer !== undefined) {
			clearInterval(this.pollQRCTimer)
			delete this.pollQRCTimer
		}

		this.config = config
		this.init_tcp()

		this.initFeedbacks()
		this.subscribeFeedbacks()  // ensures control hashmap is updated with all feedbacks when config is changed
		this.initPolling()
	}

	initVariables() {
		this.variables.push({
			name: 'State',
			variableId: 'state'
		}, {
			name: 'Design Name',
			variableId: 'design_name'
		}, {
			name: 'redundant',
			variableId: 'redundant'
		}, {
			name: 'emulator',
			variableId: 'emulator'
		})

		if (!('variables' in this.config) || this.config.variables === '') {
			this.setVariableDefinitions(this.variables) // This gets called in addControls if there are vars
			return
		}

		this.config.variables.split(',').forEach(v => {
			this.addControl({
				options: {
					name: v.trim()
				},
				id: 'var'
			})
		})
	}

	init_tcp() {
		if (this.socket !== undefined) {
			this.socket.destroy()
			delete this.socket
		}

		if (this.config.host) {
			this.controls = new Map()

			this.socket = new TCPHelper(this.config.host, this.config.port)

			this.socket.on('error', err => {
				this.updateStatus('connection_failure')
				this.log('error', `Network error: ${err.message}`)
			})

			this.socket.on('connect', socket => {
				this.response_buffer = ''

				const login = {
					jsonrpc: 2.0,
					method: 'Logon',
					params: {}
				}

				if ('user' in this.config && 'pass' in this.config) {
					login.params = {
						User: this.config.user,
						Password: this.config.pass
					}
				}

				if (this.console_debug) {
					console.log('Q-SYS Connected')
					console.log('Q-SYS Send: ' + login)
				}

				this.socket.send(JSON.stringify(login) + '\x00')

				this.updateStatus('ok')

				this.initVariables()
			})

			this.socket.on('data', d => {
				const response = d.toString()

				if (this.console_debug) {
					console.log(response)
				}

				if (this.config.feedback_enabled) {
					this.processResponse(response)
				}
			})

		}
	}

	processResponse(response) {
		const list = (this.response_buffer + response).split('\x00')
		this.response_buffer = list.pop()
		let refresh = false

		list.forEach(jsonstr => {
			const obj = JSON.parse(jsonstr)

			if ((obj.id !== undefined) && (obj.id == this.QRC_GET)) {
				if (Array.isArray(obj?.result)) {
					obj.result.forEach(r => this.updateControl(r))
					refresh = true
				} else if (obj.error !== undefined) {
					this.log('error', obj?.error)
				}
			} else if (obj.method === 'EngineStatus') {
				this.setVariableValues({
					state: obj.params.State,
					design_name: obj.params.DesignName,
					redundant: obj.params.IsRedundant,
					emulator: obj.params.IsEmulator
				})
			}
		})

		if (refresh) this.checkFeedbacks()
	}

	// Return config fields for web config
	getConfigFields() {
		return [
			{
				type: 'textinput',
				id: 'host',
				label: 'Target IP',
				width: 6,
				regex: Regex.IP
			},
			{
				type: 'textinput',
				id: 'port',
				label: 'Target Port (Default: 1710)',
				width: 6,
				default: 1710,
				regex: Regex.PORT
			},
			{
				type: 'static-text',
				id: 'info',
				label: 'Login Information',
				width: 12,
				value: 'If you have login enabled, specify the creditials below.'
			},
			{
				type: 'textinput',
				id: 'user',
				label: 'Username',
				width: 6,
				default: ''
			},
			{
				type: 'textinput',
				id: 'pass',
				label: 'Password',
				width: 6,
				default: ''
			},
			{
				type: 'static-text',
				id: 'info',
				label: 'Feedback and Variables',
				width: 12,
				value: 'Feedback must be enabled to watch for variables and feedbacks. Bundling feedbacks will send every variable/feedback control in one request vs multiple. ' +
					'Depending on the amount of watched controls, this can add a lot of additional, unneccesary traffic to the device (polling interval &times; the number of named controls). ' +
					'However, if one control name is incorrect, all of the feedbacks and variables will fail to load. Therefore, it may be useful to keep this disabled while testing, ' +
					'and then enable it in a production environment.'
			},
			{
				type: 'checkbox',
				id: 'feedback_enabled',
				label: 'Feedback Enabled',
				width: 6,
				default: false
			},
			{
				type: 'checkbox',
				id: 'bundle_feedbacks',
				label: 'Bundle Feedbacks?',
				width: 6,
				default: false
			},
			{
				type: 'number',
				id: 'poll_interval',
				label: 'Polling Interval (ms)',
				min: 30,
				max: 60000,
				width: 6,
				default: 100
			},
			{
				type: 'static-text',
				id: 'info',
				label: 'Control Variables',
				width: 12,
				value: 'Specify a list of named controls to add as Companion variables. Separated by commas. Any feedbacks used are automatically added to the variable list.'
			},
			{
				type: 'textinput',
				id: 'variables',
				label: 'Variables',
				width: 12,
				default: ''
			},
		]
	}

	// When module gets deleted
	destroy() {
		if (this.socket !== undefined) {
			this.socket.destroy()
		}

		if (this.pollQRCTimer !== undefined) {
			clearInterval(this.pollQRCTimer)
			delete this.pollQRCTimer
		}

		if (this.controls !== undefined) {
			this.controls = undefined
		}
	}

	sendCommand(command, params) {
		this.callCommandObj({
			method: command,
			params: params
		})
	}

	actions() {
		this.setActionDefinitions({
			control_set: {
				name: 'Control.set',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name:',
						default: '',
					},
					{
						type: 'textinput',
						id: 'value',
						label: 'Value:',
						default: '',
						useVariables: true,
					}
				],
				callback: async (evt) => {
					const value = await this.parseVariablesInString(evt.options.value);

					this.sendCommand('Control.Set', {
						Name: evt.options.name,
						Value: value
					})
				}
			},
			control_toggle: {
				name: 'Control.toggle',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name:',
						default: '',
						tooltip: 'Only applies to controls with an on/off state.'
					}
				],
				callback: evt => {
					let control = this.controls.get(evt.options.name)
					// set our internal state in anticipation of success, allowing two presses
					// of the button faster than the polling interval to correctly toggle the state
					this.sendCommand('Control.Set', {
						Name: evt.options.name,
						Value: !control.value
					})
				}
			},
			'component_set': {
				name: 'Component.Set',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name:',
						default: '',
					},
					{
						type: 'textinput',
						id: 'control_name',
						label: 'Control Name:',
						default: '',
					},
					{
						type: 'textinput',
						id: 'value',
						label: 'Value:',
						default: '',
					},
					{
						type: 'textinput',
						id: 'ramp',
						label: 'Ramp:',
						default: '',
					}
				],
				callback: evt => this.sendCommand('Component.Set', {
					Name: evt.options.name,
					Controls: [{
						Name: evt.options.control_name,
						Value: evt.options.value,
						Ramp: evt.options.ramp
					}]
				})
			},
			changeGroup_addControl: {
				name: 'ChangeGroup.AddControl',
				options: [
					{
						type: 'textinput',
						id: 'id',
						label: 'Group Id:',
						default: '',
					},
					{
						type: 'textinput',
						id: 'controls',
						label: 'Controls:',
						default: '',
					}
				],
				callback: evt => this.changeGroup('AddControl', evt.options.id, evt.options.controls)
			},
			changeGroup_addComponentControl: {
				name: 'ChangeGroup.AddComponentControl',
				options: [
					{
						type: 'textinput',
						id: 'id',
						label: 'Group Id:',
						default: '',
					},
					{
						type: 'textinput',
						id: 'controls',
						label: 'Controls:',
						default: '',
					}
				],
				callback: evt => this.changeGroup('AddComponentControl', evt.options.id, evt.options.controls)
			},
			changeGroup_remove: {
				name: 'ChangeGroup.Remove',
				options: [
					{
						type: 'textinput',
						id: 'id',
						label: 'Group Id:',
						default: '',
					},
					{
						type: 'textinput',
						id: 'controls',
						label: 'Controls:',
						default: '',
					}
				],
				callback: evt => this.changeGroup('Remove', evt.options.id, evt.options.controls)
			},
			changeGroup_destroy: {
				name: 'ChangeGroup.Destroy',
				options: [
					{
						type: 'textinput',
						id: 'id',
						label: 'Group Id:',
						default: '',
					}
				],
				callback: evt => this.changeGroup('Destroy', evt.options.id)
			},
			changeGroup_invalidate: {
				name: 'ChangeGroup.Invalidate',
				options: [
					{
						type: 'textinput',
						id: 'id',
						label: 'Group Id:',
						default: '',
					}
				],
				callback: evt => this.changeGroup('Invalidate', evt.options.id)
			},
			changeGroup_clear: {
				name: 'ChangeGroup.Clear',
				options: [
					{
						type: 'textinput',
						id: 'id',
						label: 'Group Id:',
						default: '',
					}
				],
				callback: evt => this.changeGroup('Clear', evt.options.id)
			},
			mixer_setCrossPointGain: {
				name: 'Mixer.SetCrossPointGain',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name',
						default: '',
					},
					{
						type: 'textinput',
						id: 'inputs',
						label: 'Inputs',
						default: '1',
					},
					{
						type: 'textinput',
						id: 'outputs',
						label: 'Outputs',
						default: '1',
					},
					{
						type: 'number',
						id: 'value',
						label: 'Value',
						default: 0,
						min: -100,
						max: 20,
						regex: Regex.NUMBER
					},
					{
						type: 'number',
						id: 'ramp',
						label: 'Ramp',
						default: 0,
						min: 0,
						max: 100,
						regex: Regex.NUMBER
					},
				],
				callback: evt => this.sendCommand('Mixer.SetCrossPointGain', {
					Name: evt.options.name,
					Inputs: evt.options.inputs,
					Outputs: evt.options.outputs,
					Value: evt.options.value,
					Ramp: evt.options.ramp
				})
			},
			mixer_setCrossPointDelay: {
				name: 'Mixer.SetCrossPointDelay',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name',
						default: '',
					},
					{
						type: 'textinput',
						id: 'inputs',
						label: 'Inputs',
						default: '1',
					},
					{
						type: 'textinput',
						id: 'outputs',
						label: 'Outputs',
						default: '1',
					},
					{
						type: 'number',
						id: 'value',
						label: 'Value',
						default: 0,
						min: 0,
						max: 60,
						regex: Regex.NUMBER
					},
					{
						type: 'number',
						id: 'ramp',
						label: 'Ramp',
						default: 0,
						min: 0,
						max: 100,
						regex: Regex.NUMBER
					},
				],
				callback: evt => this.sendCommand('Mixer.SetCrossPointDelay', {
					Name: evt.options.name,
					Inputs: evt.options.inputs,
					Outputs: evt.options.outputs,
					Value: evt.options.value,
					Ramp: evt.options.ramp,
				})
			},
			mixer_setCrossPointMute: {
				name: 'Mixer.SetCrossPointMute',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name',
						default: '',
					},
					{
						type: 'textinput',
						id: 'inputs',
						label: 'Inputs',
						default: '1',
					},
					{
						type: 'textinput',
						id: 'outputs',
						label: 'Outputs',
						default: '1',
					},
					{
						type: 'dropdown',
						id: 'value',
						label: 'Value',
						default: 'true',
						choices: [
							{ id: 'true', label: 'true' },
							{ id: 'false', label: 'false' },
						]
					},
				],
				callback: evt => this.sendCommand('Mixer.SetCrossPointMute', {
					Name: evt.options.name,
					Inputs: evt.options.inputs,
					Outputs: evt.options.outputs,
					Value: evt.options.value,
				})
			},
			mixer_setCrossPointSolo: {
				name: 'Mixer.SetCrossPointSolo',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name',
						default: '',
					},
					{
						type: 'textinput',
						id: 'inputs',
						label: 'Inputs',
						default: '1',
					},
					{
						type: 'textinput',
						id: 'outputs',
						label: 'Outputs',
						default: '1',
					},
					{
						type: 'dropdown',
						id: 'value',
						label: 'Value',
						default: 'true',
						choices: [
							{ id: 'true', label: 'true' },
							{ id: 'false', label: 'false' },
						]
					},
				],
				callback: evt => this.sendCommand('Mixer.SetCrossPointSolo', {
					Name: evt.options.name,
					Inputs: evt.options.inputs,
					Outputs: evt.options.outputs,
					Value: evt.options.value,
				})
			},
			mixer_setInputGain: {
				name: 'Mixer.SetInputGain',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name',
						default: '',
					},
					{
						type: 'textinput',
						id: 'inputs',
						label: 'Inputs',
						default: '1',
					},
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
						regex: Regex.NUMBER
					},
				],
				callback: evt => this.sendCommand('Mixer.SetInputGain', {
					Name: evt.options.name,
					Inputs: evt.options.inputs,
					Value: evt.options.value,
					Ramp: evt.options.ramp,
				})
			},
			'mixer_setInputMute': {
				name: 'Mixer.SetInputMute',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name',
						default: '',
					},
					{
						type: 'textinput',
						id: 'inputs',
						label: 'Inputs',
						default: '1',
					},
					{
						type: 'dropdown',
						id: 'value',
						label: 'Value',
						default: 'true',
						choices: [
							{ id: 'true', label: 'true' },
							{ id: 'false', label: 'false' },
						]
					},
				],
				callback: evt => this.sendCommand('Mixer.SetInputMute', {
					Name: evt.options.name,
					Inputs: evt.options.inputs,
					Value: evt.options.value,
				})
			},
			mixer_setInputSolo: {
				name: 'Mixer.SetInputSolo',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name',
						default: '',
					},
					{
						type: 'textinput',
						id: 'inputs',
						label: 'Inputs',
						default: '1',
					},
					{
						type: 'dropdown',
						id: 'value',
						label: 'Value',
						default: 'true',
						choices: [
							{ id: 'true', label: 'true' },
							{ id: 'false', label: 'false' },
						]
					},
				],
				callback: evt => this.sendCommand('Mixer.SetInputSolo', {
					Name: evt.options.name,
					Inputs: evt.options.inputs,
					Value: evt.options.value,
				})
			},
			mixer_setOutputGain: {
				name: 'Mixer.SetOutputGain',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name',
						default: '',
					},
					{
						type: 'textinput',
						id: 'outputs',
						label: 'Outputs',
						default: '1',
					},
					{
						type: 'number',
						id: 'value',
						label: 'Value',
						default: 0,
						min: -100,
						max: 20,
						regex: Regex.NUMBER
					},
					{
						type: 'number',
						id: 'ramp',
						label: 'Ramp',
						default: 0,
						min: 0,
						max: 100,
						regex: Regex.NUMBER
					},
				],
				callback: evt => this.sendCommand('Mixer.SetOutputGain', {
					Name: evt.options.name,
					Outputs: evt.options.outputs,
					Value: evt.options.value,
					Ramp: evt.options.ramp,
				})
			},
			mixer_setOutputMute: {
				name: 'Mixer.SetOutputMute',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name',
						default: '',
					},
					{
						type: 'textinput',
						id: 'outputs',
						label: 'Outputs',
						default: '1',
					},
					{
						type: 'dropdown',
						id: 'value',
						label: 'Value',
						default: 'true',
						choices: [
							{ id: 'true', label: 'true' },
							{ id: 'false', label: 'false' },
						]
					},
				],
				callback: evt => this.sendCommand('Mixer.SetOutputMute', {
					Name: evt.options.name,
					Outputs: evt.options.outputs,
					Value: evt.options.value,
				})
			},
			mixer_setCueMute: {
				name: 'Mixer.SetCueMute',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name',
						default: '',
					},
					{
						type: 'textinput',
						id: 'cues',
						label: 'Cues',
						default: '1',
					},
					{
						type: 'dropdown',
						id: 'value',
						label: 'Value',
						default: 'true',
						choices: [
							{ id: 'true', label: 'true' },
							{ id: 'false', label: 'false' },
						]
					},
				],
				callback: evt => this.sendCommand('Mixer.SetCueMute', {
					Name: evt.options.name,
					Cues: evt.options.cues,
					Value: evt.options.value,
				})
			},
			mixer_setCueGain: {
				name: 'Mixer.SetCueGain',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name',
						default: '',
					},
					{
						type: 'textinput',
						id: 'cues',
						label: 'Cues',
						default: '1',
					},
					{
						type: 'number',
						id: 'value',
						label: 'Value',
						default: 0,
						min: -100,
						max: 20,
						regex: Regex.NUMBER
					},
					{
						type: 'number',
						id: 'ramp',
						label: 'Ramp',
						default: 0,
						min: 0,
						max: 100,
						regex: Regex.NUMBER
					},
				],
				callback: evt => this.sendCommand('Mixer.SetCueGain', {
					Name: evt.options.name,
					Cues: evt.options.cues,
					Value: evt.options.value,
					Ramp: evt.options.ramp,
				})
			},
			mixer_setInputCueEnable: {
				name: 'Mixer.SetInputCueEnable',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name',
						default: '',
					},
					{
						type: 'textinput',
						id: 'cues',
						label: 'Cues',
						default: '1',
					},
					{
						type: 'textinput',
						id: 'inputs',
						label: 'Inputs',
						default: '1',
					},
					{
						type: 'dropdown',
						id: 'value',
						label: 'Value',
						default: 'true',
						choices: [
							{ id: 'true', label: 'true' },
							{ id: 'false', label: 'false' },
						]
					},
				],
				callback: evt => this.sendCommand('Mixer.SetInputCueEnable', {
					Name: evt.options.name,
					Cues: evt.options.cues,
					Inputs: evt.options.inputs,
					Value: evt.options.value,
				})
			},
			mixer_setInputCueAfl: {
				name: 'Mixer.SetInputCueAfl',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name',
						default: '',
					},
					{
						type: 'textinput',
						id: 'cues',
						label: 'Cues',
						default: '1',
					},
					{
						type: 'textinput',
						id: 'inputs',
						label: 'Inputs',
						default: '1',
					},
					{
						type: 'dropdown',
						id: 'value',
						label: 'Value',
						default: 'true',
						choices: [
							{ id: 'true', label: 'true' },
							{ id: 'false', label: 'false' },
						]
					},
				],
				callback: evt => this.sendCommand('Mixer.SetInputCueAfl', {
					Name: evt.options.name,
					Cues: evt.options.cues,
					Inputs: evt.options.inputs,
					Value: evt.options.value,
				})
			},
			loopPlayer_start: {
				name: 'LoopPlayer.Start',
				options: [
					{
						type: 'textinput',
						id: 'file_name',
						label: 'File Name:',
						default: '',
					},
					{
						type: 'dropdown',
						id: 'channel',
						label: 'Channel',
						default: 'stereo',
						choices: [
							{ id: 'mono', label: 'Mono' },
							{ id: 'stereo', label: 'Stereo' },
						]
					},
					{
						type: 'textinput',
						id: 'output',
						label: 'Output',
						default: '1',
					},
					{
						type: 'number',
						id: 'startTime',
						label: 'Start Time',
						default: 0,
						regex: Regex.NUMBER
					},
					{
						type: 'dropdown',
						id: 'loop',
						label: 'Loop',
						default: 'true',
						choices: [
							{ id: 'true', label: 'true' },
							{ id: 'false', label: 'false' },
						]
					}
				],
				callback: evt => this.sendCommand('LoopPlayer.Start', {
					Files: [
						{
							Name: evt.options.file_name,
							Mode: evt.options.mode,
							Output: evt.options.output
						}
					],
					Name: evt.options.name,
					StartTime: evt.options.startTime,
					Loop: evt.options.loop,
					Log: true
				})
			},
			loopPlayer_stop: {
				name: 'LoopPlayer.Stop',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name:',
						default: '',
					},
					{
						type: 'textinput',
						id: 'output',
						label: 'Output',
						default: '1',
					}
				],
				callback: evt => this.sendCommand('LoopPlayer.Stop', {
					Name: evt.options.name,
					Outputs: evt.options.output,
					Log: true
				})
			},
			loopPlayer_cancel: {
				name: 'LoopPlayer.Cancel',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name:',
						default: '',
					},
					{
						type: 'textinput',
						id: 'output',
						label: 'Output',
						default: '1',
					}
				],
				callback: evt => this.sendCommand('LoopPlayer.Cancel', {
					Name: evt.options.name,
					Outputs: evt.options.output,
					Log: true
				})
			},
			snapshot_load: {
				name: 'Snapshot.Load',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name:',
						default: '',
					},
					{
						type: 'number',
						id: 'bank',
						label: 'Bank:',
						default: '',
						tooltip: 'Specific bank number to recall from the snapshot'
					},
					{
						type: 'number',
						id: 'ramp',
						label: 'Ramp',
						tooltip: 'Time in seconds to ramp to banked snapshot'
					}
				],
				callback: evt => this.sendCommand('Snapshot.Load', {
						Name: evt.options.name,
						Bank: evt.options.bank,
						Ramp: evt.options.ramp
				})
			},
			snapshot_save: {
				name: 'Snapshot.Save',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name:',
						default: '',
					},
					{
						type: 'number',
						id: 'bank',
						label: 'Bank:',
						default: '',
						tooltip: 'Specific bank number to save to within the snapshot'
					}
				],
				callback: evt => this.sendCommand('Snapshot.Save', {
						Name: evt.options.name,
						Bank: evt.options.bank
				})
			}
		})
	}

	initFeedbacks() {
		this.variables = []
		if(!this.config.feedback_enabled) {
			this.setFeedbackDefinitions({})
			return
		}

		const feedbacks = {
			"control-string": {
				name: 'Change text to reflect control value',
				description: 'Will return current state of a control as a string',
				type: 'advanced',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name:',
						default: '',
					},
					{
						type: 'dropdown',
						id: 'type',
						label: 'Type',
						choices: [
							{ id: 'string',   label: 'String'},
							{ id: 'value',    label: 'Value'},
							{ id: 'position', label: 'Position'}
						],
						default: 'value'
					},
				],
				subscribe: feedback => this.addControl(feedback),
				unsubscribe: feedback => this.removeControl(feedback),
				callback: feedback => {
					const opt = feedback.options
					const control = this.controls.get(opt.name)
					if (!control.value) return

					switch (opt.type) {
						case 'string':
							return {
								text: control.strval
							}
						case 'value':
							return {
								text: control.value.toString()
							}
						case 'position':
							return {
								text: control.position.toString()
							}
						default:
							break
					}
				}
			},
			"control-boolean": {
				name: 'Feedback on boolean control value',
				type: 'boolean',
				defaultStyle: {
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(255, 0, 0),
				},
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name:',
						default: '',
					},
					{
						type: 'dropdown',
						id: 'value',
						label: 'Control value',
						choices: [
							{ id: 'true', label: 'True'},
							{ id: 'false', label: 'False'}
						],
						default: 'true'
					},
				],
				subscribe: feedback => this.addControl(feedback),
				unsubscribe: feedback => this.removeControl(feedback),
				callback: feedback => {
					const opt = feedback.options
					const control = this.controls.get(opt.name)

					return (opt.value === 'true' && control.value) || (opt.value === 'false' && !control.value)
				}
			},
			"control-threshold": {
				name: 'Feedback if control value at or exceeds threshold',
				type: 'boolean',
				defaultStyle: {
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(255, 0, 0),
				},
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name:',
						default: '',
					},
					{
						type: 'number',
						id: 'threshold',
						label: 'Threshold value',
						default: '',
						min: -10000,
						max: 10000,
						range: false,
					},
				],
				subscribe: feedback => this.addControl(feedback),
				unsubscribe: feedback => this.removeControl(feedback),
				callback: feedback => {
					const opt = feedback.options
					const control = this.controls.get(opt.name)

					return control.value >= opt.threshold
				}
			},
			"control-fade": {
				name: 'Fade color over control value range',
				description: 'Fade color over control value range',
				type: 'advanced',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name:',
						default: '',
					},
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
						default: combineRgb(0,0,0)
					},
					{
						type: 'colorpicker',
						label: 'High threshold color',
						id: 'high_bg',
						default: combineRgb(255,0,0)
					},
				],
				subscribe: feedback => this.addControl(feedback),
				unsubscribe: feedback => this.removeControl(feedback),
				callback: feedback => {
					const opt = feedback.options
					const control = this.controls.get(opt.name)
					const numToRGB = num => {
						return {
							r: (num & 0xff0000) >> 16,
							g: (num & 0x00ff00) >> 8,
							b: (num & 0x0000ff)
						}
					}

					if ((control.value > opt.high_threshold) ||
						(control.value < opt.low_threshold)) {
								return
					}

					const range = opt.high_threshold - opt.low_threshold
					const ratio = (control.value - opt.low_threshold) / range

					hi_rgb = numToRGB(opt.high_bg)
					lo_rgb = numToRGB(opt.low_bg)

					const r = Math.round((hi_rgb.r - lo_rgb.r) * ratio) + lo_rgb.r
					const g = Math.round((hi_rgb.g - lo_rgb.g) * ratio) + lo_rgb.g
					const b = Math.round((hi_rgb.b - lo_rgb.b) * ratio) + lo_rgb.b

					return {
						bgcolor: combineRgb(r, g, b)
					}
				}
			}
		}

		this.setFeedbackDefinitions(feedbacks)
	}

	async callCommandObj(cmd, get_set = this.QRC_SET) {
		if (this.socket === undefined || !this.socket.isConnected) return

		cmd.jsonrpc = 2.0
		cmd.id = get_set

		await this.socket.send(JSON.stringify(cmd) + '\x00')

		if (this.console_debug) {
			console.log('Q-SYS Send: ' + JSON.stringify(cmd) + '\r')
		}
	}

	async changeGroup(type, id, controls = null) {
		const obj = {
			method: 'ChangeGroup.' + type,
			params: {
				Id: id
			}
		}
		if (controls !== null) {
			obj.params.Controls = [controls]
		}
		await this.callCommandObj(obj)
	}

	getControlStatuses() {
		// It is possible to group multiple statuses; HOWEVER, if one doesn't exist, nothing will be returned...
		// thus, we send one at a time
		if(!('bundle_feedbacks' in this.config) || !this.config.bundle_feedbacks) {
			this.controls.forEach((x, k) => {
				const cmd = {
					method: 'Control.Get',
					params: [k]
				}

				this.callCommandObj(cmd, this.QRC_GET)
			})
		} else {
			this.callCommandObj({
				method: 'Control.Get',
				params: [...this.controls.keys()]
			}, this.QRC_GET)
		}
	}

	initPolling() {
		if (!this.config.feedback_enabled) return

		if (this.pollQRCTimer === undefined) {
			this.pollQRCTimer = setInterval(() => this.getControlStatuses(), this.config.poll_interval)
		}
	}

	addControl(feedback) {
		const name = feedback['options']['name']

		if (this.controls.has(name)) {
			const control = this.controls.get(name)
			if (control.ids === undefined) {
				control.ids = new Set()
			}
			control.ids.add(feedback.id)
		} else {
			this.controls.set(name, {
				ids: new Set([feedback.id]),
				value: null,
				position: null,
				strval: ''
			})

			this.variables.push({
				name: `${name} Value`,
				variableId: `${name}_value`,
			}, {
				name: `${name} Position`,
				variableId: `${name}_position`,
			}, {
				name: `${name} String`,
				variableId: `${name}_string`,
			})

			this.setVariableDefinitions(this.variables)
		}
	}

	removeControl(feedback) {
		const name = feedback['options']['name']

		if (this.controls.has(name)) {
			const control = this.controls.get(name)

			if (control.ids !== undefined) {
				control.ids.delete(feedback.id)
			}

			if (control.ids.size == 0) {
				this.controls.delete(name)
			}
		}
	}

	updateControl(update) {
		const name = update.Name
		const control = this.controls.get(name)

		control.value    = update.Value
		control.strval   = update.String
		control.position = update.Position

		this.setVariableValues({
			[`${name}_string`]: update.String,
			[`${name}_position`]: update.Position,
			[`${name}_value`]: update.Value
		})
	}
}

runEntrypoint(QsysRemoteControl, UpgradeScripts)
