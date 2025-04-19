import UpgradeScripts from './upgrades.js'

import {
	InstanceBase,
	Regex,
	combineRgb,
	runEntrypoint,
	TCPHelper,
	InstanceStatus,
	// eslint-disable-next-line no-unused-vars
	CompanionFeedbackInfo,
	// eslint-disable-next-line no-unused-vars
	CompanionFeedbackContext,
} from '@companion-module/base'
import { configFields } from './config.js'
import {
	calcRelativeValue,
	convertValueType,
	sanitiseVariableId,
	buildFilteredOutputArray,
	resetModuleStatus,
	validMethodsToStandbyCore,
} from './utils.js'
import { debounce } from 'lodash'
import PQueue from 'p-queue'
const queue = new PQueue({ concurrency: 1 })
const QRC_GET = 1
const QRC_SET = 2

const colours = {
	black: combineRgb(0, 0, 0),
	white: combineRgb(255, 255, 255),
	red: combineRgb(255, 0, 0),
	green: combineRgb(0, 204, 0),
}

class QsysRemoteControl extends InstanceBase {
	constructor(internal) {
		super(internal)
		this.console_debug = false
		this.pollQRCTimer = undefined
		this.variables = []
		this.moduleStatus = resetModuleStatus()
		this.controls = new Map()
		this.namesToGet = new Set()
		this.socket = {
			pri: new TCPHelper('localhost', 1710),
			sec: new TCPHelper('localhost', 1710),
			buffer: {
				pri: '',
				sec: '',
			},
		}
		this.socket.pri.destroy()
		this.socket.sec.destroy()
	}

	/**
	 * Main initialization when it's ok to login
	 * @param {Object} config New configuration
	 * @access public
	 * @since 1.0.0
	 */

	async init(config) {
		this.config = config
		this.actions()
		await this.configUpdated(config)
	}

	/**
	 * Process configuration updates
	 * @param {Object} config New configuration
	 * @access public
	 * @since 1.0.0
	 */

	async configUpdated(config) {
		queue.clear()
		this.debouncedStatusUpdate.cancel()
		this.debouncedVariableDefUpdate.cancel()
		this.namesToGet = new Set()
		this.killTimersDestroySockets()
		this.moduleStatus = resetModuleStatus()
		this.config = config
		this.console_debug = config.verbose
		this.controls = new Map()
		await this.initVariables(config.redundant)
		this.init_tcp(config.host, config.port)
		if (config.redundant) {
			this.init_tcp(config.hostSecondary, config.portSecondary, true)
		}
		this.actions()
		this.initFeedbacks()
		this.subscribeFeedbacks() // ensures control hashmap is updated with all feedbacks when config is changed
		this.initPolling()
	}

	/**
	 * Initialise module variables
	 * @param {boolean} redundant
	 * @access private
	 */

	async initVariables(redundant) {
		this.variables = []
		this.variables.push(
			{
				name: 'State',
				variableId: 'state',
			},
			{
				name: 'Design Name',
				variableId: 'design_name',
			},
			{
				name: 'Redundant',
				variableId: 'redundant',
			},
			{
				name: 'Emulator',
				variableId: 'emulator',
			},
		)
		if (redundant) {
			this.variables.push(
				{
					name: 'State - Secondary',
					variableId: 'stateSecondary',
				},
				{
					name: 'Design Name - Secondary',
					variableId: 'design_nameSecondary',
				},
				{
					name: 'Redundant - Secondary',
					variableId: 'redundantSecondary',
				},
				{
					name: 'Emulator - Secondary',
					variableId: 'emulatorSecondary',
				},
			)
		}

		if (!('variables' in this.config) || this.config.variables === '' || !this.config.feedback_enabled) {
			this.setVariableDefinitions(this.variables) // This gets called in addControls if there are vars
			return
		}
		for (const v of this.config.variables.split(',')) {
			await this.addControl({
				options: {
					name: v.trim(),
				},
				id: 'var',
			})
		}
	}

	/**
	 * Initialise TCP Socket
	 * @param {string} host Qsys host to connect to
	 * @param {string} port Port to connect on
	 * @param {boolean} secondary True if connecting to secondary core
	 * @access private
	 */

	init_tcp(host, port, secondary = false) {
		const errorEvent = (err) => {
			this.checkStatus(InstanceStatus.ConnectionFailure, '', secondary)
			this.log('error', `Network error from ${host}: ${err.message}`)
		}
		const endEvent = () => {
			this.checkStatus(InstanceStatus.Disconnected, `Connection to ${host} ended`, secondary)
			this.log('warn', `Connection to ${host} ended`)
		}
		const connectEvent = async () => {
			if (secondary) {
				this.socket.buffer.sec = ''
			} else {
				this.socket.buffer.pri = ''
			}

			const login = {
				jsonrpc: 2.0,
				method: 'Logon',
				params: {},
			}

			if ('user' in this.config && 'pass' in this.config) {
				login.params = {
					User: this.config.user,
					Password: this.config.pass,
				}
			}

			if (this.console_debug) {
				console.log(`Q-SYS Connected to ${host}:${port}`)
				console.log('Q-SYS Send: ' + JSON.stringify(login))
			}

			await socket.send(JSON.stringify(login) + '\x00')

			await this.sendCommand('StatusGet', 0)

			this.checkStatus(InstanceStatus.Ok, '', secondary)

			//await this.initVariables()
			if (this.keepAlive === undefined) {
				this.keepAlive = setInterval(async () => {
					await this.sendCommand('NoOp', {})
				}, 1000)
			}
		}
		const dataEvent = (d) => {
			const response = d.toString()

			if (this.console_debug) {
				console.log(`[${new Date().toJSON()}] Message recieved from ${host}: ${response}`)
			}
			this.processResponse(response, secondary)
		}
		if (!host) {
			this.checkStatus(
				InstanceStatus.BadConfig,
				`No host defined for ${secondary ? 'secondary' : 'primary'} core`,
				secondary,
			)
			this.log('warn', `No host defined for ${secondary ? 'secondary' : 'primary'} core`)
			return
		}
		this.checkStatus(InstanceStatus.Connecting, `Connecting to ${host}`, secondary)
		let socket
		if (secondary) {
			if (!this.socket.sec.isDestroyed) this.socket.sec.destroy()
			this.socket.sec = new TCPHelper(host, port)
			socket = this.socket.sec
		} else {
			if (!this.socket.pri.isDestroyed) this.socket.pri.destroy()
			this.socket.pri = new TCPHelper(host, port)
			socket = this.socket.pri
		}

		socket.on('error', errorEvent)
		socket.on('end', endEvent)
		socket.on('connect', connectEvent)
		socket.on('data', dataEvent)
	}

	/**
	 * Debounce status update to prevent warnings during init of redundant systems
	 * @access private
	 */

