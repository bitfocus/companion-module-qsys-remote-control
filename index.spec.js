import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QsysRemoteControl } from './index.js'

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

		// TCPHelper reconnects the same socket. The core still reports Active, so the module status never changes and
		// the status hook does not fire
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
})
