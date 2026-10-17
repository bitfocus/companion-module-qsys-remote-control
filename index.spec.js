import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InstanceStatus } from '@companion-module/base'
import QsysRemoteControl from './index.js'
import { UpdateCompositeElements } from './composites.js'
import { configFields } from './config.js'
import {
	checkboxActionOptions,
	numberActionOptions,
	numberFeedbackOptions,
	textToNumberActionOptions,
} from './upgrades.js'

// Stand-ins for the Companion host: an InstanceBase that swallows host calls, and a TCPHelper that records what is
// sent instead of opening a socket. Everything else in base is the real thing
vi.mock('@companion-module/base', async (importOriginal) => {
	const { EventEmitter } = await import('node:events')
	const actual = await importOriginal()

	class FakeTCPHelper extends EventEmitter {
		isConnected = false
		isDestroyed = false
		sent = []
		// Methods whose send fails, as TCPHelper.send reports a failed write
		failing = new Set()
		// While set, a send waits on it before writing, holding the queue behind it
		hold = undefined

		async send(message) {
			const cmd = JSON.parse(message.slice(0, -1))
			if (this.hold) await this.hold
			if (!this.isConnected || this.failing.has(cmd.method)) return false
			this.sent.push(cmd)
			return true
		}

		destroy() {
			this.isDestroyed = true
			this.isConnected = false
		}
	}

	class FakeInstanceBase {
		log() {}
		updateStatus() {}
		setVariableDefinitions() {}
		setVariableValues() {}
		setActionDefinitions() {}
		setFeedbackDefinitions() {}
		setCompositeElementDefinitions() {}
		checkFeedbacks() {}
		checkAllFeedbacks() {}
		checkFeedbacksById() {}
		recordAction() {}
	}

	return { ...actual, InstanceBase: FakeInstanceBase, TCPHelper: FakeTCPHelper }
})

// StatusGet result from an active, non-redundant core
const CORE_STATUS = {
	Platform: 'Core 110f',
	State: 'Active',
	DesignName: 'Test Design',
	DesignCode: 'abc123',
	IsRedundant: false,
	IsEmulator: false,
}

const UNKNOWN_CHANGE_GROUP = { code: 6, message: 'Unknown change group' }

