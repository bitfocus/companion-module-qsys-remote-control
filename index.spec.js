import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InstanceStatus } from '@companion-module/base'
import { QsysRemoteControl } from './index.js'
import { checkboxActionOptions, numberActionOptions, numberFeedbackOptions } from './upgrades.js'

// Stand-ins for the Companion host: an InstanceBase that swallows host calls, and a TCPHelper that records what is
// sent instead of opening a socket. Everything else in base is the real thing
vi.mock('@companion-module/base', async (importOriginal) => {
	const { EventEmitter } = await import('node:events')
	const actual = await importOriginal()
	const real = actual.default

	class FakeTCPHelper extends EventEmitter {
		isConnected = false
		isDestroyed = false
		sent = []
		// Methods whose send fails, as TCPHelper.send reports a failed write
		failing = new Set()

		async send(message) {
			const cmd = JSON.parse(message.slice(0, -1))
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
		checkFeedbacks() {}
		checkFeedbacksById() {}
		subscribeFeedbacks() {}
		recordAction() {}
	}

	return {
		...actual,
		default: { ...real, InstanceBase: FakeInstanceBase, TCPHelper: FakeTCPHelper, runEntrypoint: () => {} },
	}
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
	self.actions()
	self.initFeedbacks()
	return { actions: setActions.mock.lastCall[0], feedbacks: setFeedbacks.mock.lastCall[0] }
}

// The properties each input field type has in @companion-module/base 1.14
const COMMON_PROPERTIES = [
	'id',
	'type',
	'label',
	'tooltip',
	'description',
	'isVisible',
	'isVisibleExpression',
	'isVisibleData',
]
const FIELD_PROPERTIES = {
	'static-text': ['value'],
	colorpicker: ['default', 'enableAlpha', 'returnType', 'presetColors'],
	textinput: ['default', 'required', 'regex', 'useVariables', 'multiline'],
	dropdown: ['choices', 'default', 'allowCustom', 'regex', 'minChoicesForSearch'],
	multidropdown: ['choices', 'default', 'minChoicesForSearch', 'minSelection', 'maxSelection'],
	checkbox: ['default'],
	number: [
		'default',
		'required',
		'min',
		'max',
		'step',
		'range',
		'showMinAsNegativeInfinity',
		'showMaxAsPositiveInfinity',
	],
	'custom-variable': [],
	'bonjour-device': [],
	'secret-text': ['default', 'required', 'regex'],
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
		const { actions, feedbacks } = definitions()
		const problems = []

		for (const [id, def] of [...Object.entries(actions), ...Object.entries(feedbacks)]) {
			for (const option of def.options) {
				const where = `${id}.${option.id}`
				if (typeof option.label !== 'string') problems.push(`${where}: no label`)
				const properties = FIELD_PROPERTIES[option.type]
				if (properties === undefined) problems.push(`${where}: unknown field type ${option.type}`)
				for (const key of Object.keys(option)) {
					if (properties && !COMMON_PROPERTIES.includes(key) && !properties.includes(key)) {
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
					case 'dropdown':
						if (option.choices.some((choice) => !['string', 'number'].includes(typeof choice.id))) {
							problems.push(`${where}: choice id is not a string or number`)
						}
						if (!option.choices.some((choice) => choice.id === option.default)) {
							problems.push(`${where}: default matches no choice`)
						}
						break
				}
			}
		}

		expect(problems).toEqual([])
	})

	it('define each option fixOptionTypes converts as the type it converts to', () => {
		const { actions, feedbacks } = definitions()

		for (const [id, keys] of Object.entries(checkboxActionOptions)) {
			for (const key of keys) expect(field(actions, id, key)).toMatchObject({ type: 'checkbox', default: true })
		}
		for (const [defs, converted] of [
			[actions, numberActionOptions],
			[feedbacks, numberFeedbackOptions],
		]) {
			for (const [id, defaults] of Object.entries(converted)) {
				for (const [key, value] of Object.entries(defaults)) {
					expect(field(defs, id, key)).toMatchObject({ type: 'number', default: value })
				}
			}
		}
	})
})
