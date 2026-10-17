import UpgradeScripts from './upgrades.js'

export { UpgradeScripts }

import { InstanceBase, InstanceStatus, TCPHelper, combineRgb } from '@companion-module/base'
import { configFields } from './config.js'
import { options } from './options.js'
import {
	buildFilteredOutputArray,
	imageResult,
	calcRelativeValue,
	convertValueType,
	isCoreActive,
	isSocketOkToSend,
	namesArray,
	resetModuleStatus,
	sanitiseVariableId,
	validMethodsToStandbyCore,
	valueToPercent,
	variableDefinitions,
} from './utils.js'
import { debounce, throttle } from 'es-toolkit'
import PQueue from 'p-queue'
import { graphics } from 'companion-module-utils'
import { UpdateCompositeElements } from './composites.js'

const QRC_GET = 1
const QRC_SET = 2
const QRC_LOGIN = 3

const KA_INTERVAL = 5000 //Interval on which to send NoOp keepalives

const colours = {
	black: combineRgb(0, 0, 0),
	white: combineRgb(255, 255, 255),
	red: combineRgb(255, 0, 0),
	green: combineRgb(0, 204, 0),
	greenBright: combineRgb(0, 255, 0),
	yellow: combineRgb(255, 255, 0),
}

export default class QsysRemoteControl extends InstanceBase {
	// Declared before the debounces and throttles, which take its signal when they are created.
	// Aborted only on destroy: an aborted signal disables them for good
	#controller = new AbortController()
	#queue = new PQueue({ concurrency: 1 })
	config = {
		host: '',
		port: '1710',
		redundant: false,
		verbose: false,
		hostSecondary: '',
		portSecondary: '1710',
		user: '',
		variables: '',
		poll_interval: 1000,
	}
	secrets = { pass: '' }
	pollQRCTimer = undefined
	variables = []
	moduleStatus = resetModuleStatus()
	controls = new Map()
	namesToGet = new Set()
	feedbackIdsToCheck = new Set()
	variablesToUpdate = new Map()
	feedbackControlMap = new Map()
	changeGroupSet = false
	isRecordingActions = false
	socket = {
		pri: new TCPHelper('localhost', 1710),
		sec: new TCPHelper('localhost', 1710),
		buffer: { pri: '', sec: '' },
	}
	constructor(internal) {
		super(internal)
		this.socket.pri.destroy()
		this.socket.sec.destroy()
	}

	/**
	 * Debug logging utility function
	 * @param {string | object} msg
	 * @access private
	 * @since 3.1.1
	 */

	debug(msg) {
		if (this.config?.verbose) {
			if (typeof msg == 'object') msg = JSON.stringify(msg)
			this.log('debug', `${msg}`)
		}
	}

	/**
	 * Main initialization when it's ok to login
	 * @param {Object} config New configuration
	 * @param {boolean} _isFirstInit True if first init after module is loaded
	 * @param {Object} secrets New secrets
	 * @access public
	 * @since 1.0.0
	 */

	async init(config, _isFirstInit, secrets) {
		this.config = config
		this.secrets = secrets
		this.debug(`init\nConfig: ${JSON.stringify(config)}`)
		this.actions()
		await this.configUpdated(config, secrets)
	}

	/**
	 * Process configuration updates
	 * @param {Object} config New configuration
	 * @param {Object} secrets New secrets
	 * @access public
	 * @since 1.0.0
	 */

	async configUpdated(config, secrets) {
		this.config = config
		this.secrets = secrets
		this.debug(`configUpdated\nConfig: ${JSON.stringify(config)}`)
		this.killTimersDestroySockets()
		this.moduleStatus = resetModuleStatus()
		await this.initVariables(config.redundant)
		this.actions()
		this.initFeedbacks()
		UpdateCompositeElements(this)
		this.checkAllFeedbacks() // Runs every feedback callback, which registers its control

		this.init_tcp(config.host, config.port)
		if (config.redundant) {
			this.init_tcp(config.hostSecondary, config.portSecondary, true)
		}
		this.initPolling()
	}

	/**
	 * Initialise module variables
	 * @param {boolean} redundant
	 * @access private
	 */

