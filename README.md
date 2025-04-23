# companion-module-qsys-remote-control

See [HELP.md](./companion/HELP.md) and [LICENSE](./LICENSE)

Reference available here: https://q-syshelp.qsc.com/#External_Control_APIs/QRC/QRC_Overview.htm

**V0.0.1**

- Initial module
- Includes most commands available, in a rough test state

**V1.0.0**

- Fixed login bug

**V1.0.1**

- Fixed termination bug

**V1.0.2**

- Fixed mixer_set\* actions

**V2.0.0**

- Upgrades for Companion v3 compatibility
- Added support for variables: any feedbacks currently in use can be variables, and additional can be set in module config
- EngineStatus variables added
- Threshold and boolean feedbacks are now boolean feedbacks
- Better response handling and command sending

**V2.0.1**

- Fix debug logging
- Fix configuration update to resubscribe feedbacks

**V2.1.0**

- Add Snapshot.Load and Snapshot.Save methods

**V2.2.0**

- Feat: Parse variables from `textinput` options in actions & feedbacks
- Improvement: Support sequential actions
- Improvement: Add message queue
- Fix: Declare consts in `control-fade` feedback callback
- Fix: Add `name` option to `loopPlayer_start` action def. Previously referenced in callback without option def
- Chore: Update dependencies
- Chore: Use `Node 22`
- Chore: Use `Yarn 4`
- Chore: Lint

**V3.0.0**

- Feat: Connect to & control redundant Qsys Cores, with appropriate variables, logging and status updates
- Feat: `PA.PageSubmit` action
- Feat: `StatusGet` action
- Feat: `Control.Get` action
- Feat: `ChangeGroup.Poll` action
- Feat: `Relative` action option for `Control.Set`, with `Min` and `Max` range limits
- Feat: `Ramp` action option for `Control.Set` when `Type` set to `Number`
- Feat: `Type` action option for `Control.Set` to set the data type of `Value` in the message
- Feat: `Seek` and `RefID` action options for `LoopPlayer.Start`
- Feat: `Control.Set` add `learn` callback
- Feat: `Control-state` feedback
- Feat: `Verbose Logs` config option
- Feat: `Action Recorder`
- Improvement: Send keep alive `NoOp` messages when socket is connected
- Improvement: Process responses from `ChangeGroup.Poll` messages
- Improvement: Control polling via a change group for better efficiency
- Improvement: `Control.Toggle` subscribe and unsubscribe callbacks
- Improvement: `Control.Set` subscribe (when `relative` == `true`) and unsubscribe callbacks
- Improvement: After `Control.Toggle` & `Control.Set` actions update internal controls map value, value variable & check feedbacks for response UI
- Improvement: Throttled `checkFeedbacksById` for named controls for better efficiency. Previously every feedback was rechecked when any control changed
- Improvement: Debounce variable definition updates after `addControl()` calls
- Improvement: Auto set `RefID` during `LoopPlayer.Start` API call if empty.
- Improvement: Log `LoopPlayer.Error` messages
- Fix: Send boolean values as bools rather than strings (`Mixer.SetCrossPointMute`, `Mixer.SetCrossPointSolo`, `Mixer.SetInputMute`, `Mixer.SetInputSolo`, `Mixer.SetOutputMute`, `Mixer.SetCueMute`, `Mixer.SetInputCueEnable`, `Mixer.SetInputCueAfl`, `LoopPlayer.Start`)
- Fix: `Feedback on boolean control value` when value is `true`
- Fix: `LoopPlayer.Stop` & `LoopPlayer.Cancel` Send `Outputs` as array of numbers
- Fix: `Component.Set` option `Ramp` sent as number
- Remove: `ChangeGroup.AddComponentControl` action broken, and module has no system for tracking component values
- Remove: `ChangeGroup.Remove`,`ChangeGroup.Destroy`,`ChangeGroup.Poll`,`ChangeGroup.Clear`,`ChangeGroup.addControl` actions. `ChangeGroup` API calls managed internally now.
- Deprecate: `Change text to reflect control value` feedback, use variables instead.
- Deprecate: `feedbacks_enabled` config option. Feedbacks always enabled.
- Deprecate: `bundle_feedbacks` option. Controls are always polled via a `ChangeGroup` which makes the option of disabling this irrelevant.