# companion-module-qsys-remote-control
See HELP.md and LICENSE

Reference available here: https://q-syshelp.qsc.com/#External_Control_APIs/QRC/QRC_Overview.htm

**V0.0.1** 
* Initial module
* Includes most commands available, in a rough test state

**V1.0.0**
* Fixed login bug

**V1.0.1**
* Fixed termination bug

**V1.0.2**
* Fixed mixer_set* actions

**V2.0.0**
* Upgrades for Companion v3 compatibility
* Added support for variables: any feedbacks currently in use can be variables, and additional can be set in module config
* EngineStatus variables added
* Threshold and boolean feedbacks are now boolean feedbacks
* Better response handling and command sending

**V2.0.1**
* Fix debug logging
* Fix configuration update to resubscribe feedbacks

**V2.1.0**
* Add Snapshot.Load and Snapshot.Save methods
