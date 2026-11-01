// Fake JetKVM Mini W for tests: ESP-IDF style provisioning (security 1) plus the
// "jetkvm-saved" endpoint. Imported by the unit and browser tests and by
// tools/record-original.ts; the parity test bundles it into a script and injects it
// into the page under test.
//
// Deliberately shares no code with src/: it has its own protobuf helpers and derives
// AES-CTR keystream by offset instead of keeping a running counter.

const te = new TextEncoder();
const td = new TextDecoder();

export interface FakeOptions {
  /** Advertised Bluetooth name. */
  name?: string;
  /** Setup code; "" = device needs none. */
  pop?: string;
  /** Scan results as [ssid, channel, rssi, auth]. */
  networks?: Array<[string, number, number, number]>;
  /** Saved SSIDs, oldest first; null = no saved-networks support. */
  saved?: string[] | null;
  savedMax?: number;
  /** Status polls until a scan pass reports finished. */
  scanPolls?: number;
  /** Status polls until "connected". */
  connectPolls?: number;
  /** Outcome of joining a network with a password. */
  joinResult?: (ssid: string, pass: string) => "ok" | "auth" | "not-found";
  mac?: string;
}

/** What the device received: session messages by type only (keys are random), the rest decrypted. */
export type RequestLog = Array<Array<string | number>>;

export interface FakeDevice {
  name: string;
  log: RequestLog;
  endpoints: string[];
  has(endpoint: string): boolean;
  /** Answer one request on an endpoint. */
  handle(endpoint: string, data: Uint8Array): Promise<Uint8Array>;
}

declare global {
  /** Set by `install()`, read back by the parity test. */
  var __fakeLog: RequestLog | undefined;
}

// ---------- protobuf ----------

type Value = number | bigint | boolean | Uint8Array | Fields | null | undefined;
type Fields = Array<[number, Value]>;
type Decoded = Map<number, Array<bigint | Uint8Array>>;

function varint(out: number[], v: bigint) {
  while (v >= 128n) {
    out.push(Number(v & 127n) | 128);
    v >>= 7n;
  }
  out.push(Number(v));
}

/**
 * Encode `[field, value]` pairs. Numbers → varint (negative as 64-bit two's complement),
 * Uint8Array → bytes, arrays → nested message. `null`/`undefined` are skipped.
 */
function encode(fields: Fields): Uint8Array {
  const out: number[] = [];
  for (const [f, v] of fields) {
    if (v === null || v === undefined) continue;
    if (v instanceof Uint8Array || Array.isArray(v)) {
      const b = v instanceof Uint8Array ? v : encode(v);
      varint(out, BigInt((f << 3) | 2));
      varint(out, BigInt(b.length));
      out.push(...b);
    } else {
      varint(out, BigInt((f << 3) | 0));
      varint(out, BigInt.asUintN(64, BigInt(typeof v === "boolean" ? Number(v) : v)));
    }
  }
  return Uint8Array.from(out);
}

function decode(b: Uint8Array): Decoded {
  const m: Decoded = new Map();
  let i = 0;
  const vi = () => {
    let v = 0n;
    let s = 0n;
    for (;;) {
      const x = b[i++];
      v |= BigInt(x & 127) << s;
      if (!(x & 128)) return v;
      s += 7n;
    }
  };
  while (i < b.length) {
    const key = Number(vi());
    let val: bigint | Uint8Array;
    if ((key & 7) === 0) val = vi();
    else {
      const n = Number(vi());
      val = b.slice(i, i + n);
      i += n;
    }
    const list = m.get(key >>> 3) ?? [];
    list.push(val);
    m.set(key >>> 3, list);
  }
  return m;
}

const U = (m: Decoded | null, f: number) => Number(m?.get(f)?.at(-1) ?? 0n);
const B = (m: Decoded | null, f: number): Uint8Array => {
  const v = m?.get(f)?.at(-1);
  return v instanceof Uint8Array ? v : new Uint8Array();
};
const M = (m: Decoded | null, f: number) => (m?.has(f) ? decode(B(m, f)) : null);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const bytes = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;

// ---------- crypto ----------

/** AES-CTR keystream bytes [offset, offset+len) for key/iv, recomputed from the start. */
async function keystream(key: CryptoKey, iv: Uint8Array, offset: number, len: number) {
  const blocks = Math.ceil((offset + len) / 16);
  const ks = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-CTR", counter: bytes(iv), length: 128 },
      key,
      new Uint8Array(blocks * 16),
    ),
  );
  return ks.subarray(offset, offset + len);
}

// ---------- device ----------

const DEFAULTS: Required<FakeOptions> = {
  name: "JetKVM_TEST",
  pop: "123456",
  networks: [
    ["home", 6, -40, 3],
    ["home", 36, -60, 3],
    ["cafe", 1, -70, 0],
    ["neighbour", 11, -85, 4],
    ["", 3, -50, 3],
    ["lab", 149, -55, 3],
  ],
  saved: ["home", "office"],
  savedMax: 3,
  scanPolls: 3,
  connectPolls: 2,
  joinResult: (ssid, pass) => (ssid === "cafe" ? "not-found" : pass === "wrong" ? "auth" : "ok"),
  mac: "aa:bb:cc:dd:ee:0f",
};

