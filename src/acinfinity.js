// AC Infinity cloud API client for UIS 69 Pro / Pro+ controllers.
// API details: dalinicus/homeassistant-acinfinity (client.py, const.py) and
// keithah/homebridge-acinfinity API_REFERENCE.md.

const HOST = "http://www.acinfinityserver.com"; // plain HTTP, same as the official app
const USER_AGENT = "okhttp/4.12.0";
const REQUEST_SPACING_MS = 500;
const REQUEST_TIMEOUT_MS = 20000;

export const AT_TYPE = { OFF: 1, ON: 2, AUTO: 3 };

// Derived from homeassistant-acinfinity (MIT); see THIRD_PARTY_NOTICES.md.
// Every key the HA integration (const.py DeviceControlKey) round-trips to
// /api/dev/addDevMode for non-AI controllers.
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

// Never written to the log, in requests or responses.
const SECRET_KEYS = new Set(["appPasswordl", "appId", "token", "userId", "appEmail"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// devIds exceed Number.MAX_SAFE_INTEGER, so quote any bare 16+ digit integer before parsing.
function parseJsonPreservingBigInts(text) {
  return JSON.parse(text.replace(/([:,[]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"'));
}

// Debug logs show only what the plugin uses, never whole responses: those also carry device
// identifiers such as MAC addresses. Sensor-like fields are kept to help diagnose probe readings.
const SENSOR_FIELD = /temp|humi|vpd|sensor|probe/i;
const PORT_SETTING_FIELDS = [
  "atType", "modeType", "onSpead", "offSpead", "activeHt", "devHt", "devHtf", "activeLt", "activeHh", "activeLh",
];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj?.[k] !== undefined) out[k] = obj[k];
  return out;
}

function sensorFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (SENSOR_FIELD.test(k) && (v === null || typeof v !== "object")) out[k] = v;
  }
  return out;
}

function summarizeResponse(path, body) {
  const summary = pick(body, ["code", "msg"]);
  const data = body?.data;
  if (path === "/api/user/devInfoListAll" && Array.isArray(data)) {
    summary.controllers = data.map((c) => ({
      ...pick(c, ["devId", "devName", "devType"]),
      ...sensorFields(c.deviceInfo),
      ports: (c.deviceInfo?.ports ?? []).map((p) => pick(p, ["port", "portName", "online", "speak", "loadState", "curMode"])),
    }));
  } else if (path === "/api/dev/getdevModeSettingList" && data) {
    summary.settings = { ...pick(data, PORT_SETTING_FIELDS), ...sensorFields(data) };
  }
  return summary;
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.has(k) ? "<redacted>" : redact(v);
    return out;
  }
  return value;
}

export class ACInfinityClient {
  constructor({ email, password, log, debug = false }) {
    this.email = email;
    this.password = String(password).slice(0, 25); // the API only accepts 25 characters
    this.log = log;
    this.debug = debug;
    this.token = null;
    this.lastRequestAt = 0;
    this.queue = Promise.resolve();
  }

  // Public calls run one at a time so requests stay sequential and spaced.
  #enqueue(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async #send(path, { form, query } = {}) {
    const wait = this.lastRequestAt + REQUEST_SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);

    const headers = { "User-Agent": USER_AGENT };
    if (this.token) headers.token = this.token;
    const init = { method: "POST", headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
    if (form) init.body = new URLSearchParams(form);
    const url = query ? `${HOST}${path}?${new URLSearchParams(query)}` : `${HOST}${path}`;

    // addDevMode sends every port setting; its changes are logged separately by setPortControls.
    if (this.debug) this.log.debug(`AC Infinity -> ${path}`, query ? "(port settings)" : JSON.stringify(redact(form ?? {})));
    try {
      const res = await fetch(url, init);
      if (!res.ok) throw new Error(`AC Infinity HTTP ${res.status} on ${path}`);
      const body = parseJsonPreservingBigInts(await res.text());
      if (this.debug) this.log.debug(`AC Infinity <- ${path}`, JSON.stringify(summarizeResponse(path, body)));
      return body;
    } finally {
      this.lastRequestAt = Date.now();
    }
  }

  async #login() {
    this.token = null;
    const body = await this.#send("/api/user/appUserLogin", {
      form: { appEmail: this.email, appPasswordl: this.password }, // "appPasswordl" is the API's spelling
    });
    if (body.code !== 200 || !body.data?.appId) {
      throw new Error(`AC Infinity login failed (code ${body.code}${body.msg ? `: ${body.msg}` : ""})`);
    }
    this.token = String(body.data.appId);
  }

  // Token lifetime is undocumented: on any non-200 code, log in again and retry once.
  async #call(path, opts) {
    if (!this.token) await this.#login();
    let body = await this.#send(path, opts);
    if (body.code !== 200) {
      await this.#login();
      body = await this.#send(path, opts);
    }
    if (body.code !== 200) throw new Error(`AC Infinity code ${body.code} on ${path}${body.msg ? `: ${body.msg}` : ""}`);
    return body.data;
  }

  // Callers can accept a cached result up to maxAgeMs old. A fetch already in flight is shared,
  // so the sensor poll, fan refresh and cooldown check never send duplicate calls.
  listControllers({ maxAgeMs = 0 } = {}) {
    if (this.devices && Date.now() - this.devices.at < maxAgeMs) return Promise.resolve(this.devices.data);
    if (this.devicesInFlight) return this.devicesInFlight;
    this.devicesInFlight = this.#enqueue(async () => {
      if (!this.token) await this.#login();
      const data = (await this.#call("/api/user/devInfoListAll", { form: { userId: this.token } })) ?? [];
      this.devices = { at: Date.now(), data };
      return data;
    }).finally(() => {
      this.devicesInFlight = null;
    });
    return this.devicesInFlight;
  }

  getPortSettings(devId, port) {
    return this.#enqueue(() => this.#call("/api/dev/getdevModeSettingList", { form: { devId, port } }));
  }

  // Same approach as HA's update_device_controls: read current settings, apply overrides,
  // send the full key set back as a query string with an empty body.
  // `overrides` may be a function of the settings just read, for changes that depend on them.
  setPortControls(devId, port, overridesOrFn) {
    return this.#enqueue(async () => {
      const existing = await this.#call("/api/dev/getdevModeSettingList", { form: { devId, port } });
      const overrides = typeof overridesOrFn === "function" ? overridesOrFn(existing ?? {}) : overridesOrFn;
      const payload = {};
      for (const key of DEVICE_CONTROL_KEYS) {
        let v = key in overrides ? overrides[key] : existing?.[key];
        if (v === undefined || v === null) v = 0;
        else if (typeof v === "object") v = JSON.stringify(v);
        else if (typeof v === "boolean") v = String(v);
        payload[key] = v;
      }
      if (this.debug) {
        const changes = Object.keys(overrides).map((k) => `${k}=${payload[k]} (was ${existing?.[k]})`);
        this.log.debug(`addDevMode devId ${devId} port ${port}: ${changes.join(", ")}`);
      }
      await this.#call("/api/dev/addDevMode", { query: payload });
    });
  }
}
