// Wi-Fi provisioning over Web Bluetooth for devices using ESP-IDF style provisioning
// (protocomm security scheme 1: X25519 + AES-CTR + optional proof of possession),
// plus the optional "jetkvm-saved" endpoint for managing saved networks.

// ---------- constants ----------

export const SERVICE_UUID = "1775244d-6b43-439b-877c-060f2d9bed07";
export const NAME_PREFIX = "JetKVM_";
/** GATT "Characteristic User Description" descriptor, names non-standard endpoints. */
const USER_DESCRIPTION = 0x2901;
/** Characteristic UUID bytes 2-3 → endpoint name. */
const ENDPOINTS: Record<string, string> = {
  ff4f: "prov-ctrl",
  ff50: "prov-scan",
  ff51: "prov-session",
  ff52: "prov-config",
  ff53: "proto-ver",
};
const STATUS = [
  "Success",
  "InvalidSecScheme",
  "InvalidProto",
  "TooManySessions",
  "InvalidArgument",
  "InternalError",
  "CryptoError",
  "InvalidSession",
];
const PROTO_VERSION = "v1.1";
/** Channels per group for each scan pass: a quick pass first, then a full pass. */
const SCAN_PASSES = [3, 0];
const SCAN_PASS_TIMEOUT_MS = 45000;
const SCAN_BATCH = 4;

const enc = new TextEncoder();
const dec = new TextDecoder();

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const statusName = (s: number) => STATUS[s] ?? `Status(${s})`;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------- debug log (on by default, ?debug=0 turns it off) ----------

const LOG_TAG = "[wifi-setup]";
const LOG_START = Date.now();
const LOG_ON =
  typeof location !== "undefined" && new URLSearchParams(location.search).get("debug") !== "0";
const stamp = () => `+${((Date.now() - LOG_START) / 1000).toFixed(2)}s`;

export function log(msg: string, data?: unknown) {
  if (!LOG_ON) return;
  if (data === undefined) console.log(LOG_TAG, stamp(), msg);
  else console.log(LOG_TAG, stamp(), msg, data);
}

export function warn(msg: string, err: unknown) {
  if (!LOG_ON) return;
  console.warn(
    LOG_TAG,
    stamp(),
    msg,
    err instanceof Error ? { name: err.name, message: err.message } : { value: err },
  );
}

// ---------- errors ----------

export type ErrorCode =
  | "unsupported"
  | "blocked"
  | "cancelled"
  | "no-adapter"
  | "connect-failed"
  | "not-provisioning-device"
  | "io"
  | "disconnected"
  | "auth-failed"
  | "crypto-unsupported"
  | "device-error"
  | "protocol";

/** Any failure during setup, tagged with a code the UI turns into advice. */
export class SetupError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
  ) {
    super(message);
    this.name = "SetupError";
  }
}

export const toSetupError = (e: unknown): SetupError =>
  e instanceof SetupError ? e : new SetupError(messageOf(e), "protocol");

/** Classify a `requestDevice()` failure. */
function chooserErrorCode(e: unknown): ErrorCode {
  if (!(e instanceof DOMException)) return "connect-failed";
  if (e.name === "SecurityError") return "blocked";
  if (e.name !== "NotFoundError") return "connect-failed";
  if (/cancel/i.test(e.message)) return "cancelled";
  if (/disabled|blocked/i.test(e.message)) return "blocked";
  if (/adapter|powered/i.test(e.message)) return "no-adapter";
  return "cancelled";
}

// ---------- minimal protobuf ----------

/** Protobuf writer for the varint and length-delimited fields the protocol uses. */
export class PB {
  out: number[] = [];

  varint(v: number | bigint) {
    let n = BigInt(v);
    while (n >= 128n) {
      this.out.push(Number(n & 127n) | 128);
      n >>= 7n;
    }
    this.out.push(Number(n));
  }

  /** Varint field; zero (the proto3 default) is omitted. */
  uint(field: number, v: number | boolean) {
    if (Number(v)) {
      this.varint((field << 3) | 0);
      this.varint(Number(v));
    }
    return this;
  }