function reply(self, message) {
	self.processResponse(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\x00', false)
}

async function reconnect(self, socket) {
	socket.isConnected = true
	socket.emit('connect')
	await vi.advanceTimersByTimeAsync(0)
	reply(self, { id: 2, result: CORE_STATUS })
}

async function connect(self) {
	self.init_tcp(self.config.host, self.config.port)
	const socket = self.socket.pri
	await reconnect(self, socket)
	return socket
}

function addControls(self, ...names) {
	names.forEach((name, i) => self.addControl({ id: `action${i}`, options: { name } }))
}

// Control and change group traffic, without keepalives and status queries
function traffic(socket) {
	return socket.sent
		.filter((cmd) => !['NoOp', 'StatusGet', 'Logon'].includes(cmd.method))
		.map((cmd) => {
			if (cmd.method === 'Control.Get') return [cmd.method, cmd.params]
			if (cmd.params?.Controls) return [cmd.method, cmd.params.Controls]
			return [cmd.method]
		})
}

const FULL_REBUILD = [
	['ChangeGroup.Destroy'],
	['Control.Get', ['gain', 'mute']],
	['ChangeGroup.AddControl', ['gain', 'mute']],
]

let self

beforeEach(() => {
	vi.useFakeTimers()
	self = new QsysRemoteControl({})
	self.id = 'test-group'
	self.config = { ...self.config, host: 'core.local', port: '1710' }
	self.secrets = { pass: '' }
})

afterEach(() => {
	self.killTimersDestroySockets()
	vi.useRealTimers()
})

// The action and feedback definitions as the module registers them with Companion
function definitions() {
	const setActions = vi.spyOn(self, 'setActionDefinitions')
	const setFeedbacks = vi.spyOn(self, 'setFeedbackDefinitions')
	const setComposites = vi.spyOn(self, 'setCompositeElementDefinitions')
	self.actions()
	self.initFeedbacks()
	UpdateCompositeElements(self)
	return {
		actions: setActions.mock.lastCall[0],
		feedbacks: setFeedbacks.mock.lastCall[0],
		composites: setComposites.mock.lastCall[0],
	}
}

// The properties each input field type has in @companion-module/base 2.2
const COMMON_PROPERTIES = [
	'id',
	'type',
	'label',
	'tooltip',
	'description',
	'expressionDescription',
	'isVisibleExpression',
	'disableAutoExpression',
	'allowInvalidValues',
]
const FIELD_PROPERTIES = {
	'static-text': ['value'],
	colorpicker: ['default', 'enableAlpha', 'returnType', 'presetColors'],
	textinput: ['default', 'minLength', 'regex', 'useVariables', 'multiline'],
	dropdown: ['choices', 'default', 'allowCustom', 'regex', 'minChoicesForSearch'],
	multidropdown: ['choices', 'default', 'minChoicesForSearch', 'minSelection', 'maxSelection', 'sortSelection'],
	checkbox: ['default'],
	number: [
		'default',
		'min',
		'max',
		'step',
		'range',
		'showMinAsNegativeInfinity',
		'showMaxAsPositiveInfinity',
		'clampValues',
		'asInteger',
	],
	'custom-variable': [],
	'bonjour-device': [],
	'secret-text': ['default', 'minLength', 'regex'],
}

// Every list of options the module defines, by where it is defined
function optionLists() {
	const { actions, feedbacks, composites } = definitions()
	return [
		...Object.entries(actions).map(([id, def]) => [`action ${id}`, def.options]),
		...Object.entries(feedbacks).map(([id, def]) => [`feedback ${id}`, def.options]),
		...Object.entries(composites).map(([id, def]) => [`composite ${id}`, def.options]),
		['config', configFields],
	]
}

describe('status, not redundant', () => {
	it.each([
		['end', [], InstanceStatus.Disconnected, 'Connection to core.local ended'],
		['error', [new Error('read ECONNRESET')], InstanceStatus.ConnectionFailure, ''],
	])('reports a connection %s, not the core state from before it', async (event, args, status, message) => {
		const updateStatus = vi.spyOn(self, 'updateStatus')
		const socket = await connect(self)
		await vi.advanceTimersByTimeAsync(1500)
		expect(updateStatus).toHaveBeenLastCalledWith(InstanceStatus.Ok, 'Core active')

		socket.isConnected = false
		socket.emit(event, ...args)
		await vi.advanceTimersByTimeAsync(1500)
		expect(updateStatus).toHaveBeenLastCalledWith(status, message)

		await reconnect(self, socket)
		await vi.advanceTimersByTimeAsync(1500)
		expect(updateStatus).toHaveBeenLastCalledWith(InstanceStatus.Ok, 'Core active')
	})

	it('reports the core state while connected', async () => {
		const updateStatus = vi.spyOn(self, 'updateStatus')
		self.init_tcp(self.config.host, self.config.port)
		const socket = self.socket.pri
		socket.isConnected = true
		socket.emit('connect')
		await vi.advanceTimersByTimeAsync(0)
		reply(self, { id: 2, result: { ...CORE_STATUS, State: 'Standby' } })
		await vi.advanceTimersByTimeAsync(1500)

		expect(updateStatus).toHaveBeenLastCalledWith(InstanceStatus.UnknownWarning, 'Core state standby')
	})
})

describe('change group', () => {
	it('builds the group with every control, then polls it', async () => {
		const socket = await connect(self)
		addControls(self, 'gain', 'mute')
		await vi.advanceTimersByTimeAsync(3000)

		expect(traffic(socket)).toContainEqual(['ChangeGroup.AddControl', ['gain', 'mute']])
		expect(self.changeGroupSet).toBe(true)

		socket.sent.length = 0
		await self.getControlStatuses()
		expect(traffic(socket)).toEqual([['ChangeGroup.Poll']])
	})

	it('polls with Control.Get when there are no controls to group', async () => {
		const socket = await connect(self)
		await vi.advanceTimersByTimeAsync(3000)

		expect(traffic(socket)).not.toContainEqual(expect.arrayContaining(['ChangeGroup.AddControl']))
		expect(self.changeGroupSet).toBe(false)
	})

	it('rebuilds the group on reconnect, polling with Control.Get until it exists', async () => {
		const socket = await connect(self)
		addControls(self, 'gain', 'mute')
		await vi.advanceTimersByTimeAsync(3000)
		expect(self.changeGroupSet).toBe(true)

		// TCPHelper reconnects the same socket
		socket.isConnected = false
		socket.emit('end')
		socket.sent.length = 0
		await reconnect(self, socket)

		expect(self.changeGroupSet).toBe(false)
		await self.getControlStatuses()
		expect(traffic(socket)).toEqual([['Control.Get', ['gain', 'mute']]])

		socket.sent.length = 0
		await vi.advanceTimersByTimeAsync(3000)
		expect(traffic(socket)).toEqual(FULL_REBUILD)
		expect(self.changeGroupSet).toBe(true)
	})

	it('builds the group once a standby core goes active', async () => {
		self.init_tcp(self.config.host, self.config.port)
		const socket = self.socket.pri
		socket.isConnected = true
		socket.emit('connect')
		await vi.advanceTimersByTimeAsync(0)
		reply(self, { id: 2, result: { ...CORE_STATUS, State: 'Standby' } })
		addControls(self, 'gain', 'mute')
		await vi.advanceTimersByTimeAsync(3000)

		// A standby core is only sent status queries and keepalives, so the rebuild on connect went nowhere
		expect(traffic(socket)).toEqual([])
		expect(self.changeGroupSet).toBe(false)

		const { Platform: _platform, ...engineStatus } = CORE_STATUS
		reply(self, { method: 'EngineStatus', params: engineStatus })
		await vi.advanceTimersByTimeAsync(3000)

		expect(traffic(socket)).toEqual(FULL_REBUILD)
		expect(self.changeGroupSet).toBe(true)
	})

	it('rebuilds every control, not just a new one, once the group is lost', async () => {
		const socket = await connect(self)
		addControls(self, 'gain', 'mute')
		await vi.advanceTimersByTimeAsync(3000)

		// Reconnecting loses the group, and the rebuild cannot send its AddControl, so no group exists
		socket.failing.add('ChangeGroup.AddControl')
		socket.isConnected = false
		socket.emit('end')
		await reconnect(self, socket)
		await vi.advanceTimersByTimeAsync(3000)
		expect(self.changeGroupSet).toBe(false)

		socket.failing.clear()
		socket.sent.length = 0
		self.addControl({ id: 'action2', options: { name: 'level' } })
		await vi.advanceTimersByTimeAsync(3000)

		expect(traffic(socket)).toContainEqual(['ChangeGroup.AddControl', ['gain', 'mute', 'level']])
		expect(traffic(socket)).not.toContainEqual(['ChangeGroup.AddControl', ['level']])
		expect(self.changeGroupSet).toBe(true)
	})

	it('rebuilds the group when a poll reports it unknown', async () => {
		const socket = await connect(self)
		addControls(self, 'gain', 'mute')
		await vi.advanceTimersByTimeAsync(3000)
		socket.sent.length = 0

		reply(self, { id: 1, error: UNKNOWN_CHANGE_GROUP })
		expect(self.changeGroupSet).toBe(false)

		await vi.advanceTimersByTimeAsync(1000)
		expect(traffic(socket)).toEqual(FULL_REBUILD)
		expect(self.changeGroupSet).toBe(true)
	})

	it('ignores the unknown group error returned to its own Destroy', async () => {
		const socket = await connect(self)
		addControls(self, 'gain', 'mute')
		await vi.advanceTimersByTimeAsync(3000)
		socket.sent.length = 0

		// A rebuild on a fresh connection destroys a group the core never had. Treating this like a poll's error
		// would rebuild, destroy and error again, forever
		reply(self, { id: 2, error: UNKNOWN_CHANGE_GROUP })
		await vi.advanceTimersByTimeAsync(3000)

		expect(traffic(socket)).toEqual([])
		expect(self.changeGroupSet).toBe(true)
	})

	it('drops a pending rebuild when the config changes', async () => {
		await connect(self)
		addControls(self, 'gain', 'mute')
		await vi.advanceTimersByTimeAsync(3000)
		const changeGroup = vi.spyOn(self, 'changeGroup')

		self.resetChangeGroup()
		self.killTimersDestroySockets()
		await vi.advanceTimersByTimeAsync(3000)

		expect(changeGroup).not.toHaveBeenCalled()
	})
})

describe('loopPlayer_start', () => {
	it('sends the chosen channel as the file mode', async () => {
		const socket = await connect(self)
		const { actions } = definitions()
		socket.sent.length = 0

		await actions.loopPlayer_start.callback(
			{
				id: 'action0',
				actionId: 'loopPlayer_start',
				options: {
					file_name: 'intro.wav',
					channel: 'mono',
					output: '2',
					name: 'Loop Player',
					startTime: 0,
					seek: 0,
					loop: true,
					refID: 'ref',
				},
			},
			{},
		)

		expect(socket.sent).toContainEqual(
			expect.objectContaining({
				method: 'LoopPlayer.Start',
				params: expect.objectContaining({ Files: [{ Name: 'intro.wav', Mode: 'mono', Output: 2 }] }),
			}),
		)
	})
})

describe('option definitions', () => {
	const field = (defs, id, key) => defs[id].options.find((option) => option.id === key)

	it('match the field type they declare', () => {
		const problems = []

		for (const [id, options] of optionLists()) {
			// Config fields also take a width, for the layout of the config page
			const extra = id === 'config' ? ['width'] : []
			for (const option of options) {
				const where = `${id}.${option.id}`
				if (typeof option.label !== 'string') problems.push(`${where}: no label`)
				const properties = FIELD_PROPERTIES[option.type]
				if (properties === undefined) problems.push(`${where}: unknown field type ${option.type}`)
				for (const key of Object.keys(option)) {
					if (properties && ![...COMMON_PROPERTIES, ...extra, ...properties].includes(key)) {
						problems.push(`${where}: ${option.type} field has no ${key}`)
					}
				}
				switch (option.type) {
					case 'number':
						for (const key of ['default', 'min', 'max']) {
							if (typeof option[key] !== 'number') problems.push(`${where}: ${key} is not a number`)
						}
						break
					case 'checkbox':
						if (typeof option.default !== 'boolean') problems.push(`${where}: default is not a boolean`)
						break
					case 'textinput':
						if ('useVariables' in option && typeof option.useVariables !== 'boolean') {
							problems.push(`${where}: useVariables is not a boolean`)
						}
						break
					case 'dropdown':
						if (!option.choices.some((choice) => choice.id === option.default)) {
							problems.push(`${where}: default matches no choice`)
						}
						break
				}
			}
		}

		expect(problems).toEqual([])
	})

	// Companion only allows isVisibleExpression to read options that can't be switched into expression mode
	it('only show or hide options by others that cannot be expressions', () => {
		const problems = []

		for (const [id, options] of optionLists()) {
			for (const option of options) {
				for (const [, key] of (option.isVisibleExpression ?? '').matchAll(/\$\(options:(\w+)\)/g)) {
					const read = options.find((other) => other.id === key)
					if (!read) problems.push(`${id}.${option.id}: reads ${key}, which is not an option`)
					else if (read.disableAutoExpression !== true)
						problems.push(`${id}.${option.id}: reads ${key}, which can be an expression`)
				}
			}
		}

		expect(problems).toEqual([])
	})

	it('declare what each advanced feedback changes, and give no feedback a subscribe hook', () => {
		const { feedbacks } = definitions()

		for (const [id, def] of Object.entries(feedbacks)) {
			expect(def, id).not.toHaveProperty('subscribe')
			if (def.type === 'advanced') expect(Array.isArray(def.affectedProperties), id).toBe(true)
		}
	})

	it("name the options that re-run an action's subscribe hook", () => {
		const { actions } = definitions()

		for (const [id, def] of Object.entries(actions)) {
			if (!def.subscribe) continue
			const ids = def.options.map((option) => option.id)
			expect(def.optionsToMonitorForSubscribe?.length, id).toBeGreaterThan(0)
			for (const key of def.optionsToMonitorForSubscribe) expect(ids, `${id} monitors ${key}`).toContain(key)
		}
	})

	it('define each option an upgrade script converts as the type it converts to', () => {
		const { actions, feedbacks } = definitions()

		for (const [id, keys] of Object.entries(checkboxActionOptions)) {
			for (const key of keys) expect(field(actions, id, key)).toMatchObject({ type: 'checkbox', default: true })
		}
		for (const [defs, converted] of [
			[actions, numberActionOptions],
			[feedbacks, numberFeedbackOptions],
			[actions, textToNumberActionOptions],
		]) {
			for (const [id, defaults] of Object.entries(converted)) {
				for (const [key, value] of Object.entries(defaults)) {
					expect(field(defs, id, key)).toMatchObject({ type: 'number', default: value })
				}
			}
		}
	})
})

describe('feedbacks', () => {
	const event = (feedbackId, options, extra = {}) => ({
		id: `${feedbackId}-1`,
		feedbackId,
		type: 'boolean',
		controlId: 'bank:1:1',
		options,
		previousOptions: null,
		...extra,
	})

	// Feedbacks have no subscribe hook in API 2.x, so the callback is where a control first gets polled
	it('register the control they read from their callback', async () => {
		const socket = await connect(self)
		await vi.advanceTimersByTimeAsync(3000)
		const { feedbacks } = definitions()
		socket.sent.length = 0

		const result = await feedbacks['control-boolean'].callback(
			event('control-boolean', { name: ' Gain ', value: 'true' }),
			{},
		)
		await vi.advanceTimersByTimeAsync(3000)

		expect(result).toBe(false)
		expect(self.controls.get('Gain')?.feedbackIds).toEqual(new Set(['control-boolean-1']))
		expect(traffic(socket)).toContainEqual(['Control.Get', ['Gain']])
		expect(traffic(socket)).toContainEqual(['ChangeGroup.AddControl', ['Gain']])
	})

	// A feedback has no name until the user types one, and an empty control would break the change group
	it('register nothing for a feedback with no name yet', async () => {
		const socket = await connect(self)
		const { feedbacks } = definitions()

		await feedbacks['control-value'].callback(event('control-value', { name: '' }, { type: 'value' }), {})
		await vi.advanceTimersByTimeAsync(3000)

		expect(self.controls.size).toBe(0)
		expect(traffic(socket)).not.toContainEqual(expect.arrayContaining(['ChangeGroup.AddControl']))
	})

	// Equal thresholds left nothing to fade across, and the colour maths came out NaN
	it('warn when a fade has no range to fade across, once per setting, and draw nothing', async () => {
		const { feedbacks } = definitions()
		const log = vi.spyOn(self, 'log')
		const warnings = () => log.mock.calls.filter(([level]) => level === 'warn')
		const options = { name: 'Gain', low_threshold: 0, high_threshold: 0, low_bg: 0x000000, high_bg: 0xff0000 }
		const fade = event('control-fade', options, { type: 'advanced' })
		await feedbacks['control-fade'].callback(fade, {})
		self.updateControl({ Name: 'Gain', Value: 0, Position: 0.5, String: '0.0dB' })

		// Rechecked as the value changes, with the same thresholds
		const result = await feedbacks['control-fade'].callback({ ...fade, previousOptions: options }, {})

		expect(result).toEqual({})
		expect(warnings()).toHaveLength(1)

		const reversed = { ...options, low_threshold: 10, high_threshold: -10 }
		await feedbacks['control-fade'].callback({ ...fade, options: reversed, previousOptions: options }, {})
		expect(warnings()).toHaveLength(2)

		const valid = { ...options, low_threshold: -10, high_threshold: 10 }
		expect(
			await feedbacks['control-fade'].callback({ ...fade, options: valid, previousOptions: reversed }, {}),
		).toEqual({
			bgcolor: 0x800000,
		})
		expect(warnings()).toHaveLength(2)
	})

	// imageBuffer is a base64 string in API 2.x; companion-module-utils draws 32 bit ARGB
	it('return images as base64 ARGB', async () => {
		const { feedbacks } = definitions()
		const meter = event(
			'level-meter',
			{
				name: 'Gain',
				position: 'right',
				padding: 1,
				offset: 5,
				width: 6,
				max: 0,
				min: -100,
				valPos: false,
				invertMeter: false,
				invertValue: false,
				customColor: false,
				color: 0xffffff,
			},
			{ type: 'advanced', image: { width: 72, height: 72 } },
		)
		await feedbacks['level-meter'].callback(meter, {})
		self.updateControl({ Name: 'Gain', Value: -20, Position: 0.8, String: '-20.0dB' })

		const result = await feedbacks['level-meter'].callback(meter, {})

		expect(result.imageBufferEncoding).toEqual({ pixelFormat: 'ARGB' })
		expect(typeof result.imageBuffer).toBe('string')
		expect(Buffer.from(result.imageBuffer, 'base64').length).toBe(72 * 72 * 4)
		// Not every button has an image to draw on
		expect(await feedbacks['level-meter'].callback({ ...meter, image: undefined }, {})).toEqual({})
	})
})

describe('variables', () => {
	it('are defined keyed by id', async () => {
		const setVariableDefinitions = vi.spyOn(self, 'setVariableDefinitions')

		addControls(self, 'Gain')
		await vi.advanceTimersByTimeAsync(1000)

		expect(setVariableDefinitions.mock.lastCall[0]).toEqual({
			Gain_value: { name: 'Gain Value' },
			Gain_position: { name: 'Gain Position' },
			Gain_string: { name: 'Gain String' },
		})
	})
})

describe('actions', () => {
	const event = (actionId, options) => ({
		id: `${actionId}-1`,
		actionId,
		controlId: 'bank:1:1',
		options,
		surfaceId: undefined,
	})

	it('learn only the options they learned', async () => {
		const { actions } = definitions()
		addControls(self, 'Gain')
		self.updateControl({ Name: 'Gain', Value: -6, Position: 0.7, String: '-6.0dB' })

		const learned = await actions.control_set.learn(
			event('control_set', { name: 'Gain', value: '0', type: 'string', relative: true, ramp: 2, min: -10, max: 0 }),
			{ type: 'action', signal: new AbortController().signal },
		)

		expect(learned).toEqual({ relative: false, value: '-6', type: 'number' })
	})

	it('drop a request still waiting to be sent once their action is aborted', async () => {
		const socket = await connect(self)
		await vi.advanceTimersByTimeAsync(3000)
		const { actions } = definitions()
		socket.sent.length = 0

		// Hold the queue on a send still being written, so the action's request waits behind it
		let release
		socket.hold = new Promise((resolve) => (release = resolve))
		const busy = self.sendCommand('NoOp', {})
		const controller = new AbortController()
		const done = actions.statusGet.callback(event('statusGet', {}), { type: 'action', signal: controller.signal })

		controller.abort()
		release()
		socket.hold = undefined
		await Promise.all([busy, done])

		expect(socket.sent.map((cmd) => cmd.method)).toEqual(['NoOp'])
	})
})

describe('connection', () => {
	it('does not poll, or log failed sends, while no active core is connected', async () => {
		const socket = await connect(self)
		addControls(self, 'gain')
		await vi.advanceTimersByTimeAsync(3000)
		const log = vi.spyOn(self, 'log')

		socket.isConnected = false
		socket.emit('end')
		log.mockClear()
		for (let poll = 0; poll < 3; poll++) await self.getControlStatuses()

		expect(log.mock.calls.filter(([level]) => level === 'warn')).toEqual([])

		await reconnect(self, socket)
		socket.sent.length = 0
		await self.getControlStatuses()
		expect(traffic(socket)).toEqual([['Control.Get', ['gain']]])
	})

	// p-queue 10 rejects queued requests when the queue is cleared, so the connect handler carries on after a drop
	it('leaves a connection that ends while it is being set up marked as down', async () => {
		self.init_tcp(self.config.host, self.config.port)
		const socket = self.socket.pri
		socket.isConnected = true
		// Hold the queue on a send, so the StatusGet sent on connecting waits behind it
		let release
		socket.hold = new Promise((resolve) => (release = resolve))
		const busy = self.sendCommand('NoOp', {})
		socket.emit('connect')
		await vi.advanceTimersByTimeAsync(0)

		socket.isConnected = false
		socket.emit('end')
		release()
		socket.hold = undefined
		await busy
		await vi.advanceTimersByTimeAsync(0)

		expect(self.moduleStatus.status).toBe(InstanceStatus.Disconnected)
	})
})

describe('unused controls', () => {
	const LEVEL = { Name: 'Level', Value: -12, String: '-12.0dB', Position: 0.6 }
	const rebuildOf = (...names) => [['ChangeGroup.Destroy'], ['Control.Get', names], ['ChangeGroup.AddControl', names]]

	it('are not polled when a reply for one arrives after it was removed', async () => {
		const socket = await connect(self)
		addControls(self, 'gain', 'mute')
		await vi.advanceTimersByTimeAsync(3000)

		await self.removeControl({ id: 'action1', options: { name: 'mute' } })
		// The answer to a poll sent before mute was removed
		reply(self, {
			id: 1,
			result: { Id: 'test-group', Changes: [{ Name: 'mute', Value: 1, String: 'muted', Position: 1 }] },
		})
		socket.sent.length = 0
		self.resetChangeGroup()
		await vi.advanceTimersByTimeAsync(1000)

		expect(traffic(socket)).toEqual(rebuildOf('gain'))
	})

	it('keep a learned value without polling its control', async () => {
		const socket = await connect(self)
		addControls(self, 'gain')
		await vi.advanceTimersByTimeAsync(3000)
		const { actions } = definitions()
		const learn = () =>
			actions.control_set.learn(
				{ id: 'set-1', actionId: 'control_set', controlId: 'bank:1:1', options: { name: 'Level', value: '' } },
				{ type: 'action', signal: new AbortController().signal },
			)

		// Not known yet, so it asks for the value
		expect(await learn()).toBeUndefined()
		reply(self, { id: 1, result: [LEVEL] })
		expect(await learn()).toEqual({ relative: false, value: '-12', type: 'number' })

		socket.sent.length = 0
		self.resetChangeGroup()
		await vi.advanceTimersByTimeAsync(1000)
		expect(traffic(socket)).toEqual(rebuildOf('gain'))
	})

	it('are fetched and grouped once something uses them, though a reply mentioned them first', async () => {
		const socket = await connect(self)
		addControls(self, 'gain')
		await vi.advanceTimersByTimeAsync(3000)
		reply(self, { id: 1, result: [LEVEL] })
		const setVariableDefinitions = vi.spyOn(self, 'setVariableDefinitions')
		socket.sent.length = 0

		self.addControl({ id: 'action9', options: { name: 'Level' } })
		await vi.advanceTimersByTimeAsync(1000)

		expect(traffic(socket)).toEqual([
			['Control.Get', ['Level']],
			['ChangeGroup.AddControl', ['Level']],
		])
		expect(setVariableDefinitions.mock.lastCall[0]).toHaveProperty('Level_value', { name: 'Level Value' })
	})
})
