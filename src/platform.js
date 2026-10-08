import { ACInfinityClient, AT_TYPE } from "./acinfinity.js";
import { HuumClient, HUUM_STATUS } from "./huum.js";
import { SaunaFan } from "./fanv2.js";

export const PLUGIN_NAME = "homebridge-acinfinity-sauna";
export const PLATFORM_NAME = "ACInfinitySauna";

// 69 Pro (11) and 69 Pro+ (18) share the addDevMode write path. AI controllers do not.
const SUPPORTED_DEV_TYPES = new Map([[11, "UIS Controller 69 Pro"], [18, "UIS Controller 69 Pro+"]]);
const STARTUP_RETRY_MS = 60 * 1000;
const FAN_REFRESH_MS = 60 * 1000;
// The controller reports its old mode until the fan stops after an Off, for up to about this long.
const OFF_READBACK_LAG_MS = 2 * 60 * 1000;
// The sensor poll and cooldown check reuse a device list fetched by another poll if it is this fresh.
const SHARED_READING_MAX_AGE_MS = 60 * 1000;
// After this many failed polls in a row, the temperature sensor shows No Response.
const SENSOR_FAILURE_LIMIT = 3;
// Believable probe readings, in °C. Anything else, a missing value or exactly 0 is not a reading.
const PROBE_MIN_C = -20;
const PROBE_MAX_C = 130;

const fToC = (f) => Math.round(((f - 32) * 5) / 9);

class ConfigError extends Error {}

function readConfig(config) {
  const aci = config.acinfinity ?? {};
  const cooldown = config.cooldown ?? {};
  const huum = config.huum ?? {};

  if (!aci.email || !aci.password) throw new ConfigError("acinfinity.email and acinfinity.password are required.");
  const port = Number(aci.port);
  if (!Number.isInteger(port) || port < 1 || port > 8) throw new ConfigError("acinfinity.port must be a whole number from 1 to 8.");

  const temperatureF = Number(cooldown.temperatureF ?? 90);
  if (!Number.isFinite(temperatureF) || temperatureF < 32 || temperatureF > 200) {
    throw new ConfigError("cooldown.temperatureF must be between 32 and 200.");
  }
  const fanSpeed = Number(cooldown.fanSpeed ?? 10);
  if (!Number.isInteger(fanSpeed) || fanSpeed < 1 || fanSpeed > 10) throw new ConfigError("cooldown.fanSpeed must be 1 to 10.");
  const checkIntervalMinutes = Number(cooldown.checkIntervalMinutes ?? 10);
  if (!Number.isFinite(checkIntervalMinutes) || checkIntervalMinutes < 1) {
    throw new ConfigError("cooldown.checkIntervalMinutes must be at least 1.");
  }

  const sensor = config.temperatureSensor ?? {};
  const pollIntervalSeconds = Number(sensor.pollIntervalSeconds ?? 120);
  if (!Number.isFinite(pollIntervalSeconds) || pollIntervalSeconds < 30 || pollIntervalSeconds > 600) {
    throw new ConfigError("temperatureSensor.pollIntervalSeconds must be between 30 and 600.");
  }
  const temperatureSensor = { name: sensor.name || "Sauna Temperature", intervalMs: pollIntervalSeconds * 1000 };

  const fan = config.fan ?? {};

  let scheduledOff = null;
  if (config.scheduledOffTime) {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(config.scheduledOffTime).trim());
    if (!m) throw new ConfigError(`scheduledOffTime "${config.scheduledOffTime}" is not a valid HH:MM time.`);
    scheduledOff = { hour: Number(m[1]), minute: Number(m[2]) };
  }

  return {
    aci: {
      email: aci.email,
      password: aci.password,
      controllerId: aci.controllerId ? String(aci.controllerId).trim() : "",
      port,
    },
    cooldown: { temperatureF, fanSpeed, intervalMs: checkIntervalMinutes * 60 * 1000 },
    scheduledOff,
    huum: huum.email && huum.password ? { email: huum.email, password: huum.password } : null,
    temperatureSensor,
    fanName: fan.name || "Sauna Fan",
    cooldownName: config.cooldownName || "Sauna Cooldown",
    debug: Boolean(config.debug),
  };
}

