import { ACInfinityClient, AT_TYPE } from "./acinfinity.js";
import { HuumClient, HUUM_STATUS } from "./huum.js";

export const PLUGIN_NAME = "homebridge-acinfinity-sauna";
export const PLATFORM_NAME = "ACInfinitySauna";

// 69 Pro (11) and 69 Pro+ (18) share the addDevMode write path. AI controllers do not.
const SUPPORTED_DEV_TYPES = new Map([[11, "UIS Controller 69 Pro"], [18, "UIS Controller 69 Pro+"]]);
const MOMENTARY_RESET_MS = 1000;
const STARTUP_RETRY_MS = 60 * 1000;
const FAN_REFRESH_MS = 60 * 1000;
// After a switch change, keep showing the requested state while the fan spins up or down.
const FAN_HOLD_MS = 2 * 60 * 1000;

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
    endSaunaName: config.endSaunaName || "End Sauna",
    fanName: config.fanName || "Sauna Fan",
    debug: Boolean(config.debug),
  };
}

export class ACInfinitySaunaPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    this.cachedAccessories = new Map();
    this.actions = Promise.resolve(); // user actions, poll ticks and scheduled Off run one at a time
    this.pollTimer = null;
    this.pollGeneration = 0;
    this.scheduleTimer = null;
    this.startupTimer = null;
    this.fanRefreshTimer = null;
    this.fanOn = false;
    this.fanHoldUntil = 0;

    try {
      this.cfg = readConfig(config ?? {});
    } catch (e) {
      this.cfg = null;
      this.log.error(`Configuration error: ${e.message} No accessories will be exposed.`);
    }

    api.on("didFinishLaunching", () => this.start());
    api.on("shutdown", () => {
      this.cancelCooldownPoll();
      clearTimeout(this.scheduleTimer);
      clearTimeout(this.startupTimer);
      clearInterval(this.fanRefreshTimer);
    });
  }

  configureAccessory(accessory) {
    this.cachedAccessories.set(accessory.UUID, accessory);
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
      this.startupTimer = setTimeout(() => this.start(), STARTUP_RETRY_MS);
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
      this.setUpSwitch("end-sauna", cfg.endSaunaName, () => this.endSauna()),
      this.setUpFanSwitch(cfg.fanName),
    ];
    this.removeStaleAccessories(active); // e.g. the momentary "Sauna Fan Off" switch from v0.1.0
    this.scheduleDailyOff();

    await this.refreshFanState();
    this.fanRefreshTimer = setInterval(() => this.refreshFanState(), FAN_REFRESH_MS);
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

  // Momentary switch: runs the action and flips back off after about a second.
  setUpSwitch(role, name, action) {
    const { Characteristic } = this.api.hap;
    const { accessory, service } = this.getSwitchAccessory(role, name);
    service.getCharacteristic(Characteristic.On)
      .onGet(() => false)
      .onSet((value) => {
        if (!value) return;
        setTimeout(() => service.updateCharacteristic(Characteristic.On, false), MOMENTARY_RESET_MS);
        this.log.info(`${name} pressed.`);
        this.runAction(action);
      });
    return accessory;
  }

  // Stateful switch: shows whether the fan is spinning, and sets the port On or Off.
  setUpFanSwitch(name) {
    const { Characteristic } = this.api.hap;
    const { accessory, service } = this.getSwitchAccessory("fan", name);
    this.fanCharacteristic = service.getCharacteristic(Characteristic.On);
    this.fanCharacteristic
      .onGet(() => this.fanOn)
      .onSet((value) => {
        const on = Boolean(value);
        this.log.info(`${name} switched ${on ? "on" : "off"}.`);
        this.setFanState(on, { hold: true });
        this.runAction(async () => {
          try {
            await (on ? this.fanOnAction() : this.fanOff(`${name} switch`));
          } catch (e) {
            this.fanHoldUntil = 0; // show the real state again on the next refresh
            this.refreshFanState();
            throw e;
          }
        });
      });
    return accessory;
  }

  getSwitchAccessory(role, name) {
    const { Service, Characteristic, uuid } = this.api.hap;
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

    const service = accessory.getService(Service.Switch) ?? accessory.addService(Service.Switch, name);
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
    this.startCooldownPoll();
  }

  async fanOff(reason) {
    this.cancelCooldownPoll();
    await this.setPort({ atType: AT_TYPE.OFF });
    // The controller keeps reporting the old mode until the fan spins down, so don't verify by reading back.
    this.log.info(`Fan port set to Off (${reason}).`);
    this.setFanState(false, { hold: true });
  }

  // On mode at the speed set on the controller; the cooldown speed if that is 0.
  async fanOnAction() {
    this.cancelCooldownPoll();
    const { devId, port } = this.target;
    const current = await this.aci.getPortSettings(devId, port);
    const overrides = { atType: AT_TYPE.ON };
    if (!Number(current?.onSpead)) overrides.onSpead = this.cfg.cooldown.fanSpeed;
    await this.setPort(overrides);
    this.log.info(`Fan port set to On at speed ${overrides.onSpead ?? current.onSpead}.`);
    this.setFanState(true, { hold: true });
  }

  // ---------- fan state ----------

  setFanState(on, { hold = false } = {}) {
    if (hold) this.fanHoldUntil = Date.now() + FAN_HOLD_MS;
    else if (Date.now() < this.fanHoldUntil) return; // a read while the fan is still spinning up or down
    this.fanOn = on;
    this.fanCharacteristic?.updateValue(on);
  }

  // The switch shows on whenever the fan is spinning, including during an Auto cooldown.
  async refreshFanState() {
    try {
      const { devId, port } = this.target;
      const controllers = await this.aci.listControllers();
      const portInfo = controllers.find((c) => String(c.devId) === devId)?.deviceInfo?.ports?.find((p) => Number(p.port) === port);
      if (!portInfo) throw new Error(`controller ${devId} port ${port} missing from device list`);
      this.setFanState(Number(portInfo.speak) > 0);
    } catch (e) {
      this.log.debug(`Fan state refresh failed: ${e.message}`);
    }
  }

  setPort(overrides) {
    const { devId, port } = this.target;
    return this.aci.setPortControls(devId, port, overrides);
  }

  // ---------- cooldown poll ----------

  startCooldownPoll() {
    this.cancelCooldownPoll();
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
          } else {
            schedule();
          }
        });
      }, intervalMs);
    };
    schedule();
  }

  cancelCooldownPoll() {
    this.pollGeneration++;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
      this.log.info("Cooldown poll stopped.");
    }
  }

  // Returns true once the port has been set Off. API errors are logged and retried next tick.
  async cooldownTick() {
    const { devId, port } = this.target;
    const { temperatureF } = this.cfg.cooldown;
    try {
      const controllers = await this.aci.listControllers();
      const controller = controllers.find((c) => String(c.devId) === devId);
      const portInfo = controller?.deviceInfo?.ports?.find((p) => Number(p.port) === port);
      if (!portInfo) throw new Error(`controller ${devId} port ${port} missing from device list`);

      const settings = await this.aci.getPortSettings(devId, port);
      const probeF = readProbeF(settings, controller);
      const speed = Number(portInfo.speak);
      this.setFanState(speed > 0);
      this.log.info(`Cooldown check: probe ${probeF?.toFixed(1) ?? "?"}°F (target ${temperatureF}°F), fan speed ${speed}.`);

      if (speed === 0 && probeF !== null && probeF <= temperatureF) {
        await this.setPort({ atType: AT_TYPE.OFF });
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

// Port settings report °F × 100. Fall back to the controller's °C × 100 reading.
function readProbeF(settings, controller) {
  const f = Number(settings?.temperatureF ?? settings?.devSetting?.temperatureF);
  if (Number.isFinite(f) && f !== 0) return f / 100;
  const c = Number(controller?.deviceInfo?.temperature);
  if (Number.isFinite(c)) return (c / 100) * 9 / 5 + 32;
  return null;
}
