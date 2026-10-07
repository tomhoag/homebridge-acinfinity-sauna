#!/usr/bin/env node
// sauna.mjs — HUUM stop + AC Infinity 69 Pro auto-mode cooldown.
// Node 18+ (built-in fetch), no dependencies.
//
// Env:
//   ACI_EMAIL, ACI_PASSWORD     AC Infinity account
//   HUUM_EMAIL, HUUM_PASSWORD   HUUM account (only needed for huum-* and cooldown)
//
// Usage:
//   node sauna.mjs list                              controllers, ports, devIds
//   node sauna.mjs show <devId> <port>               current port mode/trigger settings
//   node sauna.mjs cooldown <devId> <port> [tempF]   HUUM stop + port Auto, high-temp trigger (default 90F), speed 10
//   node sauna.mjs off <devId> <port>                port Off (use at sauna start)
//   node sauna.mjs watch <devId> <port> [tempF] [intervalSec]
//                                                    daemon: heater on -> port Off; heater off -> port Auto cooldown
//   node sauna.mjs huum-status | huum-stop
//   Add --dry to print the addDevMode payload without sending it.

const ACI_HOST = "http://www.acinfinityserver.com";
const HUUM_BASE = "https://sauna.huum.eu/action/home";

const AT_TYPE = { OFF: 1, ON: 2, AUTO: 3 };

// Every key the HA integration (dalinicus/homeassistant-acinfinity, const.py DeviceControlKey)
// round-trips to /api/dev/addDevMode for non-AI controllers (69 Pro / Pro+).
const DEVICE_CONTROL_KEYS = [
  "devId", "externalPort", "modeSetid", "modeType", "masterPort", "surplus",
  "onSpead", "offSpead", "onSelfSpead", "atType", "powerState", "power", "loadState",
  "loadType", "speak", "abnormalState", "toward", "schedStartTime", "schedEndtTime",
  "acitveTimerOn", "acitveTimerOff", "activeCycleOn", "activeCycleOff",
  "activeHtVpd", "activeHtVpdNums", "activeLtVpd", "activeLtVpdNums", "vpdstatus",
  "vpdnums", "vpdSettingMode", "targetVpd", "targetVpdSwitch", "isUpdateVpdNums",
  "devHt", "activeHt", "devLt", "activeLt", "temperature", "targetTemp",
  "targetTSwitch", "insideTemp", "outsideTemp", "devHtf", "devLtf", "temperatureF",
  "targetTempF", "devHh", "activeHh", "devLh", "activeLh", "humidity", "targetHumi",
  "targetHumiSwitch", "trend", "tTrend", "hTrend", "insideTrend", "outsideTrend",
  "unit", "ecOrTds", "ecUnit", "tdsUnit", "ecTdsSettingMode", "ecTdsAccuracy",
  "ecTdsTargetSwitch", "ecTdsTargetValueEcUs", "ecTdsTargetValueEcMs",
  "ecTdsTargetValueTdsPpm", "ecTdsTargetValueTdsPpt", "ecTdsHighSwitch",
  "ecTdsHighValueEcUs", "ecTdsHighValueEcMs", "ecTdsHighValueTdsPpm",
  "ecTdsHighValueTdsPpt", "ecTdsLowSwitchEc", "ecTdsLowSwitchTds",
  "ecTdsLowValueEcUs", "ecTdsLowValueEcMs", "ecTdsLowValueTdsPpm",
  "ecTdsLowValueTdsPpt", "phSettingMode", "phAccuracy", "phTargetSwitch",
  "phTargetValue", "phHighSwitch", "phHighValue", "phLowSwitch", "phLowValue",
  "co2SettingMode", "co2Accuracy", "co2TargetSwitch", "co2TargetValue",
  "co2HighSwitch", "co2HighValue", "co2LowSwitch", "co2LowValue",
  "co2FanSettingMode", "co2FanAccuracy", "co2FanTargetSwitch", "co2FanTargetValue",
  "co2FanHighSwitch", "co2FanHighValue", "co2FanLowSwitch", "co2FanLowValue",
  "moistureSettingMode", "moistureAccuracy", "moistureTargetSwitch",
  "moistureTargetValue", "moistureHighSwitch", "moistureHighValue",
  "moistureLowSwitch", "moistureLowValue", "waterLevelSettingMode",
  "waterLevelAccuracy", "waterLevelTargetSwitch", "waterLevelTargetValue",
  "waterLevelHighSwitch", "waterLevelHighValue", "waterLevelLowSwitch",
  "waterLevelLowValue", "waterTempSettingMode", "waterTempAccuracy",
  "waterTempTargetSwitch", "waterTempTargetValue", "waterTempHighSwitch",
  "waterTempHighValue", "waterTempLowSwitch", "waterTempLowValue",
  "waterTempTargetValueF", "waterTempHighValueF", "waterTempLowValueF",
  "isOpenAutomation", "settingMode", "onlyUpdateSpeed", "restore", "devSetting",
];

