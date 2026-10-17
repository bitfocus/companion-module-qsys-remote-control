import { describe, expect, it, vi } from 'vitest'
import {
	CompositeElementId,
	INDICATOR_MARKER_WIDTH,
	LED_THRESHOLD,
	METER_DEFAULT_MAX,
	METER_DEFAULT_MIN,
	METER_STOPS,
	SPECTRUM_STOPS,
	UpdateCompositeElements,
} from './composites.js'

function defineElements() {
	const setCompositeElementDefinitions = vi.fn()
	UpdateCompositeElements({ setCompositeElementDefinitions })
	return setCompositeElementDefinitions.mock.lastCall[0]
}

function definitionOf(id) {
	const definition = defineElements()[id]
	if (!definition) throw new Error(`No ${id} element was defined`)
	return definition
}

/** The gauge one of the composites is made of. */
function gaugeOf(id) {
	const gauge = definitionOf(id).elements.find((element) => element.type === 'gauge')
	if (!gauge) throw new Error(`${id} has no gauge`)
	return gauge
}

/** Every option's default, as a composite placed on a button starts out. */
function defaultsOf(id) {
	return Object.fromEntries(definitionOf(id).options.map((option) => [option.id, option.default]))
}

/**
 * An element property as Companion would draw it with these options. The expressions here use only `$(options:…)`,
 * arithmetic, comparisons, `?:` and `min`/`max`, which read the same in JavaScript.
 */
function evaluate(property, options) {
	if (property?.isExpression !== true) return property
	const js = property.value.replaceAll(/\$\(options:(\w+)\)/g, (_, key) => JSON.stringify(options[key]))
	return new Function('min', 'max', `return (${js})`)(Math.min, Math.max)
}

/**
 * Where a point on a ring gauge's arc sits on a clock face, by Companion's maths
 * (`LayeredRenderer.ts:596-620`): angles are degrees clockwise from 12 o'clock.
 */
function clockPosition(degrees) {
	const hour = (degrees / 30) % 12
	return ((hour % 12) + 12) % 12 || 12
}

/** The arc's clockwise span, the way the renderer derives it; a span of 0 would mean a full circle. */
function sweepDegrees(start, end) {
	return (((end - start) % 360) + 360) % 360 || 360
}