	debouncedStatusUpdate = debounce(
		() => {
			if (this.moduleStatus.logMessage !== '') this.log(this.moduleStatus.logLevel, this.moduleStatus.logMessage)
			this.updateStatus(this.moduleStatus.status, this.moduleStatus.message)
		},
		1000,
		{ leading: false, maxWait: 2000, trailing: true },
	)

	/**
	 * Check and update module status. For redundant connections, will check states of both cores before setting module status
	 * @param {InstanceStatus} status
	 * @param {string} message Qsys host to connect to
	 * @param {boolean} secondary True if updating secondary core status
	 * @access private
	 * @since 2.3.0
	 */

	checkStatus(status, message, secondary) {
		const newStatus = {
			status: InstanceStatus.UnknownWarning,
			message: '',
			logLevel: 'debug',
			logMessage: '',
		}
		if (secondary) {
			if (this.moduleStatus.secondary.status == status && this.moduleStatus.secondary.message == message) return
			this.moduleStatus.secondary.status = status
			this.moduleStatus.secondary.message = message
		} else {
			if (this.moduleStatus.primary.status == status && this.moduleStatus.secondary.primary == message) return
			this.moduleStatus.primary.status = status
			this.moduleStatus.primary.message = message
		}
		if (this.config.redundant) {
			if (
				this.moduleStatus.primary.status == InstanceStatus.Ok &&
				this.moduleStatus.secondary.status == InstanceStatus.Ok
			) {
				if (this.moduleStatus.primary.state == 'Active' && this.moduleStatus.secondary.state == 'Standby') {
					newStatus.status = InstanceStatus.Ok
					newStatus.message = 'Primary core active'
					newStatus.logLevel = 'info'
					newStatus.logMessage = ''
				} else if (this.moduleStatus.primary.state == 'Standby' && this.moduleStatus.secondary.state == 'Active') {
					newStatus.status = InstanceStatus.Ok
					newStatus.message = 'Secondary core active'
					newStatus.logLevel = 'info'
					newStatus.logMessage = ''
				} else if (this.moduleStatus.primary.state == 'Active' && this.moduleStatus.secondary.state == 'Active') {
					newStatus.status = InstanceStatus.UnknownError
					newStatus.message = 'Both cores active'
					newStatus.logLevel = 'error'
					newStatus.logMessage = 'Both cores active'
				} else if (this.moduleStatus.primary.state == 'Standby' && this.moduleStatus.secondary.state == 'Standby') {
					newStatus.status = InstanceStatus.UnknownError
					newStatus.message = `Both cores in standby`
					newStatus.logLevel = 'error'
					newStatus.logMessage = 'Both cores in standby'
				} else {
					newStatus.status = InstanceStatus.UnknownWarning
					newStatus.message = `Unexpected state. Primary: ${this.moduleStatus.primary.state}. Secondary: ${this.moduleStatus.secondary.state}`
					newStatus.logLevel = 'warn'
					newStatus.logMessage = `Unexpected state. Primary: ${this.moduleStatus.primary.state}. Secondary: ${this.moduleStatus.secondary.state}`
				}
				if (this.moduleStatus.primary.design_code !== this.moduleStatus.secondary.design_code) {
					newStatus.status = InstanceStatus.UnknownWarning
					newStatus.message = 'Cores reporting different designs'
					newStatus.logLevel = 'error'
					newStatus.logMessage = `Cores running different designs. Primary: ${this.moduleStatus.primary.design_name}. Secondary: ${this.moduleStatus.secondary.design_name}`
				}
				if (this.moduleStatus.primary.emulator) {
					newStatus.status = InstanceStatus.UnknownWarning
					newStatus.message = 'Primary core in Emulator mode'
					newStatus.logLevel = 'warn'
					newStatus.logMessage = 'Primary core in Emulator mode'
				}
				if (this.moduleStatus.secondary.emulator) {
					newStatus.status = InstanceStatus.UnknownWarning
					newStatus.message = 'Secondary core in Emulator mode'
					newStatus.logLevel = 'warn'
					newStatus.logMessage = 'Secondary core in Emulator mode'
				}
				if (!this.moduleStatus.primary.redundant || !this.moduleStatus.secondary.redundant) {
					newStatus.status = InstanceStatus.UnknownWarning
					newStatus.message = 'Cores not configured for redundant mode'
					newStatus.logLevel = 'error'
					newStatus.logMessage = 'Cores not configured for redundant mode'
				}
			} else if (
				this.moduleStatus.primary.status == InstanceStatus.Ok ||
				this.moduleStatus.secondary.status == InstanceStatus.Ok
			) {
				newStatus.status = InstanceStatus.UnknownWarning
				newStatus.message = `Redundancy compromised`
				newStatus.logLevel = 'warn'
				newStatus.logMessage = 'Redundancy compromised'
			} else if (this.moduleStatus.primary.status == this.moduleStatus.secondary.status) {
				newStatus.status = this.moduleStatus.primary.status
				newStatus.message = this.moduleStatus.primary.message + ' : ' + this.moduleStatus.secondary.message
				newStatus.logLevel = 'info'
				newStatus.logMessage =
					`Core states: ` + this.moduleStatus.primary.message + ' : ' + this.moduleStatus.secondary.message
			} else {
				newStatus.status = InstanceStatus.UnknownError
				newStatus.message = `Core connections in unexpected & inconsistent states`
				newStatus.logLevel = 'warn'
				newStatus.logMessage =
					`Core states: ` + this.moduleStatus.primary.message + ' : ' + this.moduleStatus.secondary.message
			}
		} else {
			if (this.moduleStatus.primary.state == 'Active') {
				newStatus.status = InstanceStatus.Ok
				newStatus.message = 'Core active'
				newStatus.logLevel = 'info'
				newStatus.logMessage = ''
			} else if (this.moduleStatus.primary.state == 'Standby') {
				newStatus.status = InstanceStatus.UnknownWarning
				newStatus.message = 'Core state standby'
				newStatus.logLevel = 'warn'
				newStatus.logMessage = 'Core state standby'
			} else if (this.moduleStatus.primary.state == 'Idle') {
				newStatus.status = InstanceStatus.UnknownError
				newStatus.message = 'Core state idle'
				newStatus.logLevel = 'warn'
				newStatus.logMessage = 'Core state Idle'
			} else {
				newStatus.status = this.moduleStatus.primary.status
				newStatus.message = this.moduleStatus.primary.message
				newStatus.logLevel = 'info'
				newStatus.logMessage = this.moduleStatus.primary.message
			}
		}
		if (this.moduleStatus.status == newStatus.status && this.moduleStatus.message == newStatus.message) return
		this.moduleStatus.status = newStatus.status
		this.moduleStatus.message = newStatus.message
		this.moduleStatus.logLevel = newStatus.logLevel
		this.moduleStatus.logMessage = newStatus.logMessage
		this.debouncedStatusUpdate()
	}

	/**
	 * Set the engine variable values
	 */