export function createDevice(opts: FakeOptions = {}): FakeDevice {
  const o = { ...DEFAULTS, ...opts };
  const saved = o.saved ? [...o.saved] : null;
  const log: RequestLog = [];
  let key: CryptoKey | null = null;
  let iv = new Uint8Array(16);
  let offset = 0;
  let devPub: Uint8Array = new Uint8Array();
  let clientPub: Uint8Array = new Uint8Array();
  let scanPolls = 0;
  let statusPolls = 0;
  let target = { ssid: "", pass: "" };

  const crypt = async (data: Uint8Array) => {
    if (!key) throw new Error("no session");
    const ks = await keystream(key, iv, offset, data.length);
    offset += data.length;
    return data.map((b, i) => b ^ ks[i]);
  };

  async function session(d: Uint8Array) {
    const m = decode(d);
    const s1 = M(m, 11);
    const type = U(s1, 1);
    log.push(["session", type, U(m, 2)]);
    if (type === 0) {
      clientPub = B(M(s1, 20), 1);
      const kp = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
        "deriveBits",
      ])) as CryptoKeyPair;
      devPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
      iv = crypto.getRandomValues(new Uint8Array(16));
      offset = 0;
      const peer = await crypto.subtle.importKey(
        "raw",
        bytes(clientPub),
        { name: "X25519" },
        false,
        [],
      );
      let shared = new Uint8Array(
        await crypto.subtle.deriveBits({ name: "X25519", public: peer }, kp.privateKey, 256),
      );
      if (o.pop) {
        const h = new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(o.pop)));
        shared = shared.map((b, i) => b ^ h[i]);
      }
      key = await crypto.subtle.importKey("raw", shared, { name: "AES-CTR" }, false, ["encrypt"]);
      return encode([
        [2, 1],
        [
          11,
          [
            [1, 1],
            [
              21,
              [
                [1, 0],
                [2, devPub],
                [3, iv],
              ],
            ],
          ],
        ],
      ]);
    }
    const verify = await crypt(B(M(s1, 22), 2));
    if (hex(verify) !== hex(devPub)) {
      throw new DOMException("GATT operation failed for unknown reason.", "NetworkError");
    }
    return encode([
      [2, 1],
      [
        11,
        [
          [1, 3],
          [
            23,
            [
              [1, 0],
              [3, await crypt(clientPub)],
            ],
          ],
        ],
      ],
    ]);
  }

  function scan(d: Uint8Array) {
    const m = decode(d);
    const type = U(m, 1);
    log.push(["scan", hex(d)]);
    if (type === 0) {
      scanPolls = 0;
      return encode([
        [1, 1],
        [2, 0],
        [11, new Uint8Array()],
      ]);
    }
    if (type === 2) {
      scanPolls++;
      const count = Math.min(o.networks.length, scanPolls * 2);
      return encode([
        [1, 3],
        [2, 0],
        [
          13,
          [
            [1, scanPolls >= o.scanPolls ? 1 : 0],
            [2, count],
          ],
        ],
      ]);
    }
    const q = M(m, 14);
    const start = U(q, 1);
    const entries: Fields = o.networks
      .slice(start, start + U(q, 2))
      .map(([ssid, ch, rssi, auth]) => [
        1,
        [
          [1, te.encode(ssid)],
          [2, ch],
          [3, rssi],
          [4, Uint8Array.from([1, 2, 3, 4, 5, ch])],
          [5, auth],
        ],
      ]);
    return encode([
      [1, 5],
      [2, 0],
      [15, entries],
    ]);
  }

  function config(d: Uint8Array) {
    const m = decode(d);
    const type = U(m, 1);
    log.push(["config", hex(d)]);
    if (type === 2) {
      const c = M(m, 12);
      target = { ssid: td.decode(B(c, 1)), pass: td.decode(B(c, 2)) };
      return encode([
        [1, 3],
        [13, [[1, 0]]],
      ]);
    }
    if (type === 4) {
      statusPolls = 0;
      return encode([
        [1, 5],
        [15, [[1, 0]]],
      ]);
    }
    statusPolls++;
    const result = o.joinResult(target.ssid, target.pass);
    if (result !== "ok" && statusPolls >= 2) {
      // fail_reason is a oneof member: sent even when 0 (AuthError)
      return encode([
        [1, 1],
        [
          11,
          [
            [1, 0],
            [2, 3],
            [10, result === "auth" ? 0 : 1],
          ],
        ],
      ]);
    }
    if (statusPolls < o.connectPolls + 1) {
      return encode([
        [1, 1],
        [
          11,
          [
            [1, 0],
            [2, 1],
            [12, [[1, 4 - statusPolls]]],
          ],
        ],
      ]);
    }
    const connected: Fields = [
      [1, te.encode("192.168.1.50")],
      [3, te.encode(target.ssid)],
    ];
    return encode([
      [1, 1],
      [
        11,
        [
          [1, 0],
          [2, 0],
          [11, connected],
        ],
      ],
    ]);
  }

  function savedOp(d: Uint8Array) {
    const req = JSON.parse(td.decode(d)) as { op: string; ssid?: string };
    log.push(["saved", JSON.stringify(req)]);
    const list = saved ?? [];
    let r: object;
    if (req.op === "list") r = { saved: [...list], max: o.savedMax };
    else if (!req.ssid || !list.includes(req.ssid)) r = { error: `${req.ssid} is not saved` };
    else {
      if (req.op === "forget") list.splice(list.indexOf(req.ssid), 1);
      if (req.op === "join") {
        target = { ssid: req.ssid, pass: "" };
        statusPolls = 0;
      }
      r = { ok: true };
    }
    return te.encode(JSON.stringify(r));
  }

  const encrypted: Record<string, (d: Uint8Array) => Uint8Array> = {
    "prov-scan": scan,
    "prov-config": config,
    "jetkvm-saved": savedOp,
  };
  const endpoints = [
    "prov-ctrl",
    "prov-scan",
    "prov-session",
    "prov-config",
    "proto-ver",
    ...(saved ? ["jetkvm-saved"] : []),
  ];

  return {
    name: o.name,
    log,
    endpoints,
    has: (ep) => endpoints.includes(ep),
    async handle(ep, data) {
      if (ep === "proto-ver") {
        log.push(["proto-ver", td.decode(data)]);
        const cap = ["wifi_scan", ...(o.pop ? [] : ["no_pop"])];
        const jetkvm = [`mac:${o.mac}`, ...(saved ? ["saved_networks"] : [])];
        return te.encode(
          JSON.stringify({ prov: { ver: "v1.1", sec_ver: 1, cap }, jetkvm: { cap: jetkvm } }),
        );
      }
      if (ep === "prov-session") return session(data);
      const handler = encrypted[ep];
      if (handler) return crypt(handler(await crypt(data)));
      throw new DOMException(`no handler for ${ep}`, "NotSupportedError");
    },
  };
}

