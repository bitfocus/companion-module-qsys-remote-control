import { combineRgb } from '@companion-module/base'

/**
 * Composite graphics elements this module offers for layered buttons.
 *
 * The meter and dials are ported from companion-module-generic-oca. Its meter is modelled on the one in
 * companion-module-turtleav-mineola, itself modelled on the `vumeter` composite in companion-module-glensound-divine,
 * with the same bar thickness, end inset and edge padding, so meters from these modules line up on a page.
 *
 * A Q-SYS control reads in whatever unit it is defined in, over whatever span the design gives it, so the meter's
 * ends are options rather than fixed at -60..0 dB, and the colour stops are placed across whatever range it is given.
 *
 * The LED and indicator draw what the `led` and `Indicator` advanced feedbacks draw as images.
 */
export const CompositeElementId = Object.freeze({
	Meter: 'meter',
	Dial: 'dial',
	CentredDial: 'centred_dial',
	WidthDial: 'width_dial',
	Indicator: 'indicator',
	Led: 'led',
})

const POSITION_CHOICES = [
	{ id: 'left', label: 'Left' },
	{ id: 'right', label: 'Right' },
	{ id: 'top', label: 'Top' },
	{ id: 'bottom', label: 'Bottom' },
]

/** How a meter is coloured: the audio metering scale, or one colour of the user's choosing. */
const SCHEME_CHOICES = [
	{ id: 'meter', label: 'Audio metering' },
	{ id: 'custom', label: 'Single colour' },
]

/** How a value dial is coloured: one colour, or the visible spectrum across its range. */
const DIAL_SCHEME_CHOICES = [
	{ id: 'single', label: 'Single colour' },
	{ id: 'spectrum', label: 'Spectrum' },
]

const LED_SHAPE_CHOICES = [
	{ id: 'circle', label: 'Circle' },
	{ id: 'rectangle', label: 'Rectangle' },
]

/** Percentage of the button taken up by the short axis of the bar */
export const METER_THICKNESS = 8
/** Percentage inset at each end of the bar's long axis */
const METER_INSET = 6
const METER_LENGTH = 100 - METER_INSET * 2
/** Default distance of the bar from the edge of the button, as a percentage */
export const METER_PADDING = 2

/** The ends of the bar a meter gets until it is told otherwise, in dB: a full scale audio meter. */
export const METER_DEFAULT_MIN = -60
export const METER_DEFAULT_MAX = 0

/** The single colour a meter is drawn in when it isn't using the metering scale. */
export const METER_DEFAULT_COLOR = combineRgb(0, 204, 0)

/**
 * How much of its colour the unfilled part of the bar keeps, 0 - 100. At 100 it matches the fill and a silent
 * meter looks full scale; Companion's own default is 70.
 */
const METER_TRACK_AMOUNT = 20

/**
 * Colour stops, each a fraction of the way from the meter's min to its max, so the splits follow whatever
 * range the meter is given. Every stop is a gradient, so the gauge blends each colour into the next; the
 * last, red, has nothing to blend into and runs solid from 0.9 to the top of the bar.
 *
 * The fractions are where mineola's fixed stops fall on its -60..0 dB meter, so a meter left on the default
 * range is coloured identically to one of its.
 */
export const METER_STOPS = Object.freeze([
	{ at: 0, color: combineRgb(0, 100, 0) }, // dark green, -60 dB on the default range
	{ at: 1 / 3, color: combineRgb(0, 204, 0) }, // green, -40 dB
	{ at: 2 / 3, color: combineRgb(255, 255, 0) }, // yellow, -20 dB
	{ at: 0.8, color: combineRgb(255, 191, 0) }, // amber, -12 dB
	{ at: 0.9, color: combineRgb(255, 0, 0) }, // red, -6 dB
])

/**
 * Newton's spectrum, each colour a fraction of the way along the dial. Every stop blends into the
 * next, so the arc runs red through to violet rather than banding.
 */
