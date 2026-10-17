import { InstanceStatus } from '@companion-module/base'

/**
 * Perform type conversion on value
 * @param {number} value
 * @param {string} name
 * @param {import('@companion-module/base').CompanionActionInfo} evt
 * @param {Map<string, object>} controls
 * @returns {number | undefined}
 * @throws If Calculation fails or is a NaN
 * @since 3.0.0
 */

export const calcRelativeValue = (value, name, evt, controls) => {
	const control = controls.get(name)
	const min = Number.parseFloat(evt.options.min)
	const max = Number.parseFloat(evt.options.max)
	if (control == undefined || control.value == null) {
		throw new Error(`Do not have existing value of ${name}, cannot perform action ${evt.actionId}:${evt.id}`)
	}
	value = Number(value) + Number(control.value)
	if (isNaN(value)) {
		throw new Error(`Result value is a NaN, cannot perform action ${evt.actionId}:${evt.id}`)
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
 * @param {import('@companion-module/base').CompanionActionInfo} evt
 * @param {import('./index.js').default} self
 * @returns {number[]}
 * @since 3.0.0
 */
export const buildFilteredOutputArray = (evt, self) => {
	let filteredOutputs = []
	const outputs = evt.options.output.split(',').map((out) => Number.parseInt(out))
	outputs.forEach((out) => {
		if (!Number.isNaN(out) && out > 0 && !filteredOutputs.includes(out)) filteredOutputs.push(out)
	})
	if (filteredOutputs.length == 0) {
		self.log('warn', `No valid elements for ${evt.actionId}:${evt.id}`)
		return []
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
 * @param {import('@companion-module/base').CompanionActionInfo} action
 * @returns {string[]}
 */

export const namesArray = (action) => {
	const names = action.options.name.split(',')
	const result = []
	names.forEach((name) => {
		const trimmedName = name.trim()
		if (trimmedName !== '') result.push(trimmedName)
	})
	return result
}

/**
 * Converts value to a percentage value of the range between min and max. NaN and -ve values return 0.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @param {boolean} invert
 * @returns rounded percentage
 */

export const valueToPercent = (value, min = 0, max = 100, invert = false) => {
	if (typeof value == 'string') value = Number.parseFloat(value)
	const percent = ((value - min) / (max - min)) * 100
	let result = Number.isNaN(percent) || percent < 0 ? 0 : Math.round(percent)
	return invert ? 100 - result : result
}

/**
 * Variable definitions keyed by variable id, as setVariableDefinitions takes them
 * @param {{ variableId: string, name: string }[]} variables
 * @returns {import('@companion-module/base').CompanionVariableDefinitions}
 */

export const variableDefinitions = (variables) =>
	Object.fromEntries(variables.map(({ variableId, name }) => [variableId, { name }]))

/**
 * Advanced feedback result for an image drawn by companion-module-utils, which draws 32 bit ARGB
 * @param {Uint8Array} buffer
 * @returns {import('@companion-module/base').CompanionAdvancedFeedbackResult}
 */

export const imageResult = (buffer) => ({
	imageBuffer: Buffer.from(buffer).toString('base64'),
	imageBufferEncoding: { pixelFormat: 'ARGB' },
})