	async initVariables(redundant) {
		this.debug(`initVariables`)
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

		if (!('variables' in this.config) || this.config.variables === '') {
			this.setVariableDefinitions(variableDefinitions(this.variables)) // This gets called in addControls if there are vars
			return
		}
		for (const v of this.config.variables.split(',')) {
			this.addControl({
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
		this.debug(`init_tcp for ${!secondary ? 'Primary' : 'Secondary'} \nHost: ${host} Port: ${port}`)
		const errorEvent = (err) => {
			this.checkStatus(InstanceStatus.ConnectionFailure, '', secondary)
			this.log('error', `Network error from ${host}: ${err.message}`)
			if (!this.config.redundant) this.#queue.clear()
			this.checkKeepAlive()
		}
		const endEvent = () => {
			this.checkStatus(InstanceStatus.Disconnected, `Connection to ${host} ended`, secondary)
			this.log('warn', `Connection to ${host} ended`)
			if (!this.config.redundant) this.#queue.clear()
			this.checkKeepAlive()
		}
		const connectEvent = async () => {
			if (secondary) {
				this.socket.buffer.sec = ''
			} else {
				this.socket.buffer.pri = ''
			}

			// A new connection has no change group
			this.changeGroupSet = false

			this.debug(`Q-SYS Connected to ${host}:${port}`)

			await this.login()

			await this.sendCommand('StatusGet', 0)

			// The connection can end while these wait in the queue, which then drops them. Carrying on would mark it Ok
			if (!isSocketOkToSend(socket)) return

			this.checkStatus(InstanceStatus.Ok, '', secondary)

			this.checkAllFeedbacks()
			//await this.initVariables()
			this.checkKeepAlive()

			// Rebuild on every connect, rather than depend on the status hook, which only fires when the overall status changes
			this.resetChangeGroup()
		}
		const dataEvent = (d) => {
			const response = d.toString()

			this.debug(`Message recieved from ${host}: ${response}`)

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
			this.socket.sec.removeAllListeners()
			this.socket.sec = new TCPHelper(host, port)
			socket = this.socket.sec
		} else {
			if (!this.socket.pri.isDestroyed) this.socket.pri.destroy()
			this.socket.pri.removeAllListeners()
			this.socket.pri = new TCPHelper(host, port)
			socket = this.socket.pri
		}

		socket.on('error', errorEvent)
		socket.on('end', endEvent)
		socket.on('connect', connectEvent)
		socket.on('data', dataEvent)
	}

	/**
	 * Logon to core if credentials provided
	 * @param {string} user
	 * @param {string} pass
	 * @access private
	 */

	async login(user = this.config.user, pass = this.secrets.pass) {
		const login = {
			jsonrpc: `2.0`,
			method: 'Logon',
			params: {},
		}

		if (user && pass) {
			login.params = {
				User: user,
				Password: pass,
			}
			await this.callCommandObj(login, QRC_LOGIN)
		}
	}

	/**
	 * Debounce status update to prevent warnings during init of redundant systems
	 * @access private
	 */

	debouncedStatusUpdate = debounce(
		() => {
			this.debug(`debouncedStatusUpdate`)
			if (this.moduleStatus.logMessage !== '') this.log(this.moduleStatus.logLevel, this.moduleStatus.logMessage)
			this.updateStatus(this.moduleStatus.status, this.moduleStatus.message)
			// Change groups belong to a connection, so rebuild after every connect or failover
			if (this.moduleStatus.status == InstanceStatus.Ok || this.moduleStatus.status == InstanceStatus.UnknownWarning)
				this.resetChangeGroup()
		},
		1000,
		{ edges: ['trailing'], signal: this.#controller.signal },
	)

	/**
	 * Check and update module status. For redundant connections, will check states of both cores before setting module status
	 * @param {InstanceStatus} status
	 * @param {string} message Qsys host to connect to
	 * @param {boolean} secondary True if updating secondary core status
	 * @access private
	 * @since 3.0.0
	 */

	checkKeepAlive() {
		if (this.socket.pri.isConnected || this.socket.sec.isConnected) {
			if (this.keepAlive) clearTimeout(this.keepAlive)
			this.keepAlive = setTimeout(async () => {
				this.debug(`Sending keepalive`)
				await this.sendCommand('NoOp', {})
				this.checkKeepAlive()
			}, KA_INTERVAL)
		} else {
			this.debug(`No socket connected; ceasing keep alive`)
			if (this.keepAlive) {
				clearTimeout(this.keepAlive)
				delete this.keepAlive
			}
		}
	}

	/**
	 * @typedef {Object} StatusResult
	 * @property {import('@companion-module/base').InstanceStatus} status
	 * @property {string} message
	 * @property {string} [logLevel]
	 * @property {string} [logMessage]
	 */

	/**
	 * @returns {StatusResult}
	 */
	#getHealthyRedundantStatus() {
		const { primary, secondary } = this.moduleStatus

		const stateKey = `${primary.state}:${secondary.state}`
		const stateResults = {
			'Active:Standby': {
				status: InstanceStatus.Ok,
				message: 'Primary core active',
				logLevel: 'info',
				logMessage: '',
			},
			'Standby:Active': {
				status: InstanceStatus.Ok,
				message: 'Secondary core active',
				logLevel: 'info',
				logMessage: '',
			},
			'Active:Active': {
				status: InstanceStatus.UnknownError,
				message: 'Both cores active',
				logLevel: 'error',
				logMessage: 'Both cores active',
			},
			'Standby:Standby': {
				status: InstanceStatus.UnknownError,
				message: 'Both cores in standby',
				logLevel: 'error',
				logMessage: 'Both cores in standby',
			},
		}

		const result = stateResults[stateKey] ?? {
			status: InstanceStatus.UnknownWarning,
			message: `Unexpected state. Primary: ${primary.state}. Secondary: ${secondary.state}`,
			logLevel: 'warn',
			logMessage: `Unexpected state. Primary: ${primary.state}. Secondary: ${secondary.state}`,
		}

		// Apply overrides in priority order
		if (!primary.redundant || !secondary.redundant)
			return {
				status: InstanceStatus.UnknownWarning,
				message: 'Cores not configured for redundant mode',
				logLevel: 'error',
				logMessage: 'Cores not configured for redundant mode',
			}
		if (primary.design_code !== secondary.design_code)
			return {
				status: InstanceStatus.UnknownWarning,
				message: 'Cores reporting different designs',
				logLevel: 'error',
				logMessage: `Cores running different designs. Primary: ${primary.design_name}. Secondary: ${secondary.design_name}`,
			}
		if (primary.emulator)
			return {
				status: InstanceStatus.UnknownWarning,
				message: 'Primary core in Emulator mode',
				logLevel: 'warn',
				logMessage: 'Primary core in Emulator mode',
			}
		if (secondary.emulator)
			return {
				status: InstanceStatus.UnknownWarning,
				message: 'Secondary core in Emulator mode',
				logLevel: 'warn',
				logMessage: 'Secondary core in Emulator mode',
			}

		return result
	}

	/**
	 * @returns {StatusResult}
	 */
	#getDegradedRedundantStatus() {
		const { primary, secondary } = this.moduleStatus

		if (primary.status === InstanceStatus.Ok || secondary.status === InstanceStatus.Ok)
			return {
				status: InstanceStatus.UnknownWarning,
				message: 'Redundancy compromised',
				logLevel: 'warn',
				logMessage: 'Redundancy compromised',
			}

		if (primary.status === secondary.status)
			return {
				status: primary.status,
				message: `${primary.message} : ${secondary.message}`,
				logLevel: 'info',
				logMessage: `Core states: ${primary.message} : ${secondary.message}`,
			}

		return {
			status: InstanceStatus.UnknownError,
			message: 'Core connections in unexpected & inconsistent states',
			logLevel: 'warn',
			logMessage: `Core states: ${primary.message} : ${secondary.message}`,
		}
	}

	/**
	 * @returns {StatusResult}
	 */
	#getRedundantStatus() {
		const { primary, secondary } = this.moduleStatus

		if (primary.status !== InstanceStatus.Ok || secondary.status !== InstanceStatus.Ok) {
			return this.#getDegradedRedundantStatus()
		}

		return this.#getHealthyRedundantStatus()
	}

	/**
	 * @returns {StatusResult}
	 */
	#getNonRedundantStatus() {
		const { primary } = this.moduleStatus

		const connectionResult = {
			status: primary.status,
			message: primary.message,
			logLevel: 'info',
			logMessage: primary.message,
		}
		// The core's last reported state only holds while connected to it
		if (primary.status !== InstanceStatus.Ok) return connectionResult

		const stateResults = {
			Active: { status: InstanceStatus.Ok, message: 'Core active', logLevel: 'info', logMessage: '' },
			Standby: {
				status: InstanceStatus.UnknownWarning,
				message: 'Core state standby',
				logLevel: 'warn',
				logMessage: 'Core state standby',
			},
			Idle: {
				status: InstanceStatus.UnknownError,
				message: 'Core state idle',
				logLevel: 'warn',
				logMessage: 'Core state Idle',
			},
		}

		return stateResults[primary.state] ?? connectionResult
	}

	/**
	 * @param {import('@companion-module/base').InstanceStatus} status
	 * @param {string} message
	 * @param {boolean} [secondary]
	 */
	checkStatus(status, message, secondary = false) {
		this.debug(`checkStatus from ${secondary ? 'Secondary' : 'Primary'}\nStatus: ${status} Message: ${message}`)

		// Update the relevant core's status, bail if unchanged
		const core = secondary ? this.moduleStatus.secondary : this.moduleStatus.primary
		if (core.status === status && core.message === message) return
		core.status = status
		core.message = message

		// Determine new overall status
		const newStatus = this.config.redundant ? this.#getRedundantStatus() : this.#getNonRedundantStatus()

		// Bail if overall status unchanged
		if (this.moduleStatus.status === newStatus.status && this.moduleStatus.message === newStatus.message) return

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
		this.debug(`setEngineVariableValues`)
		//let engineVars = []
		if (this.config.redundant) {
			this.variablesToUpdate
				.set('stateSecondary', this.moduleStatus.secondary.state)
				.set('design_nameSecondary', this.moduleStatus.secondary.design_name)
				.set('redundantSecondary', this.moduleStatus.secondary.redundant)
				.set('emulatorSecondary', this.moduleStatus.secondary.emulator)
		}
		this.variablesToUpdate
			.set('state', this.moduleStatus.primary.state)
			.set('design_name', this.moduleStatus.primary.design_name)
			.set('redundant', this.moduleStatus.primary.redundant)
			.set('emulator', this.moduleStatus.primary.emulator)
		this.throttledVariableUpdates()
	}

