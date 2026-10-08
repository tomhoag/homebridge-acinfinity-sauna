# Changelog

All notable changes to this plugin. Versions follow [semantic versioning](https://semver.org).

## 1.0.2

- Declares HomeKit (HAP) support with the `supports-hap` keyword, as the Homebridge verification checks require. No code changes.

## 1.0.1

- An unexpected error during startup is now logged instead of risking a Homebridge crash.
- The `debug` setting now works on its own. Before, its output only appeared with Homebridge's own debug mode turned on.
- Debug logs now show only the fields the plugin uses, plus sensor readings. Whole API responses, including device identifiers such as MAC addresses, are no longer logged.
- The README now warns near the top that the plugin relies on undocumented cloud APIs.
- Supported Node.js versions are now stated precisely: 20, 22, 24 and 26.
- Added this changelog, and tests that run on every push and pull request.
- Added a funding link, so the Homebridge UI shows a Donate button.

## 1.0.0

First public release.

- **Sauna Cooldown** switch: stops the HUUM heater (optional), runs the AC Infinity fan in Auto until the sauna cools to a target temperature, then sets the fan port Off. On for as long as a cooldown runs.
- **Sauna Fan**: on/off and speed control, showing the fan's real speed. Speed changes during a cooldown keep Auto.
- **Sauna Temperature** sensor for the AC Infinity probe, up to 150 °C.
- Optional daily Off time as a backstop.
- Supports the UIS Controller 69 Pro and 69 Pro+.