export const SPECTRUM_STOPS = Object.freeze([
	{ at: 0, color: combineRgb(255, 0, 0) }, // red
	{ at: 1 / 6, color: combineRgb(255, 127, 0) }, // orange
	{ at: 2 / 6, color: combineRgb(255, 255, 0) }, // yellow
	{ at: 3 / 6, color: combineRgb(0, 255, 0) }, // green
	{ at: 4 / 6, color: combineRgb(0, 0, 255) }, // blue
	{ at: 5 / 6, color: combineRgb(75, 0, 130) }, // indigo
	{ at: 1, color: combineRgb(148, 0, 211) }, // violet
])

/**
 * The dial's arc, as positions on a clock face. Companion measures a ring gauge's angles in degrees
 * clockwise from 12 o'clock, so an hour is 30 degrees. Running from 8 round through 12 to 4 sweeps 240
 * degrees and leaves the bottom 120 undrawn, which is where a knob's pointer never goes.
 */
const CLOCK_HOUR_DEGREES = 30
const DIAL_START_HOUR = 8
const DIAL_END_HOUR = 4

/** How thick the ring is, as a percentage of its radius. Companion allows 1 to 50. */
const DIAL_RING_WIDTH = 15

/**
 * How far the ring is held back from each edge of the button, as a percentage. At 0 the ring touches the
 * edge at 12, 3, 6 and 9 o'clock, since its radius is half the shorter side.
 */
const DIAL_PADDING = 5
const DIAL_DIAMETER = 100 - DIAL_PADDING * 2

/** How much colour the untravelled part of the arc keeps, so the dial still reads as one. */
const DIAL_TRACK_AMOUNT = 20

/**
 * How long the pan dial's marker bead is along the arc, as a percentage of the ring's thickness, so at 100
 * it is as long as the ring is thick and reads as a dot rather than a hairline. Companion's own default, 15,
 * would come out under a pixel and be clamped to one.
 */
const DIAL_MARKER_WIDTH = 100

/** The indicator's default bar thickness, matching the Indicator feedback's 6 pixel marker on a 72 pixel button. */
export const INDICATOR_THICKNESS = 8

/**
 * How long the indicator's marker is along the bar, as a percentage of the bar's thickness. The Indicator
 * feedback draws a 3 pixel marker across its 6 pixel bar, so half.
 */
export const INDICATOR_MARKER_WIDTH = 50

/** `hour` on a clock face as a gauge angle. */
function clockAngle(hour) {
	return (hour % 12) * CLOCK_HOUR_DEGREES
}

const expression = (value) => ({ isExpression: true, value })

const POSITION = `$(options:position)`
const PADDING = `$(options:padding)`
const MIN = `$(options:min)`
const MAX = `$(options:max)`
const COLOR = `$(options:color)`
const COLOR_BELOW = `$(options:colorBelow)`
const COLOR_ZERO = `$(options:colorZero)`
const IS_VERTICAL = `(${POSITION} == 'left' || ${POSITION} == 'right')`
const IS_METERING = `$(options:scheme) == '${SCHEME_CHOICES[0].id}'`
const IS_SPECTRUM = `$(options:scheme) == '${DIAL_SCHEME_CHOICES[1].id}'`
const IS_LIT = `$(options:on)`

/** Where `stop` sits on a bar running from the meter's min to its max. */
function stopValue(at) {
	if (at === 0) return MIN
	return `${MIN} + (${MAX} - ${MIN}) * ${at}`
}

/** Halfway between the dial's ends, which a width dial grows out from. */
const MIDPOINT = `(${MIN} + ${MAX}) / 2`

/**
 * Zero, held inside the dial's range: where a centred dial's arc starts. On a range either side of
 * zero that is 12 o'clock when the ends match and offset when they don't, and on a range that never
 * reaches zero it lands on whichever end is nearer, so the arc grows from there like a plain dial.
 */
const ZERO_ORIGIN = `min(max(0, ${MIN}), ${MAX})`

/** A number option that takes any value, for a reading or the ends of its range. */
function anyNumber(id, label, tooltip, defaultValue) {
	return {
		type: 'number',
		label,
		id,
		tooltip,
		min: Number.MIN_SAFE_INTEGER,
		max: Number.MAX_SAFE_INTEGER,
		default: defaultValue,
	}
}