// Fields printed by `show` and after writes.
const WATCH_KEYS = [
  "atType", "modeType", "onSpead", "offSpead", "activeHt", "devHt", "devHtf",
  "activeLt", "devLt", "devLtf", "activeHh", "activeLh", "temperature", "temperatureF",
];

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
// --mode-type N : also override modeType (test whether the 69 Pro needs it alongside atType)
const mtIdx = args.indexOf("--mode-type");
const MODE_TYPE = mtIdx >= 0 ? Number(args[mtIdx + 1]) : undefined;
const positional = args.filter((a, i) => {
  if (a === "--dry") return false;
  if (mtIdx >= 0 && (i === mtIdx || i === mtIdx + 1)) return false;
  return true;
});
const [cmd, ...rest] = positional;
const withModeType = (o) => (MODE_TYPE === undefined ? o : { ...o, modeType: MODE_TYPE });

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

// ---------- AC Infinity ----------

let aciToken = null;

async function aciPost(path, form) {
  const headers = { "User-Agent": "okhttp/4.12.0" };
  if (aciToken) headers.token = aciToken;
  const init = { method: "POST", headers };
  if (form) init.body = new URLSearchParams(form);
  const res = await fetch(`${ACI_HOST}${path}`, init);
  if (!res.ok) throw new Error(`AC Infinity HTTP ${res.status} on ${path}`);
  const body = await res.json();
  if (body.code !== 200) throw new Error(`AC Infinity code ${body.code} on ${path}: ${JSON.stringify(body)}`);
  return body.data;
}

async function aciLogin() {
  const data = await aciPost("/api/user/appUserLogin", {
    appEmail: env("ACI_EMAIL"),
    appPasswordl: env("ACI_PASSWORD").slice(0, 25), // API spelling and 25-char limit are intentional
  });
  aciToken = String(data.appId);
}

async function getPortSettings(devId, port) {
  return aciPost("/api/dev/getdevModeSettingList", { devId, port });
}

// Same approach as HA's update_device_controls: read current settings, override, send everything back.
async function setPortControls(devId, port, overrides) {
  const existing = await getPortSettings(devId, port);
  const payload = {};
  for (const key of DEVICE_CONTROL_KEYS) {
    let v = key in overrides ? overrides[key] : existing[key];
    if (v === undefined || v === null) v = 0;
    else if (typeof v === "object") v = JSON.stringify(v);
    else if (typeof v === "boolean") v = String(v);
    payload[key] = v;
  }
  const qs = new URLSearchParams(payload).toString();
  if (DRY) {
    console.log("DRY RUN — would POST /api/dev/addDevMode with:");
    for (const k of Object.keys(overrides)) console.log(`  ${k}=${payload[k]}  (was ${existing[k]})`);
    return;
  }
  const res = await fetch(`${ACI_HOST}/api/dev/addDevMode?${qs}`, {
    method: "POST",
    headers: { "User-Agent": "okhttp/4.12.0", token: aciToken },
  });
  const text = await res.text();
  console.log(`addDevMode HTTP ${res.status}: ${text}`);
  // Give the cloud/controller a moment before the read-back.
  await new Promise((r) => setTimeout(r, 5000));
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj?.[k] ?? obj?.devSetting?.[k];
  return out;
}

async function showPort(devId, port, label = "Port settings") {
  const s = await getPortSettings(devId, port);
  console.log(`${label} (devId ${devId}, port ${port}):`);
  console.table(pick(s, WATCH_KEYS));
  return s;
}

const fToC = (f) => Math.round(((f - 32) * 5) / 9);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- HUUM ----------