  /** Length-delimited field, always written (used for sub-messages and oneof members). */
  msg(field: number, bytes: Uint8Array = new Uint8Array()) {
    this.varint((field << 3) | 2);
    this.varint(bytes.length);
    this.out.push(...bytes);
    return this;
  }

  /** Bytes field; empty is omitted. */
  bytes(field: number, bytes: Uint8Array) {
    return bytes.length ? this.msg(field, bytes) : this;
  }

  done() {
    return Uint8Array.from(this.out);
  }
}

/** Field number → values (varints as bigint, length-delimited as bytes). */
export type Fields = Map<number, Array<bigint | Uint8Array>>;

/** Parse a protobuf message. Fixed32/64 fields are skipped. */
export function parse(buf: Uint8Array): Fields {
  const fields: Fields = new Map();
  let i = 0;
  const varint = () => {
    let v = 0n;
    let shift = 0n;
    for (;;) {
      if (i >= buf.length) throw new Error("protobuf: truncated varint");
      const b = buf[i++];
      v |= BigInt(b & 127) << shift;
      if (!(b & 128)) return v;
      shift += 7n;
    }
  };
  while (i < buf.length) {
    const key = Number(varint());
    const field = key >>> 3;
    const wire = key & 7;
    let val: bigint | Uint8Array;
    if (wire === 0) val = varint();
    else if (wire === 2) {
      const n = Number(varint());
      if (i + n > buf.length) throw new Error("protobuf: truncated field");
      val = buf.slice(i, i + n);
      i += n;
    } else if (wire === 1) {
      i += 8;
      continue;
    } else if (wire === 5) {
      i += 4;
      continue;
    } else throw new Error(`protobuf: unsupported wire type ${wire}`);
    let list = fields.get(field);
    if (!list) fields.set(field, (list = []));
    list.push(val);
  }
  return fields;
}

const last = (m: Fields | null, f: number) => m?.get(f)?.at(-1);
const num = (m: Fields | null, f: number) => {
  const v = last(m, f);
  return typeof v === "bigint" ? Number(v) : 0;
};
const int32 = (m: Fields | null, f: number) => {
  const v = last(m, f);
  return typeof v === "bigint" ? Number(BigInt.asIntN(32, v)) : 0;
};
const raw = (m: Fields | null, f: number): Uint8Array => {
  const v = last(m, f);
  return v instanceof Uint8Array ? v : new Uint8Array();
};
const sub = (m: Fields | null, f: number): Fields | null => {
  const v = last(m, f);
  return v instanceof Uint8Array ? parse(v) : null;
};
const subs = (m: Fields | null, f: number): Fields[] =>
  (m?.get(f) ?? []).filter((v): v is Uint8Array => v instanceof Uint8Array).map(parse);

/** NUL-padded string (SSIDs come as fixed 32-byte arrays). */
function cstr(b: Uint8Array) {
  let n = b.length;
  while (n && b[n - 1] === 0) n--;
  return dec.decode(b.subarray(0, n));
}

const hexMac = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(":");

/** Provisioning messages are `{ 1: msg type, <field>: payload }`. */
const cmd = (type: number, field: number, payload: Uint8Array = new Uint8Array()) =>
  new PB().uint(1, type).msg(field, payload).done();

/** Check a scan reply's top-level status and return its payload. */
function scanReply(resp: Uint8Array, field: number) {
  const m = parse(resp);
  const status = num(m, 2);
  if (status !== 0) throw new SetupError(`Scan command failed: ${statusName(status)}`, "protocol");
  return sub(m, field);
}

// ---------- transport ----------

/** What the provisioning client needs from a link to the device. */
export interface Link {
  readonly name: string;
  has(endpoint: string): boolean;
  /** Write a request to an endpoint and read the reply. */
  send(endpoint: string, data: Uint8Array): Promise<Uint8Array>;
  /** Called when the link drops without `close()`. */
  onUnexpectedDisconnect(fn: () => void): void;
  close(): void;
}

