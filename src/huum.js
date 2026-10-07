// HUUM cloud API (frwickst/pyhuum). HTTP Basic auth with the HUUM app credentials.

const BASE = "https://sauna.huum.eu/action/home";
const REQUEST_TIMEOUT_MS = 20000;

export const HUUM_STATUS = {
  230: "offline",
  231: "heating",
  232: "online, not heating",
  233: "locked",
  400: "emergency stop",
};

export class HuumClient {
  constructor({ email, password, log, debug = false }) {
    this.auth = `Basic ${Buffer.from(`${email}:${password}`).toString("base64")}`;
    this.log = log;
    this.debug = debug;
  }

  async #request(method, action) {
    const res = await fetch(`${BASE}/${action}`, {
      method,
      headers: { Authorization: this.auth },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HUUM HTTP ${res.status} on ${action}`);
    const body = await res.json();
    if (this.debug) this.log.debug(`HUUM <- ${action}`, JSON.stringify(body));
    return body;
  }

  stop() {
    return this.#request("POST", "stop");
  }

  status() {
    return this.#request("GET", "status");
  }
}
