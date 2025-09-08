import {
	// eslint-disable-next-line no-unused-vars
	CompanionActionInfo,
	// eslint-disable-next-line no-unused-vars
	CompanionActionContext,
	// eslint-disable-next-line no-unused-vars
	CompanionFeedbackInfo,
	// eslint-disable-next-line no-unused-vars
	CompanionFeedbackContext,
	// eslint-disable-next-line no-unused-vars
	InstanceBase,
	InstanceStatus,
	// eslint-disable-next-line no-unused-vars
	TCPHelper,
} from '@companion-module/base'

import {
	// eslint-disable-next-line no-unused-vars
	QsysRemoteControl,
} from './index.js'

/**
 * Perform type conversion on value
 * @param {number} value
 * @param {string} name
 * @param {CompanionActionInfo} evt
 * @param {CompanionActionContext} context
 * @param {Map<string, object>} controls
 * @param {InstanceBase} self
 * @returns {Promise<number | undefined>}
 * @since 3.0.0
 */

export const calcRelativeValue = async (value, name, evt, context, controls, self) => {
	const control = controls.get(name)
	const min = Number.parseFloat(await context.parseVariablesInString(evt.options.min))
	const max = Number.parseFloat(await context.parseVariablesInString(evt.options.max))
	if (control == undefined || control.value == null) {
		self.log('warn', `Do not have existing value of ${name}, cannot perform action ${evt.actionId}:${evt.id}`)
		return undefined
	}
	value = Number(value) + Number(control.value)
	if (isNaN(value)) {
		self.log('warn', `Result value is a NaN, cannot perform action ${evt.actionId}:${evt.id}`)
		return undefined
	}
	if (!isNaN(min)) value = value < min ? min : value
	if (!isNaN(max)) value = value > max ? max : value
	return value
}

/**
 * Perform type conversion on value
 * @param {string | number} value
 * @param {'string' | 'boolean' | 'number'} type
 * @returns {string | number | boolean }
 * @since 3.0.0
 */

export const convertValueType = (value, type) => {
	switch (type) {
		case 'number':
			value = Number(value)
			if (Number.isNaN(value)) return undefined
			return value
		case 'boolean':
			if (value.toLowerCase().trim() == 'false' || value.trim() == '0') {
				return false
			} else if (value.toLowerCase().trim() == 'true' || value.trim() == '1') {
				return true
			} else {
				return Boolean(value)
			}
		case `string`:
		default:
			return String(value)
	}
}

/**
 * Remove illegal characters from variable Ids
 * @param {string} id variable id to sanitize
 * @param {'' | '.' | '-' | '_'} substitute Char to replace illegal characters
 * @since 3.0.0
 */

export const sanitiseVariableId = (id, substitute = '_') => id.replaceAll(/[^a-zA-Z0-9-_.]/gm, substitute)

/**
 * Build valid array of outputs
 * @param {CompanionActionInfo} evt
 * @param {CompanionActionContext} context
 * @returns {Promise<number[] | undefined>}
 *  * @param {InstanceBase} self
 * @since 3.0.0
 */
export const buildFilteredOutputArray = async (evt, context, self) => {
	let filteredOutputs = []
	const outputs = (await context.parseVariablesInString(evt.options.output))
		.split(',')
		.map((out) => Number.parseInt(out))
	outputs.forEach((out) => {
		if (!isNaN(out) && out > 0 && !filteredOutputs.includes(out)) filteredOutputs.push(out)
	})
	if (filteredOutputs.length == 0) {
		self.log('warn', `No valid elements for ${evt.actionId}:${evt.id}`)
		return undefined
	}
	return filteredOutputs.sort((a, b) => a - b)
}

/**
 * Return new moduleStatus object
 * @returns {object} new moduleStatus
 * @since 3.0.0
 */

export const resetModuleStatus = () => {
	return {
		status: InstanceStatus.Connecting,
		message: '',
		logLevel: 'debug',
		logMessage: '',
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
 * Add message to outbound queue and send
 * @param {object} cmd Command object to send
 * @returns {boolean} If cmd.method is OK to send to core that isn't active
 */

export const validMethodsToStandbyCore = (cmd) => {
	const validMethods = ['StatusGet', 'NoOp', 'Logon'] //Add methods here that are OK to send to core that is in Standby or Idle
	return validMethods.includes(cmd?.method)
}

/**
 * Check if socket is ok to send data
 * @param {TCPHelper} socket
 * @returns {boolean}
 */

export const isSocketOkToSend = (socket) => {
	return socket && !socket.isDestroyed && socket.isConnected
}

/**
 * Check if the core is active
 * @param {object} engine
 * @returns {boolean}
 */

export const isCoreActive = (engine) => {
	return engine.state == 'Active'
}

/**
 * Parse array of names from comma seperated list
 * @param {CompanionActionInfo} action
 * @param {CompanionActionContext} context
 * @returns {Promise<string[]>}
 */

export const namesArray = async (action, context) => {
	const names = (await context.parseVariablesInString(action.options.name)).split(',')
	let namesArray = []
	names.forEach(async (name) => {
		const trimmedName = name.trim()
		if (trimmedName !== '') namesArray.push(trimmedName)
	})
	return namesArray
}

/**
 * Converts value to a percentage value of the range between min and max. NaN and -ve values return 0.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns rounded percentage
 */

export const valueToPercent = (value, min = 0, max = 100) => {
	const percent = ((value - min) / (max - min)) * 100
	return Number.isNaN(percent) || percent < 0 ? 0 : Math.round(percent)
}