/** GATT link to one device: endpoint name → characteristic, one request at a time. */
export class Transport implements Link {
  readonly name: string;
  private queue: Promise<unknown> = Promise.resolve();
  private connected = true;
  private closing = false;
  /** Endpoint of the request in flight, for logging. */
  private inFlight: string | null = null;
  private onDropped?: () => void;
  private readonly handleDisconnect = () => {
    this.connected = false;
    log("gattserverdisconnected", { expected: this.closing, duringOperation: this.inFlight });
    if (!this.closing) this.onDropped?.();
  };

  private constructor(
    private readonly device: BluetoothDevice,
    private readonly chars: Map<string, BluetoothRemoteGATTCharacteristic>,
  ) {
    this.name = device.name ?? "Unnamed device";
    device.addEventListener("gattserverdisconnected", this.handleDisconnect);
  }

  /** Show the browser's device chooser, connect, and map the endpoints. */
  static async open(): Promise<Transport> {
    if (!navigator.bluetooth) throw new SetupError("Web Bluetooth is not available", "unsupported");
    let device: BluetoothDevice;
    try {
      log("requestDevice: opening chooser");
      device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [SERVICE_UUID], namePrefix: NAME_PREFIX }],
        optionalServices: [SERVICE_UUID],
      });
      log("requestDevice: chose device", { name: device.name, id: device.id });
    } catch (e) {
      warn("requestDevice failed", e);
      throw new SetupError(messageOf(e), chooserErrorCode(e));
    }
    let chars: Map<string, BluetoothRemoteGATTCharacteristic>;
    try {
      log("gatt.connect: connecting");
      if (!device.gatt) throw new Error("Device has no GATT server");
      const gatt = await device.gatt.connect();
      log("gatt.connect: connected, discovering endpoints");
      chars = await Transport.endpoints(gatt);
      log("endpoints discovered", [...chars.keys()]);
    } catch (e) {
      warn("gatt.connect / discovery failed", e);
      device.gatt?.disconnect();
      throw new SetupError(messageOf(e), "connect-failed");
    }
    if (!chars.has("prov-session")) {
      log("no prov-session endpoint: device is not in setup mode");
      device.gatt?.disconnect();
      throw new SetupError("The device is not in setup mode", "not-provisioning-device");
    }
    return new Transport(device, chars);
  }

  private static async endpoints(gatt: BluetoothRemoteGATTServer) {
    const service = await gatt.getPrimaryService(SERVICE_UUID);
    const chars = new Map<string, BluetoothRemoteGATTCharacteristic>();
    for (const c of await service.getCharacteristics()) {
      const name =
        ENDPOINTS[c.uuid.slice(4, 8).toLowerCase()] ?? (await Transport.describedName(c));
      if (name) chars.set(name, c);
    }
    return chars;
  }

  private static async describedName(c: BluetoothRemoteGATTCharacteristic): Promise<string | null> {
    try {
      const v = await (await c.getDescriptor(USER_DESCRIPTION)).readValue();
      return dec.decode(v).replace(/\0+$/, "").toLowerCase();
    } catch {
      return null;
    }
  }

  has(endpoint: string) {
    return this.chars.has(endpoint);
  }

  onUnexpectedDisconnect(fn: () => void) {
    this.onDropped = fn;
  }

  /** Write a request and read the reply. Requests are serialized. */
  send(endpoint: string, data: Uint8Array): Promise<Uint8Array> {
    const c = this.chars.get(endpoint);
    if (!c)
      return Promise.reject(
        new SetupError(`Device has no "${endpoint}" endpoint`, "not-provisioning-device"),
      );
    const p = this.queue.then(async () => {
      if (!this.connected) throw new SetupError("Device disconnected", "disconnected");
      this.inFlight = endpoint;
      try {
        await c.writeValueWithResponse(data as Uint8Array<ArrayBuffer>);
        const v = await c.readValue();
        const out = new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
        log(`send ${endpoint}`, { sent: data.length, received: out.length });
        return out;
      } catch (e) {
        if (!this.connected) {
          log(`send ${endpoint}: link already down`);
          throw new SetupError("Device disconnected", "disconnected");
        }
        warn(`send ${endpoint} failed`, e);
        throw new SetupError(messageOf(e), "io");
      } finally {
        this.inFlight = null;
      }
    });
    this.queue = p.catch(() => {});
    return p;
  }

  close() {
    log("disconnect requested by page");
    this.closing = true;
    this.connected = false;
    this.device.removeEventListener("gattserverdisconnected", this.handleDisconnect);
    if (this.device.gatt?.connected) this.device.gatt.disconnect();
  }
}

