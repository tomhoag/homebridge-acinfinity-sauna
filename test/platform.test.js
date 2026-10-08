import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ACInfinitySaunaPlatform } from "../src/platform.js";

const DEV_ID = "1234567890123456789"; // larger than Number.MAX_SAFE_INTEGER

// ---------- fake AC Infinity / HUUM server ----------

let server;
const realFetch = globalThis.fetch;

function makeServer({ devType = 11, ports = [1, 2], speak = 10, temp = 4000 } = {}) {
  const s = {
    calls: [],
    devType, ports, speak, temp,
    tokenValid: true,
    settings: { devId: DEV_ID, atType: 3, modeType: 0, onSpead: 7, offSpead: 0, devSetting: { a: 1 }, isOpenAutomation: false },
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const form = Object.fromEntries(new URLSearchParams(init.body?.toString() ?? ""));
    s.calls.push({ path: u.pathname, form, query: Object.fromEntries(u.searchParams), headers: init.headers });
    const json = (o) => new Response(typeof o === "string" ? o : JSON.stringify(o), { status: 200 });

    if (u.hostname === "sauna.huum.eu") return json({ statusCode: 232, temperature: 70 });
    if (u.pathname === "/api/user/appUserLogin") {
      s.tokenValid = true;
      return json({ code: 200, data: { appId: "tok123" } });
    }
    if (!s.tokenValid) return json({ code: 10001, msg: "token expired" });
    if (u.pathname === "/api/user/devInfoListAll") {
      // devId as a bare JSON number, the worst case for precision.
      const ports = s.ports.map((p) => `{"port":${p},"portName":"Fan ${p}","online":1,"speak":${s.speak}}`).join(",");
      const temp = s.temp === undefined ? "" : `"temperature":${JSON.stringify(s.temp)},`;
      return json(`{"code":200,"data":[{"devId":${DEV_ID},"devName":"Sauna","devType":${s.devType},"deviceInfo":{${temp}"ports":[${ports}]}}]}`);
    }
    if (u.pathname === "/api/dev/getdevModeSettingList") {
      return json({ code: 200, data: s.settings });
    }
    if (u.pathname === "/api/dev/addDevMode") return json({ code: 200, data: null });
    return new Response("not found", { status: 404 });
  };
  return s;
}

// ---------- fake Homebridge API ----------

function makeApi() {
  class Characteristic {
    constructor() { this.value = false; }
    onGet(fn) { this.get = fn; return this; }
    onSet(fn) { this.set = fn; return this; }
    setProps(p) { this.props = p; return this; }
    updateValue(v) { this.value = v; return this; }
  }
  class Service {
    constructor() { this.chars = new Map(); }
    getCharacteristic(c) { if (!this.chars.has(c)) this.chars.set(c, new Characteristic()); return this.chars.get(c); }
    setCharacteristic() { return this; }
    updateCharacteristic(c, v) { this.getCharacteristic(c).value = v; return this; }
  }
  const Service_ = { AccessoryInformation: "info", Switch: "switch", TemperatureSensor: "temperature", Fanv2: "fanv2" };
  class HapStatusError extends Error { constructor(status) { super(`HAP status ${status}`); this.hapStatus = status; } }
  class PlatformAccessory {
    constructor(displayName, UUID) { this.displayName = displayName; this.UUID = UUID; this.services = new Map([["info", new Service()]]); }
    getService(t) { return this.services.get(t); }
    addService(t) { const s = new Service(); this.services.set(t, s); return s; }
  }
  const handlers = {};
  const api = {
    hap: {
      Service: Service_,
      Characteristic: { On: "On", Name: "Name", Manufacturer: "M", Model: "Mo", SerialNumber: "S", CurrentTemperature: "CurrentTemperature", StatusActive: "StatusActive",
        Active: { ACTIVE: 1, INACTIVE: 0 }, RotationSpeed: "RotationSpeed", CurrentFanState: { INACTIVE: 0, IDLE: 1, BLOWING_AIR: 2 } },
      HapStatusError,
      HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
      uuid: { generate: (s) => `uuid:${s}` },
    },
    platformAccessory: PlatformAccessory,
    registered: [],
    unregistered: [],
    registerPlatformAccessories(_p, _n, accs) { this.registered.push(...accs); },
    unregisterPlatformAccessories(_p, _n, accs) { this.unregistered.push(...accs); },
    on(ev, fn) { handlers[ev] = fn; },
    emit: (ev) => handlers[ev]?.(),
  };
  return api;
}