// ---------- Web Bluetooth shim ----------

const SERVICE = "1775244d-6b43-439b-877c-060f2d9bed07";
const SHORT: Record<string, string> = {
  "prov-ctrl": "ff4f",
  "prov-scan": "ff50",
  "prov-session": "ff51",
  "prov-config": "ff52",
  "proto-ver": "ff53",
};

/**
 * A `navigator.bluetooth` replacement whose chooser always picks `device`.
 * Custom endpoints (no well-known UUID) are named through the 0x2901 descriptor.
 */
export function bluetooth(device: FakeDevice): Bluetooth {
  const listeners = new Set<(e: Event) => void>();
  const chars = device.endpoints.map((ep, i) => {
    let reply: Uint8Array = new Uint8Array();
    const short = SHORT[ep] ?? `ab${String(i).padStart(2, "0")}`;
    return {
      uuid: `${SERVICE.slice(0, 4)}${short}${SERVICE.slice(8)}`,
      async writeValueWithResponse(d: BufferSource) {
        const view = ArrayBuffer.isView(d)
          ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
          : new Uint8Array(d);
        reply = await device.handle(ep, view.slice());
      },
      async readValue() {
        return new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
      },
      async getDescriptor(uuid: number | string) {
        const userDescription = uuid === 0x2901 || uuid === "00002901-0000-1000-8000-00805f9b34fb";
        if (SHORT[ep] || !userDescription) throw new DOMException("No descriptor", "NotFoundError");
        return { readValue: async () => new DataView(te.encode(`${ep}\0`).buffer) };
      },
    };
  });
  const gatt = {
    connected: false,
    async connect() {
      gatt.connected = true;
      return {
        async getPrimaryService() {
          return {
            async getCharacteristics() {
              return chars;
            },
          };
        },
      };
    },
    disconnect() {
      if (!gatt.connected) return;
      gatt.connected = false;
      for (const fn of listeners) fn(new Event("gattserverdisconnected"));
    },
  };
  const btDevice = {
    name: device.name,
    id: "fake-device",
    gatt,
    addEventListener: (type: string, fn: (e: Event) => void) => {
      if (type === "gattserverdisconnected") listeners.add(fn);
    },
    removeEventListener: (_type: string, fn: (e: Event) => void) => listeners.delete(fn),
  };
  return {
    getAvailability: async () => true,
    requestDevice: async () => btDevice,
  } as unknown as Bluetooth;
}

/** Install a fake device as `navigator.bluetooth` and expose its log as `__fakeLog`. */
export function install(opts?: FakeOptions): FakeDevice {
  const device = createDevice(opts);
  Object.defineProperty(navigator, "bluetooth", { value: bluetooth(device), configurable: true });
  globalThis.__fakeLog = device.log;
  return device;
}
