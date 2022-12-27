var tcp           = require('../../tcp')
var instance_skel = require('../../instance_skel')
var controls

import UpgradeScripts from './upgrades.js'

import { InstanceBase, Regex, combineRgb, runEntrypoint } from '@companion-module/base'

class QsysRemoteControl extends InstanceBase {	
	async init(config) {
		this.console_debug = false

		this.pollQRCTimer = undefined
		this.config = config

		this.QRC_GET = 1
		this.QRC_SET = 2

//		this.actions(); // export actions

		if (this.config.feedback_enabled) {
			this.initControls()
			this.initFeedbacks()
			this.initPolling()
		}

		this.init_tcp()
	}

	updateConfig(config) {
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

		if (this.config.feedback_enabled) {
			this.initControls()
			this.initFeedbacks()
			this.initPolling()
		}
	}

	init_tcp() {
		if (this.socket !== undefined) {
			this.socket.destroy()
			delete this.socket
		}

		this.status(this.STATE_WARNING, 'Connecting')

		if (this.config.host) {
			this.socket = new tcp(this.config.host, this.config.port)

			this.socket.on('status_change', function (status, message) {
				this.status(status, message)
			})

			this.socket.on('error', function (err) {
				debug("Network error", err)
				this.status(this.STATE_ERROR, err)
				this.log('error',"Network error: " + err.message)
			})

			this.socket.on('connect', function (socket) {
				this.status(this.STATE_OK)
				debug("Connected")

				let login = '{ "jsonrpc":"2.0", "method":"Logon", "params": { "User":"' + this.config.user + '", "Password":"' + this.config.pass + '" } }' + '\x00'

				if (this.console_debug) {
					console.log('Q-SYS Connected')
					console.log('Q-SYS Send: ' + login)
				}

				this.socket.write(login)

				socket.once('close', function() {
					if (this.console_debug) {
						console.log('Q-SYS Disconnect')
					}
				})
			})

			this.socket.on('data', function (d) {
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
		const messages = this.getMessages(response)
		let refresh = false
		let obj

		for (message of messages) {
			obj = JSON.parse(message.slice(0, -1)) // trim trailing null

			if ((obj.id !== undefined) && (obj.id == this.QRC_GET)) {
				if (obj.result !== undefined) {
					this.updateControl(obj)
					refresh = true
				} else if (obj.error !== undefined) {
					// @todo this should not be console.log
					console.log('Q-Sys error', obj.error)
				}
			}
		}

		if (refresh) this.checkFeedbacks()
	}

	getMessages(input) {
		const messageStart = '{"jsonrpc"'
		const messages = []
		let remaining = input
		let i = 1 //looking for the next message, not the first one

		while (i > 0) {
			i = remaining.indexOf(messageStart, 1)
			if (i > 0) {  // if there is another message, split off the first and repeat
				nextMessage = remaining.substring(0,i)
				remaining = remaining.substring(i)

				messages.push(nextMessage)
			} else {  // else add the last remaining message
				messages.push(remaining)
			}
		}

		return messages
	}

	// Return config fields for web config
	config_fields() {
		return [
			{
				type: 'textinput',
				id: 'host',
				label: 'Target IP',
				width: 5,
				regex: Regex.IP
			},
			{
				type: 'textinput',
				id: 'port',
				label: 'Target Port (Default: 1710)',
				width: 3,
				default: 1710,
				regex: Regex.PORT
			},
			{
				type: 'checkbox',
				id: 'feedback_enabled',
				label: 'Feedback Enabled',
				default: false
			},
			{
				type: 'number',
				id: 'poll_interval',
				label: 'Polling Interval (ms)',
				min: 30,
				max: 60000,
				default: 100
			},
			{
				type: 'text',
				id: 'info',
				label: 'Information',
				width: 12,
				value: 'Please type in your ID and Password credentials:'
			},
			{
				type: 'textinput',
				id: 'user',
				label: 'ID',
				width: 4,
				default: 'username'
			},
			{
				type: 'textinput',
				id: 'pass',
				label: 'Password',
				width: 4,
				default: '1234'
			},
		]
	}

	// When module gets deleted
	destroy() {
		if (this.socket !== undefined) {
			this.socket.destroy()
		}

		if (this.udp !== undefined) {
			this.udp.destroy()
		}

		if (this.pollQRCTimer !== undefined) {
			clearInterval(this.pollQRCTimer)
			delete this.pollQRCTimer
		}

		if (this.controls !== undefined) {
			this.controls.destroy()
		}

		debug("destroy", this.id)
	}

	actions(system) {
		this.setActionDefinitions({
			'control_set': {
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
					}
				],
				callback: evt => this.callCommand('"Control.Set", "params": { "Name": "' + evt.options.name + '", "Value": "' + evt.options.value + '" } }')
			},
			'control_toggle': {
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
					let control = controls.get(evt.options.name)
					// set our internal state in anticipation of success, allowing two presses
					// of the button faster than the polling interval to correctly toggle the state
					control.value = !control.value
					this.callCommand('"Control.Set", "params": { "Name": "' + evt.options.name + '", "Value": "' + evt.value + '" } }')
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
				callback: evt => this.callCommand('"Component.Set", "params": { "Name": "' + evt.options.name + '", "Controls": [{ "Name": "' + evt.options.control_name + '", "Value": ' + evt.options.value + ', "Ramp": ' + evt.options.ramp + ' }] } }')
			},
			'changeGroup_addControl': {
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
				callback: evt => this.callCommand('"ChangeGroup.AddControl", "params": { "Id": "' + evt.options.id + '", "Controls": [ ' + evt.options.controls + ' ] } }')
			},
			'changeGroup_addComponentControl': {
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
				callback: evt => this.callCommand('"ChangeGroup.AddComponentControl", "params": { "Id": "' + evt.options.id + '", "Controls": [ ' + evt.options.controls + ' ] } }')
			},
			'changeGroup_remove': {
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
				callback: evt => this.callCommand('"ChangeGroup.Remove", "params": { "Id": "' + evt.options.id + '", "Controls": [ ' + evt.options.controls + ' ] } }')
			},
			'changeGroup_destroy': {
				name: 'ChangeGroup.Destroy',
				options: [
					{
						type: 'textinput',
						id: 'id',
						label: 'Group Id:',
						default: '',
					}
				],
				callback: evt => this.callCommand('"ChangeGroup.Destroy", "params": { "Id": "' + evt.options.id + '" } }')
			},
			'changeGroup_invalidate': {
				name: 'ChangeGroup.Invalidate',
				options: [
					{
						type: 'textinput',
						id: 'id',
						label: 'Group Id:',
						default: '',
					}
				],
				callback: evt => this.callCommand('"ChangeGroup.Invalidate", "params": { "Id": "' + evt.options.id + '" } }')
			},
			'changeGroup_clear': {
				name: 'ChangeGroup.Clear',
				options: [
					{
						type: 'textinput',
						id: 'id',
						label: 'Group Id:',
						default: '',
					}
				],
				callback: evt => this.callCommand('"ChangeGroup.Clear", "params": { "Id": "' + evt.options.id + '" } }')
			},

			'mixer_setCrossPointGain': {
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
				callback: evt => this.callCommand('"Mixer.SetCrossPointGain", "params": { "Name": "' + evt.options.name + '", "Inputs": "' + evt.options.inputs + '", "Outputs": "' + evt.options.outputs + '", "Value": ' + evt.options.value + ', "Ramp": ' + evt.options.ramp + ' } }')
			},
			'mixer_setCrossPointDelay': {
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
				callback: evt => this.callCommand('"Mixer.SetCrossPointDelay", "params": { "Name": "' + evt.options.name + '", "Inputs": "' + evt.options.inputs + '", "Outputs": "' + evt.options.outputs + '", "Value": ' + evt.options.value + ', "Ramp": ' + evt.options.ramp + ' } }')
			},
			'mixer_setCrossPointMute': {
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
				callback: evt => this.callCommand('"Mixer.SetCrossPointMute", "params": { "Name": "' + evt.options.name + '", "Inputs": "' + evt.options.inputs + '", "Outputs": "' + evt.options.outputs + '", "Value": ' + evt.options.value + ' } }')
			},
			'mixer_setCrossPointSolo': {
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
				callback: evt => this.callCommand('"Mixer.SetCrossPointSolo", "params": { "Name": "' + evt.options.name + '", "Inputs": "' + evt.options.inputs + '", "Outputs": "' + evt.options.outputs + '", "Value": ' + evt.options.value + ' } }')
			},
			'mixer_setInputGain': {
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
				callback: evt => this.callCommand('"Mixer.SetInputGain", "params": { "Name": "' + evt.options.name + '", "Inputs": "' + evt.options.inputs + '", "Value": ' + evt.options.value + ', "Ramp": ' + evt.options.ramp + ' } }')
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
				callback: evt => this.callCommand('"Mixer.SetInputMute", "params": { "Name": "' + evt.options.name + '", "Inputs": "' + evt.options.inputs + '", "Value": ' + evt.options.value + ' } }')
			},
			'mixer_setInputSolo': {
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
				callback: evt => this.callCommand('"Mixer.SetInputSolo", "params": { "Name": "' + evt.options.name + '", "Inputs": "' + evt.options.inputs + '", "Value": ' + evt.options.value + ' } }')
			},
			'mixer_setOutputGain': {
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
				callback: evt => this.callCommand('"Mixer.SetOutputGain", "params": { "Name": "' + evt.options.name + '", "Outputs": "' + evt.options.outputs + '", "Value": ' + evt.options.value + ', "Ramp": ' + evt.options.ramp + ' } }')
			},
			'mixer_setOutputMute': {
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
				callback: evt => this.callCommand('"Mixer.SetOutputMute", "params": { "Name": "' + evt.options.name + '", "Outputs": "' + evt.options.outputs + '", "Value": ' + evt.options.value + ' } }')
			},
			'mixer_setCueMute': {
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
				callback: evt => this.callCommand('"Mixer.SetCueMute", "params": { "Name": "' + evt.options.name + '", "Cues": "' + evt.options.cues + '", "Value": ' + evt.options.value + ' } }')
			},
			'mixer_setCueGain': {
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
				callback: evt => this.callCommand('"Mixer.SetCueGain", "params": { "Name": "' + evt.options.name + '", "Cues": "' + evt.options.cues + '", "Value": ' + evt.options.value + ', "Ramp": ' + evt.options.ramp + ' } }')
			},
			'mixer_setInputCueEnable': {
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
				callback: evt => this.callCommand('"Mixer.SetInputCueEnable", "params": { "Name": "' + evt.options.name + '", "Cues": "' + evt.options.cues + '", "Inputs": "' + evt.options.inputs + '", "Value": ' + evt.options.value + ' } }')
			},
			'mixer_setInputCueAfl': {
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
				callback: evt => this.callCommand('"Mixer.SetInputCueAfl", "params": { "Name": "' + evt.options.name + '", "Cues": "' + evt.options.cues + '", "Inputs": "' + evt.options.inputs + '", "Value": ' + evt.options.value + ' } }')
			},
			'loopPlayer_start': {
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
				callback: evt => this.callCommand('"LoopPlayer.Start", "params": { "Files": [ { "Name": "' + evt.options.file_name + '", "Mode": "' + evt.options.mode + '", "Output": ' + evt.options.output + ' } ], "Name": "' + evt.options.name + '", "StartTime": ' + evt.options.startTime + ', "Loop": ' + evt.options.loop + ', "Log": true }, }')
			},
			'loopPlayer_stop': {
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
				callback: evt => this.callCommand('"LoopPlayer.Stop", "params": { "Name": "' + evt.options.name + '", "Outputs": ' + evt.options.output + ', "Log": true } }')
			},
			'loopPlayer_cancel': {
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
				callback: evt => this.callCommand('"LoopPlayer.Cancel", "params": { "Name": "' + evt.options.name + '", "Outputs": ' + evt.options.output + ', "Log": true } }')
			},
		})
	}

	initControls() {
		controls = new Map()

		for (let bank in feedbacks) {
			for (let button in feedbacks[bank]) {
				feedback = feedbacks[bank][button]
				if (Object.keys(feedback).length > 0) {
					this.addControl(feedback[0])
				}
			}
		}
	}

	initFeedbacks() {
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
					const control = controls.get(opt.name)

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
				name: 'Toggle color on boolean control value',
				description: 'Toggle color on boolean control value',
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
					const control = controls.get(opt.name)

					return (opt.value === 'true' && control.value) || (opt.value === 'false' && !control.value)
				}
			},

