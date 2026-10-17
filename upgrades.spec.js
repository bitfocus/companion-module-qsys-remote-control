import { describe, expect, it } from 'vitest'
import {
	fixBooleanValues,
	fixOptionTypes,
	loopPlayerStartSeek,
	relativeControlSet,
	textToNumberOptions,
} from './upgrades.js'

function upgrade(script, { actions = [], feedbacks = [] }) {
	return script({ currentConfig: {} }, { config: null, secrets: null, actions, feedbacks })
}

// Companion passes saved options to upgrade scripts wrapped like this
const fixed = (value) => ({ value, isExpression: false })
const expression = (value) => ({ value, isExpression: true })
const wrap = (options) => Object.fromEntries(Object.entries(options).map(([key, value]) => [key, fixed(value)]))

const action = (actionId, options) => ({ id: `${actionId}-1`, controlId: 'bank:1:1', actionId, options: wrap(options) })
const feedback = (feedbackId, options) => ({
	id: `${feedbackId}-1`,
	controlId: 'bank:1:1',
	feedbackId,
	options: wrap(options),
	isInverted: fixed(false),
})

describe('relativeControlSet', () => {
	it('fills in the options Control.Set gained', () => {
		const set = action('control_set', { name: 'Gain', value: '-6' })

		upgrade(relativeControlSet, { actions: [set] })

		expect(set.options).toMatchObject({
			relative: fixed(false),
			min: fixed(''),
			max: fixed(''),
			type: fixed('string'),
			ramp: fixed(''),
		})
	})
})

describe('loopPlayerStartSeek', () => {
	it('fills in seek and refID, keeping saved values', () => {
		const start = action('loopPlayer_start', { name: 'Player', seek: 5 })

		upgrade(loopPlayerStartSeek, { actions: [start] })

		expect(start.options).toMatchObject({ seek: fixed(5), refID: fixed('') })
	})
})

describe('fixBooleanValues', () => {
	it('turns the saved true/false strings into booleans', () => {
		const mute = action('mixer_setInputMute', { name: 'Mixer', inputs: '1', value: 'true' })
		const solo = action('mixer_setInputSolo', { name: 'Mixer', inputs: '1', value: 'false' })
		const loop = action('loopPlayer_start', { name: 'Player', loop: 'true' })

		upgrade(fixBooleanValues, { actions: [mute, solo, loop] })

		expect(mute.options.value).toEqual(fixed(true))
		expect(solo.options.value).toEqual(fixed(false))
		expect(loop.options.loop).toEqual(fixed(true))
	})
})

describe('fixOptionTypes', () => {
	it('turns a true/false dropdown saved on its default into a checkbox value', () => {
		const mute = action('mixer_setInputMute', { name: 'Mixer', inputs: '1', value: 'true' })
		const loop = action('loopPlayer_start', { name: 'Player', file_name: 'a.wav', loop: 'true' })

		const result = upgrade(fixOptionTypes, { actions: [mute, loop] })

		expect(mute.options.value).toEqual(fixed(true))
		expect(loop.options.loop).toEqual(fixed(true))
		expect(result.updatedActions).toEqual([mute, loop])
	})

	it('keeps checkbox values already saved as booleans, and does not report them', () => {
		const on = action('mixer_setCueMute', { name: 'Mixer', cues: '1', value: true })
		const off = action('mixer_setCrossPointSolo', { name: 'Mixer', inputs: '1', outputs: '1', value: false })

		const result = upgrade(fixOptionTypes, { actions: [on, off] })

		expect(on.options.value).toEqual(fixed(true))
		expect(off.options.value).toEqual(fixed(false))
		expect(result.updatedActions).toEqual([])
	})

	it('replaces the empty default of a number option with a number', () => {
		const page = action('page_submit_message', { zones: '1', priority: '', preamble: '', message: '' })
		const threshold = feedback('control-threshold', { name: 'Gain', threshold: '' })
		const fade = feedback('control-fade', { name: 'Gain', low_threshold: '', high_threshold: '-3' })

		const result = upgrade(fixOptionTypes, { actions: [page], feedbacks: [threshold, fade] })

		expect(page.options.priority).toEqual(fixed(1))
		expect(threshold.options.threshold).toEqual(fixed(0))
		// A number saved as text keeps its value
		expect(fade.options).toMatchObject({ low_threshold: fixed(0), high_threshold: fixed(-3) })
		expect(result.updatedActions).toEqual([page])
		expect(result.updatedFeedbacks).toEqual([threshold, fade])
	})

	it('leaves options it does not convert alone', () => {
		// Control.Set's value is a text input, where 'true' is a valid value
		const set = action('control_set', { name: 'Gain', value: 'true', type: 'boolean' })
		const page = action('page_submit_message', { zones: '1', priority: 3, preamble: '', message: '' })
		const threshold = feedback('control-threshold', { name: 'Gain', threshold: -6 })
		const mute = action('mixer_setOutputMute', { name: 'Mixer', outputs: '1' })
		mute.options.value = expression('$(internal:time_s) % 2 == 0')

		const result = upgrade(fixOptionTypes, { actions: [set, page, mute], feedbacks: [threshold] })

		expect(set.options.value).toEqual(fixed('true'))
		expect(page.options.priority).toEqual(fixed(3))
		expect(threshold.options.threshold).toEqual(fixed(-6))
		expect(mute.options.value).toEqual(expression('$(internal:time_s) % 2 == 0'))
		expect(result).toMatchObject({ updatedActions: [], updatedFeedbacks: [] })
	})
})

describe('textToNumberOptions', () => {
	it('turns numbers typed as text into numbers, and blanks into the field default', () => {
		const set = action('control_set', { name: 'Gain', value: '3', ramp: '2.5', min: '', max: '-6' })
		const component = action('component_set', { name: 'Comp', control_name: 'gain', value: '1', ramp: '' })
		const start = action('loopPlayer_start', { name: 'Player', file_name: 'a.wav', output: ' 2 ' })

		const result = textToNumberOptions(
			{ currentConfig: {} },
			{ config: null, secrets: null, actions: [set, component, start], feedbacks: [] },
		)

		// A blank min or max meant no limit
		expect(set.options).toMatchObject({ ramp: fixed(2.5), min: fixed(Number.MIN_SAFE_INTEGER), max: fixed(-6) })
		expect(component.options.ramp).toEqual(fixed(0))
		expect(start.options.output).toEqual(fixed(2))
		expect(result.updatedActions).toEqual([set, component, start])
	})

	it('turns variables into expressions', () => {
		const set = action('control_set', { name: 'Gain', ramp: '$(internal:ramp)', min: 'from $(internal:min)', max: 0 })

		upgrade(textToNumberOptions, { actions: [set] })

		expect(set.options.ramp).toEqual(expression('$(internal:ramp)'))
		expect(set.options.min).toEqual(expression('parseVariables("from $(internal:min)")'))
		expect(set.options.max).toEqual(fixed(0))
	})

	it('reports only the actions it changed', () => {
		const set = action('control_set', { name: 'Gain', ramp: 0, min: -10, max: 10 })
		const start = action('loopPlayer_start', { name: 'Player', output: 3 })
		start.options.output = expression('$(internal:output)')

		const result = upgrade(textToNumberOptions, { actions: [set, start] })

		expect(result.updatedActions).toEqual([])
	})
})