	setEngineVariableValues() {
		let engineVars = []
		if (this.config.redundant) {
			engineVars.stateSecondary = this.moduleStatus.secondary.state
			engineVars.design_nameSecondary = this.moduleStatus.secondary.design_name
			engineVars.redundantSecondary = !!this.moduleStatus.secondary.redundant
			engineVars.emulatorSecondary = !!this.moduleStatus.secondary.emulator
		}
		engineVars.state = this.moduleStatus.primary.state
		engineVars.design_name = this.moduleStatus.primary.design_name
		engineVars.redundant = !!this.moduleStatus.primary.redundant
		engineVars.emulator = !!this.moduleStatus.primary.emulator
		this.setVariableValues(engineVars)
	}

	/**
	 * Update Engine variables and related status
	 * @param {object} data Recieved JSON blod
	 * @param {boolean} secondary True if message from secondary core
	 * @access private
	 */

	updateEngineVariables(data, secondary) {
		if (secondary) {
			this.moduleStatus.secondary.state = data?.State.toString() ?? this.moduleStatus.secondary.state
			this.moduleStatus.secondary.design_name = data?.DesignName.toString() ?? this.moduleStatus.secondary.design_name
			this.moduleStatus.secondary.design_code = data?.DesignCode.toString() ?? this.moduleStatus.secondary.design_code
			this.moduleStatus.secondary.redundant = !!data.IsRedundant
			this.moduleStatus.secondary.emulator = !!data.IsEmulator
		} else {
			this.moduleStatus.primary.state = data?.State.toString() ?? this.moduleStatus.primary.state
			this.moduleStatus.primary.design_name = data?.DesignName.toString() ?? this.moduleStatus.primary.design_name
			this.moduleStatus.primary.design_code = data?.DesignCode.toString() ?? this.moduleStatus.primary.design_code
			this.moduleStatus.primary.redundant = !!data.IsRedundant
			this.moduleStatus.primary.emulator = !!data.IsEmulator
		}
		this.checkFeedbacks('core-state')
		this.setEngineVariableValues()
		this.checkStatus(InstanceStatus.Ok, data.State.toString(), secondary)
	}

	/**
	 * Process recieved data
	 * @param {string} response Recieved message to process
	 * @param {boolean} secondary True if message from secondary core
	 * @access private
	 */

	processResponse(response, secondary) {
		let list = []
		if (secondary) {
			list = (this.socket.buffer.sec + response).split('\x00')
			this.socket.buffer.sec = list.pop()
		} else {
			list = (this.socket.buffer.pri + response).split('\x00')
			this.socket.buffer.pri = list.pop()
		}

		let refresh = false

		list.forEach((jsonstr) => {
			const obj = JSON.parse(jsonstr)

			if (obj?.id == QRC_GET) {
				if (Array.isArray(obj?.result)) {
					obj.result.forEach((r) => this.updateControl(r))
					refresh = true
				} else if (obj.error !== undefined) {
					this.log('error', JSON.stringify(obj.error))
				}
			} else if (obj.method === 'EngineStatus') {
				this.updateEngineVariables(obj.params, secondary)
			} else if (obj.method === 'LoopPlayer.Error') {
				this.log('warn', `Loop Player Error ${JSON.stringify(obj?.params)}`)
			} else if (obj?.id == QRC_SET && typeof obj?.result === 'object') {
				if (Object.keys(obj.result).includes('Platform')) {
					this.log(
						`info`,
						`StatusGet Response from ${secondary ? this.config.hostSecondary : this.config.host}: ${JSON.stringify(obj.result)}`,
					)
					this.updateEngineVariables(obj.result, secondary)
				}
			}
		})

		if (refresh) this.checkFeedbacks()
	}

	/**
	 * Get configuration fields
	 * @returns {Array} response Recieved message to process
	 * @access public
	 * @since 1.0.0
	 */

	getConfigFields() {
		return configFields
	}

	/**
	 * Stop and delete running timers, destroy sockets
	 * @access private
	 * @since 2.3.0
	 */

	killTimersDestroySockets() {
		if (this.pollQRCTimer !== undefined) {
			clearInterval(this.pollQRCTimer)
			delete this.pollQRCTimer
		}
		if (this.keepAlive !== undefined) {
			clearInterval(this.keepAlive)
			delete this.keepAlive
		}
		if (!this.socket.pri.isDestroyed) {
			this.socket.pri.destroy()
		}
		if (!this.socket.sec.isDestroyed) {
			this.socket.sec.destroy()
		}
	}

	/**
	 * Call when module is destroyed
	 * @access public
	 * @since 1.0.0
	 */

	destroy() {
		queue.clear()
		this.debouncedStatusUpdate.cancel()
		this.debouncedVariableDefUpdate.cancel()
		this.killTimersDestroySockets()
		if (this.controls !== undefined) {
			delete this.controls
		}
	}

	/**
	 * Build command message and send
	 * @param {string} command
	 * @param {*} params
	 * @return {Promise<boolean>}
	 * @access private
	 */

	async sendCommand(command, params) {
		return await this.callCommandObj({
			method: command,
			params: params,
		})
	}

	/**
	 * Update action definitions
	 * @access private
	 */

