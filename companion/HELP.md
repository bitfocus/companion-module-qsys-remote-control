## Q-SYS Remote Control

This module will connect to Q-SYS systems using the [QRC](https://q-syshelp.qsc.com/#External_Control_APIs/QRC/QRC_Overview.htm) protocol.

**Available commands for Q-SYS Remote Control**

- ChangeGroup.Invalidate
- Component.Set
- Control.Get
- Control.Set
- Control.Toggle
- LoopPlayer.Cancel
- LoopPlayer.Start
- LoopPlayer.Stop
- Mixer.SetCrossPointDelay
- Mixer.SetCrossPointGain
- Mixer.SetCrossPointMute
- Mixer.SetCrossPointSolo
- Mixer.SetCueGain
- Mixer.SetCueMute
- Mixer.SetInputCueAfl
- Mixer.SetInputCueEnable
- Mixer.SetInputGain
- Mixer.SetInputMute
- Mixer.SetInputSolo
- Mixer.SetOutputGain
- Mixer.SetOutputMute
- PA.PageSubmit - Message
- Snapshot.Load
- Snapshop.Save
- StatusGet

**Mixer Input Output String Synatx**

The mixer control API uses a string specification to determine to which inputs and outputs to apply changes. The syntax supports space- or comma-separated numbers, ranges of numbers, all numbers (\*), and negation of a selection with the ! operator. For example:

| Syntax  | Meaning                              |
| ------- | ------------------------------------ |
| \*      | Everything                           |
| 1 2 3   | Channels 1, 2, 3                     |
| 1-6     | Channels 1 through 6                 |
| 1-6 9   | Channels 1 through 6 and 9           |
| 1-3 5-9 | Channels 1 through 3 and 5 through 9 |
| 1-8 !3  | Channels 1 through 8 except 3        |
| \* !3-5 | Everything but 3 through 5           |
|         |                                      |

**Feedbacks**

- Core State
- Feedback on boolean control value
- Feedback if control value at or exceeds threshold
- Fade color over control value range
- Indicator (Deprecated)
- LED (Deprecated)
- Level Meter (Deprecated)
- Named Control Position
- Named Control String Value
- Named Control Value

**Composite Elements**

Graphics elements for layered buttons. Feed each one from a named control's variables, e.g. `$(label:Gain_value)` or `$(label:Gain_position)`, where `label` is the connection's label. Sizes and offsets are percentages of the button.

- Signal Meter: a bargraph along one edge of the button, in audio metering colours or a single colour. Use in place of the Level Meter feedback
- Value Dial: a knob-style arc, filling from the minimum as the value rises
- Centred Dial: an arc growing out from zero, clockwise above it and anticlockwise below, for pan or cut and boost
- Width Dial: an arc growing both ways from 12 o'clock, a dot at the minimum and the whole arc at the maximum
- Indicator: a marker along one edge of the button showing where a value sits in its range. Use in place of the Indicator feedback
- LED: a round or square LED, lit when the position is 0.5 or more. Use in place of the LED feedback

The meter, dials and indicator take the ends of their range as options.

**Variables**

- Engine Status
- Named control values