export class ACInfinitySaunaPlatform {
  constructor(log, config, api) {
    this.log = config?.debug ? withVisibleDebug(log) : log;
    this.api = api;
    this.cachedAccessories = new Map();
    this.actions = Promise.resolve(); // user actions, poll ticks and scheduled Off run one at a time
    this.pollTimer = null;
    this.pollGeneration = 0;
    this.scheduleTimer = null;
    this.startupTimer = null;
    this.fanRefreshTimer = null;
    this.cooldownActive = false;
    this.fanV2 = null;
    this.offSentAt = 0;
    this.fanStreak = new FailureStreak(this.log, "Fan state check");
    this.sensorTimer = null;
    this.temperatureC = null;
    this.sensorStreak = new FailureStreak(this.log, "Temperature poll");

    try {
      this.cfg = readConfig(config ?? {});
    } catch (e) {
      this.cfg = null;
      this.log.error(`Configuration error: ${e.message} No accessories will be exposed.`);
    }

    api.on("didFinishLaunching", () => this.startSafely());
    api.on("shutdown", () => {
      this.cancelCooldownPoll();
      clearTimeout(this.scheduleTimer);
      clearTimeout(this.startupTimer);
      clearInterval(this.fanRefreshTimer);
      clearInterval(this.sensorTimer);
      this.fanV2?.stop();
    });
  }