describe('composite elements', () => {
	it('offers a meter taking a level and the two ends of the range it draws', () => {
		const meter = definitionOf(CompositeElementId.Meter)

		expect(meter.options.map((option) => option.id)).toEqual([
			'level',
			'min',
			'max',
			'position',
			'padding',
			'scheme',
			'color',
		])
		// A control reads in whatever unit it is defined in, so nothing here is limited to a dB range
		for (const id of ['level', 'min', 'max']) {
			const option = meter.options.find((o) => o.id === id)
			expect(option, id).toMatchObject({ type: 'number', min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER })
		}
		expect(meter.options.find((o) => o.id === 'position')).toMatchObject({ default: 'bottom' })
	})

	it('draws the bar between the given ends, from the given level', () => {
		const gauge = gaugeOf(CompositeElementId.Meter)

		expect(gauge.min).toEqual({ isExpression: true, value: '$(options:min)' })
		expect(gauge.max).toEqual({ isExpression: true, value: '$(options:max)' })
		expect(gauge.value).toEqual({ isExpression: true, value: '$(options:level)' })
	})

	it('draws the meter in one colour instead of the metering scale when asked', () => {
		const meter = definitionOf(CompositeElementId.Meter)
		const gauge = gaugeOf(CompositeElementId.Meter)

		expect(meter.options.find((o) => o.id === 'scheme')).toMatchObject({ type: 'dropdown', default: 'meter' })
		expect(meter.options.find((o) => o.id === 'color')).toMatchObject({ type: 'colorpicker', default: 0x00cc00 })
		// Only the metering scale blends between colours
		expect(gauge.multiColour).toEqual({ isExpression: true, value: "$(options:scheme) == 'meter'" })
		// Every stop falls back to the chosen colour, so the bar is flat whichever one the reading is in
		expect(gauge.stops).toHaveLength(5)
		for (const [index, stop] of gauge.stops.entries()) {
			expect(stop.color.value, `stop ${index}`).toBe(
				`$(options:scheme) == 'meter' ? ${METER_STOPS[index].color} : $(options:color)`,
			)
		}
	})

	it('spaces its colour stops across the range, rather than at fixed levels', () => {
		const gauge = gaugeOf(CompositeElementId.Meter)

		expect(gauge.stops.map((stop) => stop.value)).toEqual([
			// The bottom of the bar, wherever that is
			{ isExpression: true, value: '$(options:min)' },
			{ isExpression: true, value: '$(options:min) + ($(options:max) - $(options:min)) * 0.3333333333333333' },
			{ isExpression: true, value: '$(options:min) + ($(options:max) - $(options:min)) * 0.6666666666666666' },
			{ isExpression: true, value: '$(options:min) + ($(options:max) - $(options:min)) * 0.8' },
			{ isExpression: true, value: '$(options:min) + ($(options:max) - $(options:min)) * 0.9' },
		])
		// Every stop blends into the next, so the bar is a gradient rather than five bands
		expect(gauge.stops.every((stop) => stop.gradient === true)).toBe(true)
	})

	it("draws the dial as an arc from 8 o'clock round through 12 to 4, leaving the bottom undrawn", () => {
		const { startAngle, endAngle, orientation } = gaugeOf(CompositeElementId.Dial)

		expect(orientation).toBe('ring')
		expect(clockPosition(startAngle)).toBe(8)
		expect(clockPosition(endAngle)).toBe(4)
		expect(sweepDegrees(startAngle, endAngle)).toBe(240)
		// Halfway along the arc is straight up
		expect(clockPosition(startAngle + sweepDegrees(startAngle, endAngle) / 2)).toBe(12)
	})

	it('fills the dial from the given value and range, in one colour defaulting to green', () => {
		const dial = definitionOf(CompositeElementId.Dial)
		const gauge = gaugeOf(CompositeElementId.Dial)

		expect(dial.options.map((option) => option.id)).toEqual(['level', 'min', 'max', 'color', 'scheme'])
		expect(dial.options.find((o) => o.id === 'color')).toMatchObject({ type: 'colorpicker', default: 0x00cc00 })
		expect(dial.options.find((o) => o.id === 'scheme')).toMatchObject({ type: 'dropdown', default: 'single' })
		expect(gauge.value).toEqual({ isExpression: true, value: '$(options:level)' })
		// Blended only on a spectrum; on a single colour every stop resolves to it, so the arc stays flat
		expect(gauge.multiColour).toEqual({ isExpression: true, value: "$(options:scheme) == 'spectrum'" })
	})

	it('runs the value dial through the spectrum when asked, red at the bottom and violet at the top', () => {
		const { stops } = gaugeOf(CompositeElementId.Dial)

		expect(stops).toHaveLength(7)
		expect(SPECTRUM_STOPS.map((stop) => stop.color)).toEqual([
			0xff0000, 0xff7f00, 0xffff00, 0x00ff00, 0x0000ff, 0x4b0082, 0x9400d3,
		])
		expect(stops[0].value.value).toBe('$(options:min)')
		expect(stops[6].value.value).toBe('$(options:min) + ($(options:max) - $(options:min)) * 1')
		for (const [index, stop] of stops.entries()) {
			expect(stop.color.value, `stop ${index}`).toBe(
				`$(options:scheme) == 'spectrum' ? ${SPECTRUM_STOPS[index].color} : $(options:color)`,
			)
			expect(stop.gradient, `stop ${index}`).toBe(true)
		}
	})

	it('grows the centred dial out from zero, held inside the range', () => {
		const centred = definitionOf(CompositeElementId.CentredDial)
		const gauge = gaugeOf(CompositeElementId.CentredDial)

		expect(centred.options.map((option) => option.id)).toEqual([
			'level',
			'min',
			'max',
			'color',
			'colorZero',
			'colorBelow',
		])
		// All three default alike, so a dial is one colour throughout until told otherwise
		const colours = centred.options.filter((option) => option.type === 'colorpicker')
		expect(colours.map((option) => option.default)).toEqual([0xffff00, 0xffff00, 0xffff00])
		expect(gauge.origin).toEqual({ isExpression: true, value: 'min(max(0, $(options:min)), $(options:max))' })
		// Zero when the range spans it, otherwise whichever end is nearer
		expect(evaluate(gauge.origin, { min: -10, max: 10 })).toBe(0)
		expect(evaluate(gauge.origin, { min: 20, max: 80 })).toBe(20)
		expect(evaluate(gauge.origin, { min: -80, max: -20 })).toBe(-20)
		expect(gauge.symmetric).toBeUndefined()
		expect(gauge.multiColour).toBe(true)
	})

	it('opens the width dial both ways from the middle, a dot at the minimum and the whole arc at the maximum', () => {
		const gauge = gaugeOf(CompositeElementId.WidthDial)

		expect(gauge.symmetric).toBe(true)
		expect(gauge.origin).toEqual({ isExpression: true, value: '($(options:min) + $(options:max)) / 2' })
		expect(definitionOf(CompositeElementId.WidthDial).options.map((option) => option.id)).toEqual([
			'level',
			'min',
			'max',
			'color',
		])
	})

	it('marks the position on both growing dials with a bead, so a value at the origin still shows a dot', () => {
		for (const id of [CompositeElementId.CentredDial, CompositeElementId.WidthDial]) {
			const gauge = gaugeOf(id)
			expect(gauge.markerEnabled, id).toBe(true)
			expect(gauge.markerWidth, id).toBe(100)
		}
		// The centred dial's dot takes the colour of the end it heads for, and the zero colour on zero
		const { markerColor } = gaugeOf(CompositeElementId.CentredDial)
		const colours = { min: -10, max: 10, color: 1, colorZero: 2, colorBelow: 3 }
		expect(evaluate(markerColor, { ...colours, level: 5 })).toBe(1)
		expect(evaluate(markerColor, { ...colours, level: 0 })).toBe(2)
		expect(evaluate(markerColor, { ...colours, level: -5 })).toBe(3)
	})

	it('draws every dial with the same ring, inset from every edge so it stays round', () => {
		const dial = gaugeOf(CompositeElementId.Dial)

		for (const id of [CompositeElementId.CentredDial, CompositeElementId.WidthDial]) {
			const other = gaugeOf(id)
			for (const key of ['x', 'y', 'width', 'height', 'orientation', 'startAngle', 'endAngle', 'ringWidth']) {
				expect(other[key], `${id} ${key}`).toEqual(dial[key])
			}
		}
		expect(dial.width).toBe(dial.height)
		expect(dial.x).toBe(dial.y)
		expect(dial.x).toBeGreaterThan(0)
		expect(dial.x + dial.width).toBe(100 - dial.x)
	})

	it('puts the meter stops at mineola’s dB levels when left on the default range', () => {
		const levels = METER_STOPS.map((stop) => METER_DEFAULT_MIN + (METER_DEFAULT_MAX - METER_DEFAULT_MIN) * stop.at)

		for (const [index, expected] of [-60, -40, -20, -12, -6].entries()) {
			expect(levels[index], `stop ${index}`).toBeCloseTo(expected, 10)
		}
	})
})

