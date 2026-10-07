# Handoff: homebridge-acinfinity-sauna

## Goal

Homebridge plugin that gives HomeKit an **"End Sauna"** action for a sauna vented by an AC Infinity UIS fan:

1. Optionally stop the HUUM sauna heater.
2. Put the AC Infinity fan port in **Auto** mode with a high-temperature trigger, so the controller runs the fan until the sauna cools to a target temperature, then stops the fan itself.
3. Once cooled, put the port in **Off** mode. Otherwise Auto would turn the fan on during the next heat-up and fight the heater.

The owner sets fan speed during sessions at the controller. This plugin does **not** control speed during a session.

## Status

- Spec is final (below). No plugin code written yet.
- A stray `package.json` was started under the old name `homebridge-sauna-cooldown`. Discard it.
- A CLI prototype (`sauna.mjs`, since removed) verified the API against the real hardware. `src/acinfinity.js` is now the API reference.

## Naming

- Package: `homebridge-acinfinity-sauna`. Homebridge requires the `homebridge-` prefix and the `homebridge-plugin` keyword.
- Display name: "AC Infinity Sauna".
- Platform alias: `ACInfinitySauna`.

## Supported hardware (v1)

| Controller | devType | Status |
|---|---|---|
| UIS Controller 69 Pro | 11 | Supported. Tested via the CLI prototype on the owner's unit. |
| UIS Controller 69 Pro+ | 18 | Supported; untested. Uses the same API path per the HA integration. |
| 89 AI+, Outlet AI, Outlet AI+ | 20, 21, 22 | **Not in v1.** They need a different write path (see below). At startup, log a clear "unsupported controller type N" error and expose nothing. |
| 69 (base), 67 | — | Bluetooth only, no cloud API. Cannot be supported. |

## Config (`config.schema.json`)

| Key | Required | Default | Notes |
|---|---|---|---|
| `platform` | yes | `ACInfinitySauna` | |
| `name` | no | `AC Infinity Sauna` | |
| `acinfinity.email` | yes | | |
| `acinfinity.password` | yes | | The API only accepts the first 25 characters, so truncate. |
| `acinfinity.controllerId` | no | auto | If blank and the account has exactly one supported controller, use it. If several, log each controller's `devId`, `devName` and `devType`, and refuse to start. |
| `acinfinity.port` | yes | | 1–8 depending on controller. Validate against the ports returned. |
| `cooldown.temperatureF` | no | 90 | Target °F. Also write °C, rounded, to `devHt`. |
| `cooldown.fanSpeed` | no | 10 | 1–10 (`onSpead`). |
| `cooldown.checkIntervalMinutes` | no | 10 | Polling interval after End Sauna. |
| `scheduledOffTime` | no | blank | `HH:MM`, local time. Daily backstop that sets the port Off. Blank disables it. |
| `huum.email` | no | | If `huum.email` or `huum.password` is missing, skip HUUM entirely. |
| `huum.password` | no | | |
| `endSaunaName` | no | `End Sauna` | Accessory name. |
| `fanOffName` | no | `Sauna Fan Off` | Accessory name. |
| `debug` | no | false | Log request and response bodies. Never log passwords or tokens. |

## HomeKit accessories

Both are **stateless/momentary Switch services**: on `set(true)`, start the action asynchronously, return immediately, and flip back to `false` after about 1 s. `set(false)` is a no-op.

### "End Sauna"
1. If HUUM is configured, call HUUM stop.
   - On failure, log it and **continue** with the fan.
2. Set the port to **Auto**, using the override set below.
3. Start the cooldown poll, which replaces any poll already running.

### "Sauna Fan Off"
1. Cancel any cooldown poll.
2. Set the port to **Off** (`atType: 1`).

## Cooldown poll

Every `checkIntervalMinutes`:
1. Read the port and controller state (see API below).
2. If the fan has stopped (port `speak == 0`) **and** the probe reads at or below `temperatureF`, set the port **Off** and stop polling.
3. On API errors, log and retry on the next tick. Do not stop polling.

Known gaps, deliberately accepted:
- If Homebridge restarts mid-cooldown, the poll is lost. `scheduledOffTime` is the backstop. Do not add persistence in v1.
- Open question for the owner: add a maximum cooldown duration (e.g. 4 h) that forces the port Off? It is not in the agreed spec; ask before adding.

## Scheduled Off

If `scheduledOffTime` is set:
- Compute the next local occurrence, `setTimeout` to it, set the port **Off**, then reschedule.
- Recompute each day so DST changes are handled.
- Also cancel any running cooldown poll.

## AC Infinity cloud API

These details are verified from source and from live runs.

Sources:
- HA integration: dalinicus/homeassistant-acinfinity, `custom_components/ac_infinity/client.py` and `const.py`.
- keithah/homebridge-acinfinity `API_REFERENCE.md`.

Base URL: `http://www.acinfinityserver.com`. It is plain HTTP; HTTPS is not used by the official app.

Header on every call: `User-Agent: okhttp/4.12.0`. After login, also send `token: <appId>`. Bodies are `application/x-www-form-urlencoded`.

