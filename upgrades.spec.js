import { describe, expect, it } from 'vitest'
import { fixOptionTypes } from './upgrades.js'

function upgrade({ actions = [], feedbacks = [] }) {
	return fixOptionTypes({ currentConfig: {} }, { config: null, secrets: null, actions, feedbacks })
}

const action = (actionId, options) => ({ id: `${actionId}-1`, controlId: 'bank:1:1', actionId, options })
const feedback = (feedbackId, options) => ({
	id: `${feedbackId}-1`,
	controlId: 'bank:1:1',
	feedbackId,
	options,
	isInverted: false,
})

describe('fixOptionTypes', () => {
	it('turns a true/false dropdown saved on its default into a checkbox value', () => {
		const mute = action('mixer_setInputMute', { name: 'Mixer', inputs: '1', value: 'true' })
		const loop = action('loopPlayer_start', { name: 'Player', file_name: 'a.wav', loop: 'true' })

		const result = upgrade({ actions: [mute, loop] })

		expect(mute.options.value).toBe(true)
		expect(loop.options.loop).toBe(true)
		expect(result.updatedActions).toEqual([mute, loop])
	})

	it('keeps checkbox values already saved as booleans, and does not report them', () => {
		const on = action('mixer_setCueMute', { name: 'Mixer', cues: '1', value: true })
		const off = action('mixer_setCrossPointSolo', { name: 'Mixer', inputs: '1', outputs: '1', value: false })

		const result = upgrade({ actions: [on, off] })

		expect(on.options.value).toBe(true)
		expect(off.options.value).toBe(false)
		expect(result.updatedActions).toEqual([])
	})

	it('replaces the empty default of a number option with a number', () => {
		const page = action('page_submit_message', { zones: '1', priority: '', preamble: '', message: '' })
		const threshold = feedback('control-threshold', { name: 'Gain', threshold: '' })
		const fade = feedback('control-fade', { name: 'Gain', low_threshold: '', high_threshold: '-3' })

		const result = upgrade({ actions: [page], feedbacks: [threshold, fade] })

		expect(page.options.priority).toBe(1)
		expect(threshold.options.threshold).toBe(0)
		// A number saved as text keeps its value
		expect(fade.options).toMatchObject({ low_threshold: 0, high_threshold: -3 })
		expect(result.updatedActions).toEqual([page])
		expect(result.updatedFeedbacks).toEqual([threshold, fade])
	})

	it('leaves options it does not convert alone', () => {
		// Control.Set's value is a text input, where 'true' is a valid value
		const set = action('control_set', { name: 'Gain', value: 'true', type: 'boolean' })
		const page = action('page_submit_message', { zones: '1', priority: 3, preamble: '', message: '' })
		const threshold = feedback('control-threshold', { name: 'Gain', threshold: -6 })

		const result = upgrade({ actions: [set, page], feedbacks: [threshold] })

		expect(set.options.value).toBe('true')
		expect(page.options.priority).toBe(3)
		expect(threshold.options.threshold).toBe(-6)
		expect(result).toMatchObject({ updatedActions: [], updatedFeedbacks: [] })
	})
})