  configureAccessory(accessory) {
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  // An unexpected startup error must never become an unhandled rejection, which can stop Homebridge.
  startSafely() {
    this.start().catch((e) => this.log.error(`Startup failed unexpectedly: ${e.stack ?? e.message}`));
  }

  async start() {
    if (!this.cfg) return this.removeAllAccessories();

    const { cfg } = this;
    this.aci = new ACInfinityClient({ ...cfg.aci, log: this.log, debug: cfg.debug });
    this.huum = cfg.huum ? new HuumClient({ ...cfg.huum, log: this.log, debug: cfg.debug }) : null;

    try {
      this.target = await this.resolveTarget();
    } catch (e) {
      if (e instanceof ConfigError) {
        this.log.error(`${e.message} No accessories will be exposed.`);
        return this.removeAllAccessories();
      }
      this.log.error(`Could not reach AC Infinity (${e.message}). Retrying in ${STARTUP_RETRY_MS / 1000}s.`);
      this.startupTimer = setTimeout(() => this.startSafely(), STARTUP_RETRY_MS);
      return;
    }

    const { devId, devName, devType, port, portName } = this.target;
    this.log.info(
      `Using controller "${devName}" (devId ${devId}, ${SUPPORTED_DEV_TYPES.get(devType)}), port ${port} "${portName}".`,
    );
    this.log.info(
      `Cooldown: Auto, high trigger ${cfg.cooldown.temperatureF}°F, speed ${cfg.cooldown.fanSpeed}, ` +
        `checking every ${cfg.cooldown.intervalMs / 60000} min. HUUM ${this.huum ? "enabled" : "not configured"}.`,
    );

    const active = [
      this.setUpCooldownSwitch(cfg.cooldownName),
      this.setUpFanV2(cfg.fanName),
      this.setUpTemperatureSensor(cfg.temperatureSensor.name),
    ];
    // e.g. the momentary End Sauna and Sauna Fan Off switches from v0.1, or the Sauna Fan switch from v0.2-0.5
    this.removeStaleAccessories(active);
    this.scheduleDailyOff();

    await this.refreshFanState();
    this.fanRefreshTimer = setInterval(() => this.refreshFanState(), FAN_REFRESH_MS);

    const { intervalMs } = cfg.temperatureSensor;
    this.log.info(`Temperature sensor polling every ${intervalMs / 1000}s.`);
    await this.pollTemperature();
    this.sensorTimer = setInterval(() => this.pollTemperature(), intervalMs);
  }

  async resolveTarget() {
    const { controllerId, port } = this.cfg.aci;
    const controllers = await this.aci.listControllers();
    const describe = (c) => `devId ${c.devId}, name "${c.devName}", devType ${c.devType}`;

    let controller;
    if (controllerId) {
      controller = controllers.find((c) => String(c.devId) === controllerId);
      if (!controller) {
        controllers.forEach((c) => this.log.error(`  Found controller: ${describe(c)}`));
        throw new ConfigError(`No controller with devId ${controllerId} on this account.`);
      }
    } else {
      const supported = controllers.filter((c) => SUPPORTED_DEV_TYPES.has(Number(c.devType)));
      // A lone unsupported controller falls through to the devType check for a specific error.
      if (supported.length === 0 && controllers.length === 1) {
        controller = controllers[0];
      } else if (supported.length !== 1) {
        controllers.forEach((c) => this.log.error(`  Found controller: ${describe(c)}`));
        throw new ConfigError(
          supported.length === 0
            ? "No supported controller (69 Pro or 69 Pro+) on this account."
            : "Several supported controllers on this account. Set acinfinity.controllerId to one of the devIds above.",
        );
      } else {
        controller = supported[0];
      }
    }

    const devType = Number(controller.devType);
    if (!SUPPORTED_DEV_TYPES.has(devType)) {
      throw new ConfigError(
        `Unsupported controller type ${devType} ("${controller.devName}"). Only the 69 Pro (11) and 69 Pro+ (18) are supported.`,
      );
    }

    const ports = controller.deviceInfo?.ports ?? [];
    const portInfo = ports.find((p) => Number(p.port) === port);
    if (!portInfo) {
      const available = ports.map((p) => `${p.port} "${p.portName}"`).join(", ") || "none";
      throw new ConfigError(`Port ${port} does not exist on "${controller.devName}". Available ports: ${available}.`);
    }

    return { devId: String(controller.devId), devName: controller.devName, devType, port, portName: portInfo.portName };
  }

  // ---------- accessories ----------

  // Stateful switch: on while a cooldown runs, off once the port has been set Off.
  setUpCooldownSwitch(name) {
    const { Characteristic } = this.api.hap;
    const { accessory, service } = this.getAccessory("cooldown", name);
    this.cooldownCharacteristic = service.getCharacteristic(Characteristic.On);
    this.cooldownCharacteristic
      .onGet(() => this.cooldownActive)
      .onSet((value) => {
        const on = Boolean(value);
        if (on === this.cooldownActive) return;
        this.log.info(`${name} switched ${on ? "on" : "off"}.`);
        this.setCooldownState(on);
        this.runAction(() => (on ? this.endSauna() : this.fanOff(`${name} switch`)));
      });
    return accessory;
  }

  // Fanv2 with on/off and speed, showing the live fan level.
  setUpFanV2(name) {
    const { accessory, service } = this.getAccessory("fanv2", name, this.api.hap.Service.Fanv2);
    this.fanV2 = new SaunaFan({
      hap: this.api.hap,
      service,
      onCommand: (command) => {
        const what = command.type === "speed" ? `speed ${command.level * 10}%` : command.type;
        this.log.info(`${name} set to ${what}.`);
        this.runAction(async () => {
          try {
            if (command.type === "off") await this.fanOff(name);
            else if (command.type === "speed") await this.fanSpeedAction(command.level);
            else await this.fanOnAction();
          } catch (e) {
            this.fanV2.failed();
            throw e;
          }
        });
      },
    });
    return accessory;
  }

  // Probe temperature in °C; Home converts for display. Polling is the only source of truth.
  setUpTemperatureSensor(name) {
    const { Service, Characteristic, HapStatusError, HAPStatus } = this.api.hap;
    const { accessory, service } = this.getAccessory("temperature", name, Service.TemperatureSensor);
    this.temperatureCharacteristic = service.getCharacteristic(Characteristic.CurrentTemperature);
    // HAP's default maximum is 100 °C, which a sauna can exceed.
    this.temperatureCharacteristic.setProps({ minValue: -40, maxValue: 150, minStep: 0.1 });
    this.temperatureCharacteristic.onGet(() => {
      if (this.temperatureC === null || this.sensorStreak.count >= SENSOR_FAILURE_LIMIT) {
        throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
      return this.temperatureC;
    });
    this.sensorActiveCharacteristic = service.getCharacteristic(Characteristic.StatusActive);
    this.sensorActiveCharacteristic.onGet(() => this.sensorStreak.count < SENSOR_FAILURE_LIMIT);
    return accessory;
  }

  getAccessory(role, name, serviceType = this.api.hap.Service.Switch) {
    const { Characteristic, Service, uuid } = this.api.hap;
    const id = uuid.generate(`${PLATFORM_NAME}:${role}`);

    let accessory = this.cachedAccessories.get(id);
    if (!accessory) {
      accessory = new this.api.platformAccessory(name, id);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cachedAccessories.set(id, accessory);
    }

    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, "AC Infinity")
      .setCharacteristic(Characteristic.Model, SUPPORTED_DEV_TYPES.get(this.target.devType))
      .setCharacteristic(Characteristic.SerialNumber, `${this.target.devId}-${this.target.port}-${role}`);

    const service = accessory.getService(serviceType) ?? accessory.addService(serviceType, name);
    service.setCharacteristic(Characteristic.Name, name);
    return { accessory, service };
  }

  removeStaleAccessories(active) {
    const keep = new Set(active.map((a) => a.UUID));
    const stale = [...this.cachedAccessories.values()].filter((a) => !keep.has(a.UUID));
    if (!stale.length) return;
    this.log.info(`Removing old accessories: ${stale.map((a) => a.displayName).join(", ")}.`);
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    stale.forEach((a) => this.cachedAccessories.delete(a.UUID));
  }

  removeAllAccessories() {
    const stale = [...this.cachedAccessories.values()];
    if (stale.length) this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    this.cachedAccessories.clear();
  }

  // Serialize every action so a late poll tick or a second tap can't undo a newer one.
  runAction(fn) {
    const run = this.actions.then(fn).catch((e) => this.log.error(e.message));
    this.actions = run;
    return run;
  }

  // ---------- actions ----------

  async endSauna() {
    if (this.huum) {
      try {
        const r = await this.huum.stop();
        const label = HUUM_STATUS[r.statusCode] ?? "unknown";
        this.log.info(`HUUM stop sent. statusCode ${r.statusCode} (${label}), temperature ${r.temperature ?? "?"}°C.`);
      } catch (e) {
        this.log.error(`HUUM stop failed: ${e.message}. Continuing with the fan.`);
      }
    }

    const { temperatureF, fanSpeed } = this.cfg.cooldown;
    try {
      await this.setPort({
        atType: AT_TYPE.AUTO,
        activeHt: 1,
        devHtf: temperatureF,
        devHt: fToC(temperatureF),
        activeLt: 0,
        activeHh: 0,
        activeLh: 0,
        onSpead: fanSpeed,
        offSpead: 0,
      });
    } catch (e) {
      this.cancelCooldownPoll();
      throw new Error(`Setting the fan port to Auto failed: ${e.message}`);
    }
    this.log.info(`Fan port set to Auto: runs at speed ${fanSpeed} until ${temperatureF}°F.`);
    this.offSentAt = 0;
    this.noteFanCommand({ type: "auto" });
    this.startCooldownPoll();
    await this.refreshFanState();
  }

  async fanOff(reason) {
    this.cancelCooldownPoll();
    await this.setPort({ atType: AT_TYPE.OFF });
    // The controller keeps reporting the old mode until the fan spins down, so don't verify by reading back.
    this.log.info(`Fan port set to Off (${reason}).`);
    this.offSentAt = Date.now();
    this.noteFanCommand({ type: "off" });
    await this.refreshFanState();
  }

  // On mode at the speed set on the controller, or 10 if that is 0.
  async fanOnAction() {
    this.cancelCooldownPoll();
    let level;
    await this.setPort((existing) => {
      level = Number(existing.onSpead) || 10;
      return { atType: AT_TYPE.ON, onSpead: level };
    });
    this.log.info(`Fan port set to On at speed ${level}.`);
    this.offSentAt = 0;
    this.noteFanCommand({ type: "on", level });
    await this.refreshFanState();
  }

  // In Auto (a cooldown), change only the speed so the auto-stop still applies. Otherwise On at this level.
  async fanSpeedAction(level) {
    // Right after an Off, the controller still reports its old mode; don't mistake that for Auto.
    const offLagging = Date.now() - this.offSentAt < OFF_READBACK_LAG_MS;
    let auto = false;
    await this.setPort((existing) => {
      auto = Number(existing.atType) === AT_TYPE.AUTO && !offLagging;
      return auto ? { onSpead: level } : { atType: AT_TYPE.ON, onSpead: level };
    });
    if (auto) {
      this.log.info(`Cooldown fan speed set to ${level}; the port stays in Auto.`);
    } else {
      this.cancelCooldownPoll();
      this.log.info(`Fan port set to On at speed ${level}.`);
    }
    this.offSentAt = 0;
    this.noteFanCommand({ type: "speed", level });
    await this.refreshFanState();
  }

  // Tell the fan accessory what was just commanded.
  noteFanCommand(command) {
    this.fanV2?.commanded(command);
  }

  // Every device-list read (fan check, sensor poll, cooldown check) updates the fan accessory.
  onPolledPort(portInfo) {
    const speak = Number(portInfo.speak) || 0;
    if (speak === 0) this.offSentAt = 0;
    this.fanV2?.onSpeak(speak);
  }

  // ---------- fan state ----------

  // The fan shows its real level, including during an Auto cooldown.
  async refreshFanState() {
    try {
      const { portInfo } = await this.readPort();
      this.onPolledPort(portInfo);
      this.fanStreak.succeed();
    } catch (e) {
      this.fanStreak.fail(e.message);
    }
  }

  // ---------- temperature sensor ----------

  async pollTemperature() {
    const { HapStatusError, HAPStatus } = this.api.hap;
    try {
      const { controller, portInfo } = await this.readPort({ maxAgeMs: SHARED_READING_MAX_AGE_MS });
      this.onPolledPort(portInfo);
      const c = readProbeC(controller);
      if (c === null) {
        throw new Error(`no valid probe reading (deviceInfo.temperature = ${JSON.stringify(controller.deviceInfo?.temperature)})`);
      }
      const wasInactive = this.sensorStreak.count >= SENSOR_FAILURE_LIMIT;
      this.temperatureC = Math.round(c * 10) / 10;
      this.sensorStreak.succeed();
      this.log.debug(`Temperature poll: ${this.temperatureC}°C.`);
      // Pushing the value is what lets "rises above / drops below" automations fire.
      this.temperatureCharacteristic.updateValue(this.temperatureC);
      if (wasInactive) this.sensorActiveCharacteristic.updateValue(true);
    } catch (e) {
      // Until the limit, Home keeps showing the last reading.
      if (this.sensorStreak.fail(e.message) === SENSOR_FAILURE_LIMIT) {
        this.log.warn(`Temperature sensor marked not responding after ${SENSOR_FAILURE_LIMIT} failed polls.`);
        this.sensorActiveCharacteristic.updateValue(false);
        this.temperatureCharacteristic.updateValue(new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
      }
    }
  }

  // The configured controller and port from the device list, fresh or from a recent cached fetch.
  async readPort({ maxAgeMs = 0 } = {}) {
    const { devId, port } = this.target;
    const controllers = await this.aci.listControllers({ maxAgeMs });
    const controller = controllers.find((c) => String(c.devId) === devId);
    const portInfo = controller?.deviceInfo?.ports?.find((p) => Number(p.port) === port);
    if (!portInfo) throw new Error(`controller ${devId} port ${port} missing from device list`);
    return { controller, portInfo };
  }

  setPort(overrides) {
    const { devId, port } = this.target;
    return this.aci.setPortControls(devId, port, overrides);
  }

  // ---------- cooldown poll ----------

  startCooldownPoll() {
    this.stopPollTimer();
    this.setCooldownState(true);
    const generation = this.pollGeneration;
    const { intervalMs } = this.cfg.cooldown;
    this.log.info(`Cooldown poll started; checking every ${intervalMs / 60000} min.`);

    const schedule = () => {
      this.pollTimer = setTimeout(() => {
        this.runAction(async () => {
          if (generation !== this.pollGeneration) return; // cancelled or replaced while queued
          const done = await this.cooldownTick();
          if (generation !== this.pollGeneration) return;
          if (done) {
            this.pollGeneration++;
            this.pollTimer = null;
            this.setCooldownState(false);
          } else {
            schedule();
          }
        });
      }, intervalMs);
    };
    schedule();
  }

  cancelCooldownPoll() {
    this.stopPollTimer();
    this.setCooldownState(false);
  }

  stopPollTimer() {
    this.pollGeneration++;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
      this.log.info("Cooldown poll stopped.");
    }
  }

  setCooldownState(on) {
    this.cooldownActive = on;
    this.cooldownCharacteristic?.updateValue(on);
  }

  // Returns true once the port has been set Off. API errors are logged and retried next tick.
  async cooldownTick() {
    const { temperatureF } = this.cfg.cooldown;
    try {
      const { controller, portInfo } = await this.readPort({ maxAgeMs: SHARED_READING_MAX_AGE_MS });
      const probeC = readProbeC(controller);
      const probeF = probeC === null ? null : (probeC * 9) / 5 + 32;
      const speed = Number(portInfo.speak);
      this.onPolledPort(portInfo);
      const probe = probeF === null ? "no valid reading" : `${probeF.toFixed(1)}°F`;
      this.log.info(`Cooldown check: probe ${probe} (target ${temperatureF}°F), fan speed ${speed}.`);

      if (speed === 0 && probeF !== null && probeF <= temperatureF) {
        await this.setPort({ atType: AT_TYPE.OFF });
        this.noteFanCommand({ type: "off" });
        this.log.info("Sauna has cooled and the fan has stopped. Fan port set to Off; cooldown poll finished.");
        return true;
      }
    } catch (e) {
      this.log.error(`Cooldown check failed: ${e.message}. Retrying next check.`);
    }
    return false;
  }

  // ---------- scheduled Off ----------

  scheduleDailyOff() {
    clearTimeout(this.scheduleTimer);
    if (!this.cfg.scheduledOff) return;
    const { hour, minute } = this.cfg.scheduledOff;

    // Recomputed after every run, so DST changes are picked up.
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) {
      next.setDate(next.getDate() + 1);
      next.setHours(hour, minute, 0, 0);
    }
    this.log.info(`Scheduled Off at ${next.toLocaleString()}.`);
    this.scheduleTimer = setTimeout(() => {
      this.runAction(() => this.fanOff("scheduled Off")).finally(() => this.scheduleDailyOff());
    }, next - now);
  }
}