	/**
	 * Update Engine variables and related status
	 * @param {object} data Recieved JSON blod
	 * @param {boolean} secondary True if message from secondary core
	 * @access private
	 */

	updateEngineVariables(data, secondary) {
		this.debug(`updateEngineVariables from ${!secondary ? 'Primary' : 'Secondary'} \nResponse: ${JSON.stringify(data)}`)
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

	/** Check the size of the TCP Socket recieve buffers and flush if excessively large
	 * @param {boolean} secondary
	 */

	checkBufferSize(secondary) {
		const MAX_BUFFER_SIZE = 1024 * 1024
		const key = secondary ? 'sec' : 'pri'
		const host = secondary ? this.config.hostSecondary : this.config.host
		if (this.socket.buffer[key].length > MAX_BUFFER_SIZE) {
			this.log('error', `Socket buffer overflow for ${host} — clearing`)
			this.socket.buffer[key] = ''
		}
	}

	/**
	 * Process recieved data
	 * @param {string} response Recieved message to process
	 * @param {boolean} secondary True if message from secondary core
	 * @access private
	 */

	processResponse(response, secondary) {
		this.debug(`processResponse from ${!secondary ? 'Primary' : 'Secondary'} \nResponse: ${response}`)
		this.checkBufferSize(secondary)

		let list
		if (secondary) {
			list = (this.socket.buffer.sec + response).split('\x00')
			this.socket.buffer.sec = list.pop()
		} else {
			list = (this.socket.buffer.pri + response).split('\x00')
			this.socket.buffer.pri = list.pop()
		}

		//let refresh = false

		list.forEach((jsonstr) => {
			if (!jsonstr) return
			let obj
			try {
				obj = JSON.parse(jsonstr)
			} catch (e) {
				this.log('warn', `Failed to parse JSON: ${e.message}`)
				return
			}

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
				} else if (Number(obj.error?.code) === 6) {
					// Unknown change group. Only ChangeGroup.Poll can return it on this id, so the core has lost our group
					this.log('warn', `Change group ${this.id} unknown to core, rebuilding`)
					this.changeGroupSet = false
					this.resetChangeGroup()
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
			} else if (obj?.id == QRC_LOGIN) {
				if ('error' in obj) {
					if (Number(obj.error?.code) === 10) this.login()
					if (obj.error?.message) this.log('warn', obj.error.message)
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
		this.debug(`getConfigFields ${JSON.stringify(configFields)}`)
		return configFields
	}

	/**
	 * Track whether actions are being recorded
	 * @param {boolean} isRecording
	 * @access public
	 * @since 3.0.0
	 */

	handleStartStopRecordActions(isRecording) {
		this.debug(`handleStartStopRecordActions ${isRecording}`)
		this.isRecordingActions = isRecording
	}

	/**
	 * Stop and delete running timers, destroy sockets
	 * @access private
	 * @since 3.0.0
	 */

	killTimersDestroySockets() {
		this.debug(`killTimersDestroySockets`)
		this.#queue.clear()
		this.debouncedStatusUpdate.cancel()
		this.debouncedVariableDefUpdate.cancel()
		this.resetChangeGroup.cancel()
		this.throttledFeedbackIdCheck.cancel()
		this.controls.clear()
		this.namesToGet.clear()
		this.feedbackIdsToCheck.clear()
		this.variablesToUpdate.clear()
		this.feedbackControlMap.clear()
		this.changeGroupSet = false
		if (this.pollQRCTimer !== undefined) {
			clearTimeout(this.pollQRCTimer)
			delete this.pollQRCTimer
		}
		if (this.keepAlive !== undefined) {
			clearTimeout(this.keepAlive)
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

	async destroy() {
		this.debug(`destroy ${this.id}: ${this.label}`)
		this.killTimersDestroySockets()
		this.#controller.abort()
		this.#queue.clear()
	}

	/**
	 * Build command message and send
	 * @param {string} command
	 * @param {*} params
	 * @param {AbortSignal} [signal] Aborts the request if it is still waiting to be sent
	 * @return {Promise<boolean>}
	 * @access private
	 */

	async sendCommand(command, params, signal) {
		this.debug(
			`sendCommand: ${JSON.stringify({
				method: command,
				params: params,
			})}`,
		)
		return await this.callCommandObj(
			{
				method: command,
				params: params,
			},
			QRC_SET,
			signal,
		)
	}

	/**
	 * Update action definitions
	 * @access private
	 */

	actions() {
		this.debug(`actions`)
		this.setActionDefinitions({
			control_set: {
				name: 'Control.Set',
				options: options.actions.controlSet(this.config),
				optionsToMonitorForSubscribe: ['name', 'relative'],
				subscribe: async (action, _context) => {
					if (action.options.relative) this.addControl(action)
				},
				unsubscribe: async (action, _context) => await this.removeControl(action),
				callback: async (evt, context) => {
					const name = evt.options.name.trim()
					if (name == '') throw new Error(`Invalid name supplied to: ${evt.id}`)
					let value = evt.options.value
					const control = this.controls.get(name)
					if (evt.options.relative && evt.options.type == 'number') {
						try {
							value = calcRelativeValue(value, name, evt, this.controls)
						} catch (err) {
							this.addControl(evt)
							throw err
						}
					}
					value = convertValueType(value, evt.options.type)
					if (value !== undefined) {
						const params = {
							Name: name,
							Value: value,
						}
						const ramp = Number.parseFloat(evt.options.ramp)
						// A ramp of 0 is no ramp, and is left out as an empty ramp was before it became a number
						if (evt.options.type == 'number' && ramp > 0) params.Ramp = ramp
						const sent = await this.sendCommand('Control.Set', params, context.signal)
						if (sent && control !== undefined) {
							control.value = value //If message sent immediately update control value to make subsequent relative actions more responsive
							this.variablesToUpdate.set(`${name}_value`, control.value)
							this.throttledVariableUpdates()
							if (control.feedbackIds.size > 0) {
								control.feedbackIds.forEach((id) => this.feedbackIdsToCheck.add(id))
								this.throttledFeedbackIdCheck()
							}
							// Follow with Control.Get to stay in sync
							await this.getControl(name, context.signal)
						}
					} else {
						throw new Error(`Invalid value (NaN) could not complete ${evt.actionId}:${evt.id}`)
					}
				},
				learn: async (evt, context) => {
					const name = evt.options.name.trim()
					if (name == '') throw new Error(`Invalid name supplied to: ${evt.id}`)
					const control = this.controls.get(name)
					if (control != undefined && control.value != null) {
						let type = 'string'
						if (typeof control.value == 'boolean') type = 'boolean'
						if (typeof control.value == 'number') type = 'number'
						return {
							relative: false,
							value: control.value.toString(),
							type: type,
						}
					} else {
						await this.getControl(name, context.signal)
					}
					return undefined
				},
			},
			control_toggle: {
				name: 'Control.Toggle',
				options: options.actions.controlToggle(),
				optionsToMonitorForSubscribe: ['name'],
				subscribe: async (action, _context) => this.addControl(action),
				unsubscribe: async (action, _context) => await this.removeControl(action),
				callback: async (evt, context) => {
					const name = evt.options.name.trim()
					if (name == '') throw new Error(`Invalid name supplied to: ${evt.id}`)
					const control = this.controls.get(name)
					if (control === undefined || control.value == null) {
						throw new Error(`Control ${name} unavailable. Check named control name`)
					}
					const sent = await this.sendCommand(
						'Control.Set',
						{
							Name: name,
							Value: !control.value,
						},
						context.signal,
					)
					// set our internal state in anticipation of success, allowing two presses
					// of the button faster than the polling interval to correctly toggle the state
					if (sent) {
						control.value = !control.value
						this.variablesToUpdate.set(`${name}_value`, control.value)
						this.throttledVariableUpdates()
						if (control.feedbackIds.size > 0) {
							control.feedbackIds.forEach((id) => this.feedbackIdsToCheck.add(id))
							this.throttledFeedbackIdCheck()
						}
						// Follow with Control.Get to stay in sync
						await this.getControl(name, context.signal)
					}
				},
			},
			control_get: {
				name: 'Control.Get',
				options: options.actions.controlGet(),
				optionsToMonitorForSubscribe: ['name'],
				subscribe: async (action, _context) => this.addControls(action),
				unsubscribe: async (action, _context) => await this.removeControls(action),
				callback: async (evt, context) => {
					const names = namesArray(evt)
					if (names.length == 0) throw new Error('No names supplied')
					names.forEach(async (name) => {
						if (!this.controls.has(name)) {
							evt.options.name = name
							this.addControl(evt)
						}
					})
					await this.getControl(names, context.signal)
				},
			},
			component_set: {
				name: 'Component.Set',
				options: options.actions.componentSet(),
				callback: async (evt, context) => {
					let ramp = Number.parseFloat(evt.options.ramp)
					if (Number.isNaN(ramp) || ramp < 0) ramp = 0
					await this.sendCommand(
						'Component.Set',
						{
							Name: evt.options.name,
							Controls: [
								{
									Name: evt.options.control_name.trim(),
									Value: evt.options.value,
									Ramp: ramp,
								},
							],
						},
						context.signal,
					)
				},
			},
			changeGroup_invalidate: {
				name: 'ChangeGroup.Invalidate',
				options: options.actions.changeGroup_invalidate(this.id),
				callback: async (_evt, context) => {
					await this.changeGroup('Invalidate', this.id, null, undefined, context.signal)
				},
			},
			mixer_setCrossPointGain: {
				name: 'Mixer.SetCrossPointGain',
				options: options.actions.mixer_setCrossPointGain(),
				callback: async (evt, context) => {
					await this.sendCommand(
						'Mixer.SetCrossPointGain',
						{
							Name: evt.options.name.trim(),
							Inputs: evt.options.inputs,
							Outputs: evt.options.outputs,
							Value: evt.options.value,
							Ramp: evt.options.ramp,
						},
						context.signal,
					)
				},
			},
			mixer_setCrossPointDelay: {
				name: 'Mixer.SetCrossPointDelay',
				options: options.actions.mixer_setCrossPointDelay(),
				callback: async (evt, context) => {
					await this.sendCommand(
						'Mixer.SetCrossPointDelay',
						{
							Name: evt.options.name.trim(),
							Inputs: evt.options.inputs,
							Outputs: evt.options.outputs,
							Value: evt.options.value,
							Ramp: evt.options.ramp,
						},
						context.signal,
					)
				},
			},
			mixer_setCrossPointMute: {
				name: 'Mixer.SetCrossPointMute',
				options: options.actions.mixer_setCrossPointMute(),
				callback: async (evt, context) => {
					await this.sendCommand(
						'Mixer.SetCrossPointMute',
						{
							Name: evt.options.name.trim(),
							Inputs: evt.options.inputs,
							Outputs: evt.options.outputs,
							Value: evt.options.value,
						},
						context.signal,
					)
				},
			},
			mixer_setCrossPointSolo: {
				name: 'Mixer.SetCrossPointSolo',
				options: options.actions.mixer_setCrossPointSolo(),
				callback: async (evt, context) => {
					await this.sendCommand(
						'Mixer.SetCrossPointSolo',
						{
							Name: evt.options.name.trim(),
							Inputs: evt.options.inputs,
							Outputs: evt.options.outputs,
							Value: evt.options.value,
						},
						context.signal,
					)
				},
			},
			mixer_setInputGain: {
				name: 'Mixer.SetInputGain',
				options: options.actions.mixer_setInputGain(),
				callback: async (evt, context) => {
					await this.sendCommand(
						'Mixer.SetInputGain',
						{
							Name: evt.options.name.trim(),
							Inputs: evt.options.inputs,
							Value: evt.options.value,
							Ramp: evt.options.ramp,
						},
						context.signal,
					)
				},
			},
			mixer_setInputMute: {
				name: 'Mixer.SetInputMute',
				options: options.actions.mixer_setInputMute(),
				callback: async (evt, context) => {
					await this.sendCommand(
						'Mixer.SetInputMute',
						{
							Name: evt.options.name.trim(),
							Inputs: evt.options.inputs,
							Value: evt.options.value,
						},
						context.signal,
					)
				},
			},
			mixer_setInputSolo: {
				name: 'Mixer.SetInputSolo',
				options: options.actions.mixer_setInputSolo(),
				callback: async (evt, context) => {
					await this.sendCommand(
						'Mixer.SetInputSolo',
						{
							Name: evt.options.name.trim(),
							Inputs: evt.options.inputs,
							Value: evt.options.value,
						},
						context.signal,
					)
				},
			},
			mixer_setOutputGain: {
				name: 'Mixer.SetOutputGain',
				options: options.actions.mixer_setOutputGain(),
				callback: async (evt, context) => {
					await this.sendCommand(
						'Mixer.SetOutputGain',
						{
							Name: evt.options.name.trim(),
							Outputs: evt.options.outputs,
							Value: evt.options.value,
							Ramp: evt.options.ramp,
						},
						context.signal,
					)
				},
			},
			mixer_setOutputMute: {
				name: 'Mixer.SetOutputMute',
				options: options.actions.mixer_setOutputMute(),
				callback: async (evt, context) => {
					await this.sendCommand(
						'Mixer.SetOutputMute',
						{
							Name: evt.options.name.trim(),
							Outputs: evt.options.outputs,
							Value: evt.options.value,
						},
						context.signal,
					)
				},
			},
			mixer_setCueMute: {
				name: 'Mixer.SetCueMute',
				options: options.actions.mixer_setCueMute(),
				callback: async (evt, context) => {
					await this.sendCommand(
						'Mixer.SetCueMute',
						{
							Name: evt.options.name.trim(),
							Cues: evt.options.cues,
							Value: evt.options.value,
						},
						context.signal,
					)
				},
			},
			mixer_setCueGain: {
				name: 'Mixer.SetCueGain',
				options: options.actions.mixer_setCueGain(),
				callback: async (evt, context) => {
					await this.sendCommand(
						'Mixer.SetCueGain',
						{
							Name: evt.options.name.trim(),
							Cues: evt.options.cues,
							Value: evt.options.value,
							Ramp: evt.options.ramp,
						},
						context.signal,
					)
				},
			},
			mixer_setInputCueEnable: {
				name: 'Mixer.SetInputCueEnable',
				options: options.actions.mixer_setInputCueEnable(),
				callback: async (evt, context) => {
					await this.sendCommand(
						'Mixer.SetInputCueEnable',
						{
							Name: evt.options.name.trim(),
							Cues: evt.options.cues,
							Inputs: evt.options.inputs,
							Value: evt.options.value,
						},
						context.signal,
					)
				},
			},
			mixer_setInputCueAfl: {
				name: 'Mixer.SetInputCueAfl',
				options: options.actions.mixer_setInputCueAfl(),
				callback: async (evt, context) => {
					await this.sendCommand(
						'Mixer.SetInputCueAfl',
						{
							Name: evt.options.name.trim(),
							Cues: evt.options.cues,
							Inputs: evt.options.inputs,
							Value: evt.options.value,
						},
						context.signal,
					)
				},
			},
			loopPlayer_start: {
				name: 'LoopPlayer.Start',
				options: options.actions.loopPlayer_start(),
				callback: async (evt, context) => {
					const output = Number.parseInt(evt.options.output)
					let refID = evt.options.refID.trim()
					refID = refID == '' ? `${this.label}:${evt.actionId}:${evt.id}` : refID
					if (isNaN(output)) {
						throw new Error(`Output is a NaN cannot complete ${evt.actionId}:${evt.id}`)
					}
					await this.sendCommand(
						'LoopPlayer.Start',
						{
							Files: [
								{
									Name: evt.options.file_name.trim(),
									Mode: evt.options.channel,
									Output: output,
								},
							],
							Name: evt.options.name, // Had to add name to the options array.
							StartTime: Math.round(evt.options.startTime),
							Seek: Math.round(evt.options.seek),
							Loop: evt.options.loop,
							Log: true,
							RefID: refID,
						},
						context.signal,
					)
				},
			},
			loopPlayer_stop: {
				name: 'LoopPlayer.Stop',
				options: options.actions.loopPlayer_stop(),
				callback: async (evt, context) => {
					const filteredOutputs = buildFilteredOutputArray(evt, this)
					if (filteredOutputs.length == 0) throw new Error(`No valid outputs`)
					await this.sendCommand(
						'LoopPlayer.Stop',
						{
							Name: evt.options.name.trim(),
							Outputs: filteredOutputs,
							Log: true,
						},
						context.signal,
					)
				},
			},
			loopPlayer_cancel: {
				name: 'LoopPlayer.Cancel',
				options: options.actions.loopPlayer_cancel(),
				callback: async (evt, context) => {
					const filteredOutputs = buildFilteredOutputArray(evt, this)
					if (filteredOutputs.length == 0) throw new Error(`No valid outputs`)
					await this.sendCommand(
						'LoopPlayer.Cancel',
						{
							Name: evt.options.name.trim(),
							Outputs: filteredOutputs,
							Log: true,
						},
						context.signal,
					)
				},
			},
			snapshot_load: {
				name: 'Snapshot.Load',
				options: options.actions.snapshot_load(),
				callback: async (evt, context) => {
					await this.sendCommand(
						'Snapshot.Load',
						{
							Name: evt.options.name.trim(),
							Bank: Math.floor(evt.options.bank),
							Ramp: evt.options.ramp,
						},
						context.signal,
					)
				},
			},
			snapshot_save: {
				name: 'Snapshot.Save',
				options: options.actions.snapshot_save(),
				callback: async (evt, context) => {
					await this.sendCommand(
						'Snapshot.Save',
						{
							Name: evt.options.name.trim(),
							Bank: Math.floor(evt.options.bank),
						},
						context.signal,
					)
				},
			},
			page_submit_message: {
				name: 'PA.PageSubmit - Message',
				options: options.actions.page_submit_message(),
				callback: async (evt, context) => {
					evt.options.output = evt.options.zones
					const zones = buildFilteredOutputArray(evt, this)
					if (zones.length == 0) throw new Error(`No valid zones`)
					await this.sendCommand(
						'PA.PageSubmit',
						{
							Mode: 'message',
							Zones: zones,
							Priority: evt.options.priority,
							Preamble: evt.options.preamble,
							Message: evt.options.message,
							Start: true,
						},
						context.signal,
					)
				},
			},
			statusGet: {
				name: 'StatusGet',
				options: options.actions.statusGet(),
				callback: async (_evt, context) => {
					await this.sendCommand('StatusGet', 0, context.signal)
				},
			},
		})
	}

	/**
	 * Update feedback definitions
	 * @access private
	 */

	initFeedbacks() {
		this.debug(`initFeedbacks`)
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
		feedbacks['control-boolean'] = {
			name: 'Feedback on boolean control value',
			type: 'boolean',
			defaultStyle: {
				color: colours.white,
				bgcolor: colours.red,
			},
			options: options.feedbacks.controlBoolean(),
			unsubscribe: async (feedback, _context) => await this.removeControl(feedback),
			callback: async (feedback, _context) => {
				const opt = feedback.options
				const name = this.ensureFeedbackControl(feedback.id, opt.name)
				const control = this.controls.get(name)
				if (control === undefined) return false
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
			unsubscribe: async (feedback, _context) => await this.removeControl(feedback),
			callback: async (feedback, _context) => {
				const opt = feedback.options
				const name = this.ensureFeedbackControl(feedback.id, opt.name)
				const control = this.controls.get(name)
				if (control === undefined) return false
				return control.value >= opt.threshold
			},
		}
		feedbacks['control-fade'] = {
			name: 'Fade color over control value range',
			description: 'Fade color over control value range',
			type: 'advanced',
			affectedProperties: ['bgcolor'],
			options: options.feedbacks.controlFade(colours),
			unsubscribe: async (feedback, _context) => await this.removeControl(feedback),
			callback: async (feedback, _context) => {
				const opt = feedback.options
				const name = this.ensureFeedbackControl(feedback.id, opt.name)
				if (opt.low_threshold >= opt.high_threshold) {
					// The callback reruns on every change of the control's value, so warn when the thresholds are set
					const previous = feedback.previousOptions
					if (previous?.low_threshold !== opt.low_threshold || previous?.high_threshold !== opt.high_threshold) {
						this.log(
							'warn',
							`Fade color over control value range: the low threshold (${opt.low_threshold}) must be below the high threshold (${opt.high_threshold})`,
						)
					}
					return {}
				}
				const control = this.controls.get(name)
				if (control === undefined) return {}
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
		feedbacks['level-meter'] = {
			name: 'Level Meter',
			description: 'Level Meter (Deprecated)',
			type: 'advanced',
			affectedProperties: ['imageBuffer'],
			options: options.feedbacks.levelMeter(),
			unsubscribe: async (feedback, _context) => await this.removeControl(feedback),
			callback: async (feedback, _context) => {
				const opt = feedback.options
				const name = this.ensureFeedbackControl(feedback.id, opt.name)
				const control = this.controls.get(name)
				if (control === undefined || feedback.image === undefined) return {}
				if (opt.min >= opt.max) {
					this.log('warn', `Invalid min/max choices for level-meter.\n${JSON.stringify(opt)}`)
					return {}
				}
				const position = opt.position
				const padding = opt.padding
				let ofsX1 = 0,
					ofsY1 = 0,
					bWidth = 0,
					bLength = 0
				switch (position) {
					case 'left':
						ofsX1 = padding
						ofsY1 = opt.offset
						bWidth = opt.width ?? 6
						bLength = feedback.image.height - ofsY1 * 2
						break
					case 'right':
						ofsY1 = opt.offset
						bWidth = opt.width ?? 6
						bLength = feedback.image.height - ofsY1 * 2
						ofsX1 = feedback.image.width - bWidth - padding
						break
					case 'top':
						ofsX1 = opt.offset
						ofsY1 = padding
						bWidth = opt.width ?? 7
						bLength = feedback.image.width - ofsX1 * 2
						break
					case 'bottom':
						ofsX1 = opt.offset
						bWidth = opt.width ?? 7
						ofsY1 = feedback.image.height - bWidth - padding
						bLength = feedback.image.width - ofsX1 * 2
				}

				const colors = opt.customColor
					? [
							{
								size: 100,
								color: opt.color ?? colours.white,
								background: opt.color ?? colours.black,
								backgroundOpacity: 64,
							},
						]
					: [
							{ size: 50, color: colours.greenBright, background: colours.greenBright, backgroundOpacity: 64 },
							{ size: 25, color: colours.yellow, background: colours.yellow, backgroundOpacity: 64 },
							{ size: 25, color: colours.red, background: colours.red, backgroundOpacity: 64 },
						]
				const options = {
					width: feedback.image.width,
					height: feedback.image.height,
					colors: colors,
					barLength: bLength,
					barWidth: bWidth,
					type: position == 'left' || position == 'right' ? 'vertical' : 'horizontal',
					value: valueToPercent(opt.valPos ? control.position : control.value, opt.min, opt.max, opt.invertValue),
					reverse: opt.invertMeter,
					offsetX: ofsX1,
					offsetY: ofsY1,
					opacity: 255,
				}
				this.debug(`Feedback: ${JSON.stringify(feedback)}\n Bar Options: ${JSON.stringify(options)}`)
				return imageResult(graphics.bar(options))
			},
		}
		feedbacks['Indicator'] = {
			type: 'advanced',
			affectedProperties: ['imageBuffer'],
			name: 'Indicator',
			description: 'Show a position indicator on the button (Deprecated)',
			options: options.feedbacks.indicator(),
			unsubscribe: async (feedback, context) => await this.removeControl(feedback, context),
			callback: async (feedback, _context) => {
				const opt = feedback.options
				const name = this.ensureFeedbackControl(feedback.id, opt.name)
				const control = this.controls.get(name)
				if (control === undefined || feedback.image === undefined) return {}
				if (opt.min >= opt.max) {
					throw new Error(`Invalid min/max choices for indicator.\n${JSON.stringify(opt)}`)
				}
				const position = opt.position
				const padding = opt.padding
				let ofsX1 = 0,
					ofsY1 = 0,
					bWidth,
					bLength = 0
				const markerOffset = (bLength, value, offset) => {
					return bLength * (value / 100) + offset
				}
				switch (position) {
					case 'left':
						ofsX1 = padding
						ofsY1 = opt.offset
						bLength = feedback.image.height - ofsY1 * 2 - 2
						break
					case 'right':
						ofsY1 = opt.offset
						bWidth = opt.width ?? 6
						bLength = feedback.image.height - ofsY1 * 2 - 2
						ofsX1 = feedback.image.width - bWidth - padding
						break
					case 'top':
						ofsX1 = opt.offset
						ofsY1 = padding
						bLength = feedback.image.width - ofsX1 * 2 - 2
						break
					case 'bottom':
						ofsX1 = opt.offset
						bWidth = opt.width ?? 7
						ofsY1 = feedback.image.height - bWidth - padding
						bLength = feedback.image.width - ofsX1 * 2 - 2
				}
				const val = valueToPercent(opt.valPos ? control.position : control.value, opt.min, opt.max)
				const options = {
					width: feedback.image.width,
					height: feedback.image.height,
					rectWidth: position == 'left' || position == 'right' ? opt.width : 3,
					rectHeight: position == 'left' || position == 'right' ? 3 : opt.width,
					strokeWidth: 1,
					color: feedback.options.indicatorColor,
					fillColor: combineRgb(128, 128, 128),
					fillOpacity: 255,
					offsetX: position == 'left' || position == 'right' ? ofsX1 : markerOffset(bLength, val, ofsX1),
					offsetY:
						position == 'left' || position == 'right'
							? feedback.image.height - markerOffset(bLength, val, ofsY1)
							: ofsY1,
				}
				this.debug(`Feedback: ${JSON.stringify(feedback)}\n Rectangle Options: ${JSON.stringify(options)}`)

				return imageResult(graphics.rect(options))
			},
		}
		feedbacks['led'] = {
			type: 'advanced',
			affectedProperties: ['imageBuffer'],
			name: 'LED',
			description: 'Show a boolean LED on the button (Deprecated)',
			options: options.feedbacks.led(),
			unsubscribe: async (feedback, _context) => await this.removeControl(feedback),
			callback: async (feedback, _context) => {
				const opt = feedback.options
				const name = this.ensureFeedbackControl(feedback.id, opt.name)
				const control = this.controls.get(name)
				if (control === undefined || feedback.image === undefined) return {}
				let options
				let imageBuf
				if (opt.shape == 'circle') {
					const cirlceOptions = {
						radius: Math.round(opt.radius),
						color: Math.round(control.position) ? opt.colorOn : opt.colorOff,
						opacity: Math.round(control.position) ? opt.opacityOn : opt.opacityOff,
					}
					const circle = graphics.circle(cirlceOptions)
					options = {
						width: feedback.image.width,
						height: feedback.image.height,
						custom: circle,
						type: 'custom',
						customHeight: 2 * Math.round(opt.radius),
						customWidth: 2 * Math.round(opt.radius),
						offsetX: opt.offsetX,
						offsetY: opt.offsetY,
					}
					this.debug(
						`Feedback: ${JSON.stringify(feedback)}\nCircle Options: ${JSON.stringify(cirlceOptions)}\nIcon Options: ${JSON.stringify(options)}`,
					)
					imageBuf = graphics.icon(options)
				} else if (opt.shape == 'rectangle') {
					options = {
						width: feedback.image.width,
						height: feedback.image.height,
						rectWidth: opt.width,
						rectHeight: opt.height,
						strokeWidth: 1,
						color: Math.round(control.position) ? opt.colorOn : opt.colorOff,
						fillColor: Math.round(control.position) ? opt.colorOn : opt.colorOff,
						opacity: Math.round(control.position) ? opt.opacityOn : opt.opacityOff,
						fillOpacity: Math.round(control.position) ? opt.opacityOn : opt.opacityOff,
						offsetX: opt.offsetX,
						offsetY: opt.offsetY,
					}
					this.debug(`Feedback: ${JSON.stringify(feedback)}\nRectangle Options: ${JSON.stringify(options)}`)
					imageBuf = graphics.rect(options)
				}

				return imageBuf === undefined ? {} : imageResult(imageBuf)
			},
		}
		feedbacks['control-value'] = {
			name: 'Named Control Value Feedback',
			type: 'value',
			options: options.feedbacks.controlValue(),
			unsubscribe: async (feedback, _context) => await this.removeControl(feedback),
			callback: async (feedback, _context) => {
				const name = this.ensureFeedbackControl(feedback.id, feedback.options.name)
				return this.controls.get(name)?.value ?? null
			},
		}
		feedbacks['control-string-value'] = {
			name: 'Named Control String Value Feedback',
			type: 'value',
			options: options.feedbacks.controlStringValue(),
			unsubscribe: async (feedback, _context) => await this.removeControl(feedback),
			callback: async (feedback, _context) => {
				const name = this.ensureFeedbackControl(feedback.id, feedback.options.name)
				return this.controls.get(name)?.strval ?? null
			},
		}
		feedbacks['control-position'] = {
			name: 'Named Control Position Feedback',
			type: 'value',
			options: options.feedbacks.controlPosition(),
			unsubscribe: async (feedback, _context) => await this.removeControl(feedback),
			callback: async (feedback, _context) => {
				const name = this.ensureFeedbackControl(feedback.id, feedback.options.name)
				return this.controls.get(name)?.position ?? null
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
			this.debug(`Q-SYS Sent to ${host}: ` + JSON.stringify(cmd) + '\r')
		} else {
			this.log('warn', `Q-SYS Send to ${host} Failed: ` + JSON.stringify(cmd) + '\r')
		}
	}

	/**
	 * The instance's signal, combined with a caller's so a request dies whichever aborts first. p-queue listens on
	 * the result as soon as the task is queued, which keeps it propagating on Node 26
	 * @param {AbortSignal} [signal]
	 * @returns {AbortSignal}
	 * @access private
	 */

	#combineSignal(signal) {
		return signal ? AbortSignal.any([this.#controller.signal, signal]) : this.#controller.signal
	}

	/**
	 * Add message to outbound queue and send
	 * @param {object} cmd Command object to send
	 * @param {QRC_GET | QRC_SET | QRC_LOGIN} get_set Get or Set method, defaults to Set (2)
	 * @param {AbortSignal} [signal] Aborts the request if it is still waiting to be sent, as does destroying the instance
	 * @return {Promise<boolean>}
	 * @access private
	 */

	async callCommandObj(cmd, get_set = QRC_SET, signal) {
		const payload = { ...cmd, jsonrpc: '2.0', id: get_set }
		this.debug(`callCommandObj: ${JSON.stringify(payload)}`)
		return await this.#queue
			.add(
				async ({ signal }) => {
					if (signal.aborted) return false
					let sentPri = false
					let sentSec = false
					if (isCoreActive(this.moduleStatus.primary) || validMethodsToStandbyCore(payload)) {
						if (isSocketOkToSend(this.socket.pri)) {
							sentPri = await this.socket.pri.send(JSON.stringify(payload) + '\x00')
							this.logSentMessage(sentPri, payload)
						} else {
							this.log(
								'warn',
								`Q-SYS Send to ${this.config.host} Failed as not connected. Message: ` + JSON.stringify(payload),
							)
						}
					}

					if (this.config.redundant) {
						if (isCoreActive(this.moduleStatus.secondary) || validMethodsToStandbyCore(payload)) {
							if (isSocketOkToSend(this.socket.sec)) {
								sentSec = await this.socket.sec.send(JSON.stringify(payload) + '\x00')
								this.logSentMessage(sentSec, payload, this.config.hostSecondary)
							} else {
								this.log(
									'warn',
									`Q-SYS Send to ${this.config.hostSecondary} Failed as not connected. Message: ` +
										JSON.stringify(payload),
								)
							}
						}
					}
					return sentPri || sentSec
				},
				{ signal: this.#combineSignal(signal), priority: get_set },
			)
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
	 * @param {AbortSignal} [signal] Aborts the request if it is still waiting to be sent
	 * @returns {Promise<boolean>} True if message send was successful
	 * @access private
	 */

	async changeGroup(type, id, controls = null, rate = 1000, signal) {
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
		this.debug(`changeGroup: ${JSON.stringify(obj)}`)
		const getSet = type == 'Poll' || type == 'AutoPoll' ? QRC_GET : QRC_SET
		return await this.callCommandObj(obj, getSet, signal)
	}

	/**
	 * Get named control value
	 * @param {string | MapIterator<string> | SetIterator<string> | string[]} name
	 * @param {AbortSignal} [signal] Aborts the request if it is still waiting to be sent
	 * @returns {Promise<boolean>} True if message send was successful
	 * @access private
	 */

	async getControl(name, signal) {
		const cmd = {
			method: 'Control.Get',
			params: typeof name == 'object' ? [...name] : [name],
		}
		this.debug(`getControl: ${JSON.stringify(cmd)}`)
		return await this.callCommandObj(cmd, QRC_GET, signal)
	}

	/**
	 * Query values of controls in this.controls
	 * @access private
	 */

	async getControlStatuses() {
		this.debug(`getControlStatuses Queue Size ${this.#queue.size}`)
		// With no connected active core there is nothing to poll, and every attempt would log a failed send
		if (!this.#canReachActiveCore()) return
		if (this.changeGroupSet) {
			await this.changeGroup('Poll', this.id)
		} else {
			//Directly get controls if we havent setup the changeGroup yet
			await this.getControl(this.#usedControlNames())
		}
	}

	/**
	 * Whether a core that takes control requests is connected, as callCommandObj sends them only to an active core
	 * @returns {boolean}
	 * @access private
	 */

	#canReachActiveCore() {
		const { primary, secondary } = this.moduleStatus
		if (isCoreActive(primary) && isSocketOkToSend(this.socket.pri)) return true
		return !!this.config.redundant && isCoreActive(secondary) && isSocketOkToSend(this.socket.sec)
	}

	/**
	 * Initialise polling timer
	 * @access private
	 */

	initPolling() {
		this.debug(`initPolling`)
		if (this.pollQRCTimer) {
			clearTimeout(this.pollQRCTimer)
		}
		this.pollQRCTimer = setTimeout(async () => {
			await this.getControlStatuses().catch(() => {})
			this.initPolling()
		}, Math.round(this.config.poll_interval))
	}
	/**
	 * Reinit default change group, and get all controls.
	 * The only place changeGroupSet is set true, as only here does the group get every control
	 * @access private
	 */

	resetChangeGroup = debounce(
		async () => {
			this.debug(`resetChangeGroup`)
			// Poll with Control.Get until the group is rebuilt, rather than against the destroyed one
			this.changeGroupSet = false
			await this.changeGroup('Destroy', this.id)
			const names = this.#usedControlNames()
			if (names.length === 0) return
			await this.getControl(names)
			this.changeGroupSet = await this.changeGroup('AddControl', this.id, names)
		},
		1000,
		{ edges: ['trailing'], signal: this.#controller.signal },
	)

	/**
	 * Update the variable definitions
	 * @access private
	 */

	debouncedVariableDefUpdate = debounce(
		async () => {
			this.debug(`debouncedVariableDefUpdate: ${JSON.stringify(this.variables)}`)
			this.setVariableDefinitions(variableDefinitions(this.variables))
			this.setEngineVariableValues()
			if (this.namesToGet.size > 0) {
				await this.getControl(this.namesToGet.keys())
				if (this.changeGroupSet) {
					await this.changeGroup('AddControl', this.id, this.namesToGet.keys())
				} else {
					// Adding only the new names would leave a group missing every other control
					this.resetChangeGroup()
				}
				this.namesToGet.clear()
			}
		},
		1000,
		{ edges: ['trailing'], signal: this.#controller.signal },
	)

	/**
	 * Call addControl for each element in a comma seperated list of control names
	 * @param {CompanionActionInfo} action
	 * @param {CompanionActionContext | InstanceBase} context
	 * @access private
	 */

	async addControls(action) {
		this.debug(`addControls: ${JSON.stringify(action)}`)
		const names = namesArray(action)
		names.forEach((name) => {
			action.options.name = name
			this.addControl(action)
		})
	}

	/**
	 * @param {CompanionActionInfo |CompanionFeedbackInfo} feedback
	 * @param {CompanionActionContext | CompanionFeedbackContext} context
	 * @access private
	 */

	addControl(feedback) {
		this.debug(`addControl: ${JSON.stringify(feedback)}\n Current size of this.controls: ${this.controls.size}`)
		const name = feedback['options']['name'].trim()
		if (name == '') throw new Error(`Invalid name supplied to: ${feedback.id}`)
		const control = this.#useControl(name)
		if (feedback.feedbackId !== undefined) {
			control.feedbackIds.add(feedback.id)
		} else {
			control.actionIds.add(feedback.id)
		}
	}

	/**
	 * Whether an action, feedback or the variables config uses a control. Only those are polled: the map also holds
	 * controls heard of only in a reply, such as one still on its way when its control was removed, or to a learn
	 * @param {object} control
	 * @returns {boolean}
	 * @access private
	 */

	#isUsed(control) {
		return control.actionIds.size > 0 || control.feedbackIds.size > 0
	}

	/**
	 * Names of the controls to poll, and to put in the change group
	 * @returns {string[]}
	 * @access private
	 */

	#usedControlNames() {
		return [...this.controls].filter(([, control]) => this.#isUsed(control)).map(([name]) => name)
	}

	/**
	 * The entry for a control something is starting to use, created if the module has not heard of it. A control
	 * nothing used until now has its variables defined, and is fetched and added to the change group
	 * @param {string} name
	 * @returns {object}
	 * @access private
	 */

	#useControl(name) {
		let control = this.controls.get(name)
		if (control === undefined) {
			control = { actionIds: new Set(), feedbackIds: new Set(), value: null, position: null, strval: '' }
			this.controls.set(name, control)
		}
		if (!this.#isUsed(control)) {
			const variableId = sanitiseVariableId(name)
			// Variables are never removed, so a control used before still has its definitions
			if (!this.variables.some((variable) => variable.variableId === `${variableId}_value`)) {
				this.variables.push(
					{ name: `${name} Value`, variableId: `${variableId}_value` },
					{ name: `${name} Position`, variableId: `${variableId}_position` },
					{ name: `${name} String`, variableId: `${variableId}_string` },
				)
			}
			this.namesToGet.add(name)
			this.debouncedVariableDefUpdate()
		}
		return control
	}

	/**
	 * Call removeControl for each element in a comma seperated list of control names
	 * @param {CompanionActionInfo} action
	 * @access private
	 */

	async removeControls(action) {
		this.debug(`removeControls: ${JSON.stringify(action)}`)
		const names = namesArray(action)
		await Promise.all(
			names.map(async (name) => {
				action.options.name = name
				await this.removeControl(action)
			}),
		)
	}

	/**
	 * @param {CompanionActionInfo | CompanionFeedbackInfo} feedback
	 * @access private
	 */

	async removeControl(feedback) {
		this.debug(`removeControl: ${JSON.stringify(feedback)}\n Current size of this.controls: ${this.controls.size}`)
		const name = feedback['options']['name'].trim()
		if (this.controls.has(name)) {
			const control = this.controls.get(name)
			if (feedback.feedbackId !== undefined) {
				control.feedbackIds.delete(feedback.id)
				this.feedbackControlMap.delete(feedback.id)
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
	 * Called at the top of every feedback callback that uses a named control. Feedbacks have no
	 * subscribe hook, so this registers the feedback against its control on the first call, and
	 * moves the registration when the `name` option changes.
	 * @param {string} feedbackId
	 * @param {string} name The current value of feedback.options.name
	 * @returns {string} The trimmed control name
	 * @access private
	 */
	ensureFeedbackControl(feedbackId, name) {
		name = String(name ?? '').trim()
		const previousName = this.feedbackControlMap.get(feedbackId)

		if (previousName === name) return name // Nothing changed

		// Remove feedbackId from the old control
		const oldControl = previousName === undefined ? undefined : this.controls.get(previousName)
		if (oldControl) {
			oldControl.feedbackIds.delete(feedbackId)
			if (oldControl.actionIds.size === 0 && oldControl.feedbackIds.size === 0) {
				this.controls.delete(previousName)
				if (this.namesToGet.has(previousName)) this.namesToGet.delete(previousName)
				this.changeGroup('Remove', this.id, previousName).catch(() => {})
			}
		}

		// A feedback with no name yet has no control to register against
		if (name === '') {
			this.feedbackControlMap.delete(feedbackId)
			return name
		}
		this.feedbackControlMap.set(feedbackId, name)

		// Add feedbackId to the new control, creating it if necessary
		this.#useControl(name).feedbackIds.add(feedbackId)
		return name
	}

	/**
	 * Throttled Feedback checks
	 */

	throttledFeedbackIdCheck = throttle(
		() => {
			this.debug(
				`throttledFeedbackIdCheck: Number of Feedbacks: ${this.feedbackIdsToCheck.size}\n${[...this.feedbackIdsToCheck].join(', ')}`,
			)
			this.checkFeedbacksById(...this.feedbackIdsToCheck)
			this.feedbackIdsToCheck.clear()
		},
		30,
		{ edges: ['trailing'], signal: this.#controller.signal },
	)

	/**
	 * Throttled Feedback checks
	 */

	throttledVariableUpdates = throttle(
		() => {
			this.debug(
				`throttledVariableUpdates: Number of Variables ${this.variablesToUpdate.size}\n${JSON.stringify(Object.fromEntries(this.variablesToUpdate))}`,
			)
			this.setVariableValues(Object.fromEntries(this.variablesToUpdate))
			this.variablesToUpdate.clear()
		},
		30,
		{ edges: ['trailing'], signal: this.#controller.signal },
	)

	/**
	 * Updates a controls variable values
	 * @param {object} update
	 * @access private
	 */

	updateControl(update) {
		this.debug(`updateControl: ${JSON.stringify(update)}\n Current size of this.controls: ${this.controls.size}`)
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
		this.variablesToUpdate
			.set(`${name}_string`, control.strval)
			.set(`${name}_position`, control.position)
			.set(`${name}_value`, control.value)
		this.throttledVariableUpdates()
		if (control.feedbackIds.size > 0) {
			control.feedbackIds.forEach((id) => this.feedbackIdsToCheck.add(id))
			this.throttledFeedbackIdCheck()
		}
		if (this.isRecordingActions) {
			let type = 'string'
			if (typeof control.value == 'boolean') type = 'boolean'
			if (typeof control.value == 'number') type = 'number'
			const opts = {
				actionId: 'control_set',
				options: {
					name: update.Name,
					value: control.value?.toString() ?? '',
					min: '',
					max: '',
					ramp: '',
					relative: false,
					type: type,
				},
			}
			this.recordAction(opts, `Set:${update.Name}`)
			this.debug(`recordAction: Set:${update.Name}\n${JSON.stringify(opts)}`)
		}
	}
}
