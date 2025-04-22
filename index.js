import UpgradeScripts from './upgrades.js'

import {
	InstanceBase,
	combineRgb,
	runEntrypoint,
	TCPHelper,
	InstanceStatus,
	// eslint-disable-next-line no-unused-vars
	CompanionActionInfo,
	// eslint-disable-next-line no-unused-vars
	CompanionActionContext,
	// eslint-disable-next-line no-unused-vars
	CompanionFeedbackInfo,
	// eslint-disable-next-line no-unused-vars
	CompanionFeedbackContext,
} from '@companion-module/base'
import { configFields } from './config.js'
import { options } from './options.js'
import {
	buildFilteredOutputArray,
	calcRelativeValue,
	convertValueType,
	isCoreActive,
	isSocketOkToSend,
	namesArray,
	resetModuleStatus,
	sanitiseVariableId,
	validMethodsToStandbyCore,
} from './utils.js'
import { debounce, throttle } from 'lodash'
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
		this.feedbackIdsToCheck = new Set()
		this.changeGroupSet = false
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
		this.killTimersDestroySockets()
		this.moduleStatus = resetModuleStatus()
		this.config = config
		this.console_debug = config.verbose
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
			this.checkKeepAlive()
		}
		const endEvent = () => {
			this.checkStatus(InstanceStatus.Disconnected, `Connection to ${host} ended`, secondary)
			this.log('warn', `Connection to ${host} ended`)
			this.checkKeepAlive()
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
			this.checkKeepAlive()
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
			if (
				this.changeGroupSet &&
				(this.moduleStatus.status == InstanceStatus.Ok || this.moduleStatus.status == InstanceStatus.UnknownWarning)
			)
				this.resetChangeGroup()
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

	checkKeepAlive() {
		if (this.socket.pri.isConnected || this.socket.sec.isConnected) {
			if (this.keepAlive === undefined) {
				this.keepAlive = setInterval(async () => {
					await this.sendCommand('NoOp', {})
				}, 1000)
			}
		} else {
			if (this.keepAlive) {
				clearInterval(this.keepAlive)
				delete this.keepAlive
			}
		}
	}

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

		//let refresh = false

		list.forEach((jsonstr) => {
			const obj = JSON.parse(jsonstr)

			if (obj?.id == QRC_GET) {
				// Response from Control.Get
				if (Array.isArray(obj?.result)) {
					obj.result.forEach((r) => this.updateControl(r))
					//refresh = true
				} else if (Array.isArray(obj?.result?.Changes)) {
					// Response from ChangeGroup.Poll
					obj.result.Changes.forEach((r) => {
						if (r.Component === undefined) this.updateControl(r) // Dont track Component values
					})
					//refresh = true
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

		//if (refresh) this.checkFeedbacks()
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
		queue.clear()
		this.debouncedStatusUpdate.cancel()
		this.debouncedVariableDefUpdate.cancel()
		this.throttledFeedbackIdCheck.cancel()
		this.controls.clear()
		this.namesToGet.clear()
		this.feedbackIdsToCheck.clear()
		this.changeGroupSet = false
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
				options: options.actions.controlSet(this.config),
				subscribe: async (action, context) => {
					if (action.options.relative) await this.addControl(action, context)
				},
				unsubscribe: async (action, context) => await this.removeControl(action, context),
				callback: async (evt, context) => {
					const name = (await context.parseVariablesInString(evt.options.name)).trim()
					if (name == '') return
					let value = await context.parseVariablesInString(evt.options.value)
					const control = this.controls.get(name)
					if (evt.options.relative && this.config.feedback_enabled && evt.options.type == 'number') {
						value = await calcRelativeValue(value, name, evt, context, this.controls, this)
						if (value === undefined) {
							await this.addControl(evt, context)
							return
						}
					} else if (evt.options.relative && !this.config.feedback_enabled) {
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
					const name = (await context.parseVariablesInString(evt.options.name)).trim()
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
				options: options.actions.controlToggle(this.config),
				subscribe: async (action, context) => await this.addControl(action, context),
				unsubscribe: async (action, context) => await this.removeControl(action, context),
				callback: async (evt, context) => {
					const name = (await context.parseVariablesInString(evt.options.name)).trim()
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
				options: options.actions.controlGet(),
				subscribe: async (action, context) => await this.addControls(action, context),
				unsubscribe: async (action, context) => await this.removeControls(action, context),
				callback: async (evt, context) => {
					const names = await namesArray(evt, context)
					if (names.length == 0) return
					names.forEach(async (name) => {
						if (!this.controls.has(name)) {
							evt.options.name = name
							await this.addControl(evt, context)
						}
					})
					await this.getControl(names)
				},
			},
			component_set: {
				name: 'Component.Set',
				options: options.actions.componentSet(),
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
				options: options.actions.changeGroup_addControl(),
				callback: async (evt, context) => {
					await this.changeGroup(
						'AddControl',
						await context.parseVariablesInString(evt.options.id),
						(await context.parseVariablesInString(evt.options.controls)).split(','),
					)
				},
			},
			/* changeGroup_addComponentControl: {
				name: 'ChangeGroup.AddComponentControl',
				options: options.actions.changeGroup_addComponentControl(),
				callback: async (evt, context) => {
					// This probably wont work.
					await this.changeGroup(
						'AddComponentControl',
						await context.parseVariablesInString(evt.options.id),
						await context.parseVariablesInString(evt.options.controls),
					)
				},
			}, */
			changeGroup_remove: {
				name: 'ChangeGroup.Remove',
				options: options.actions.changeGroup_remove(),
				callback: async (evt, context) => {
					await this.changeGroup(
						'Remove',
						await context.parseVariablesInString(evt.options.id),
						(await context.parseVariablesInString(evt.options.controls)).split(','),
					)
				},
			},
			changeGroup_destroy: {
				name: 'ChangeGroup.Destroy',
				options: options.actions.changeGroup_destroy(),
				callback: async (evt, context) => {
					await this.changeGroup('Destroy', await context.parseVariablesInString(evt.options.id))
				},
			},
			changeGroup_poll: {
				name: 'ChangeGroup.Poll',
				options: options.actions.changeGroup_poll(),
				callback: async (evt, context) => {
					await this.changeGroup('Poll', await context.parseVariablesInString(evt.options.id))
				},
			},
			changeGroup_invalidate: {
				name: 'ChangeGroup.Invalidate',
				options: options.actions.changeGroup_invalidate(),
				callback: async (evt, context) => {
					await this.changeGroup('Invalidate', await context.parseVariablesInString(evt.options.id))
				},
			},
			changeGroup_clear: {
				name: 'ChangeGroup.Clear',
				options: options.actions.changeGroup_clear(),
				callback: async (evt, context) => {
					await this.changeGroup('Clear', await context.parseVariablesInString(evt.options.id))
				},
			},
			mixer_setCrossPointGain: {
				name: 'Mixer.SetCrossPointGain',
				options: options.actions.mixer_setCrossPointGain(),
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
				options: options.actions.mixer_setCrossPointDelay(),
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
				options: options.actions.mixer_setCrossPointMute(),
				callback: async (evt, context) => {
					await this.sendCommand('Mixer.SetCrossPointMute', {
						Name: await context.parseVariablesInString(evt.options.name),
						Inputs: await context.parseVariablesInString(evt.options.inputs),
						Outputs: await context.parseVariablesInString(evt.options.outputs),
						Value: evt.options.value,
					})
				},
			},
			mixer_setCrossPointSolo: {
				name: 'Mixer.SetCrossPointSolo',
				options: options.actions.mixer_setCrossPointSolo(),
				callback: async (evt, context) => {
					await this.sendCommand('Mixer.SetCrossPointSolo', {
						Name: await context.parseVariablesInString(evt.options.name),
						Inputs: await context.parseVariablesInString(evt.options.inputs),
						Outputs: await context.parseVariablesInString(evt.options.outputs),
						Value: evt.options.value,
					})
				},
			},
			mixer_setInputGain: {
				name: 'Mixer.SetInputGain',
				options: options.actions.mixer_setInputGain(),
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
				options: options.actions.mixer_setInputMute(),
				callback: async (evt, context) => {
					await this.sendCommand('Mixer.SetInputMute', {
						Name: await context.parseVariablesInString(evt.options.name),
						Inputs: await context.parseVariablesInString(evt.options.inputs),
						Value: evt.options.value,
					})
				},
			},
			mixer_setInputSolo: {
				name: 'Mixer.SetInputSolo',
				options: options.actions.mixer_setInputSolo(),
				callback: async (evt, context) => {
					await this.sendCommand('Mixer.SetInputSolo', {
						Name: await context.parseVariablesInString(evt.options.name),
						Inputs: await context.parseVariablesInString(evt.options.inputs),
						Value: evt.options.value,
					})
				},
			},
			mixer_setOutputGain: {
				name: 'Mixer.SetOutputGain',
				options: options.actions.mixer_setOutputGain(),
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
				options: options.actions.mixer_setOutputMute(),
				callback: async (evt, context) => {
					await this.sendCommand('Mixer.SetOutputMute', {
						Name: await context.parseVariablesInString(evt.options.name),
						Outputs: await context.parseVariablesInString(evt.options.outputs),
						Value: evt.options.value,
					})
				},
			},
			mixer_setCueMute: {
				name: 'Mixer.SetCueMute',
				options: options.actions.mixer_setCueMute(),
				callback: async (evt, context) => {
					await this.sendCommand('Mixer.SetCueMute', {
						Name: await context.parseVariablesInString(evt.options.name),
						Cues: await context.parseVariablesInString(evt.options.cues),
						Value: evt.options.value,
					})
				},
			},
			mixer_setCueGain: {
				name: 'Mixer.SetCueGain',
				options: options.actions.mixer_setCueGain(),
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
				options: options.actions.mixer_setInputCueEnable(),
				callback: async (evt, context) => {
					await this.sendCommand('Mixer.SetInputCueEnable', {
						Name: await context.parseVariablesInString(evt.options.name),
						Cues: await context.parseVariablesInString(evt.options.cues),
						Inputs: await context.parseVariablesInString(evt.options.inputs),
						Value: evt.options.value,
					})
				},
			},
			mixer_setInputCueAfl: {
				name: 'Mixer.SetInputCueAfl',
				options: options.actions.mixer_setInputCueAfl(),
				callback: async (evt, context) => {
					await this.sendCommand('Mixer.SetInputCueAfl', {
						Name: await context.parseVariablesInString(evt.options.name),
						Cues: await context.parseVariablesInString(evt.options.cues),
						Inputs: await context.parseVariablesInString(evt.options.inputs),
						Value: evt.options.value,
					})
				},
			},
			loopPlayer_start: {
				name: 'LoopPlayer.Start',
				options: options.actions.loopPlayer_start(),
				callback: async (evt, context) => {
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
						Loop: evt.options.loop,
						Log: true,
						RefID: refID,
					})
				},
			},
			loopPlayer_stop: {
				name: 'LoopPlayer.Stop',
				options: options.actions.loopPlayer_stop(),
				callback: async (evt, context) => {
					const filteredOutputs = await buildFilteredOutputArray(evt, context, this)
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
				options: options.actions.loopPlayer_cancel(),
				callback: async (evt, context) => {
					const filteredOutputs = await buildFilteredOutputArray(evt, context, this)
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
				options: options.actions.snapshot_load(),
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
				options: options.actions.snapshot_save(),
				callback: async (evt, context) => {
					await this.sendCommand('Snapshot.Save', {
						Name: await context.parseVariablesInString(evt.options.name),
						Bank: Math.floor(evt.options.bank),
					})
				},
			},
			page_submit_message: {
				name: 'PA.PageSubmit - Message',
				options: options.actions.page_submit_message(),
				callback: async (evt, context) => {
					evt.options.output = evt.options.zones
					const zones = await buildFilteredOutputArray(evt, context, this)
					await this.sendCommand('PA.PageSubmit', {
						Mode: 'message',
						Zones: zones,
						Priority: evt.options.priority,
						Preamble: await context.parseVariablesInString(evt.options.preamble),
						Message: await context.parseVariablesInString(evt.options.message),
						Start: true,
					})
				},
			},
			statusGet: {
				name: 'StatusGet',
				options: options.actions.statusGet(),
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
			options: options.feedbacks.coreState(this.config.redundant),
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
			description: 'Depreciated',
			type: 'boolean',
			options: options.feedbacks.controlString(),
			//subscribe: async (feedback, context) => await this.addControl(feedback, context),
			//unsubscribe: async (feedback, context) => await this.removeControl(feedback, context),
			callback: async (feedback, _context) => {
				this.log('warn'), `Feedback ${feedback.feedbackId}:${feedback.id} has been depreciated, use variables instead.`
			},
		}
		feedbacks['control-boolean'] = {
			name: 'Feedback on boolean control value',
			type: 'boolean',
			defaultStyle: {
				color: colours.white,
				bgcolor: colours.red,
			},
			options: options.feedbacks.controlBoolean(),
			subscribe: async (feedback, context) => await this.addControl(feedback, context),
			unsubscribe: async (feedback, context) => await this.removeControl(feedback, context),
			callback: async (feedback, context) => {
				const opt = feedback.options
				const name = await context.parseVariablesInString(opt.name)
				const control = this.controls.get(name)
				if (control === undefined) {
					this.log('warn', `Control ${name} from ${feedback.id} not found`)
					await this.addControl(feedback, context)
					return false
				} else {
					if (!control.feedbackIds.has(feedback.id)) control.feedbackIds.add(feedback.id)
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
			options: options.feedbacks.controlThreshold(),
			subscribe: async (feedback, context) => await this.addControl(feedback, context),
			unsubscribe: async (feedback, context) => await this.removeControl(feedback, context),
			callback: async (feedback, context) => {
				const opt = feedback.options
				const name = await context.parseVariablesInString(opt.name)
				const control = this.controls.get(name)
				if (control === undefined) {
					this.log('warn', `Control ${name} from ${feedback.id} not found`)
					await this.addControl(feedback, context)
					return false
				} else {
					if (!control.feedbackIds.has(feedback.id)) control.feedbackIds.add(feedback.id)
				}
				return control.value >= opt.threshold
			},
		}
		feedbacks['control-fade'] = {
			name: 'Fade color over control value range',
			description: 'Fade color over control value range',
			type: 'advanced',
			options: options.feedbacks.controlFade(colours),
			subscribe: async (feedback, context) => await this.addControl(feedback, context),
			unsubscribe: async (feedback, context) => await this.removeControl(feedback, context),
			callback: async (feedback, context) => {
				const opt = feedback.options
				const name = await context.parseVariablesInString(opt.name)
				const control = this.controls.get(name)
				if (control === undefined) {
					this.log('warn', `Control ${name} from ${feedback.id} not found`)
					await this.addControl(feedback, context)
					return false
				} else {
					if (!control.feedbackIds.has(feedback.id)) control.feedbackIds.add(feedback.id)
				}
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
	 * @param {QRC_GET | QRC_SET} get_set Get or Set method, defaults to Set (2)
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
				if (isCoreActive(this.moduleStatus.primary) || validMethodsToStandbyCore(cmd)) {
					if (isSocketOkToSend(this.socket.pri)) {
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
					if (isCoreActive(this.moduleStatus.secondary) || validMethodsToStandbyCore(cmd)) {
						if (isSocketOkToSend(this.socket.sec)) {
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
	 * @param {string | string[] | MapIterator<string> | SetIterator<string> | null} controls Control names to add or remove
	 * @param {number} rate Autopoll interval (mS)
	 * @access private
	 */

	async changeGroup(type, id, controls = null, rate = 1000) {
		const obj = {
			method: 'ChangeGroup.' + type,
			params: {
				Id: id,
			},
		}
		if (controls !== null) {
			obj.params.Controls = typeof controls == 'object' ? [...controls] : [controls]
		}
		if (type == 'AutoPoll') {
			obj.params.Rate = Number(rate / 1000)
		}
		const getSet = type == 'Poll' || type == 'AutoPoll' ? QRC_GET : QRC_SET
		await this.callCommandObj(obj, getSet)
	}

	/**
	 * Get named control value
	 * @param {string | MapIterator<string> | SetIterator<string> | string[]} name
	 * @returns {Promise<boolean>} True if message send was successful
	 * @access private
	 */

	async getControl(name) {
		const cmd = {
			method: 'Control.Get',
			params: typeof name == 'object' ? [...name] : [name],
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
			this.controls.forEach(async (_value, key) => {
				await this.getControl(key)
			})
		} else {
			if (this.controlGroupSet) {
				await this.changeGroup('Poll', this.id)
			} else {
				//Directly get controls if we havent setup the changeGroup yet
				await this.getControl(this.controls.keys())
			}
		}
	}

	/**
	 * Initialise polling timer
	 * @access private
	 */

	initPolling() {
		if (!this.config.feedback_enabled) return
		if (this.pollQRCTimer) {
			clearInterval(this.pollQRCTimer)
			delete this.pollQRCTimer
		}
		this.pollQRCTimer = setInterval(async () => {
			await this.getControlStatuses().catch(() => {})
		}, Math.floor(this.config.poll_interval))
	}
	/**
	 * Reinit default change group, and get all controls
	 * @access private
	 */

	resetChangeGroup = debounce(
		async () => {
			await this.changeGroup('Destroy', this.id)
			await this.getControl(this.controls.keys())
			await this.changeGroup('AddControl', this.id, this.controls.keys())
		},
		1000,
		{ leading: false, maxWait: 5000, trailing: true },
	)

	/**
	 * Update the variable definitions
	 * @access private
	 */

	debouncedVariableDefUpdate = debounce(
		async () => {
			this.setVariableDefinitions(this.variables)
			this.setEngineVariableValues()
			if (this.namesToGet.size > 0) {
				if (!('bundle_feedbacks' in this.config) || !this.config.bundle_feedbacks) {
					this.namesToGet.forEach(async (_x, k) => {
						await this.getControl(k)
						await this.changeGroup('AddControl', this.id, k)
					})
				} else {
					await this.getControl(this.namesToGet.keys())
					await this.changeGroup('AddControl', this.id, this.namesToGet.keys())
				}
				this.changeGroupSet = true
				this.namesToGet.clear()
			}
		},
		1000,
		{ leading: false, maxWait: 5000, trailing: true },
	)

	/**
	 * Call addControl for each element in a comma seperated list of control names
	 * @param {CompanionActionInfo} action
	 * @param {CompanionActionContext | InstanceBase} context
	 * @access private
	 */

	async addControls(action, context = this) {
		const names = await namesArray(action, context)
		names.forEach(async (name) => {
			action.options.name = name
			await this.addControl(action, context)
		})
	}

	/**
	 * @param {CompanionActionInfo |CompanionFeedbackInfo} feedback
	 * @param {CompanionActionContext | CompanionFeedbackContext} context
	 * @access private
	 */

	async addControl(feedback, context = this) {
		const name = (await context.parseVariablesInString(feedback['options']['name'])).trim()
		if (name == '') return
		if (this.controls.has(name)) {
			const control = this.controls.get(name)
			if (control.actionIds === undefined) {
				control.actionIds = new Set()
			}
			if (control.feedbackIds === undefined) {
				control.feedbackIds = new Set()
			}
			if (feedback.feedbackId !== undefined) {
				control.feedbackIds.add(feedback.id)
			} else {
				control.actionIds.add(feedback.id)
			}
		} else {
			this.controls.set(name, {
				actionIds: new Set(feedback.feedbackId !== undefined ? [] : [feedback.id]),
				feedbackIds: new Set(feedback.feedbackId !== undefined ? [feedback.id] : []),
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
	 * Call removeControl for each element in a comma seperated list of control names
	 * @param {CompanionActionInfo} action
	 * @param {CompanionActionContext | InstanceBase} context
	 * @access private
	 */

	async removeControls(action, context = this) {
		const names = await namesArray(action, context)
		names.forEach(async (name) => {
			action.options.name = name
			await this.removeControl(action, context)
		})
	}

	/**
	 * @param {CompanionActionInfo | CompanionFeedbackInfo} feedback
	 * @param {CompanionActionContext | CompanionFeedbackContext | InstanceBase} context
	 * @access private
	 */

	async removeControl(feedback, context = this) {
		const name = (await context.parseVariablesInString(feedback['options']['name'])).trim()

		if (this.controls.has(name)) {
			const control = this.controls.get(name)
			if (feedback.feedbackId !== undefined) {
				control.feedbackIds.delete(feedback.id)
			} else {
				control.actionIds.delete(feedback.id)
			}

			if (control.actionIds.size == 0 && control.feedbackIds.size == 0) {
				this.controls.delete(name)
				if (this.namesToGet.has(name)) this.namesToGet.delete(name)
				await this.changeGroup('Remove', this.id, name)
			}
		}
	}

	/**
	 * Throttled Feedback checks
	 */

	throttledFeedbackIdCheck = throttle(
		() => {
			this.checkFeedbacksById(...this.feedbackIdsToCheck)
			this.feedbackIdsToCheck.clear()
		},
		5,
		{ leading: false, trailing: true },
	)

	/**
	 * Updates a controls variable values
	 * @param {object} update
	 * @access private
	 */

	updateControl(update) {
		if (update.Name === undefined || update.Name === null) return
		const name = sanitiseVariableId(update.Name)
		const control = this.controls.get(update.Name) ?? {
			value: null,
			strval: '',
			position: null,
			actionIds: new Set(),
			feedbackIds: new Set(),
		}

		control.value = update.Value ?? control.value
		control.strval = update.String ?? control.strval
		control.position = update.Position ?? control.position
		this.controls.set(update.Name, control)
		this.setVariableValues({
			[`${name}_string`]: control.strval,
			[`${name}_position`]: control.position,
			[`${name}_value`]: control.value,
		})
		if (control.feedbackIds.size > 0) {
			control.feedbackIds.forEach((id) => this.feedbackIdsToCheck.add(id))
			this.throttledFeedbackIdCheck()
		}
	}
}

runEntrypoint(QsysRemoteControl, UpgradeScripts)