// Probe °C from deviceInfo.temperature (°C × 100), or null when there is no believable reading:
// missing, exactly 0 (what a missing probe may report), or outside PROBE_MIN_C..PROBE_MAX_C.
function readProbeC(controller) {
  const raw = controller?.deviceInfo?.temperature;
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n === 0) return null;
  const c = n / 100;
  return c < PROBE_MIN_C || c > PROBE_MAX_C ? null : c;
}

// Homebridge hides log.debug unless Homebridge itself runs in debug mode. With the plugin's own
// debug setting on, write debug lines at info level so that setting works on its own.
function withVisibleDebug(log) {
  const wrapped = (...args) => log.info(...args);
  wrapped.info = (...args) => log.info(...args);
  wrapped.warn = (...args) => log.warn(...args);
  wrapped.error = (...args) => log.error(...args);
  wrapped.debug = (...args) => log.info("[debug]", ...args);
  return wrapped;
}

// Logs one warning per run of failures, and one info line when it recovers.
class FailureStreak {
  constructor(log, label) {
    this.log = log;
    this.label = label;
    this.count = 0;
  }

  fail(message) {
    this.count++;
    if (this.count === 1) this.log.warn(`${this.label} failed: ${message}. Will keep trying.`);
    return this.count;
  }

  succeed() {
    if (this.count > 0) this.log.info(`${this.label} recovered after ${this.count} failed attempt(s).`);
    this.count = 0;
  }
}