function huumAuth() {
  const token = Buffer.from(`${env("HUUM_EMAIL")}:${env("HUUM_PASSWORD")}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

async function huum(method, action) {
  const res = await fetch(`${HUUM_BASE}/${action}`, { method, headers: huumAuth() });
  if (!res.ok) throw new Error(`HUUM HTTP ${res.status} on ${action}`);
  return res.json();
}

// ---------- commands ----------

async function main() {
  switch (cmd) {
    case "list": {
      await aciLogin();
      const controllers = await aciPost("/api/user/devInfoListAll", { userId: aciToken });
      for (const c of controllers) {
        const t = c.deviceInfo?.temperature;
        console.log(`${c.devName}  devId=${c.devId}  type=${c.devType}  temp=${t != null ? (t / 100).toFixed(1) + "C" : "?"}`);
        for (const p of c.deviceInfo?.ports ?? []) {
          console.log(`  port ${p.port}: ${p.portName}  online=${p.online}  speed=${p.speak}`);
        }
      }
      break;
    }
    case "show": {
      const [devId, port] = rest;
      await aciLogin();
      await showPort(devId, port);
      break;
    }
    case "cooldown": {
      const [devId, port, tempArg] = rest;
      const tempF = Number(tempArg ?? 90);
      if (!DRY) {
        const r = await huum("POST", "stop");
        console.log("HUUM stop sent. statusCode:", r.statusCode ?? "(none)", "temperature:", r.temperature ?? "(none)");
      }
      await aciLogin();
      await showPort(devId, port, "Before");
      await setPortControls(devId, port, withModeType({
        atType: AT_TYPE.AUTO,
        activeHt: 1,
        devHtf: tempF,
        devHt: fToC(tempF),
        activeLt: 0,
        activeHh: 0,
        activeLh: 0,
        onSpead: 10,
        offSpead: 0,
      }));
      if (!DRY) await showPort(devId, port, "After");
      break;
    }
    case "off": {
      const [devId, port] = rest;
      await aciLogin();
      await setPortControls(devId, port, withModeType({ atType: AT_TYPE.OFF }));
      if (!DRY) await showPort(devId, port, "After");
      break;
    }
    case "watch": {
      // Long-running: poll HUUM and drive the fan port on heater state transitions.
      //   not heating -> heating (231): port Off   (fan won't fight the heater)
      //   heating -> not heating:       port Auto, high-temp trigger (cooldown to tempF)
      // Covers sessions started/stopped from the HUUM app, wall panel, or session timer.
      const [devId, port, tempArg, intervalArg] = rest;
      const tempF = Number(tempArg ?? 90);
      const intervalMs = Number(intervalArg ?? 60) * 1000;
      const HEATING = 231;
      const log = (...m) => console.log(new Date().toISOString(), ...m);
      let last = null;

      const act = async (fn, label) => {
        try {
          await aciLogin(); // re-login each time; token lifetime is undocumented
          await fn();
          log(`${label} done`);
        } catch (e) {
          log(`${label} FAILED: ${e.message}`);
          return false;
        }
        return true;
      };

      log(`watching HUUM every ${intervalMs / 1000}s; devId ${devId} port ${port}; cooldown to ${tempF}F`);
      for (;;) {
        try {
          const s = await huum("GET", "status");
          const code = s.statusCode;
          if (last !== null && code !== last) {
            log(`HUUM status ${last} -> ${code} (temp ${s.temperature ?? "?"}C)`);
            if (code === HEATING) {
              const ok = await act(() => setPortControls(devId, port, withModeType({ atType: AT_TYPE.OFF })), "port Off");
              if (!ok) { await sleep(intervalMs); continue; } // keep `last` so we retry next poll
            } else if (last === HEATING) {
              const ok = await act(() => setPortControls(devId, port, withModeType({
                atType: AT_TYPE.AUTO, activeHt: 1, devHtf: tempF, devHt: fToC(tempF),
                activeLt: 0, activeHh: 0, activeLh: 0, onSpead: 10, offSpead: 0,
              })), "port Auto (cooldown)");
              if (!ok) { await sleep(intervalMs); continue; }
            }
          }
          last = code;
        } catch (e) {
          log(`HUUM poll failed: ${e.message}`);
        }
        await sleep(intervalMs);
      }
    }
    case "huum-status":
      console.log(JSON.stringify(await huum("GET", "status"), null, 2));
      break;
    case "huum-stop":
      console.log(JSON.stringify(await huum("POST", "stop"), null, 2));
      break;
    default:
      console.log("Usage: node sauna.mjs list | show <devId> <port> | cooldown <devId> <port> [tempF] | off <devId> <port> | watch <devId> <port> [tempF] [intervalSec] | huum-status | huum-stop  [--dry] [--mode-type N]");
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