// ---------- security scheme 1 ----------

/** One AES-CTR keystream shared by both directions, consumed strictly in order. */
export class CtrStream {
  private counter: Uint8Array<ArrayBuffer>;
  /** Keystream bytes left over from the last block. */
  private spare = new Uint8Array();

  constructor(
    private readonly key: CryptoKey,
    iv: Uint8Array,
  ) {
    this.counter = new Uint8Array(iv);
  }

  /** XOR data with the next keystream bytes (encrypts and decrypts). */
  async apply(data: Uint8Array): Promise<Uint8Array> {
    const out = new Uint8Array(data.length);
    const fromSpare = Math.min(this.spare.length, data.length);
    for (let i = 0; i < fromSpare; i++) out[i] = data[i] ^ this.spare[i];
    this.spare = this.spare.subarray(fromSpare);
    const rest = data.length - fromSpare;
    if (rest > 0) {
      const blocks = Math.ceil(rest / 16);
      const ks = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-CTR", counter: this.counter, length: 128 },
          this.key,
          new Uint8Array(blocks * 16),
        ),
      );
      for (let i = 0; i < rest; i++) out[fromSpare + i] = data[fromSpare + i] ^ ks[i];
      this.spare = ks.subarray(rest);
      let carry = BigInt(blocks);
      for (let i = 15; i >= 0 && carry > 0n; i--) {
        const s = BigInt(this.counter[i]) + carry;
        this.counter[i] = Number(s & 255n);
        carry = s >> 8n;
      }
    }
    return out;
  }
}

/** Constant-time compare. */
function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** `SessionData { 2: sec_ver = 1, 11: Sec1Payload { 1: msg, 20..23: payload } }` */
const sessionMsg = (type: number, field: number, payload: Uint8Array) =>
  new PB()
    .uint(2, 1)
    .msg(11, cmd(type, field, payload))
    .done();

function sessionReply(resp: Uint8Array, field: number) {
  const m = parse(resp);
  if (num(m, 2) !== 1)
    throw new SetupError(
      `Device answered with security scheme ${num(m, 2)}, expected 1`,
      "device-error",
    );
  const r = sub(sub(m, 11), field);
  if (!r) throw new SetupError("Session response is missing its payload", "device-error");
  return r;
}

/**
 * Run the two-step security-1 handshake.
 * @param pop setup code ("" when the device needs none)
 */