describe('indicator', () => {
	it('draws only a marker, as the Indicator feedback does', () => {
		const gauge = gaugeOf(CompositeElementId.Indicator)

		expect(gauge).toMatchObject({
			fillEnabled: false,
			trackStyle: 'transparent',
			trackAmount: 0,
			markerEnabled: true,
			markerWidth: INDICATOR_MARKER_WIDTH,
		})
		expect(gauge.markerColor).toEqual({ isExpression: true, value: '$(options:color)' })
		expect(gauge.value).toEqual({ isExpression: true, value: '$(options:level)' })
		expect(gauge.min).toEqual({ isExpression: true, value: '$(options:min)' })
		expect(gauge.max).toEqual({ isExpression: true, value: '$(options:max)' })
	})

	it('defaults to the Indicator feedback’s range and edge', () => {
		expect(defaultsOf(CompositeElementId.Indicator)).toMatchObject({ min: -100, max: 0, position: 'right' })
	})

	it('runs along the chosen edge, its thickness the marker width', () => {
		const gauge = gaugeOf(CompositeElementId.Indicator)
		const options = { ...defaultsOf(CompositeElementId.Indicator), padding: 2, width: 10 }
		const place = (position) =>
			Object.fromEntries(
				['x', 'y', 'width', 'height', 'orientation'].map((key) => [
					key,
					evaluate(gauge[key], { ...options, position }),
				]),
			)

		expect(place('right')).toEqual({ x: 88, y: 6, width: 10, height: 88, orientation: 'vertical' })
		expect(place('left')).toEqual({ x: 2, y: 6, width: 10, height: 88, orientation: 'vertical' })
		expect(place('top')).toEqual({ x: 6, y: 2, width: 88, height: 10, orientation: 'horizontal' })
		expect(place('bottom')).toEqual({ x: 6, y: 88, width: 88, height: 10, orientation: 'horizontal' })
	})
})