/**
 * The options every dial takes, differing only in what their ends mean and their colour. Only the value dial
 * runs a scale along its arc, and only a centred dial has a second colour for below zero.
 * @param {'minimum' | 'centred' | 'width'} mode
 * @param {string} minimumTooltip
 * @param {number} defaultColor
 */
function dialOptions(mode, minimumTooltip, defaultColor) {
	return [
		anyNumber('level', 'Value', "Set this to the control's value, e.g. one of its value variables", 0),
		anyNumber('min', 'Minimum', minimumTooltip, 0),
		anyNumber('max', 'Maximum', 'The value at the full end of the arc', 100),
		{
			type: 'colorpicker',
			label: mode === 'centred' ? 'Colour above zero' : 'Colour',
			id: 'color',
			default: defaultColor,
			returnType: 'number',
		},
		// Only the value dial runs a scale along its arc; the others grow from a point
		...(mode === 'minimum'
			? [
					{
						type: 'dropdown',
						label: 'Colours',
						id: 'scheme',
						tooltip: 'A spectrum runs red to violet across the range, ignoring the colour above',
						choices: DIAL_SCHEME_CHOICES,
						default: DIAL_SCHEME_CHOICES[0].id,
					},
				]
			: []),
		// Only a centred dial has sides to tell apart. Leave all three the same for one colour throughout
		...(mode === 'centred'
			? [
					{
						type: 'colorpicker',
						label: 'Colour at zero',
						id: 'colorZero',
						tooltip: 'The arc blends from this out to the colour at each end of the range',
						default: defaultColor,
						returnType: 'number',
					},
					{
						type: 'colorpicker',
						label: 'Colour below zero',
						id: 'colorBelow',
						tooltip: 'Set all three the same to draw the whole arc in one colour',
						default: defaultColor,
						returnType: 'number',
					},
				]
			: []),
	]
}

/**
 * The ring every dial is drawn with, differing only in where its arc grows from:
 *
 * - `minimum` fills up from the empty end, like a level.
 * - `centred` fills out from zero, clockwise above it and anticlockwise below, so a range either side of
 *   zero reads as a pan or a cut-and-boost.
 * - `width` grows both ways at once from the middle of the range, so the minimum is a dot at 12 o'clock
 *   and the maximum fills the arc end to end. That is Companion's `symmetric` mode, where the fill is a
 *   band of the value's own length centred on the origin (`GaugeColorModel.ts:83-87`).
 *
 * Both of the latter carry a marker bead. The renderer draws that at the value whether or not there is any
 * fill (`LayeredRenderer.ts:794`), which is what leaves a dot behind when the two ends of the band meet.
 * @param {'minimum' | 'centred' | 'width'} mode
 */