async function establishSession(link: Link, pop: string): Promise<CtrStream> {
  if (!globalThis.crypto?.subtle)
    throw new SetupError("Web Crypto is not available in this browser", "crypto-unsupported");
  const subtle = crypto.subtle;
  let kp: CryptoKeyPair;
  try {
    kp = (await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  } catch {
    throw new SetupError("This browser cannot do X25519 key exchange", "crypto-unsupported");
  }
  const clientPub = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
  const send = (d: Uint8Array) => link.send("prov-session", d);

  const r0 = sessionReply(await send(sessionMsg(0, 20, new PB().bytes(1, clientPub).done())), 21);
  if (num(r0, 1) !== 0)
    throw new SetupError(`Key exchange: device replied ${statusName(num(r0, 1))}`, "device-error");
  const devPub = raw(r0, 2);
  const devRandom = raw(r0, 3);
  if (devPub.length !== 32 || devRandom.length !== 16)
    throw new SetupError("Device sent a malformed key exchange", "device-error");

  const peer = await subtle.importKey(
    "raw",
    devPub as Uint8Array<ArrayBuffer>,
    { name: "X25519" },
    false,
    [],
  );
  let shared = new Uint8Array(
    await subtle.deriveBits({ name: "X25519", public: peer }, kp.privateKey, 256),
  );
  if (pop) {
    const h = new Uint8Array(await subtle.digest("SHA-256", enc.encode(pop)));
    shared = shared.map((b, i) => b ^ h[i]);
  }
  const key = await subtle.importKey("raw", shared, { name: "AES-CTR" }, false, ["encrypt"]);
  const stream = new CtrStream(key, devRandom);
  const rejected = () => new SetupError("The device rejected the setup code", "auth-failed");

  let r1: Fields;
  try {
    r1 = sessionReply(
      await send(sessionMsg(2, 22, new PB().bytes(2, await stream.apply(devPub)).done())),
      23,
    );
  } catch (e) {
    throw pop ? rejected() : e;
  }
  const devVerify = await stream.apply(raw(r1, 3));
  if (num(r1, 1) !== 0 || !sameBytes(devVerify, clientPub)) {
    throw pop
      ? rejected()
      : new SetupError("The device failed session key verification", "device-error");
  }
  return stream;
}

// ---------- provisioning client ----------

export interface DeviceInfo {
  name: string;
  /** Provisioning protocol version reported by the device. */
  version: string;
  capabilities: string[];
  /** Device wants a setup code. */
  needsPop: boolean;
  /** Device can scan for networks. */
  canScan: boolean;
  /** Wi-Fi MAC address, if reported. */
  mac: string | undefined;
  /** Device supports the saved-networks endpoint. */
  savedNetworks: boolean;
}

export interface ScanEntry {
  ssid: string;
  channel: number;
  rssi: number;
  bssid: string;
  auth: number;
}

/** One SSID: its strongest BSS plus the bands it was seen on. */
export interface Network extends ScanEntry {
  secured: boolean;
  bands: string[];
}

/** Saved networks, oldest first. */
export interface SavedList {
  names: string[];
  max: number;
}

export type JoinStatus =
  | { state: "connected"; ip?: string; ssid?: string }
  | { state: "connecting"; attemptsLeft?: number }
  | { state: "disconnected" }
  | { state: "failed"; reason: "auth" | "not-found" | "unknown" };

type SavedRequest = { op: "list" } | { op: "join" | "forget"; ssid: string };

/** Provisioning operations on a connected device. */
export class Device {
  readonly name: string;
  private stream: CtrStream | null = null;
  private cached: DeviceInfo | null = null;
  private handshaking = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly link: Link) {
    this.name = link.name;
  }

  /** @param fn called on link loss outside the handshake */
  onUnexpectedDisconnect(fn: () => void) {
    this.link.onUnexpectedDisconnect(() => {
      if (!this.handshaking) fn();
    });
  }

  close() {
    this.link.close();
  }

  async info(): Promise<DeviceInfo> {
    if (this.cached) return this.cached;
    const text = dec.decode(await this.link.send("proto-ver", enc.encode(PROTO_VERSION)));
    let prov: { ver?: unknown; sec_ver?: unknown; cap?: unknown };
    let jetkvmCaps: unknown;
    try {
      const j = JSON.parse(text);
      prov = j?.prov ?? {};
      jetkvmCaps = j?.jetkvm?.cap;
    } catch {
      throw new SetupError(`Unexpected version reply: ${text.slice(0, 40)}`, "protocol");
    }
    const caps = Array.isArray(prov.cap) ? prov.cap.map(String) : [];
    const secVer = typeof prov.sec_ver === "number" ? prov.sec_ver : 1;
    if (secVer !== 1 || caps.includes("no_sec")) {
      throw new SetupError(
        `Device uses security scheme ${secVer}, only scheme 1 is supported`,
        "device-error",
      );
    }
    const advertisesSaved = Array.isArray(jetkvmCaps) && jetkvmCaps.includes("saved_networks");
    this.cached = {
      name: this.name,
      version: typeof prov.ver === "string" ? prov.ver : "",
      capabilities: caps,
      needsPop: !caps.includes("no_pop"),
      canScan: caps.includes("wifi_scan"),
      mac: macFromCaps(jetkvmCaps),
      savedNetworks: advertisesSaved && this.link.has("jetkvm-saved"),
    };
    log("device info", {
      version: this.cached.version,
      secVer,
      capabilities: caps,
      jetkvm: jetkvmCaps,
    });
    if (advertisesSaved && !this.cached.savedNetworks) {
      log("saved networks hidden: the browser has this device's endpoints from older firmware");
    }
    return this.cached;
  }

  async startSession(pop: string) {
    const info = await this.info();
    log("handshake: starting", { needsPop: info.needsPop, popLength: pop.length });
    this.stream = null;
    this.handshaking = true;
    try {
      this.stream = await establishSession(this.link, info.needsPop ? pop : "");
    } finally {
      this.handshaking = false;
    }
    log("handshake: session established");
  }

  /**
   * Encrypted request/reply. Encryption and decryption share one keystream, so
   * exchanges must not interleave.
   */
  exchange(endpoint: string, data: Uint8Array): Promise<Uint8Array> {
    const p = this.chain.then(async () => {
      const stream = this.stream;
      if (!stream) throw new SetupError("Session not established", "protocol");
      if (!this.link.has(endpoint))
        throw new SetupError(`Device has no "${endpoint}" endpoint`, "protocol");
      const reply = await this.link.send(endpoint, await stream.apply(data));
      return stream.apply(reply);
    });
    this.chain = p.catch(() => {});
    return p;
  }

  /** Scan in passes, reporting the merged list as results arrive. */
  async scan(onUpdate: (list: Network[]) => void, stopped: () => boolean): Promise<Network[]> {
    const found: ScanEntry[] = [];
    let merged: Network[] = [];
    const publish = () => {
      merged = mergeNetworks(found);
      if (merged.length > 0 && !stopped()) onUpdate(merged);
    };
    for (const group of SCAN_PASSES) {
      if (stopped()) break;
      await this.scanPass(group, found, publish, stopped);
    }
    return merged;
  }

  /** @param group channels per group (0 = all at once) */
  private async scanPass(
    group: number,
    found: ScanEntry[],
    publish: () => void,
    stopped: () => boolean,
  ) {
    log("scan pass: start", { groupChannels: group });
    // CmdScanStart { blocking: false, passive: false, group_channels, period_ms: 120 }
    scanReply(
      await this.exchange("prov-scan", cmd(0, 10, new PB().uint(3, group).uint(4, 120).done())),
      11,
    );
    let fetched = 0;
    const fetch = async (count: number) => {
      if (fetched >= count) return;
      while (fetched < count) {
        const n = Math.min(SCAN_BATCH, count - fetched);
        const r = scanReply(
          await this.exchange("prov-scan", cmd(4, 14, new PB().uint(1, fetched).uint(2, n).done())),
          15,
        );
        for (const e of subs(r, 1)) {
          found.push({
            ssid: cstr(raw(e, 1)),
            channel: num(e, 2),
            rssi: int32(e, 3),
            bssid: hexMac(raw(e, 4)),
            auth: num(e, 5),
          });
        }
        fetched += n;
      }
      publish();
    };
    const status = async () => {
      const s = scanReply(await this.exchange("prov-scan", cmd(2, 12)), 13);
      return { finished: num(s, 1) !== 0, count: num(s, 2) };
    };
    const interval = group ? 500 : 2000;
    let s = await status();
    for (let i = 0; i < SCAN_PASS_TIMEOUT_MS / interval && !stopped(); i++) {
      await fetch(s.count);
      if (s.finished) break;
      await sleep(interval);
      if (stopped()) break;
      s = await status();
    }
    if (!stopped()) await fetch(s.count);
    log("scan pass: done", { found: found.length, stopped: stopped() });
  }

  /** JSON request on the saved-networks endpoint. */
  private async saved(req: SavedRequest): Promise<Record<string, unknown>> {
    const text = dec.decode(await this.exchange("jetkvm-saved", enc.encode(JSON.stringify(req))));
    let r: unknown;
    try {
      r = JSON.parse(text);
    } catch {
      throw new SetupError(`Unexpected saved-networks reply: ${text.slice(0, 40)}`, "protocol");
    }
    if (typeof r !== "object" || !r)
      throw new SetupError("Unexpected saved-networks reply", "protocol");
    const reply = r as Record<string, unknown>;
    if (typeof reply.error === "string") throw new SetupError(reply.error, "device-error");
    return reply;
  }

  async listSaved(): Promise<SavedList> {
    const r = await this.saved({ op: "list" });
    const names = Array.isArray(r.saved)
      ? r.saved.filter((n): n is string => typeof n === "string")
      : [];
    const max = typeof r.max === "number" ? r.max : names.length;
    log("saved networks", { count: names.length, max });
    return { names, max };
  }

  async joinSaved(ssid: string) {
    log("joinSaved", { ssid });
    await this.saved({ op: "join", ssid });
  }

  async forgetSaved(ssid: string) {
    log("forgetSaved", { ssid });
    await this.saved({ op: "forget", ssid });
  }

  /** Send credentials and tell the device to apply them. */
  async provision(ssid: string, pass: string) {
    log("provision: sending credentials", { ssid });
    const setReply = await this.exchange(
      "prov-config",
      cmd(2, 12, new PB().bytes(1, enc.encode(ssid)).bytes(2, enc.encode(pass)).done()),
    );
    const set = sub(parse(setReply), 13);
    const setStatus = set ? num(set, 1) : 2;
    if (setStatus !== 0)
      throw new SetupError(
        `Device refused the network settings (${statusName(setStatus)})`,
        "device-error",
      );
    const apply = sub(parse(await this.exchange("prov-config", cmd(4, 14))), 15);
    const applyStatus = apply ? num(apply, 1) : 2;
    if (applyStatus !== 0)
      throw new SetupError(
        `Device could not apply the settings (${statusName(applyStatus)})`,
        "device-error",
      );
  }

  async status(): Promise<JoinStatus> {
    const r = sub(parse(await this.exchange("prov-config", cmd(0, 10))), 11);
    if (!r) throw new SetupError("Missing RespGetStatus", "protocol");
    if (num(r, 1) !== 0)
      throw new SetupError(
        `Device could not report status (${statusName(num(r, 1))})`,
        "device-error",
      );
    switch (num(r, 2)) {
      case 0: {
        const c = sub(r, 11);
        return {
          state: "connected",
          ip: c ? dec.decode(raw(c, 1)) : undefined,
          ssid: c ? cstr(raw(c, 3)) : undefined,
        };
      }
      case 1: {
        const c = sub(r, 12);
        return { state: "connecting", attemptsLeft: c ? num(c, 1) : undefined };
      }
      case 2:
        return { state: "disconnected" };
      default: {
        const reason = r.has(10) ? num(r, 10) : -1; // oneof member: present even when 0
        return {
          state: "failed",
          reason: reason === 0 ? "auth" : reason === 1 ? "not-found" : "unknown",
        };
      }
    }
  }
}