describe('LED', () => {
	const led = () => definitionOf(CompositeElementId.Led).elements[0]
	const shape = (type) => led().children.find((child) => child.type === type)

	it('defaults to the LED feedback’s white on, transparent off circle', () => {
		expect(defaultsOf(CompositeElementId.Led)).toMatchObject({
			shape: 'circle',
			colorOn: 0xffffff,
			opacityOn: 100,
			colorOff: 0x000000,
			opacityOff: 0,
		})
	})

	it(`lights at a position of ${LED_THRESHOLD} and above, as the feedback does`, () => {
		const options = { ...defaultsOf(CompositeElementId.Led), colorOn: 0x00ff00, colorOff: 0x330000, opacityOff: 40 }

		for (const type of ['circle', 'box']) {
			const element = shape(type)
			expect(evaluate(element.color, { ...options, position: 0.5 }), type).toBe(0x00ff00)
			expect(evaluate(element.opacity, { ...options, position: 1 }), type).toBe(100)
			expect(evaluate(element.color, { ...options, position: 0.49 }), type).toBe(0x330000)
			expect(evaluate(element.opacity, { ...options, position: 0 }), type).toBe(40)
		}
	})

	it('draws the chosen shape only, at the chosen place and size', () => {
		const options = { ...defaultsOf(CompositeElementId.Led), offsetX: 10, offsetY: 20, radius: 5, width: 12, height: 8 }
		const circle = shape('circle')
		const box = shape('box')

		expect(evaluate(circle.enabled, { ...options, shape: 'circle' })).toBe(true)
		expect(evaluate(box.enabled, { ...options, shape: 'circle' })).toBe(false)
		expect(evaluate(box.enabled, { ...options, shape: 'rectangle' })).toBe(true)
		expect(evaluate(circle.enabled, { ...options, shape: 'rectangle' })).toBe(false)
		for (const element of [circle, box]) {
			expect(evaluate(element.x, options)).toBe(10)
			expect(evaluate(element.y, options)).toBe(20)
		}
		expect([evaluate(circle.width, options), evaluate(circle.height, options)]).toEqual([10, 10])
		expect([evaluate(box.width, options), evaluate(box.height, options)]).toEqual([12, 8])
	})

	// The feedback draws in pixels, so its circle is always round
	it('keeps the circle round on a button that is not square', () => {
		expect(led()).toMatchObject({ type: 'group', squareCoords: true })
	})
})