**Login**
```
POST /api/user/appUserLogin
appEmail=<email>&appPasswordl=<password[0:25]>
```
- The field name `appPasswordl`, with a trailing `l`, is correct.
- `data.appId` is the token.
- Token lifetime is undocumented. Re-login on any `code` other than 200 and retry once. Re-logging in before each action is also acceptable.

**List controllers**
```
POST /api/user/devInfoListAll
userId=<appId>
```
`data[]` contains, per controller:
- `devId`, `devName`, `devType`
- `deviceInfo.temperature` (°C × 100)
- `deviceInfo.ports[]`, each with `port`, `portName`, `online`, `speak` (current fan level 0–10), `loadState`, `curMode`

**Read port settings**
```
POST /api/dev/getdevModeSettingList
devId=<devId>&port=<port>
```
`data` contains:
- `atType` (mode), `onSpead`, `offSpead`
- `activeHt`, `devHt` (°C), `devHtf` (°F)
- `temperature` (°C × 100), `temperatureF` (°F × 100)
- `devSetting` (nested object), among others

**Write port settings**, for the 69 Pro and Pro+. Copy the HA approach exactly:
1. Read current settings with `getdevModeSettingList` for the same `devId`/`port`.
2. For every key in HA's `DeviceControlKey` list, which is reproduced in `src/acinfinity.js` as `DEVICE_CONTROL_KEYS`:
   - use the override value if one is given, else the existing value;
   - send `null`/`undefined` as `0`, objects and arrays as JSON strings, booleans as `"true"`/`"false"`.
3. `POST /api/dev/addDevMode?<urlencoded full key set>` with an **empty body** and the `token` header.
4. Success is `code == 200`.

Do **not** use the keithah plugin's write path for devType 11. It writes controller-level port 0 settings, cannot change mode, and coerces `offSpead` 0 → 1 via `settings.offSpead || 1`.

**Mode values (`atType`):**

| atType | Mode |
|---|---|
| 1 | Off |
| 2 | On |
| 3 | Auto |
| 4 | Timer to On |
| 5 | Timer to Off |
| 6 | Cycle |
| 7 | Schedule |
| 8 | VPD |

`modeType` reads 0 on the owner's 69 Pro even in Auto. Leave it untouched; pass the existing value through.

**Auto cooldown override set:**
```
atType=3, activeHt=1, devHtf=<temperatureF>, devHt=<round((F-32)*5/9)>,
activeLt=0, activeHh=0, activeLh=0, onSpead=<fanSpeed>, offSpead=0
```

**Off override set:** `atType=1`

**Observed behavior (owner-verified):** after an Off write, the read-back keeps reporting the old `atType` until the fan has fully spun down, then reports 1. **Do not treat an immediate read-back mismatch as failure.** Either don't verify, or re-check on the next poll tick.

**Rate limiting:**
- The API reference recommends keep-alive connections and spacing requests by about 500 ms.
- Keep calls sequential.
- One read plus one write per action, plus one or two reads per poll tick, is well within limits.

**AI controllers (future, not v1):** they use `PUT /api/dev/modeAndSetting` with a `modeAndSettingIdStr` per `atType` and the `minversion: 3.5` header; see HA `update_ai_device_control_and_settings`.

## HUUM API (optional)

Source: frwickst/pyhuum `huum/huum.py` and `const.py`. HUUM stop has been verified live.

- Base: `https://sauna.huum.eu/action/home/`
- Auth: HTTP Basic with the HUUM app email and password.
- Stop: `POST stop`. Returns JSON including `statusCode` and `temperature` (°C).
- Status: `GET status`.
- `statusCode` values: 230 offline, 231 heating, 232 online not heating, 233 locked, 400 emergency stop.
- There is no local LAN API; HUUM is cloud only.

## Implementation notes

- Node ≥ 18. Use built-in `fetch`; no runtime dependencies.
- Homebridge `engines`: `^1.8.0 || ^2.0.0`.
- Dynamic platform plugin. Cache both accessories by UUID, derived from the platform name plus the accessory role.
- `config.schema.json` should use `required` on the AC Infinity fields and group HUUM under an expandable section.
- README should:
  - explain the Auto → Off lifecycle and why the port must end in Off (heat-up);
  - credit the HA integration and the keithah plugin for the API reverse-engineering;
  - document the spin-down read-back delay.

## Acceptance tests (on the owner's hardware)

1. Start Homebridge with only AC Infinity configured.
   - Two switches appear.
   - The log shows the resolved controller and port.
   - No HUUM calls are made.
2. With the sauna hot, tap **End Sauna**.
   - The HUUM heater stops (if configured); the log shows `statusCode` 232.
   - The AC Infinity app shows the port in Auto at the configured temperature and speed, and the fan running.
3. After the probe drops below the target, the next poll tick sets the port to Off. The AC Infinity app shows Off.
4. Tap **Sauna Fan Off** mid-cooldown. The port goes Off and polling stops (visible in the log).
5. Set `scheduledOffTime` to two minutes ahead with the port in Auto. The port goes Off at that time.
6. Configure the wrong port, or an unsupported controller type. You get a clear error and no accessories are exposed.