	actions() {
		this.setActionDefinitions({
			control_set: {
				name: 'Control.Set',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name:',
						default: '',
						useVariables: { local: true },
						regex: Regex.SOMETHING,
					},
					{
						type: 'textinput',
						id: 'value',
						label: 'Value:',
						default: '',
						useVariables: { local: true },
					},
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
						isVisible: (options, isVisibleData) => {
							return (isVisibleData.feedbacks || options.relative) && options.type == 'number'
						},
						isVisibleData: { feedbacks: !!this.config.feedback_enabled },
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
						id: 'filler1',
						label: 'Warning',
						width: 6,
						value: 'Relative actions require feedbacks to be enabled!',
						isVisible: (options, isVisibleData) => {
							return !isVisibleData.feedbacks && options.relative
						},
						isVisibleData: { feedbacks: !!this.config.feedback_enabled },
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
				],
				subscribe: async (action, context) => {
					if (action.options.relative) await this.addControl(action, context)
				},
				unsubscribe: async (action, context) => await this.removeControl(action, context),
				callback: async (evt, context) => {
					const name = await context.parseVariablesInString(evt.options.name)
					if (name == '') return
					let value = await context.parseVariablesInString(evt.options.value)
					const control = this.controls.get(name)
					if (evt.options.relative && this.config.feedbacks && evt.options.type == 'number') {
						value = await calcRelativeValue(value, name, evt, context)
						if (value === undefined) return
					} else if (evt.options.relative && !this.config.feedbacks) {
						this.log('warn', `Relative ${evt.actionId} actions require Feedbacks to be enabled in the module config`)
						return
					}
					value = convertValueType(value, evt.options.type)
					if (value !== undefined) {
						const params = {
							Name: name,
							Value: value,
						}
						let ramp = Number.parseFloat(await context.parseVariablesInString(evt.options.ramp))
						if (evt.options.type == 'number' && !Number.isNaN(ramp) && ramp >= 0) params.Ramp = ramp
						const sent = await this.sendCommand('Control.Set', params)
						if (sent && control !== undefined) {
							control.value = value //If message sent immediately update control value to make subsequent relative actions more responsive
							if (this.config.feedback_enabled) this.setVariableValues({ [`${name}_value`]: control.value })
							// Follow with Control.Get to stay in sync
							await this.getControl(name)
						}
					} else {
						this.log('warn', `Invalid value (NaN) could not complete ${evt.actionId}:${evt.id}`)
					}
				},
				learn: async (evt, context) => {
					const name = await context.parseVariablesInString(evt.options.name)
					if (name == '') return undefined
					const control = this.controls.get(name)
					if (control != undefined && control.value != null) {
						let type = 'string'
						if (typeof control.value == 'boolean') type = 'boolean'
						if (typeof control.value == 'number') type = 'number'
						return {
							...evt.options,
							relative: false,
							value: control.value.toString(),
							type: type,
						}
					} else {
						await this.getControl(name)
					}
					return undefined
				},
			},
			control_toggle: {
				name: 'Control.Toggle',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name:',
						default: '',
						tooltip: 'Only applies to controls with an on/off state.',
						useVariables: { local: true },
						regex: Regex.SOMETHING,
					},
					{
						type: 'static-text',
						id: 'filler1',
						label: 'Warning',
						width: 6,
						value: 'Toggle actions require feedbacks to be enabled!',
						isVisible: (_options, isVisibleData) => {
							return !isVisibleData.feedbacks
						},
						isVisibleData: { feedbacks: !!this.config.feedback_enabled },
					},
				],
				subscribe: async (action, context) => await this.addControl(action, context),
				unsubscribe: async (action, context) => await this.removeControl(action, context),
				callback: async (evt, context) => {
					const name = await context.parseVariablesInString(evt.options.name)
					if (name == '') return
					const control = this.controls.get(name)
					if (control === undefined || control.value == null) {
						if (!this.config.feedback_enabled) {
							this.log('warn', `Control ${name} unavailable. Feedbacks must be enabled`)
						} else {
							this.log('warn', `Control ${name} unavailable. Check named control name`)
						}
						return
					}
					const sent = await this.sendCommand('Control.Set', {
						Name: name,
						Value: !control.value,
					})
					// set our internal state in anticipation of success, allowing two presses
					// of the button faster than the polling interval to correctly toggle the state
					if (sent) {
						control.value = !control.value
						if (this.config.feedback_enabled) this.setVariableValues({ [`${name}_value`]: control.value })
						// Follow with Control.Get to stay in sync
						await this.getControl(name)
					}
				},
			},
			control_get: {
				name: 'Control.Get',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name:',
						default: '',
						useVariables: { local: true },
						regex: Regex.SOMETHING,
					},
				],
				subscribe: async (action, context) => await this.addControl(action, context),
				unsubscribe: async (action, context) => await this.removeControl(action, context),
				callback: async (evt, context) => {
					const name = await context.parseVariablesInString(evt.options.name)
					if (name == '') return
					if (!this.controls.get(name)) this.addControl(evt, context)
					const cmd = {
						method: 'Control.Get',
						params: [name],
					}

					await this.callCommandObj(cmd, QRC_GET)
				},
			},
			component_set: {
				name: 'Component.Set',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name:',
						default: '',
						useVariables: { local: true },
					},
					{
						type: 'textinput',
						id: 'control_name',
						label: 'Control Name:',
						default: '',
						useVariables: { local: true },
					},
					{
						type: 'textinput',
						id: 'value',
						label: 'Value:',
						default: '',
						useVariables: { local: true },
					},
					{
						type: 'textinput',
						id: 'ramp',
						label: 'Ramp:',
						default: '',
						useVariables: { local: true },
					},
				],
				callback: async (evt, context) => {
					let ramp = Number.parseFloat(await context.parseVariablesInString(evt.options.ramp))
					if (Number.isNaN(ramp) || ramp < 0) ramp = 0
					await this.sendCommand('Component.Set', {
						Name: await context.parseVariablesInString(evt.options.name),
						Controls: [
							{
								Name: await context.parseVariablesInString(evt.options.control_name),
								Value: await context.parseVariablesInString(evt.options.value),
								Ramp: ramp,
							},
						],
					})
				},
			},
			changeGroup_addControl: {
				name: 'ChangeGroup.AddControl',
				options: [
					{
						type: 'textinput',
						id: 'id',
						label: 'Group Id:',
						default: '',
						useVariables: { local: true },
					},
					{
						type: 'textinput',
						id: 'controls',
						label: 'Controls:',
						default: '',
						useVariables: { local: true },
					},
				],
				callback: async (evt, context) => {
					await this.changeGroup(
						'AddControl',
						await context.parseVariablesInString(evt.options.id),
						await context.parseVariablesInString(evt.options.controls),
					)
				},
			},
			changeGroup_addComponentControl: {
				name: 'ChangeGroup.AddComponentControl',
				options: [
					{
						type: 'textinput',
						id: 'id',
						label: 'Group Id:',
						default: '',
						useVariables: { local: true },
					},
					{
						type: 'textinput',
						id: 'controls',
						label: 'Controls:',
						default: '',
						useVariables: { local: true },
					},
				],
				callback: async (evt, context) => {
					await this.changeGroup(
						'AddComponentControl',
						await context.parseVariablesInString(evt.options.id),
						await context.parseVariablesInString(evt.options.controls),
					)
				},
			},
			changeGroup_remove: {
				name: 'ChangeGroup.Remove',
				options: [
					{
						type: 'textinput',
						id: 'id',
						label: 'Group Id:',
						default: '',
						useVariables: { local: true },
					},
					{
						type: 'textinput',
						id: 'controls',
						label: 'Controls:',
						default: '',
						useVariables: { local: true },
					},
				],
				callback: async (evt, context) => {
					await this.changeGroup(
						'Remove',
						await context.parseVariablesInString(evt.options.id),
						await context.parseVariablesInString(evt.options.controls),
					)
				},
			},
			changeGroup_destroy: {
				name: 'ChangeGroup.Destroy',
				options: [
					{
						type: 'textinput',
						id: 'id',
						label: 'Group Id:',
						default: '',
						useVariables: { local: true },
					},
				],
				callback: async (evt, context) => {
					await this.changeGroup('Destroy', await context.parseVariablesInString(evt.options.id))
				},
			},
			changeGroup_invalidate: {
				name: 'ChangeGroup.Invalidate',
				options: [
					{
						type: 'textinput',
						id: 'id',
						label: 'Group Id:',
						default: '',
						useVariables: { local: true },
					},
				],
				callback: async (evt, context) => {
					await this.changeGroup('Invalidate', await context.parseVariablesInString(evt.options.id))
				},
			},
			changeGroup_clear: {
				name: 'ChangeGroup.Clear',
				options: [
					{
						type: 'textinput',
						id: 'id',
						label: 'Group Id:',
						default: '',
						useVariables: { local: true },
					},
				],
				callback: async (evt, context) => {
					await this.changeGroup('Clear', await context.parseVariablesInString(evt.options.id))
				},
			},
			mixer_setCrossPointGain: {
				name: 'Mixer.SetCrossPointGain',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name',
						default: '',
						useVariables: { local: true },
					},
					{
						type: 'textinput',
						id: 'inputs',
						label: 'Inputs',
						default: '1',
						useVariables: { local: true },
					},
					{
						type: 'textinput',
						id: 'outputs',
						label: 'Outputs',
						default: '1',
						useVariables: { local: true },
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
						regex: Regex.NUMBER,
					},
				],
				callback: async (evt, context) => {
					await this.sendCommand('Mixer.SetCrossPointGain', {
						Name: await context.parseVariablesInString(evt.options.name),
						Inputs: await context.parseVariablesInString(evt.options.inputs),
						Outputs: await context.parseVariablesInString(evt.options.outputs),
						Value: evt.options.value,
						Ramp: evt.options.ramp,
					})
				},
			},
			mixer_setCrossPointDelay: {
				name: 'Mixer.SetCrossPointDelay',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name',
						default: '',
						useVariables: { local: true },
					},
					{
						type: 'textinput',
						id: 'inputs',
						label: 'Inputs',
						default: '1',
						useVariables: { local: true },
					},
					{
						type: 'textinput',
						id: 'outputs',
						label: 'Outputs',
						default: '1',
						useVariables: { local: true },
					},
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
				],
				callback: async (evt, context) => {
					await this.sendCommand('Mixer.SetCrossPointDelay', {
						Name: await context.parseVariablesInString(evt.options.name),
						Inputs: await context.parseVariablesInString(evt.options.inputs),
						Outputs: await context.parseVariablesInString(evt.options.outputs),
						Value: evt.options.value,
						Ramp: evt.options.ramp,
					})
				},
			},
			mixer_setCrossPointMute: {
				name: 'Mixer.SetCrossPointMute',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name',
						default: '',
						useVariables: { local: true },
					},
					{
						type: 'textinput',
						id: 'inputs',
						label: 'Inputs',
						default: '1',
						useVariables: { local: true },
					},
					{
						type: 'textinput',
						id: 'outputs',
						label: 'Outputs',
						default: '1',
						useVariables: { local: true },
					},
					{
						type: 'dropdown',
						id: 'value',
						label: 'Value',
						default: 'true',
						choices: [
							{ id: 'true', label: 'True' },
							{ id: 'false', label: 'False' },
						],
					},
				],
				callback: async (evt, context) => {
					const value = evt.options.value === 'true'
					await this.sendCommand('Mixer.SetCrossPointMute', {
						Name: await context.parseVariablesInString(evt.options.name),
						Inputs: await context.parseVariablesInString(evt.options.inputs),
						Outputs: await context.parseVariablesInString(evt.options.outputs),
						Value: value,
					})
				},
			},
			mixer_setCrossPointSolo: {
				name: 'Mixer.SetCrossPointSolo',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name',
						default: '',
						useVariables: { local: true },
					},
					{
						type: 'textinput',
						id: 'inputs',
						label: 'Inputs',
						default: '1',
						useVariables: { local: true },
					},
					{
						type: 'textinput',
						id: 'outputs',
						label: 'Outputs',
						default: '1',
						useVariables: { local: true },
					},
					{
						type: 'dropdown',
						id: 'value',
						label: 'Value',
						default: 'true',
						choices: [
							{ id: 'true', label: 'True' },
							{ id: 'false', label: 'False' },
						],
					},
				],
				callback: async (evt, context) => {
					const value = evt.options.value === 'true'
					await this.sendCommand('Mixer.SetCrossPointSolo', {
						Name: await context.parseVariablesInString(evt.options.name),
						Inputs: await context.parseVariablesInString(evt.options.inputs),
						Outputs: await context.parseVariablesInString(evt.options.outputs),
						Value: value,
					})
				},
			},
			mixer_setInputGain: {
				name: 'Mixer.SetInputGain',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name',
						default: '',
						useVariables: { local: true },
					},
					{
						type: 'textinput',
						id: 'inputs',
						label: 'Inputs',
						default: '1',
						useVariables: { local: true },
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
						regex: Regex.NUMBER,
					},
				],
				callback: async (evt, context) => {
					await this.sendCommand('Mixer.SetInputGain', {
						Name: await context.parseVariablesInString(evt.options.name),
						Inputs: await context.parseVariablesInString(evt.options.inputs),
						Value: evt.options.value,
						Ramp: evt.options.ramp,
					})
				},
			},
			mixer_setInputMute: {
				name: 'Mixer.SetInputMute',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name',
						default: '',
						useVariables: { local: true },
					},
					{
						type: 'textinput',
						id: 'inputs',
						label: 'Inputs',
						default: '1',
						useVariables: { local: true },
					},
					{
						type: 'dropdown',
						id: 'value',
						label: 'Value',
						default: 'true',
						choices: [
							{ id: 'true', label: 'True' },
							{ id: 'false', label: 'False' },
						],
					},
				],
				callback: async (evt, context) => {
					const value = evt.options.value === 'true'
					await this.sendCommand('Mixer.SetInputMute', {
						Name: await context.parseVariablesInString(evt.options.name),
						Inputs: await context.parseVariablesInString(evt.options.inputs),
						Value: value,
					})
				},
			},
			mixer_setInputSolo: {
				name: 'Mixer.SetInputSolo',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name',
						default: '',
						useVariables: { local: true },
					},
					{
						type: 'textinput',
						id: 'inputs',
						label: 'Inputs',
						default: '1',
						useVariables: { local: true },
					},
					{
						type: 'dropdown',
						id: 'value',
						label: 'Value',
						default: 'true',
						choices: [
							{ id: 'true', label: 'True' },
							{ id: 'false', label: 'False' },
						],
					},
				],
				callback: async (evt, context) => {
					const value = evt.options.value === 'true'
					await this.sendCommand('Mixer.SetInputSolo', {
						Name: await context.parseVariablesInString(evt.options.name),
						Inputs: await context.parseVariablesInString(evt.options.inputs),
						Value: value,
					})
				},
			},
			mixer_setOutputGain: {
				name: 'Mixer.SetOutputGain',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name',
						default: '',
						useVariables: { local: true },
					},
					{
						type: 'textinput',
						id: 'outputs',
						label: 'Outputs',
						default: '1',
						useVariables: { local: true },
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
						regex: Regex.NUMBER,
					},
				],
				callback: async (evt, context) => {
					await this.sendCommand('Mixer.SetOutputGain', {
						Name: await context.parseVariablesInString(evt.options.name),
						Outputs: await context.parseVariablesInString(evt.options.outputs),
						Value: evt.options.value,
						Ramp: evt.options.ramp,
					})
				},
			},
			mixer_setOutputMute: {
				name: 'Mixer.SetOutputMute',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name',
						default: '',
						useVariables: { local: true },
					},
					{
						type: 'textinput',
						id: 'outputs',
						label: 'Outputs',
						default: '1',
						useVariables: { local: true },
					},
					{
						type: 'dropdown',
						id: 'value',
						label: 'Value',
						default: 'true',
						choices: [
							{ id: 'true', label: 'True' },
							{ id: 'false', label: 'False' },
						],
					},
				],
				callback: async (evt, context) => {
					const value = evt.options.value === 'true'
					await this.sendCommand('Mixer.SetOutputMute', {
						Name: await context.parseVariablesInString(evt.options.name),
						Outputs: await context.parseVariablesInString(evt.options.outputs),
						Value: value,
					})
				},
			},
			mixer_setCueMute: {
				name: 'Mixer.SetCueMute',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name',
						default: '',
						useVariables: { local: true },
					},
					{
						type: 'textinput',
						id: 'cues',
						label: 'Cues',
						default: '1',
						useVariables: { local: true },
					},
					{
						type: 'dropdown',
						id: 'value',
						label: 'Value',
						default: 'true',
						choices: [
							{ id: 'true', label: 'True' },
							{ id: 'false', label: 'False' },
						],
					},
				],
				callback: async (evt, context) => {
					const value = evt.options.value === 'true'
					await this.sendCommand('Mixer.SetCueMute', {
						Name: await context.parseVariablesInString(evt.options.name),
						Cues: await context.parseVariablesInString(evt.options.cues),
						Value: value,
					})
				},
			},
			mixer_setCueGain: {
				name: 'Mixer.SetCueGain',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name',
						default: '',
						useVariables: { local: true },
					},
					{
						type: 'textinput',
						id: 'cues',
						label: 'Cues',
						default: '1',
						useVariables: { local: true },
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
						regex: Regex.NUMBER,
					},
				],
				callback: async (evt, context) => {
					await this.sendCommand('Mixer.SetCueGain', {
						Name: await context.parseVariablesInString(evt.options.name),
						Cues: await context.parseVariablesInString(evt.options.cues),
						Value: evt.options.value,
						Ramp: evt.options.ramp,
					})
				},
			},
			mixer_setInputCueEnable: {
				name: 'Mixer.SetInputCueEnable',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name',
						default: '',
						useVariables: { local: true },
					},
					{
						type: 'textinput',
						id: 'cues',
						label: 'Cues',
						default: '1',
						useVariables: { local: true },
					},
					{
						type: 'textinput',
						id: 'inputs',
						label: 'Inputs',
						default: '1',
						useVariables: { local: true },
					},
					{
						type: 'dropdown',
						id: 'value',
						label: 'Value',
						default: 'true',
						choices: [
							{ id: 'true', label: 'True' },
							{ id: 'false', label: 'False' },
						],
					},
				],
				callback: async (evt, context) => {
					const value = evt.options.value === 'true'
					await this.sendCommand('Mixer.SetInputCueEnable', {
						Name: await context.parseVariablesInString(evt.options.name),
						Cues: await context.parseVariablesInString(evt.options.cues),
						Inputs: await context.parseVariablesInString(evt.options.inputs),
						Value: value,
					})
				},
			},
			mixer_setInputCueAfl: {
				name: 'Mixer.SetInputCueAfl',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name',
						default: '',
						useVariables: { local: true },
					},
					{
						type: 'textinput',
						id: 'cues',
						label: 'Cues',
						default: '1',
						useVariables: { local: true },
					},
					{
						type: 'textinput',
						id: 'inputs',
						label: 'Inputs',
						default: '1',
						useVariables: { local: true },
					},
					{
						type: 'dropdown',
						id: 'value',
						label: 'Value',
						default: 'true',
						choices: [
							{ id: 'true', label: 'True' },
							{ id: 'false', label: 'False' },
						],
					},
				],
				callback: async (evt, context) => {
					const value = evt.options.value === 'true'
					await this.sendCommand('Mixer.SetInputCueAfl', {
						Name: await context.parseVariablesInString(evt.options.name),
						Cues: await context.parseVariablesInString(evt.options.cues),
						Inputs: await context.parseVariablesInString(evt.options.inputs),
						Value: value,
					})
				},
			},
			loopPlayer_start: {
				name: 'LoopPlayer.Start',
				options: [
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
					{
						// Had to add name to the options array. Referenced in callback but not present in options def
						type: 'textinput',
						id: 'name',
						label: 'Name',
						default: '',
						useVariables: { local: true },
					},
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
							{ id: 'true', label: 'True' },
							{ id: 'false', label: 'False' },
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
				],
				callback: async (evt, context) => {
					const loop = evt.options.loop === 'true'
					const output = Number.parseInt(await context.parseVariablesInString(evt.options.output))
					let refID = await context.parseVariablesInString(evt.options.refID)
					refID = refID == '' ? `${this.label}:${evt.actionId}:${evt.id}` : refID
					if (isNaN(output)) {
						this.log(`warn`, `Output is a NaN cannot complete ${evt.actionId}:${evt.id}`)
						return
					}
					await this.sendCommand('LoopPlayer.Start', {
						Files: [
							{
								Name: await context.parseVariablesInString(evt.options.file_name),
								Mode: evt.options.mode,
								Output: output,
							},
						],
						Name: await context.parseVariablesInString(evt.options.name), // Had to add name to the options array.
						StartTime: Math.round(evt.options.startTime),
						Seek: Math.round(evt.options.seek),
						Loop: loop,
						Log: true,
						RefID: refID,
					})
				},
			},
			loopPlayer_stop: {
				name: 'LoopPlayer.Stop',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name:',
						default: '',
						useVariables: { local: true },
					},
					{
						type: 'textinput',
						id: 'output',
						label: 'Output',
						default: '1',
						useVariables: { local: true },
						tooltip: `Comma seperated list of outputs to cancel. Ie. 1, 2, 3, 4`,
					},
				],
				callback: async (evt, context) => {
					const filteredOutputs = buildFilteredOutputArray(evt, context)
					if (filteredOutputs.length > 0) {
						await this.sendCommand('LoopPlayer.Stop', {
							Name: await context.parseVariablesInString(evt.options.name),
							Outputs: filteredOutputs,
							Log: true,
						})
					}
				},
			},
			loopPlayer_cancel: {
				name: 'LoopPlayer.Cancel',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name:',
						default: '',
						useVariables: { local: true },
					},
					{
						type: 'textinput',
						id: 'output',
						label: 'Output',
						default: '1',
						useVariables: { local: true },
						tooltip: `Comma seperated list of outputs to cancel. Ie. 1, 2, 3, 4`,
					},
				],
				callback: async (evt, context) => {
					const filteredOutputs = buildFilteredOutputArray(evt, context)
					if (filteredOutputs.length > 0) {
						await this.sendCommand('LoopPlayer.Cancel', {
							Name: await context.parseVariablesInString(evt.options.name),
							Outputs: filteredOutputs,
							Log: true,
						})
					}
				},
			},
			snapshot_load: {
				name: 'Snapshot.Load',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name:',
						default: '',
						useVariables: { local: true },
					},
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
				],
				callback: async (evt, context) => {
					await this.sendCommand('Snapshot.Load', {
						Name: await context.parseVariablesInString(evt.options.name),
						Bank: Math.floor(evt.options.bank),
						Ramp: evt.options.ramp,
					})
				},
			},
			snapshot_save: {
				name: 'Snapshot.Save',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name:',
						default: '',
						useVariables: { local: true },
					},
					{
						type: 'number',
						id: 'bank',
						label: 'Bank:',
						default: 1,
						tooltip: 'Specific bank number to save to within the snapshot',
						min: 1,
					},
				],
				callback: async (evt, context) => {
					await this.sendCommand('Snapshot.Save', {
						Name: await context.parseVariablesInString(evt.options.name),
						Bank: Math.floor(evt.options.bank),
					})
				},
			},
			page_submit_message: {
				name: 'PA.PageSubmit - Message',
				options: [
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
				],
				callback: async (evt, context) => {
					await this.sendCommand('PA.PageSubmit', {
						Mode: 'message',
						Zones: (await context.parseVariablesInString(evt.options.zones)).split(',').map(Number),
						Priority: evt.options.priority,
						Preamble: await context.parseVariablesInString(evt.options.preamble),
						Message: await context.parseVariablesInString(evt.options.message),
						Start: true,
					})
				},
			},
			statusGet: {
				name: 'StatusGet',
				options: [
					{
						type: 'static-text',
						id: 'info',
						label: '',
						width: 6,
						value: 'Manually update Engine variables. Full response written to logs',
					},
				],
				callback: async (_evt, _context) => {
					await this.sendCommand('StatusGet', 0)
				},
			},
		})
	}

	/**
	 * Update feedback definitions
	 * @access private
	 */

	initFeedbacks() {
		const feedbacks = {}
		feedbacks['core-state'] = {
			name: 'Core state',
			type: 'boolean',
			defaultStyle: {
				color: colours.black,
				bgcolor: colours.green,
			},
			options: [
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
					isVisibleData: { redundant: this.config.redundant },
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
			],
			callback: async (feedback, _context) => {
				let core = this.moduleStatus.primary
				if (this.config.redundant && feedback.options.core === 'sec') {
					core = this.moduleStatus.secondary
				}
				return core.state === feedback.options.state
			},
		}
		if (!this.config.feedback_enabled) {
			this.setFeedbackDefinitions(feedbacks)
			return
		}
		feedbacks['control-string'] = {
			name: 'Change text to reflect control value',
			description: 'Will return current state of a control as a string',
			type: 'advanced',
			options: [
				{
					type: 'textinput',
					id: 'name',
					label: 'Name:',
					default: '',
					useVariables: { local: true },
				},
				{
					type: 'dropdown',
					id: 'type',
					label: 'Type',
					choices: [
						{ id: 'string', label: 'String' },
						{ id: 'value', label: 'Value' },
						{ id: 'position', label: 'Position' },
					],
					default: 'value',
				},
			],
			subscribe: async (feedback, context) => await this.addControl(feedback, context),
			unsubscribe: async (feedback, context) => await this.removeControl(feedback, context),
			callback: async (feedback, context) => {
				const control = this.controls.get(await context.parseVariablesInString(feedback.options.name))
				if (!control.value) return

				switch (feedback.options.type) {
					case 'string':
						return {
							text: control.strval,
						}
					case 'value':
						return {
							text: control.value.toString(),
						}
					case 'position':
						return {
							text: control.position.toString(),
						}
					default:
						break
				}
			},
		}
		feedbacks['control-boolean'] = {
			name: 'Feedback on boolean control value',
			type: 'boolean',
			defaultStyle: {
				color: colours.white,
				bgcolor: colours.red,
			},
			options: [
				{
					type: 'textinput',
					id: 'name',
					label: 'Name:',
					default: '',
					useVariables: { local: true },
				},
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
			],
			subscribe: async (feedback, context) => await this.addControl(feedback, context),
			unsubscribe: async (feedback, context) => await this.removeControl(feedback, context),
			callback: async (feedback, context) => {
				const opt = feedback.options
				const name = await context.parseVariablesInString(opt.name)
				const control = this.controls.get(name)
				if (control === undefined) {
					this.log('warn', `Control ${name} from ${feedback.id} not found`)
					return false
				}
				return (opt.value === 'true' && !!control.value) || (opt.value === 'false' && !control.value)
			},
		}
		feedbacks['control-threshold'] = {
			name: 'Feedback if control value at or exceeds threshold',
			type: 'boolean',
			defaultStyle: {
				color: colours.white,
				bgcolor: colours.red,
			},
			options: [
				{
					type: 'textinput',
					id: 'name',
					label: 'Name:',
					default: '',
					useVariables: { local: true },
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
			subscribe: async (feedback, context) => await this.addControl(feedback, context),
			unsubscribe: async (feedback, context) => await this.removeControl(feedback, context),
			callback: async (feedback, context) => {
				const opt = feedback.options
				const control = this.controls.get(await context.parseVariablesInString(opt.name))

				return control.value >= opt.threshold
			},
		}
		feedbacks['control-fade'] = {
			name: 'Fade color over control value range',
			description: 'Fade color over control value range',
			type: 'advanced',
			options: [
				{
					type: 'textinput',
					id: 'name',
					label: 'Name:',
					default: '',
					useVariables: { local: true },
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
					default: colours.black,
				},
				{
					type: 'colorpicker',
					label: 'High threshold color',
					id: 'high_bg',
					default: colours.red,
				},
			],
			subscribe: async (feedback, context) => await this.addControl(feedback, context),
			unsubscribe: async (feedback, context) => await this.removeControl(feedback, context),
			callback: async (feedback, context) => {
				const opt = feedback.options
				const control = this.controls.get(await context.parseVariablesInString(opt.name))
				const numToRGB = (num) => {
					return {
						r: (num & 0xff0000) >> 16,
						g: (num & 0x00ff00) >> 8,
						b: num & 0x0000ff,
					}
				}

				if (control.value > opt.high_threshold || control.value < opt.low_threshold) {
					return
				}

				const range = opt.high_threshold - opt.low_threshold
				const ratio = (control.value - opt.low_threshold) / range

				const hi_rgb = numToRGB(opt.high_bg)
				const lo_rgb = numToRGB(opt.low_bg)

				const r = Math.round((hi_rgb.r - lo_rgb.r) * ratio) + lo_rgb.r
				const g = Math.round((hi_rgb.g - lo_rgb.g) * ratio) + lo_rgb.g
				const b = Math.round((hi_rgb.b - lo_rgb.b) * ratio) + lo_rgb.b

				return {
					bgcolor: combineRgb(r, g, b),
				}
			},
		}

		this.setFeedbackDefinitions(feedbacks)
	}

	/**
	 * Check if the core is active
	 * @param {boolean} secondary If you are asking if the Secondary core is Active
	 * @access private
	 */

	isCoreActive(secondary = false) {
		if (secondary) {
			return this.moduleStatus.secondary.state == 'Active'
		}
		return this.moduleStatus.primary.state == 'Active'
	}

	/**
	 * Check if socket is ok to send data
	 * @param {boolean} secondary If you are asking if the Secondary core is Active
	 * @access private
	 */

	isSocketOkToSend(secondary = false) {
		if (secondary) {
			return this.socket.sec && !this.socket.sec.isDestroyed && this.socket.sec.isConnected
		}
		return this.socket.pri && !this.socket.pri.isDestroyed && this.socket.pri.isConnected
	}

	/**
	 * Log message send result
	 * @param {boolean} sent return from socket.send
	 * @param {object} cmd Command object sent
	 * @param {string} host Host message was sent to
	 * @access private

	 */

	logSentMessage(sent, cmd, host = this.config.host) {
		if (sent) {
			if (this.console_debug) {
				console.log(`Q-SYS Sent to ${host}: ` + JSON.stringify(cmd) + '\r')
			}
		} else {
			this.log('warn', `Q-SYS Send to ${host} Failed: ` + JSON.stringify(cmd) + '\r')
		}
	}

	/**
	 * Add message to outbound queue and send
	 * @param {object} cmd Command object to send
	 * @param {QRC_GET | QRC_SET} get_set Get or Set method
	 * @return {Promise<boolean>}
	 * @access private
	 */

	async callCommandObj(cmd, get_set = QRC_SET) {
		cmd.jsonrpc = 2.0
		cmd.id = get_set
		return await queue
			.add(async () => {
				let sentPri = false
				let sentSec = false
				if (this.isCoreActive() || validMethodsToStandbyCore(cmd)) {
					if (this.isSocketOkToSend()) {
						sentPri = await this.socket.pri.send(JSON.stringify(cmd) + '\x00')
						this.logSentMessage(sentPri, cmd)
					} else {
						this.log(
							'warn',
							`Q-SYS Send to ${this.config.host} Failed as not connected. Message: ` + JSON.stringify(cmd),
						)
					}
				}

				if (this.config.redundant) {
					if (this.isCoreActive(true) || validMethodsToStandbyCore(cmd)) {
						if (this.isSocketOkToSend(true)) {
							sentSec = await this.socket.sec.send(JSON.stringify(cmd) + '\x00')
							this.logSentMessage(sentSec, cmd, this.config.hostSecondary)
						} else {
							this.log(
								'warn',
								`Q-SYS Send to ${this.config.hostSecondary} Failed as not connected. Message: ` + JSON.stringify(cmd),
							)
						}
					}
				}
				return sentPri || sentSec
			})
			.catch(() => {
				return false
			})
	}

	/**
	 * Call changeGroup command
	 * @param {string} type Type of Change Group command
	 * @param {string} id Change Group ID
	 * @param {string | null} controls
	 * @access private
	 */

	async changeGroup(type, id, controls = null) {
		const obj = {
			method: 'ChangeGroup.' + type,
			params: {
				Id: id,
			},
		}
		if (controls !== null) {
			obj.params.Controls = [controls]
		}
		await this.callCommandObj(obj)
	}

	/**
	 * Get named control value
	 * @param {string | string[]} name
	 * @returns {Promise<boolean>} True if message send was successful
	 * @access private
	 */

	async getControl(name) {
		const cmd = {
			method: 'Control.Get',
			params: Array.isArray(name) ? name : [name],
		}

		return await this.callCommandObj(cmd, QRC_GET)
	}

	/**
	 * Query values of controls in this.controls
	 * @access private
	 */

	async getControlStatuses() {
		// It is possible to group multiple statuses; HOWEVER, if one doesn't exist, nothing will be returned...
		// thus, we send one at a time
		if (!('bundle_feedbacks' in this.config) || !this.config.bundle_feedbacks) {
			this.controls.forEach(async (_x, k) => {
				await this.getControl(k)
			})
		} else {
			await this.getControl(this.controls.keys())
		}
	}

	/**
	 * Initialise polling timer
	 * @access private
	 */

	initPolling() {
		if (!this.config.feedback_enabled) return

		if (this.pollQRCTimer === undefined) {
			this.pollQRCTimer = setInterval(async () => {
				await this.getControlStatuses().catch(() => {})
			}, parseInt(this.config.poll_interval))
		}
	}

	/**
	 * Update the variable definitions
	 */

	debouncedVariableDefUpdate = debounce(
		async () => {
			this.setVariableDefinitions(this.variables)
			this.setEngineVariableValues()
			if (this.namesToGet.size > 0) {
				if (!('bundle_feedbacks' in this.config) || !this.config.bundle_feedbacks) {
					this.namesToGet.forEach(async (_x, k) => {
						await this.getControl(k)
					})
				} else {
					await this.getControl(this.namesToGet.keys())
				}
				this.namesToGet = new Set()
			}
		},
		1000,
		{ leading: false, maxWait: 5000, trailing: true },
	)

	/**
	 * @param {CompanionFeedbackInfo} feedback
	 * @param {CompanionFeedbackContext} context
	 * @access private
	 */

	async addControl(feedback, context = this) {
		const name = await context.parseVariablesInString(feedback['options']['name'])

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
				strval: '',
			})

			this.variables.push(
				{
					name: `${name} Value`,
					variableId: `${sanitiseVariableId(name)}_value`,
				},
				{
					name: `${name} Position`,
					variableId: `${sanitiseVariableId(name)}_position`,
				},
				{
					name: `${name} String`,
					variableId: `${sanitiseVariableId(name)}_string`,
				},
			)
			this.namesToGet.add(name)
			this.debouncedVariableDefUpdate()
		}
	}

	/**
	 * @param {CompanionFeedbackInfo} feedback
	 * @param {CompanionFeedbackContext | InstanceBase} context
	 * @access private
	 */

	async removeControl(feedback, context = this) {
		const name = await context.parseVariablesInString(feedback['options']['name'])

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
	/**
	 * Updates a controls variable values
	 * @param {object} update
	 * @access private
	 */

	updateControl(update) {
		if (update.Name === undefined || update.Name === null) return
		const name = sanitiseVariableId(update.Name)
		const control = this.controls.get(update.Name) ?? { value: null, strval: '', position: null, ids: new Set() }

		control.value = update.Value ?? control.value
		control.strval = update.String ?? control.strval
		control.position = update.Position ?? control.position
		this.controls.set(update.Name, control)
		this.setVariableValues({
			[`${name}_string`]: control.strval,
			[`${name}_position`]: control.position,
			[`${name}_value`]: control.value,
		})
	}
}

runEntrypoint(QsysRemoteControl, UpgradeScripts)
