# homebridge-acinfinity-sauna

A Homebridge plugin that adds a **Sauna Cooldown** switch to HomeKit for a sauna vented by an AC Infinity UIS fan.

> [!WARNING]
> This plugin uses the AC Infinity and HUUM cloud APIs, which are **undocumented and unofficial**. They were learned from other open-source projects (see [Acknowledgments](#acknowledgments)). Either company could change them at any time, which would stop the plugin working until it is updated.

When you turn **Sauna Cooldown** on, the plugin:

1. Stops the HUUM sauna heater (optional).
2. Puts the AC Infinity fan port in **Auto** mode with a high-temperature trigger. The controller then runs the fan until the sauna cools to your target temperature, and stops it on its own.
3. Once the sauna has cooled, puts the port in **Off** mode and turns the switch off.

So the switch is **on for exactly as long as a cooldown is running**. Turning it off early cancels the cooldown and sets the fan port Off straight away. Automations can use "Sauna Cooldown turns off" to act when the sauna has cooled.

It also adds a **Sauna Fan**: a HomeKit fan with on/off and a speed slider. Home shows on/off and speed only.

- **Speed shows the fan's real level** (0–10 as 0–100%), read once a minute. Changes made with the controller's buttons show up at the next check. During a cooldown, the fan shows on whenever it is spinning.
- **Setting a speed** changes only the fan speed if a cooldown is running, so the fan still stops at the target temperature. Otherwise it ends any cooldown and sets the port **On** at that speed.
- **Turning it on** without a speed sets the port **On** at the speed set on the controller, or 10 if that is 0. This also ends any cooldown.
- **Turning it off**, or setting 0%, ends any cooldown and sets the port **Off**. The fan shows off straight away, and its speed winds down to 0 as it spins down.
- **Slider drags send one change**, once the slider has been still for a second.
- After a change, Home shows the new setting for up to 10 seconds while the fan gets up to speed, then follows the real fan again. The plugin also checks the fan straight after every change.
- **Sauna Cooldown, Daily Off time and the cooldown's own Off** all update the fan.

If you leave the fan On, it will run during the next heat-up. **Daily Off time** (below) is a good backstop.

### Temperature sensor

The plugin also adds a **Sauna Temperature** sensor showing the AC Infinity probe reading. Use it in automations such as "when Sauna Temperature drops below 90 °F".

- The plugin updates the reading every 2 minutes by default (30 s to 10 min). The AC Infinity cloud can't push updates, so the plugin polls it. To save API calls, the sensor reuses the fan's once-a-minute reading when that is under a minute old, so a reading can be up to about a minute old.
- Readings up to 150 °C (302 °F) are shown. HomeKit's usual limit for temperature sensors is 100 °C.
- If the probe sends no believable reading (missing, exactly 0, or outside −20 °C to 130 °C), that poll counts as failed.
- After 3 failed polls in a row, the sensor shows **No Response** until a poll succeeds. Until then, Home keeps showing the last reading.
- After a Homebridge restart, the sensor shows No Response until the first poll succeeds.

The cooldown uses the same probe reading and the same checks: if there is no believable reading, it waits for the next check rather than deciding the sauna has cooled.

## Why the port has to end up Off

Auto mode with a high-temperature trigger is exactly right for cooling down. It is exactly wrong for the next session: as the heater warms the room past the trigger, the controller would start the fan and fight the heater.

So during a cooldown, the plugin checks the controller every few minutes. Once the fan has stopped **and** the probe reads at or below the target, it sets the port Off. The next session then starts with the fan off. Fan speed during a session is still set at the controller.

If Homebridge restarts during a cooldown, the plugin loses track of it: the Sauna Cooldown switch shows off, and the port stays in Auto. Set **Daily Off time** as a backstop: the port is set Off at that time every day.

## Supported controllers

| Controller | Supported |
|---|---|
| UIS Controller 69 Pro | Yes (tested) |
| UIS Controller 69 Pro+ | Yes (untested; same API) |
| 89 AI+, Outlet AI, Outlet AI+ | Not yet. The plugin logs "Unsupported controller type" and adds no accessories. |
| 69 (base), 67 | No. These are Bluetooth only and have no cloud API. |

## Installation

In the Homebridge UI, open **Plugins**, search for **AC Infinity Sauna**, and click **Install**. Then fill in the plugin's settings and restart Homebridge.

Or from the command line:

```sh
npm install -g homebridge-acinfinity-sauna
```

Requires Homebridge 1.8 or 2.x, on Node.js 20, 22, 24 or 26.

## Configuration

Configure it in the Homebridge UI, or add this to `config.json`:

```json
{
  "platform": "ACInfinitySauna",
  "acinfinity": {
    "email": "you@example.com",
    "password": "…",
    "port": 1
  },
  "cooldown": { "temperatureF": 90, "fanSpeed": 10, "checkIntervalMinutes": 10 },
  "scheduledOffTime": "23:30",
  "huum": { "email": "you@example.com", "password": "…" }
}
```

| Key | Default | Notes |
|---|---|---|
| `acinfinity.email`, `acinfinity.password` | (required) | The AC Infinity app login. Only the first 25 characters of the password are used, because the API ignores the rest. |
| `acinfinity.port` | (required) | The fan's port on the controller, 1–8. |
| `acinfinity.controllerId` | auto | Only needed if the account has more than one 69 Pro or Pro+. The log lists each controller's devId. |
| `cooldown.temperatureF` | 90 | The fan runs until the probe reads at or below this temperature. |
| `cooldown.fanSpeed` | 10 | Fan speed during the cooldown, 1–10. |
| `cooldown.checkIntervalMinutes` | 10 | How often to check whether the cooldown has finished. |
| `scheduledOffTime` | (off) | `HH:MM` in local time. Sets the port Off every day at this time. |
| `huum.email`, `huum.password` | (off) | If either is missing, the plugin doesn't use HUUM at all. |
| `temperatureSensor.name` | `Sauna Temperature` | Sensor name. |
| `temperatureSensor.pollIntervalSeconds` | 120 | How often to read the probe, 30–600. |
| `cooldownName` | `Sauna Cooldown` | Cooldown switch name. |
| `fan.name` | `Sauna Fan` | Fan name. |
| `debug` | false | Logs each API call and the response fields the plugin uses, at the normal log level, so you don't need Homebridge's own debug mode. Passwords, tokens and device identifiers are never logged. |

## Things to know

- **The mode reported after Off lags behind.** After the port is set Off, the AC Infinity app and API keep reporting the old mode until the fan has fully spun down, and only then show Off. That is normal. The plugin doesn't treat it as a failure.
- If the HUUM stop fails, the plugin logs the error and still starts the fan cooldown.
- If a cooldown check can't reach the API, the plugin logs the error and tries again at the next check.
- The AC Infinity API uses plain HTTP, the same as the official app.

## Development

```sh
npm test   # runs the plugin against a mocked API and a fake Homebridge; no hardware needed
```

## Acknowledgments

This plugin talks to the undocumented AC Infinity and HUUM cloud APIs. Their
behavior was learned from the following open-source projects:

- [homeassistant-acinfinity](https://github.com/dalinicus/homeassistant-acinfinity)
  by dalinicus (MIT). Source of the port-settings write approach, the
  device-control field list, and the port mode values.
- [homebridge-acinfinity](https://github.com/keithah/homebridge-acinfinity)
  by keithah (MIT). Its API reference documents the AC Infinity endpoints,
  login quirks, and rate-limiting behavior.
- [pyhuum](https://github.com/frwickst/pyhuum) by Frank Wickström (MIT).
  Source of the HUUM endpoints, authentication, and status codes.

This project is not affiliated with or endorsed by AC Infinity Inc. or HUUM.
"AC Infinity" and "HUUM" are trademarks of their respective owners.

## License

MIT. See [LICENSE](LICENSE). Third-party notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