function makeLog() {
  const lines = [];
  const log = (lvl) => (...m) => lines.push(`${lvl} ${m.join(" ")}`);
  return Object.assign(log("info"), { lines, info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") });
}

const baseConfig = {
  platform: "ACInfinitySauna",
  acinfinity: { email: "a@b.c", password: "x".repeat(30), port: 1 },
  huum: { email: "h@b.c", password: "hp" },
};

const started = [];

async function startPlatform(config = baseConfig) {
  const api = makeApi();
  started.push(api);
  const log = makeLog();
  const platform = new ACInfinitySaunaPlatform(log, config, api);
  await platform.start();
  return { api, log, platform };
}

beforeEach(() => { server = makeServer(); });
afterEach(() => {
  started.splice(0).forEach((api) => api.emit("shutdown"));
  globalThis.fetch = realFetch;
});

// ---------- tests ----------

test("startup with AC Infinity only: two switches, controller resolved, no HUUM calls", async () => {
  const { api, log, platform } = await startPlatform({ ...baseConfig, huum: undefined });
  assert.equal(api.registered.length, 2);
  assert.equal(platform.target.devId, DEV_ID, "devId must survive JSON parsing intact");
  assert.ok(log.lines.some((l) => l.includes(`devId ${DEV_ID}`) && l.includes("port 1")));
  assert.ok(!server.calls.some((c) => c.path.startsWith("/action/home")));
  const login = server.calls.find((c) => c.path === "/api/user/appUserLogin");
  assert.equal(login.form.appPasswordl.length, 25);
  api.emit("shutdown");
});

test("unsupported controller type exposes nothing and removes cached accessories", async () => {
  server.devType = 20;
  const api = makeApi();
  const log = makeLog();
  started.push(api);
  const platform = new ACInfinitySaunaPlatform(log, baseConfig, api);
  platform.configureAccessory({ UUID: "old" });
  await platform.start();
  assert.equal(api.registered.length, 0);
  assert.equal(api.unregistered.length, 1);
  assert.ok(log.lines.some((l) => l.startsWith("error") && l.includes("Unsupported controller type 20")));
});

test("wrong port exposes nothing", async () => {
  const { api, log } = await startPlatform({ ...baseConfig, acinfinity: { ...baseConfig.acinfinity, port: 4 } });
  assert.equal(api.registered.length, 0);
  assert.ok(log.lines.some((l) => l.includes("Port 4 does not exist") && l.includes('1 "Fan 1"')));
});

test("cooldown: HUUM stop, then full-key Auto write, then poll", async () => {
  const { platform, api } = await startPlatform();
  server.calls.length = 0;
  await platform.endSauna();

  assert.equal(server.calls[0].path, "/action/home/stop");
  const write = server.calls.find((c) => c.path === "/api/dev/addDevMode");
  assert.equal(write.form && Object.keys(write.form).length, 0, "body must be empty");
  assert.equal(write.headers.token, "tok123");
  const q = write.query;
  assert.deepEqual(
    [q.atType, q.activeHt, q.devHtf, q.devHt, q.activeLt, q.activeHh, q.activeLh, q.onSpead, q.offSpead],
    ["3", "1", "90", "32", "0", "0", "0", "10", "0"],
  );
  assert.equal(q.devId, DEV_ID);
  assert.equal(q.modeType, "0", "modeType passes through");
  assert.equal(q.devSetting, '{"a":1}', "objects sent as JSON");
  assert.equal(q.isOpenAutomation, "false", "booleans sent as strings");
  assert.equal(q.ecTdsHighSwitch, "0", "missing keys sent as 0");
  assert.ok(platform.pollTimer, "cooldown poll running");
  api.emit("shutdown");
});

test("cooldown continues with the fan when HUUM fails", async () => {
  const { platform, log, api } = await startPlatform();
  const fetchOk = globalThis.fetch;
  globalThis.fetch = (url, init) => (String(url).includes("huum") ? Promise.reject(new Error("offline")) : fetchOk(url, init));
  await platform.endSauna();
  assert.ok(log.lines.some((l) => l.includes("HUUM stop failed")));
  assert.ok(server.calls.some((c) => c.path === "/api/dev/addDevMode"));
  api.emit("shutdown");
});

test("cooldown tick: keeps polling while hot or fan running, sets Off once cool and stopped", async () => {
  const { platform } = await startPlatform();
  const writes = () => server.calls.filter((c) => c.path === "/api/dev/addDevMode");

  server.speak = 0; server.temp = 3500; // 95 °F
  assert.equal(await platform.cooldownTick(), false);
  server.speak = 3; server.temp = 3111; platform.aci.devices = null; // 88 °F
  assert.equal(await platform.cooldownTick(), false);
  assert.equal(writes().length, 0);

  server.speak = 0; server.temp = 3222; platform.aci.devices = null; // 90.0 °F
  assert.equal(await platform.cooldownTick(), true);
  assert.equal(writes().at(-1).query.atType, "1");
});

test("cooldown tick: API errors are logged and polling continues", async () => {
  const { platform, log } = await startPlatform();
  platform.aci.devices = null; // force a fetch instead of the startup result
  globalThis.fetch = () => Promise.reject(new Error("network down"));
  assert.equal(await platform.cooldownTick(), false);
  assert.ok(log.lines.some((l) => l.includes("Cooldown check failed: network down")));
});

test("expired token: logs in again and retries once", async () => {
  const { platform } = await startPlatform();
  server.tokenValid = false;
  const loginsBefore = server.calls.filter((c) => c.path === "/api/user/appUserLogin").length;
  await platform.aci.getPortSettings(DEV_ID, 1);
  const loginsAfter = server.calls.filter((c) => c.path === "/api/user/appUserLogin").length;
  assert.equal(loginsAfter, loginsBefore + 1);
});

const lastWrite = () => server.calls.filter((c) => c.path === "/api/dev/addDevMode").at(-1)?.query;
const fanSwitch = (api) => api.registered.find((a) => a.UUID === "uuid:ACInfinitySauna:fan").getService("switch").getCharacteristic("On");

const cooldownSwitch = (api) => api.registered.find((a) => a.UUID === "uuid:ACInfinitySauna:cooldown").getService("switch").getCharacteristic("On");

test("cooldown switch on: shows on at once, sets Auto, stays on while the poll runs", async () => {
  const { api, platform } = await startPlatform();
  const on = cooldownSwitch(api);
  assert.equal(await on.get(), false);
  on.set(true);
  assert.equal(await on.get(), true, "shown on before the API calls finish");
  await platform.actions;
  assert.equal(lastWrite().atType, "3");
  assert.ok(platform.pollTimer);
  assert.equal(await on.get(), true);
  assert.equal(on.value, true);
});

test("cooldown switch turns itself off when the cooldown finishes", async () => {
  const { api, platform } = await startPlatform();
  cooldownSwitch(api).set(true);
  await platform.actions;
  server.speak = 0; server.temp = 2944; platform.aci.devices = null; // 85 °F
  platform.cfg.cooldown.intervalMs = 10; // run the next poll tick now
  platform.startCooldownPoll();
  await new Promise((r) => setTimeout(r, 1500));
  await platform.actions;
  assert.equal(lastWrite().atType, "1");
  assert.equal(platform.pollTimer, null);
  assert.equal(cooldownSwitch(api).value, false);
});

test("cooldown switch off: cancels the cooldown and writes Off", async () => {
  const { api, platform } = await startPlatform();
  const on = cooldownSwitch(api);
  on.set(true);
  await platform.actions;
  on.set(false);
  assert.equal(await on.get(), false);
  await platform.actions;
  assert.equal(platform.pollTimer, null);
  assert.equal(lastWrite().atType, "1");
});

test("cooldown switch goes back off when the Auto write fails", async () => {
  const { api, platform, log } = await startPlatform();
  const ok = globalThis.fetch;
  globalThis.fetch = (url, init) => (String(url).includes("addDevMode") ? Promise.reject(new Error("boom")) : ok(url, init));
  cooldownSwitch(api).set(true);
  await platform.actions;
  assert.equal(await cooldownSwitch(api).get(), false);
  assert.equal(platform.pollTimer, null);
  assert.ok(log.lines.some((l) => l.includes("Setting the fan port to Auto failed")));
});

test("turning the fan switch on ends the cooldown", async () => {
  const { api, platform } = await startPlatform();
  cooldownSwitch(api).set(true);
  await platform.actions;
  fanSwitch(api).set(true);
  await platform.actions;
  assert.equal(await cooldownSwitch(api).get(), false);
});

test("fan switch shows whether the fan is spinning", async () => {
  server.speak = 6;
  const { api, platform } = await startPlatform();
  const on = fanSwitch(api);
  assert.equal(await on.get(), true);
  server.speak = 0;
  await platform.refreshFanState();
  assert.equal(await on.get(), false);
  assert.equal(on.value, false, "pushed to HomeKit");
});

test("fan switch on: cancels the cooldown, sets On at the controller's speed", async () => {
  const { api, platform } = await startPlatform();
  await platform.endSauna();
  assert.ok(platform.pollTimer);
  fanSwitch(api).set(true);
  await platform.actions;
  assert.equal(platform.pollTimer, null);
  assert.equal(lastWrite().atType, "2");
  assert.equal(lastWrite().onSpead, "7", "speed set at the controller is kept");
});

test("fan switch on: uses 10 when the controller's speed is 0", async () => {
  server.settings.onSpead = 0;
  const { api, platform } = await startPlatform({ ...baseConfig, cooldown: { fanSpeed: 4 } });
  fanSwitch(api).set(true);
  await platform.actions;
  assert.equal(lastWrite().onSpead, "10");
});

test("fan switch off: cancels the cooldown and writes Off", async () => {
  const { api, platform } = await startPlatform();
  await platform.endSauna();
  fanSwitch(api).set(false);
  await platform.actions;
  assert.equal(platform.pollTimer, null);
  assert.equal(lastWrite().atType, "1");
});

test("fan switch keeps the requested state while the fan spins down, then follows the fan", async () => {
  server.speak = 10;
  const { api, platform } = await startPlatform();
  const on = fanSwitch(api);
  on.set(false);
  await platform.actions;
  await platform.refreshFanState(); // still spinning down
  assert.equal(await on.get(), false);
  platform.fanHoldUntil = 0; // hold expired
  await platform.refreshFanState();
  assert.equal(await on.get(), true);
});

test("fan switch: a failed write shows the real state again", async () => {
  server.speak = 0;
  const { api, platform, log } = await startPlatform();
  const ok = globalThis.fetch;
  globalThis.fetch = (url, init) => (String(url).includes("addDevMode") ? Promise.reject(new Error("boom")) : ok(url, init));
  fanSwitch(api).set(true);
  await platform.actions;
  await new Promise((r) => setTimeout(r, 1100)); // let the follow-up refresh finish
  assert.equal(await fanSwitch(api).get(), false);
  assert.ok(log.lines.some((l) => l.startsWith("error") && l.includes("boom")));
});

test("old momentary End Sauna and Sauna Fan Off accessories are removed", async () => {
  const api = makeApi();
  started.push(api);
  const platform = new ACInfinitySaunaPlatform(makeLog(), baseConfig, api);
  platform.configureAccessory({ UUID: "uuid:ACInfinitySauna:end-sauna", displayName: "End Sauna" });
  platform.configureAccessory({ UUID: "uuid:ACInfinitySauna:fan-off", displayName: "Sauna Fan Off" });
  await platform.start();
  assert.deepEqual(api.unregistered.map((a) => a.displayName), ["End Sauna", "Sauna Fan Off"]);
  assert.equal(api.registered.length, 2);
});

test("bad config: clear error, nothing exposed", async () => {
  const { api, log } = await startPlatform({ ...baseConfig, scheduledOffTime: "25:00" });
  assert.equal(api.registered.length, 0);
  assert.ok(log.lines.some((l) => l.includes("scheduledOffTime")));
});

test("scheduled Off is set for the next occurrence", async () => {
  const now = new Date(Date.now() + 2 * 60 * 1000);
  const hhmm = `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`;
  const { log, api } = await startPlatform({ ...baseConfig, scheduledOffTime: hhmm });
  assert.ok(log.lines.some((l) => l.includes("Scheduled Off at")));
  api.emit("shutdown");
});

// ---------- temperature sensor ----------

const sensorConfig = { ...baseConfig, temperatureSensor: { enabled: true } };
const sensorChar = (api, c) => api.registered.find((a) => a.UUID === "uuid:ACInfinitySauna:temperature").getService("temperature").getCharacteristic(c);
const listCalls = () => server.calls.filter((c) => c.path === "/api/user/devInfoListAll").length;

test("sensor disabled: no sensor accessory and no sensor polling", async () => {
  const { api, platform, log } = await startPlatform({ ...baseConfig, debug: true });
  assert.ok(!api.registered.some((a) => a.UUID === "uuid:ACInfinitySauna:temperature"));
  assert.equal(platform.sensorTimer, null);
  assert.ok(!log.lines.some((l) => l.includes("Temperature")));
});

test("sensor disabled later: the old sensor accessory is removed", async () => {
  const api = makeApi();
  started.push(api);
  const platform = new ACInfinitySaunaPlatform(makeLog(), baseConfig, api);
  platform.configureAccessory({ UUID: "uuid:ACInfinitySauna:temperature", displayName: "Sauna Temperature" });
  await platform.start();
  assert.deepEqual(api.unregistered.map((a) => a.displayName), ["Sauna Temperature"]);
});

test("sensor enabled: widened range, probe value in °C at startup", async () => {
  server.temp = 6199;
  const { api } = await startPlatform(sensorConfig);
  const t = sensorChar(api, "CurrentTemperature");
  assert.deepEqual(t.props, { minValue: -40, maxValue: 150, minStep: 0.1 });
  assert.equal(await t.get(), 62);
  assert.equal(t.value, 62, "pushed to HomeKit");
  assert.equal(await sensorChar(api, "StatusActive").get(), true);
});

test("sensor shows readings over 100 °C", async () => {
  server.temp = 11550;
  const { api } = await startPlatform(sensorConfig);
  assert.equal(await sensorChar(api, "CurrentTemperature").get(), 115.5);
});

test("sensor poll pushes each new value", async () => {
  const { api, platform } = await startPlatform(sensorConfig);
  server.temp = 3150; platform.aci.devices = null;
  await platform.pollTemperature();
  assert.equal(sensorChar(api, "CurrentTemperature").value, 31.5);
});

for (const [label, bad] of [["missing", undefined], ["exactly 0", 0], ["below −20 °C", -2500], ["above 130 °C", 13100], ["not a number", "n/a"]]) {
  test(`probe reading ${label} counts as a failed poll`, async () => {
    const { api, platform } = await startPlatform(sensorConfig);
    server.temp = bad; platform.aci.devices = null;
    await platform.pollTemperature();
    assert.equal(platform.sensorStreak.count, 1);
    assert.equal(await sensorChar(api, "CurrentTemperature").get(), 40, "last reading kept");
  });
}

test("sensor: No Response after 3 failed polls, one warning, recovers on success", async () => {
  const { api, platform, log } = await startPlatform(sensorConfig);
  const t = sensorChar(api, "CurrentTemperature");
  const active = sensorChar(api, "StatusActive");
  const ok = globalThis.fetch;
  platform.aci.devices = null; // failed fetches leave no cache, so every poll below fetches
  globalThis.fetch = () => Promise.reject(new Error("network down"));
  await platform.pollTemperature();
  await platform.pollTemperature();
  assert.equal(await t.get(), 40, "last value kept for the first two failures");
  await platform.pollTemperature();
  await assert.rejects(async () => t.get(), (e) => e.hapStatus === -70402);
  assert.equal(active.value, false);
  assert.equal(await active.get(), false);
  assert.ok(t.value instanceof Error, "No Response pushed to HomeKit");
  await platform.pollTemperature();
  assert.equal(log.lines.filter((l) => l.startsWith("warn") && l.includes("Temperature poll failed")).length, 1);

  globalThis.fetch = ok;
  server.temp = 3000;
  await platform.pollTemperature();
  assert.equal(await t.get(), 30);
  assert.equal(active.value, true);
  assert.ok(log.lines.some((l) => l.includes("Temperature poll recovered after 4")));
});

test("sensor: No Response until the first poll succeeds", async () => {
  server.temp = 0;
  const { api } = await startPlatform(sensorConfig);
  await assert.rejects(async () => sensorChar(api, "CurrentTemperature").get(), (e) => e.hapStatus === -70402);
});

test("cooldown check reuses a device list under 60 s old", async () => {
  const { platform } = await startPlatform(sensorConfig);
  const before = listCalls();
  await platform.cooldownTick();
  assert.equal(listCalls(), before, "no extra devInfoListAll call");
  platform.aci.devices.at -= 61 * 1000;
  await platform.cooldownTick();
  assert.equal(listCalls(), before + 1);
});

test("sensor poll reuses a device list under 60 s old", async () => {
  const { platform } = await startPlatform(sensorConfig);
  const before = listCalls();
  await platform.pollTemperature();
  assert.equal(listCalls(), before, "no extra devInfoListAll call");
  platform.aci.devices.at -= 61 * 1000;
  await platform.pollTemperature();
  assert.equal(listCalls(), before + 1);
});

test("polls running at the same moment share one devInfoListAll call", async () => {
  const { platform } = await startPlatform(sensorConfig);
  const before = listCalls();
  await Promise.all([platform.pollTemperature(), platform.refreshFanState()]);
  assert.equal(listCalls(), before + 1);
});

test("cooldown waits when the probe has no believable reading", async () => {
  const { platform, log } = await startPlatform();
  server.speak = 0; server.temp = 0; platform.aci.devices = null;
  assert.equal(await platform.cooldownTick(), false);
  assert.ok(!server.calls.some((c) => c.path === "/api/dev/addDevMode"));
  assert.ok(log.lines.some((l) => l.includes("probe no valid reading")));
});

test("bad sensor poll interval is a config error", async () => {
  const { api, log } = await startPlatform({ ...baseConfig, temperatureSensor: { enabled: true, pollIntervalSeconds: 10 } });
  assert.equal(api.registered.length, 0);
  assert.ok(log.lines.some((l) => l.includes("pollIntervalSeconds")));
});

test("fan state failures: one warning per streak, info on recovery", async () => {
  const { platform, log } = await startPlatform();
  const ok = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("network down"));
  await platform.refreshFanState();
  await platform.refreshFanState();
  globalThis.fetch = ok;
  await platform.refreshFanState();
  assert.equal(log.lines.filter((l) => l.includes("Fan state check failed")).length, 1);
  assert.ok(log.lines.some((l) => l.includes("Fan state check recovered after 2")));
});

// ---------- fan with speed control (Fanv2) ----------

const fanConfig = { ...baseConfig, fan: { enabled: true } };
const fanV2 = (api) => {
  const svc = api.registered.find((a) => a.UUID === "uuid:ACInfinitySauna:fanv2").getService("fanv2");
  const get = (c) => svc.getCharacteristic(c);
  return { active: get(api.hap.Characteristic.Active), speed: get("RotationSpeed"), state: get(api.hap.Characteristic.CurrentFanState) };
};
const writes = () => server.calls.filter((c) => c.path === "/api/dev/addDevMode");

// Start with the fan enabled and short debounce/hold times so tests run quickly.
async function startFan(config = fanConfig) {
  const started_ = await startPlatform(config);
  started_.platform.fanV2.debounceMs = 20;
  return { ...started_, fan: fanV2(started_.api) };
}
const settle = async (platform, ms = 60) => {
  await new Promise((r) => setTimeout(r, ms));
  await platform.actions;
};

test("fan enabled: Fanv2 replaces the fan switch, speed in steps of 10%", async () => {
  const api = makeApi();
  started.push(api);
  const platform = new ACInfinitySaunaPlatform(makeLog(), fanConfig, api);
  platform.configureAccessory({ UUID: "uuid:ACInfinitySauna:fan", displayName: "Sauna Fan" });
  await platform.start();
  assert.deepEqual(api.unregistered.map((a) => a.displayName), ["Sauna Fan"]);
  assert.ok(api.registered.some((a) => a.UUID === "uuid:ACInfinitySauna:fanv2"));
  assert.deepEqual(fanV2(api).speed.props, { minValue: 0, maxValue: 100, minStep: 10 });
});

test("fan disabled: the switch is used and no Fanv2 appears", async () => {
  const { api } = await startPlatform();
  assert.ok(api.registered.some((a) => a.UUID === "uuid:ACInfinitySauna:fan"));
  assert.ok(!api.registered.some((a) => a.UUID === "uuid:ACInfinitySauna:fanv2"));
});

test("Fanv2 shows the real fan level from the poll", async () => {
  server.speak = 6;
  const { platform, fan } = await startFan();
  assert.equal(await fan.active.get(), 1);
  assert.equal(await fan.speed.get(), 60);
  assert.equal(await fan.state.get(), 2);
  server.speak = 0;
  await platform.refreshFanState();
  assert.equal(fan.active.value, 0);
  assert.equal(fan.speed.value, 0);
  assert.equal(fan.state.value, 1, "IDLE");
});

test("Fanv2: the sensor poll updates the fan too", async () => {
  server.speak = 0;
  const { platform, fan } = await startFan({ ...fanConfig, temperatureSensor: { enabled: true } });
  server.speak = 4; platform.aci.devices = null;
  await platform.pollTemperature();
  assert.equal(fan.speed.value, 40);
});

test("Fanv2: 50% with the port Off sets On at level 5; offSpead passes through", async () => {
  server.speak = 0;
  server.settings = { ...server.settings, atType: 1, offSpead: 3 };
  const { platform, fan } = await startFan();
  const listsBefore = listCalls();
  fan.speed.set(50);
  assert.equal(await fan.speed.get(), 50, "shown at once");
  await settle(platform);
  assert.equal(writes().length, 1);
  const w = lastWrite();
  assert.deepEqual([w.atType, w.onSpead, w.offSpead], ["2", "5", "3"]);
  assert.equal(listCalls(), listsBefore + 1, "one poll straight after the write");
  assert.equal(await fan.speed.get(), 50, "commanded value held while the fan spins up");
});

test("Fanv2: during a cooldown (Auto), a speed change keeps Auto", async () => {
  const { platform, fan } = await startFan();
  await platform.runAction(() => platform.endSauna());
  server.settings = { ...server.settings, atType: 3 };
  fan.speed.set(30);
  await settle(platform);
  const w = lastWrite();
  assert.deepEqual([w.atType, w.onSpead], ["3", "3"]);
  assert.ok(platform.pollTimer, "cooldown still running");
  assert.equal(platform.cooldownActive, true);
});

test("Fanv2: a speed change outside Auto ends the cooldown", async () => {
  const { platform, fan } = await startFan();
  await platform.runAction(() => platform.endSauna());
  server.settings = { ...server.settings, atType: 2 };
  fan.speed.set(70);
  await settle(platform);
  assert.deepEqual([lastWrite().atType, lastWrite().onSpead], ["2", "7"]);
  assert.equal(platform.cooldownActive, false);
});

test("Fanv2: on with no speed uses the controller's speed, or 10 if it is 0", async () => {
  server.speak = 0;
  const { platform, fan } = await startFan();
  fan.active.set(1);
  await settle(platform);
  assert.deepEqual([lastWrite().atType, lastWrite().onSpead], ["2", "7"]);

  server.settings = { ...server.settings, onSpead: 0 };
  fan.active.set(0);
  await settle(platform);
  fan.active.set(1);
  await settle(platform);
  assert.deepEqual([lastWrite().atType, lastWrite().onSpead], ["2", "10"]);
});

test("Fanv2 off: writes Off, ends the cooldown, shows off while the speed winds down", async () => {
  server.speak = 8;
  const { platform, fan } = await startFan();
  await platform.runAction(() => platform.endSauna());
  fan.active.set(0);
  await settle(platform);
  assert.equal(lastWrite().atType, "1");
  assert.equal(platform.cooldownActive, false);
  server.speak = 5; // spinning down
  platform.fanV2.hold = null;
  await platform.refreshFanState();
  assert.equal(fan.active.value, 0, "still shown off");
  assert.equal(fan.speed.value, 50, "real speed winding down");
  server.speak = 0;
  await platform.refreshFanState();
  assert.equal(fan.speed.value, 0);
  server.speak = 3; // turned on at the controller afterwards
  await platform.refreshFanState();
  assert.equal(fan.active.value, 1, "follows the real fan again");
});

test("Fanv2: speed 0 is Off", async () => {
  const { platform, fan } = await startFan();
  fan.speed.set(0);
  await settle(platform);
  assert.equal(lastWrite().atType, "1");
});

test("Fanv2: a quick slider drag sends one write with the final value", async () => {
  server.settings = { ...server.settings, atType: 1 };
  const { platform, fan } = await startFan();
  platform.fanV2.debounceMs = 150;
  for (const v of [10, 30, 60, 80]) {
    fan.speed.set(v);
    await new Promise((r) => setTimeout(r, 20));
  }
  await settle(platform, 250);
  assert.equal(writes().length, 1);
  assert.equal(lastWrite().onSpead, "8");
});

test("Fanv2: Active on plus a speed in one tap is one write", async () => {
  server.settings = { ...server.settings, atType: 1 };
  const { platform, fan } = await startFan();
  fan.active.set(1);
  fan.speed.set(40);
  await settle(platform);
  assert.equal(writes().length, 1);
  assert.deepEqual([lastWrite().atType, lastWrite().onSpead], ["2", "4"]);
});

test("Fanv2: the hold ends when the poll shows the new level, or when it times out", async () => {
  server.speak = 0;
  server.settings = { ...server.settings, atType: 1 };
  const { platform, fan } = await startFan();
  fan.speed.set(50);
  await settle(platform);
  assert.equal(fan.speed.value, 50, "held while the fan spins up");
  server.speak = 5;
  await platform.refreshFanState();
  assert.equal(platform.fanV2.hold, null, "change seen: hold over");

  // Timeout, without API calls (their 0.5 s spacing would outlast a short hold).
  platform.fanV2.holdMs = 100;
  platform.fanV2.commanded({ type: "speed", level: 9 });
  platform.fanV2.onSpeak(6); // never reaches 9
  assert.equal(fan.speed.value, 90, "still held");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(fan.speed.value, 60, "hold timed out: real level");
});

test("Fanv2: a failed write shows the real fan again", async () => {
  server.speak = 0;
  const { platform, fan, log } = await startFan();
  const ok = globalThis.fetch;
  globalThis.fetch = (url, init) => (String(url).includes("addDevMode") ? Promise.reject(new Error("boom")) : ok(url, init));
  fan.speed.set(50);
  await settle(platform);
  assert.equal(fan.speed.value, 0);
  assert.equal(fan.active.value, 0);
  assert.ok(log.lines.some((l) => l.startsWith("error") && l.includes("boom")));
});

test("Fanv2: right after Off, a reported Auto is not trusted", async () => {
  server.speak = 8;
  const { platform, fan } = await startFan();
  server.settings = { ...server.settings, atType: 3 }; // controller still reports Auto while spinning down
  fan.active.set(0);
  await settle(platform);
  fan.speed.set(40);
  await settle(platform);
  assert.deepEqual([lastWrite().atType, lastWrite().onSpead], ["2", "4"]);
});

test("Fanv2: Sauna Cooldown takes over the fan", async () => {
  server.speak = 0;
  const { api, platform, fan } = await startFan();
  fan.active.set(0);
  await settle(platform);
  cooldownSwitch(api).set(true);
  await platform.actions;
  assert.equal(lastWrite().atType, "3");
  assert.equal(lastWrite().onSpead, "10");
  assert.equal(platform.fanV2.hold, null);
  server.speak = 10;
  await platform.refreshFanState();
  assert.equal(fan.active.value, 1, "not stuck showing off after the earlier Off");
});

test("Fanv2: Daily Off and the cooldown's own Off update the fan", async () => {
  server.speak = 0;
  const { platform, fan } = await startFan();
  await platform.runAction(() => platform.fanOff("scheduled Off"));
  assert.equal(fan.active.value, 0);
  assert.equal(lastWrite().atType, "1");
});
