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
import PQueue from 'p-queue'
const queue = new PQueue({ concurrency: 1 })
const QRC_GET = 1
const QRC_SET = 2

const colours = {
	black: combineRgb(0, 0, 0),
	white: combineRgb(255, 255, 255),
	red: combineRgb(255, 0, 0),
}

/**
 * Remove illegal characters from variable Ids
 * @param {string} id variable id to sanitize
 * @param {'' | '.' | '-' | '_'} substitute Char to replace illegal characters
 * @since 2.3.0
 */

const sanitiseVariableId = (id, substitute = '_') => id.replaceAll(/[^a-zA-Z0-9-_.]/gm, substitute)

class QsysRemoteControl extends InstanceBase {
	constructor(internal) {
		super(internal)
		this.console_debug = false
		this.pollQRCTimer = undefined
		this.moduleStatus = this.resetModuleStatus()
		this.socket = {
			pri: new TCPHelper('localhost', 1710),
			sec: new TCPHelper('localhost', 1710),
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
		this.killTimersDestroySockets()
		this.moduleStatus = this.resetModuleStatus()
		this.config = config
		this.console_debug = config.verbose
		this.controls = new Map()
		this.init_tcp(this.config.host, this.config.port)
		if (this.config.redundant) {
			this.init_tcp(this.config.hostSecondary, this.config.portSecondary, true)
		}
		this.initFeedbacks()
		this.subscribeFeedbacks() // ensures control hashmap is updated with all feedbacks when config is changed
		this.initPolling()
	}

	/**
	 * Return new moduleStatus object
	 * @returns {object} new moduleStatus
	 * @access private
	 * @since 2.3.0
	 */

	resetModuleStatus() {
		return {
			status: InstanceStatus.Connecting,
			message: '',
			primary: {
				status: InstanceStatus.Connecting,
				message: '',
				state: null,
				design_name: '',
				redundant: null,
				emulator: null,
				design_code: '',
			},
			secondary: {
				status: InstanceStatus.Connecting,
				message: '',
				state: null,
				design_name: '',
				redundant: null,
				emulator: null,
				design_code: '',
			},
		}
	}

	/**
	 * Initialise module variables
	 * @access private
	 */

	initVariables() {
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
		if (this.config.redundant) {
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
			this.setVariableDefinitions(this.variables) // This gets called in addControls if there are vars
			return
		}

		this.config.variables.split(',').forEach((v) => {
			this.addControl({
				options: {
					name: v.trim(),
				},
				id: 'var',
			})
		})
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
			this.response_buffer = ''

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

			this.initVariables()
			if (this.keepAlive === undefined) {
				this.keepAlive = setInterval(async () => {
					await this.sendCommand('StatusGet', 0)
				}, 1000)
			}
		}
		const dataEvent = (d) => {
			const response = d.toString()

			if (this.console_debug) {
				console.log(`[${new Date().toJSON()}] Message recieved from ${host}: ${response}`)
			}

			if (this.config.feedback_enabled) {
				this.processResponse(response, secondary)
			}
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
				} else if (this.moduleStatus.primary.state == 'Standby' && this.moduleStatus.secondary.state == 'Active') {
					newStatus.status = InstanceStatus.Ok
					newStatus.message = 'Secondary core active'
				} else if (this.moduleStatus.primary.state == 'Active' && this.moduleStatus.secondary.state == 'Active') {
					newStatus.status = InstanceStatus.UnknownError
					newStatus.message = 'Both cores active'
					this.log('error', 'Both cores active')
				} else if (this.moduleStatus.primary.state == 'Standby' && this.moduleStatus.secondary.state == 'Standby') {
					newStatus.status = InstanceStatus.UnknownError
					newStatus.message = `Both cores in standby`
					this.log('error', 'Both cores in standby')
				} else {
					newStatus.status = InstanceStatus.UnknownWarning
					newStatus.message = `Unexpected state. Primary: ${this.moduleStatus.primary.state}. Secondary: ${this.moduleStatus.secondary.state}`
					this.log(
						'warn',
						`Unexpected state. Primary: ${this.moduleStatus.primary.state}. Secondary: ${this.moduleStatus.secondary.state}`,
					)
				}
				if (this.moduleStatus.primary.design_code !== this.moduleStatus.secondary.design_code) {
					newStatus.status = InstanceStatus.UnknownWarning
					newStatus.message = 'Cores reporting different designs'
					this.log(
						'error',
						`Cores running different designs. Primary: ${this.moduleStatus.primary.design_name}. Secondary: ${this.moduleStatus.secondary.design_name}`,
					)
				}
				if (this.moduleStatus.primary.emulator) {
					newStatus.status = InstanceStatus.UnknownWarning
					newStatus.message = 'Primary core in Emulator mode'
					this.log('warn', 'Primary core in Emulator mode')
				}
				if (this.moduleStatus.secondary.emulator) {
					newStatus.status = InstanceStatus.UnknownWarning
					newStatus.message = 'Secondary core in Emulator mode'
					this.log('warn', 'Secondary core in Emulator mode')
				}
				if (!this.moduleStatus.primary.redundant || !this.moduleStatus.secondary.redundant) {
					newStatus.status = InstanceStatus.UnknownWarning
					newStatus.message = 'Cores not configured for redundant mode'
					this.log('error', 'Cores not configured for redundant mode')
				}
			} else if (
				this.moduleStatus.primary.status == InstanceStatus.Ok ||
				this.moduleStatus.secondary.status == InstanceStatus.Ok
			) {
				newStatus.status = InstanceStatus.UnknownWarning
				newStatus.message = `Redundancy compromised`
				this.log('warn', 'Redundancy compromised')
			} else if (this.moduleStatus.primary.status == this.moduleStatus.secondary.status) {
				newStatus.status = this.moduleStatus.primary.status
				newStatus.message = this.moduleStatus.primary.message + ' : ' + this.moduleStatus.secondary.message
				this.log(
					'info',
					`Core states: ` + this.moduleStatus.primary.message + ' : ' + this.moduleStatus.secondary.message,
				)
			} else {
				newStatus.status = InstanceStatus.UnknownError
				newStatus.message = `Core connections in unexpected & inconsistent states`
				this.log(
					'warn',
					`Core states: ` + this.moduleStatus.primary.message + ' : ' + this.moduleStatus.secondary.message,
				)
			}
		} else {
			if (this.moduleStatus.primary.state == 'Active') {
				newStatus.status = InstanceStatus.Ok
				newStatus.message = 'Primary core active'
			} else if (this.moduleStatus.primary.state == 'Standby') {
				newStatus.status = InstanceStatus.UnknownWarning
				newStatus.message = 'Core in standby'
			} else if (this.moduleStatus.primary.state == 'Idle') {
				newStatus.status = InstanceStatus.UnknownError
				newStatus.message = 'Core in idle'
			} else {
				newStatus.status = this.moduleStatus.primary.status
				newStatus.message = this.moduleStatus.primary.message
			}
		}
		if (this.moduleStatus.status == newStatus.status && this.moduleStatus.message == newStatus.message) return
		this.moduleStatus.status = newStatus.status
		this.moduleStatus.message = newStatus.message
		this.updateStatus(newStatus.status, newStatus.message)
	}

	/**
	 * Check and update module status. For redundant connections, will check states of both cores before setting module status
	 * @param {string} response Recieved message to process
	 * @param {boolean} secondary True if message from secondary core
	 * @access private
	 */

	processResponse(response, secondary) {
		const list = (this.response_buffer + response).split('\x00')
		this.response_buffer = list.pop()
		let refresh = false

		list.forEach((jsonstr) => {
			const obj = JSON.parse(jsonstr)

			if (obj.id !== undefined && obj.id == QRC_GET) {
				if (Array.isArray(obj?.result)) {
					obj.result.forEach((r) => this.updateControl(r))
					refresh = true
				} else if (obj.error !== undefined) {
					this.log('error', JSON.stringify(obj.error))
				}
			} else if (obj.method === 'EngineStatus') {
				if (secondary) {
					this.setVariableValues({
						stateSecondary: obj.params.State.toString(),
						design_nameSecondary: obj.params.DesignName.toString(),
						redundantSecondary: !!obj.params.IsRedundant,
						emulatorSecondary: !!obj.params.IsEmulator,
					})
					this.moduleStatus.secondary.state = obj.params.State.toString()
					this.moduleStatus.secondary.design_name = obj.params.DesignName.toString()
					this.moduleStatus.secondary.design_code = obj.params.DesignCode.toString()
					this.moduleStatus.secondary.redundant = !!obj.params.IsRedundant
					this.moduleStatus.secondary.emulator = !!obj.params.IsEmulator
				} else {
					this.setVariableValues({
						state: obj.params.State.toString(),
						design_name: obj.params.DesignName.toString(),
						redundant: !!obj.params.IsRedundant,
						emulator: !!obj.params.IsEmulator,
					})
					this.moduleStatus.primary.state = obj.params.State.toString()
					this.moduleStatus.primary.design_name = obj.params.DesignName.toString()
					this.moduleStatus.primary.design_code = obj.params.DesignCode.toString()
					this.moduleStatus.primary.redundant = !!obj.params.IsRedundant
					this.moduleStatus.primary.emulator = !!obj.params.IsEmulator
				}
				this.checkStatus(InstanceStatus.Ok, obj.params.State.toString(), secondary)
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
		return [
			{
				type: 'checkbox',
				id: 'redundant',
				label: 'Redunant Cores?',
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
				id: 'info',
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
				id: 'info',
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
			},
			{
				type: 'number',
				id: 'poll_interval',
				label: 'Polling Interval (ms)',
				min: 30,
				max: 60000,
				width: 6,
				default: 100,
			},
			{
				type: 'static-text',
				id: 'info',
				label: 'Control Variables',
				width: 12,
				value:
					'Specify a list of named controls to add as Companion variables. Separated by commas. Any feedbacks used are automatically added to the variable list.',
			},
			{
				type: 'textinput',
				id: 'variables',
				label: 'Variables',
				width: 12,
				default: '',
			},
			{
				type: 'checkbox',
				id: 'verbose',
				label: 'Verbose Logs',
				width: 6,
				default: false,
			},
		]
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
		this.killTimersDestroySockets()
		if (this.controls !== undefined) {
			this.controls = undefined
		}
	}

	/**
	 * Build command message and send
	 * @param {string} command
	 * @param {*} params
	 * @access private
	 */

	async sendCommand(command, params) {
		await this.callCommandObj({
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
				name: 'Control.set',
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
						id: 'value',
						label: 'Value:',
						default: '',
						useVariables: { local: true },
					},
				],
				callback: async (evt, context) => {
					const value = await context.parseVariablesInString(evt.options.value)

					await this.sendCommand('Control.Set', {
						Name: await context.parseVariablesInString(evt.options.name),
						Value: value,
					})
				},
			},
			control_toggle: {
				name: 'Control.toggle',
				options: [
					{
						type: 'textinput',
						id: 'name',
						label: 'Name:',
						default: '',
						tooltip: 'Only applies to controls with an on/off state.',
						useVariables: { local: true },
					},
				],
				callback: async (evt, context) => {
					const name = await context.parseVariablesInString(evt.options.name)
					let control = this.controls.get(name)
					// set our internal state in anticipation of success, allowing two presses
					// of the button faster than the polling interval to correctly toggle the state
					await this.sendCommand('Control.Set', {
						Name: name,
						Value: !control.value,
					})
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
				callback: async (evt, context) =>
					await this.sendCommand('Component.Set', {
						Name: await context.parseVariablesInString(evt.options.name),
						Controls: [
							{
								Name: await context.parseVariablesInString(evt.options.control_name),
								Value: await context.parseVariablesInString(evt.options.value),
								Ramp: await context.parseVariablesInString(evt.options.ramp),
							},
						],
					}),
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
							{ id: 'true', label: 'true' },
							{ id: 'false', label: 'false' },
						],
					},
				],
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
							{ id: 'true', label: 'true' },
							{ id: 'false', label: 'false' },
						],
					},
				],
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
							{ id: 'true', label: 'true' },
							{ id: 'false', label: 'false' },
						],
					},
				],
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
							{ id: 'true', label: 'true' },
							{ id: 'false', label: 'false' },
						],
					},
				],
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
							{ id: 'true', label: 'true' },
							{ id: 'false', label: 'false' },
						],
					},
				],
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
							{ id: 'true', label: 'true' },
							{ id: 'false', label: 'false' },
						],
					},
				],
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
							{ id: 'true', label: 'true' },
							{ id: 'false', label: 'false' },
						],
					},
				],
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
							{ id: 'true', label: 'true' },
							{ id: 'false', label: 'false' },
						],
					},
				],
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
					},
					{
						type: 'dropdown',
						id: 'loop',
						label: 'Loop',
						default: 'true',
						choices: [
							{ id: 'true', label: 'true' },
							{ id: 'false', label: 'false' },
						],
					},
				],
				callback: async (evt, context) => {
					await this.sendCommand('LoopPlayer.Start', {
						Files: [
							{
								Name: await context.parseVariablesInString(evt.options.file_name),
								Mode: evt.options.mode,
								Output: await context.parseVariablesInString(evt.options.output),
							},
						],
						Name: await context.parseVariablesInString(evt.options.name), // Had to add name to the options array.
						StartTime: evt.options.startTime,
						Loop: evt.options.loop,
						Log: true,
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
					},
				],
				callback: async (evt, context) => {
					await this.sendCommand('LoopPlayer.Stop', {
						Name: await context.parseVariablesInString(evt.options.name),
						Outputs: await context.parseVariablesInString(evt.options.output),
						Log: true,
					})
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
					},
				],
				callback: async (evt, context) => {
					await this.sendCommand('LoopPlayer.Cancel', {
						Name: await context.parseVariablesInString(evt.options.name),
						Outputs: await context.parseVariablesInString(evt.options.output),
						Log: true,
					})
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
						default: '',
						tooltip: 'Specific bank number to recall from the snapshot',
					},
					{
						type: 'number',
						id: 'ramp',
						label: 'Ramp',
						tooltip: 'Time in seconds to ramp to banked snapshot',
					},
				],
				callback: async (evt, context) => {
					await this.sendCommand('Snapshot.Load', {
						Name: await context.parseVariablesInString(evt.options.name),
						Bank: evt.options.bank,
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
						default: '',
						tooltip: 'Specific bank number to save to within the snapshot',
					},
				],
				callback: async (evt, context) => {
					await this.sendCommand('Snapshot.Save', {
						Name: await context.parseVariablesInString(evt.options.name),
						Bank: evt.options.bank,
					})
				},
			},
		})
	}

	/**
	 * Update feedback definitions
	 * @access private
	 */

	initFeedbacks() {
		this.variables = []
		if (!this.config.feedback_enabled) {
			this.setFeedbackDefinitions({})
			return
		}

		const feedbacks = {
			'control-string': {
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
					const opt = feedback.options
					const control = this.controls.get(await context.parseVariablesInString(opt.name))
					if (!control.value) return

					switch (opt.type) {
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
			},
			'control-boolean': {
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
					const control = this.controls.get(await context.parseVariablesInString(opt.name))

					return (opt.value === 'true' && control.value) || (opt.value === 'false' && !control.value)
				},
			},
			'control-threshold': {
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
			},
			'control-fade': {
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
			},
		}

		this.setFeedbackDefinitions(feedbacks)
	}

	/**
	 * Add message to outbound queue and send
	 * @param {object} cmd Command object to send
	 * @param {QRC_GET | QRC_SET} get_set Get or Set method
	 * @access private
	 */

	async callCommandObj(cmd, get_set = QRC_SET) {
		cmd.jsonrpc = 2.0
		cmd.id = get_set
		await queue.add(async () => {
			if (this.moduleStatus.primary.state == 'Active' || cmd.method == 'StatusGet') {
				if (this.socket.pri && !this.socket.pri.isDestroyed && this.socket.pri.isConnected) {
					const sent = await this.socket.pri.send(JSON.stringify(cmd) + '\x00')
					if (sent) {
						if (this.console_debug) {
							console.log(`Q-SYS Sent to ${this.config.host}: ` + JSON.stringify(cmd) + '\r')
						}
					} else {
						this.log('warn', `Q-SYS Send to ${this.config.host} Failed: ` + JSON.stringify(cmd) + '\r')
					}
				} else {
					this.log(
						'warn',
						`Q-SYS Send to ${this.config.host} Failed as not connected. Message: ` + JSON.stringify(cmd) + '\r',
					)
				}
			}

			if (this.config.redundant) {
				if (this.moduleStatus.secondary.state == 'Active' || cmd.method == 'StatusGet') {
					if (this.socket.sec && !this.socket.sec.isDestroyed && this.socket.sec.isConnected) {
						const sent = await this.socket.sec.send(JSON.stringify(cmd) + '\x00')
						if (sent) {
							if (this.console_debug) {
								console.log(`Q-SYS Sent to ${this.config.hostSecondary}: ` + JSON.stringify(cmd) + '\r')
							}
						} else {
							this.log(
								'warn',
								`Q-SYS Send to ${this.config.hostSecondary} Failed. Message: ` + JSON.stringify(cmd) + '\r',
							)
						}
					} else {
						this.log(
							'warn',
							`Q-SYS Send to ${this.config.hostSecondary} Failed as not connected. Message: ` +
								JSON.stringify(cmd) +
								'\r',
						)
					}
				}
			}
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
	 * Query values of controls in this.controls
	 * @access private
	 */

	async getControlStatuses() {
		// It is possible to group multiple statuses; HOWEVER, if one doesn't exist, nothing will be returned...
		// thus, we send one at a time
		if (!('bundle_feedbacks' in this.config) || !this.config.bundle_feedbacks) {
			this.controls.forEach(async (x, k) => {
				const cmd = {
					method: 'Control.Get',
					params: [k],
				}

				await this.callCommandObj(cmd, QRC_GET)
			})
		} else {
			await this.callCommandObj(
				{
					method: 'Control.Get',
					params: [...this.controls.keys()],
				},
				QRC_GET,
			)
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

			this.setVariableDefinitions(this.variables)
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
			[`${name}_string`]: update.String ?? control.value,
			[`${name}_position`]: update.Position ?? control.position,
			[`${name}_value`]: update.Value ?? control.value,
		})
	}
}

runEntrypoint(QsysRemoteControl, UpgradeScripts)
