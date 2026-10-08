// HomeKit Fanv2 for the fan port. Shows the live fan level (`speak`, 0-10) and turns Home's
// on/off and speed changes into one debounced command.

const DEBOUNCE_MS = 1000;
// After a command, show the commanded values until a poll shows the change or this time passes.
const HOLD_MS = 10 * 1000;
// After Off, show Active off while the fan spins down, for at most this long.
const SPIN_DOWN_MAX_MS = 2 * 60 * 1000;

export const levelFromPercent = (percent) => Math.min(10, Math.max(1, Math.round(percent / 10)));

// Merged Home changes -> { type: "off" } | { type: "speed", level } | { type: "on" }
function resolveCommand({ active, percent }) {
  if (active === false || percent === 0) return { type: "off" };
  if (percent !== undefined) return { type: "speed", level: levelFromPercent(percent) };
  return { type: "on" };
}

export class SaunaFan {
  constructor({ hap, service, onCommand }) {
    const { Characteristic } = hap;
    this.C = Characteristic;
    this.onCommand = onCommand;
    this.debounceMs = DEBOUNCE_MS;
    this.holdMs = HOLD_MS;

    this.speak = 0;
    this.spinDownUntil = 0;
    this.hold = null;
    this.holdTimer = null;
    this.pending = null;
    this.debounceTimer = null;

    this.activeChar = service.getCharacteristic(Characteristic.Active);
    this.speedChar = service.getCharacteristic(Characteristic.RotationSpeed);
    this.stateChar = service.getCharacteristic(Characteristic.CurrentFanState);
    this.speedChar.setProps({ minValue: 0, maxValue: 100, minStep: 10 });

    // onGet only reads what the polls cached; it never calls the API.
    this.activeChar
      .onGet(() => this.view().active)
      .onSet((v) => this.request({ active: Number(v) === Characteristic.Active.ACTIVE }));
    this.speedChar
      .onGet(() => this.view().percent)
      .onSet((v) => this.request({ percent: Number(v) }));
    this.stateChar.onGet(() => this.view().state);
  }

  // A change from Home. Shown at once; sent once the slider has been still for debounceMs.
  request(change) {
    this.pending = { ...this.pending, ...change };
    this.commanded(resolveCommand(this.pending));
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      const command = resolveCommand(this.pending);
      this.pending = null;
      this.onCommand(command);
    }, this.debounceMs);
  }

  // A command from Home, a switch, the schedule or the cooldown.
  //   off:   Active off while the fan spins down; speed keeps showing the real level.
  //   speed: hold Active on at the commanded level.
  //   on:    hold Active on; the level is unknown until the write reads it.
  //   auto:  the cooldown took over; show the real fan from now on.
  commanded(command) {
    clearTimeout(this.holdTimer);
    this.hold = null;
    this.spinDownUntil = command.type === "off" ? Date.now() + SPIN_DOWN_MAX_MS : 0;
    if (command.type !== "auto") {
      this.hold = { until: Date.now() + this.holdMs, active: command.type !== "off", level: command.level };
      this.holdTimer = setTimeout(() => {
        this.hold = null;
        this.push();
      }, this.holdMs);
    }
    this.push();
  }

  // The write failed: show the real fan again.
  failed() {
    clearTimeout(this.holdTimer);
    this.hold = null;
    this.spinDownUntil = 0;
    this.push();
  }

  onSpeak(speak) {
    this.speak = speak;
    if (speak === 0) this.spinDownUntil = 0;
    // The change took effect: stop holding.
    if (this.hold && (this.hold.active ? this.hold.level === speak : speak === 0)) {
      clearTimeout(this.holdTimer);
      this.hold = null;
    }
    this.push();
  }

  spinningDown() {
    return Date.now() < this.spinDownUntil;
  }

  view() {
    const { Active, CurrentFanState } = this.C;
    const hold = this.hold && Date.now() < this.hold.until ? this.hold : null;
    let active = this.speak > 0 && !this.spinningDown();
    let percent = this.speak * 10;
    if (hold) {
      active = hold.active;
      if (hold.level !== undefined) percent = hold.level * 10;
    }
    return {
      active: active ? Active.ACTIVE : Active.INACTIVE,
      percent,
      state: this.speak > 0 ? CurrentFanState.BLOWING_AIR : CurrentFanState.IDLE,
    };
  }

  push() {
    const { active, percent, state } = this.view();
    this.activeChar.updateValue(active);
    this.speedChar.updateValue(percent);
    this.stateChar.updateValue(state);
  }

  stop() {
    clearTimeout(this.debounceTimer);
    clearTimeout(this.holdTimer);
  }
}