function dialGauge(mode) {
	const names = { minimum: 'Dial', centred: 'Centred Dial', width: 'Width Dial' }
	return {
		type: 'gauge',
		name: names[mode],
		// The renderer centres the ring and takes its radius from the shorter side, so a square
		// inset from every edge stays circular, scales with whatever it is drawn on, and keeps
		// clear of the button's edges
		x: DIAL_PADDING,
		y: DIAL_PADDING,
		width: DIAL_DIAMETER,
		height: DIAL_DIAMETER,
		orientation: 'ring',
		startAngle: clockAngle(DIAL_START_HOUR),
		endAngle: clockAngle(DIAL_END_HOUR),
		ringWidth: DIAL_RING_WIDTH,
		roundedEnds: true,
		min: expression(MIN),
		max: expression(MAX),
		value: expression('$(options:level)'),
		fillEnabled: true,
		// A centred dial blends across its stops, so the arc shades away from zero; anywhere else the
		// fill is one colour, taken from the last stop at or below the value (`GaugeColorModel.ts:120`)
		multiColour: mode === 'centred' ? true : mode === 'minimum' ? expression(IS_SPECTRUM) : false,
		// Three stops for a centred dial: the colour at zero blending out to each end of the range.
		// The renderer runs a gradient between consecutive stops, and the last has nothing to blend into
		stops:
			mode === 'centred'
				? [
						{ value: expression(MIN), color: expression(COLOR_BELOW), gradient: true },
						{ value: expression(ZERO_ORIGIN), color: expression(COLOR_ZERO), gradient: true },
						{ value: expression(MAX), color: expression(COLOR), gradient: false },
					]
				: mode === 'minimum'
					? SPECTRUM_STOPS.map((stop) => ({
							value: expression(stopValue(stop.at)),
							color: expression(`${IS_SPECTRUM} ? ${stop.color} : ${COLOR}`),
							// Blended on a spectrum; on a single colour every stop is the same, so it stays flat
							gradient: true,
						}))
					: [{ value: expression(MIN), color: expression(COLOR), gradient: false }],
		// The untravelled part of the arc stays faintly visible, so the dial reads as a dial
		trackStyle: 'dimmed',
		trackAmount: DIAL_TRACK_AMOUNT,
		...(mode === 'minimum'
			? {}
			: {
					origin: expression(mode === 'width' ? MIDPOINT : ZERO_ORIGIN),
					...(mode === 'width' ? { symmetric: true } : {}),
					markerEnabled: true,
					// The dot takes the colour of the end it is heading for, and the zero colour when it
					// sits on zero with no fill either side of it
					markerColor: expression(
						mode === 'centred'
							? `$(options:level) < ${ZERO_ORIGIN} ? ${COLOR_BELOW} : ($(options:level) > ${ZERO_ORIGIN} ? ${COLOR} : ${COLOR_ZERO})`
							: COLOR,
					),
					markerWidth: DIAL_MARKER_WIDTH,
				}),
	}
}

/**
 * Where a bar along one edge of the button goes, by its position option: `thickness` across, the length of
 * the button less an inset at each end along it, and `padding` away from the edge.
 * @param {string} thickness An expression for the bar's thickness, as a percentage
 */
function edgeBar(thickness) {
	return {
		x: expression(
			`${POSITION} == 'left' ? ${PADDING} : (${POSITION} == 'right' ? 100 - ${PADDING} - ${thickness} : ${METER_INSET})`,
		),
		y: expression(
			`${POSITION} == 'top' ? ${PADDING} : (${POSITION} == 'bottom' ? 100 - ${PADDING} - ${thickness} : ${METER_INSET})`,
		),
		width: expression(`${IS_VERTICAL} ? ${thickness} : ${METER_LENGTH}`),
		height: expression(`${IS_VERTICAL} ? ${METER_LENGTH} : ${thickness}`),
		orientation: expression(`${IS_VERTICAL} ? 'vertical' : 'horizontal'`),
	}
}

const positionOption = {
	type: 'dropdown',
	label: 'Position',
	id: 'position',
	choices: POSITION_CHOICES,
	default: POSITION_CHOICES[3].id,
}

const paddingOption = {
	type: 'number',
	label: 'Padding',
	id: 'padding',
	tooltip: 'Distance from the edge of the button, as a percentage',
	min: 0,
	max: 40,
	default: METER_PADDING,
}

/**
 * Register the composite elements with Companion
 * @param {import('./index.js').default} self
 */