			"control-threshold": {
				name: 'Toggle color on control value at or exceeding threshold',
				description: 'Toggle color on control value at or exceeding threshold',
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
					{
						type: 'colorpicker',
						label: 'Foreground color',
						id: 'fg',
						default: combineRgb(255,255,255)
					},
					{
						type: 'colorpicker',
						label: 'Background color',
						id: 'bg',
						default: combineRgb(255,0,0)
					},
				],
				subscribe: feedback => this.addControl(feedback),
				unsubscribe: feedback => this.removeControl(feedback),
				callback: feedback => {
					const opt = feedback.options
					const control = controls.get(opt.name)

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
					const control = controls.get(opt.name)
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

	callCommand(cmd, get_set = this.QRC_SET) {
		const full_cmd = '{ "jsonrpc": "2.0", "id": ' + get_set + ', "method": ' + cmd
		debug('sending ',full_cmd, "to", this.config.host)

		if (this.socket !== undefined && this.socket.connected) {
			this.socket.send(full_cmd + '\x00')

			if (this.console_debug) {
				console.log('Q-SYS Send: ' + full_cmd + '\r')
			}
		} else {
			debug('Socket not connected :(')
		}
	}

	getControlStatus(control) {
		const cmd = '"Control.Get", "params": ["' + control + '"] }'

		this.callServer(cmd, this.QRC_GET)
	}

	getControlStatuses() {
		for (control of controls.keys()) {
			this.getControlStatus(control)
		}
	}

	initPolling() {
		if (!this.config.feedback_enabled) return

		if (this.pollQRCTimer === undefined) {
			this.pollQRCTimer = setInterval(this.getControlStatuses.bind(this), this.config.poll_interval)
		}
	}

	addControl(feedback) {
		const name = feedback['options']['name']

		if (controls.has(name)) {
			const control = controls.get(name)
			if (control.ids === undefined) {
				control.ids = new Set()
			}
			control.ids.add(feedback.id)
		} else {
			controls.set(name, {
				ids: new Set([feedback.id]),
				value: null,
				position: null,
				strval: ''
			})
		}
	}

	removeControl(feedback) {
		const name = feedback['options']['name']

		if (controls.has(name)) {
			const control = controls.get(name)

			if (control.ids !== undefined) {
				control.ids.delete(feedback.id)
			}

			if (control.ids.size == 0) {
				controls.delete(name)
			}
		}
	}

	updateControl(update) {
		const name = update.result[0].Name
		const control = controls.get(name)

		control.value    = update.result[0].Value
		control.strval   = update.result[0].String
		control.position = update.result[0].Position
	}
}

runEntrypoint(QsysRemoteControl, UpgradeScripts)
