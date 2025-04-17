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
- Chore: Use Node 22
- Chore: Use Yarn 4
- Chore: Lint

**V2.3.0**

- Feat: Connect to & control redundant Qsys Cores, with appropriate variables, logging and status updates
- Feat: `PA.PageSubmit` action
- Feat: `StatusGet` action
- Feat: `Relative` action option for `Control.Set` only available when feedbacks are enabled, with `Min` and `Max` range limits
- Feat: `Seek` and `RefID` action options for `LoopPlayer.Start`
- Feat: `Control.set` add `learn` callback
- Feat: `Control-state` feedback
- Feat: `Verbose Logs` config option
- Feat: `StatusGet` action
- Improvement: Send keep alive `NoOp` messages
- Improvement: `Control.toggle` subscribe and unsubscribe callbacks
- Improvement: `Control.set` subscribe (when `relative` == `true`) and unsubscribe callbacks
- Improvement: After `Control.toggle` & `Control.set` actions update internal controls map value and value variable
- Improvement: Dont define control variables if feedbacks are disabled
- Improvement: Debounce variable definition updates after `addControl()` calls
- Improvement: Hide related config fields when feedbacks are disabled
- Improvement: Add static-text warning to `Control.toggle` when feedbacks are disabled
- Improvement: Add static-text warning to `Control.set` when feedbacks are disabled and `relative` is enabled
- Fix: Send boolean values as bools rather than strings (`Mixer.SetCrossPointMute`, `Mixer.SetCrossPointSolo`, `Mixer.SetInputMute`, `Mixer.SetInputSolo`, `Mixer.SetOutputMute`, `Mixer.SetCueMute`, `Mixer.SetInputCueEnable`, `Mixer.SetInputCueAfl`, `LoopPlayer.Start`)
- Improvement: Auto set `RefID` during `LoopPlayer.Start` API call if empty.
- Improvement: Log `LoopPlayer.Error` messages
- Fix: `Feedback on boolean control value` when value is `true`