export function UpdateCompositeElements(self) {
	const compositeElements = {
		[CompositeElementId.Meter]: {
			type: 'composite',
			name: 'Signal Meter',
			description:
				"A bargraph meter for a control. Feed it a level, e.g. one of the control's value variables, and the ends of the range it should draw",
			options: [
				anyNumber(
					'level',
					'Level',
					"Set this to the control's value, e.g. one of its value variables",
					METER_DEFAULT_MIN,
				),
				anyNumber('min', 'Minimum', 'The reading at the empty end of the bar', METER_DEFAULT_MIN),
				anyNumber('max', 'Maximum', 'The reading at the full end of the bar', METER_DEFAULT_MAX),
				positionOption,
				paddingOption,
				{
					type: 'dropdown',
					label: 'Colours',
					id: 'scheme',
					tooltip:
						'The metering scale runs green to red across the range; a single colour suits a reading that is not a signal level',
					choices: SCHEME_CHOICES,
					default: SCHEME_CHOICES[0].id,
				},
				{
					type: 'colorpicker',
					label: 'Colour',
					id: 'color',
					tooltip: 'Used when Colours is set to a single colour',
					default: METER_DEFAULT_COLOR,
					returnType: 'number',
				},
			],
			elements: [
				{
					type: 'gauge',
					name: 'Meter',
					...edgeBar(METER_THICKNESS),
					min: expression(MIN),
					max: expression(MAX),
					value: expression('$(options:level)'),
					fillEnabled: true,
					// Only the metering scale blends between its stops; a single colour is flat
					multiColour: expression(IS_METERING),
					trackStyle: 'dimmed',
					trackAmount: METER_TRACK_AMOUNT,
					// The stops stay in place for either scheme. On a single colour they all resolve to it,
					// so whichever one the reading falls in, and whatever blending happens, the bar is that colour
					stops: METER_STOPS.map((stop) => ({
						value: expression(stopValue(stop.at)),
						color: expression(`${IS_METERING} ? ${stop.color} : ${COLOR}`),
						gradient: true,
					})),
				},
			],
		},
		[CompositeElementId.Dial]: {
			type: 'composite',
			name: 'Value Dial',
			description: `A knob-style arc running from ${DIAL_START_HOUR} o'clock up round to ${DIAL_END_HOUR}, filling from the minimum as the value rises. Feed it a value and the ends of its range`,
			options: dialOptions('minimum', 'The value at the empty end of the arc', combineRgb(0, 204, 0)),
			elements: [dialGauge('minimum')],
		},
		[CompositeElementId.CentredDial]: {
			type: 'composite',
			name: 'Centred Dial',
			description: `A knob-style arc growing out from zero, clockwise towards ${DIAL_END_HOUR} o'clock above it and anticlockwise towards ${DIAL_START_HOUR} below, with a dot marking the position. Zero sits at 12 o'clock when the two ends match, and off to one side when they don't`,
			options: dialOptions('centred', 'The value at the anticlockwise end of the arc', combineRgb(255, 255, 0)),
			elements: [dialGauge('centred')],
		},
		[CompositeElementId.WidthDial]: {
			type: 'composite',
			name: 'Width Dial',
			description: `A knob-style arc growing both ways from 12 o'clock: a dot at the minimum, opening out until it runs the whole way from ${DIAL_START_HOUR} o'clock to ${DIAL_END_HOUR} at the maximum`,
			options: dialOptions('width', 'The value drawn as a dot at 12 o’clock', combineRgb(182, 182, 182)),
			elements: [dialGauge('width')],
		},
		[CompositeElementId.Indicator]: {
			type: 'composite',
			name: 'Indicator',
			description:
				"A marker along one edge of the button showing where a value sits in its range, as the Indicator feedback draws. Feed it a value, e.g. one of the control's value or position variables",
			options: [
				anyNumber('level', 'Value', "Set this to the control's value or position, e.g. one of its variables", 0),
				anyNumber('min', 'Minimum', 'The value at the start of the edge', -100),
				anyNumber('max', 'Maximum', 'The value at the end of the edge', 0),
				{ ...positionOption, default: POSITION_CHOICES[1].id },
				paddingOption,
				{
					type: 'number',
					label: 'Marker Width',
					id: 'width',
					tooltip: 'How far the marker reaches in from the edge, as a percentage of the button',
					min: 1,
					max: 40,
					default: INDICATOR_THICKNESS,
				},
				{
					type: 'colorpicker',
					label: 'Colour',
					id: 'color',
					default: combineRgb(255, 255, 255),
					returnType: 'number',
				},
			],
			elements: [
				{
					type: 'gauge',
					name: 'Indicator',
					...edgeBar('$(options:width)'),
					min: expression(MIN),
					max: expression(MAX),
					value: expression('$(options:level)'),
					// Only the marker is drawn: no fill, and no track behind it
					fillEnabled: false,
					trackStyle: 'transparent',
					trackAmount: 0,
					markerEnabled: true,
					markerColor: expression(COLOR),
					markerWidth: INDICATOR_MARKER_WIDTH,
				},
			],
		},
		[CompositeElementId.Led]: {
			type: 'composite',
			name: 'LED',
			description:
				"A round or square LED, as the LED feedback draws, lit while On is set. Drive On from a control's variables in expression mode",
			options: [
				{
					type: 'checkbox',
					label: 'On',
					id: 'on',
					default: false,
					description:
						"Switch to expression mode to drive this from a control's variables, e.g. $(label:Gain_position) >= 0.5",
					expressionDescription:
						"True lights the LED. $(label:Gain_position) >= 0.5 lights it as the LED feedback does, where label is the connection's label",
				},
				{
					type: 'dropdown',
					label: 'Shape',
					id: 'shape',
					choices: LED_SHAPE_CHOICES,
					default: LED_SHAPE_CHOICES[0].id,
					// Referenced by the visibility of the size options below
					disableAutoExpression: true,
				},
				{
					type: 'number',
					label: 'X Offset',
					id: 'offsetX',
					tooltip: 'Distance from the left of the button, as a percentage',
					min: 0,
					max: 100,
					default: 7,
				},
				{
					type: 'number',
					label: 'Y Offset',
					id: 'offsetY',
					tooltip: 'Distance from the top of the button, as a percentage',
					min: 0,
					max: 100,
					default: 7,
				},
				{
					type: 'number',
					label: 'Radius',
					id: 'radius',
					tooltip: 'As a percentage of the button',
					min: 1,
					max: 50,
					default: 6,
					isVisibleExpression: `$(options:shape) == '${LED_SHAPE_CHOICES[0].id}'`,
				},
				{
					type: 'number',
					label: 'Width',
					id: 'width',
					tooltip: 'As a percentage of the button',
					min: 1,
					max: 100,
					default: 6,
					isVisibleExpression: `$(options:shape) == '${LED_SHAPE_CHOICES[1].id}'`,
				},
				{
					type: 'number',
					label: 'Height',
					id: 'height',
					tooltip: 'As a percentage of the button',
					min: 1,
					max: 100,
					default: 6,
					isVisibleExpression: `$(options:shape) == '${LED_SHAPE_CHOICES[1].id}'`,
				},
				{
					type: 'colorpicker',
					label: 'On Colour',
					id: 'colorOn',
					default: combineRgb(255, 255, 255),
					returnType: 'number',
				},
				{
					type: 'number',
					label: 'On Opacity',
					id: 'opacityOn',
					tooltip: 'As a percentage',
					min: 0,
					max: 100,
					default: 100,
				},
				{
					type: 'colorpicker',
					label: 'Off Colour',
					id: 'colorOff',
					default: combineRgb(0, 0, 0),
					returnType: 'number',
				},
				{
					type: 'number',
					label: 'Off Opacity',
					id: 'opacityOff',
					tooltip: 'As a percentage',
					min: 0,
					max: 100,
					default: 0,
				},
			],
			elements: [
				{
					type: 'group',
					name: 'LED',
					// A square drawing area, centred on the button, so the circle stays round when the button isn't
					// square. On a square button it is the whole button, and the offsets match the feedback's
					squareCoords: true,
					children: [
						{
							type: 'circle',
							name: 'Circle',
							enabled: expression(`$(options:shape) == '${LED_SHAPE_CHOICES[0].id}'`),
							x: expression('$(options:offsetX)'),
							y: expression('$(options:offsetY)'),
							width: expression('$(options:radius) * 2'),
							height: expression('$(options:radius) * 2'),
							color: expression(`${IS_LIT} ? $(options:colorOn) : $(options:colorOff)`),
							opacity: expression(`${IS_LIT} ? $(options:opacityOn) : $(options:opacityOff)`),
						},
						{
							type: 'box',
							name: 'Rectangle',
							enabled: expression(`$(options:shape) == '${LED_SHAPE_CHOICES[1].id}'`),
							x: expression('$(options:offsetX)'),
							y: expression('$(options:offsetY)'),
							width: expression('$(options:width)'),
							height: expression('$(options:height)'),
							color: expression(`${IS_LIT} ? $(options:colorOn) : $(options:colorOff)`),
							opacity: expression(`${IS_LIT} ? $(options:opacityOn) : $(options:opacityOff)`),
						},
					],
				},
			],
		},
	}

	self.setCompositeElementDefinitions(compositeElements)
}