/** MAC address from the device's `jetkvm.cap` list (`"mac:aa:bb:..."`). */
function macFromCaps(caps: unknown): string | undefined {
  if (!Array.isArray(caps)) return undefined;
  for (const c of caps) {
    const m = typeof c === "string" && /^mac:([0-9a-f]{2}(?::[0-9a-f]{2}){5})$/i.exec(c);
    if (m) return m[1].toUpperCase();
  }
  return undefined;
}

const band = (channel: number) => (channel > 14 ? "5 GHz" : "2.4 GHz");

/** One entry per SSID (strongest BSS), strongest first. */
export function mergeNetworks(list: ScanEntry[]): Network[] {
  const by = new Map<string, { best: ScanEntry; bands: Set<string> }>();
  for (const n of list) {
    if (!n.ssid) continue;
    const e = by.get(n.ssid);
    if (!e) by.set(n.ssid, { best: n, bands: new Set([band(n.channel)]) });
    else {
      e.bands.add(band(n.channel));
      if (n.rssi > e.best.rssi) e.best = n;
    }
  }
  return [...by.values()]
    .sort((a, b) => b.best.rssi - a.best.rssi)
    .map(({ best, bands }) => ({
      ...best,
      secured: best.auth !== 0,
      bands: ["2.4 GHz", "5 GHz"].filter((b) => bands.has(b)),
    }));
}
