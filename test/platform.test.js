import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ACInfinitySaunaPlatform } from "../src/platform.js";

const DEV_ID = "1234567890123456789"; // larger than Number.MAX_SAFE_INTEGER

// ---------- fake AC Infinity / HUUM server ----------

let server;
const realFetch = globalThis.fetch;

function makeServer({ devType = 11, ports = [1, 2], speak = 10, temperatureF = 12000 } = {}) {
  const s = {
    calls: [],
    devType, ports, speak, temperatureF,
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
      return json(`{"code":200,"data":[{"devId":${DEV_ID},"devName":"Sauna","devType":${s.devType},"deviceInfo":{"temperature":4000,"ports":[${ports}]}}]}`);
    }
    if (u.pathname === "/api/dev/getdevModeSettingList") {
      return json({ code: 200, data: { ...s.settings, temperatureF: s.temperatureF } });
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
  }
  class Service {
    constructor() { this.chars = new Map(); }
    getCharacteristic(c) { if (!this.chars.has(c)) this.chars.set(c, new Characteristic()); return this.chars.get(c); }
    setCharacteristic() { return this; }
    updateCharacteristic(c, v) { this.getCharacteristic(c).value = v; return this; }
  }
  const Service_ = { AccessoryInformation: "info", Switch: "switch" };
  class PlatformAccessory {
    constructor(displayName, UUID) { this.displayName = displayName; this.UUID = UUID; this.services = new Map([["info", new Service()]]); }
    getService(t) { return this.services.get(t); }
    addService(t) { const s = new Service(); this.services.set(t, s); return s; }
  }
  const handlers = {};
  const api = {
    hap: { Service: Service_, Characteristic: { On: "On", Name: "Name", Manufacturer: "M", Model: "Mo", SerialNumber: "S" }, uuid: { generate: (s) => `uuid:${s}` } },
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

async function startPlatform(config = baseConfig) {
  const api = makeApi();
  const log = makeLog();
  const platform = new ACInfinitySaunaPlatform(log, config, api);
  await platform.start();
  return { api, log, platform };
}

beforeEach(() => { server = makeServer(); });
afterEach((t) => { globalThis.fetch = realFetch; });

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

test("End Sauna: HUUM stop, then full-key Auto write, then poll", async () => {
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

test("End Sauna continues with the fan when HUUM fails", async () => {
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

  server.speak = 0; server.temperatureF = 9500;
  assert.equal(await platform.cooldownTick(), false);
  server.speak = 3; server.temperatureF = 8800;
  assert.equal(await platform.cooldownTick(), false);
  assert.equal(writes().length, 0);

  server.speak = 0; server.temperatureF = 9000;
  assert.equal(await platform.cooldownTick(), true);
  assert.equal(writes().at(-1).query.atType, "1");
});

test("cooldown tick: API errors are logged and polling continues", async () => {
  const { platform, log } = await startPlatform();
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

test("Sauna Fan Off cancels the poll and writes Off", async () => {
  const { platform, api } = await startPlatform();
  await platform.endSauna();
  assert.ok(platform.pollTimer);
  await platform.fanOff("test");
  assert.equal(platform.pollTimer, null);
  assert.equal(server.calls.filter((c) => c.path === "/api/dev/addDevMode").at(-1).query.atType, "1");
  api.emit("shutdown");
});

test("switch is momentary and runs the action asynchronously", async () => {
  const { api, platform } = await startPlatform();
  const svc = api.registered[1].getService("switch");
  const on = svc.getCharacteristic("On");
  on.set(true);
  await platform.actions;
  assert.equal(server.calls.filter((c) => c.path === "/api/dev/addDevMode").at(-1).query.atType, "1");
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(on.value, false);
  assert.equal(await on.get(), false);
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
