// Record how the original jetkvm.com/wireless client talks to the fake device, for each
// scenario in tests/scenarios.ts, into tests/fixtures/original-requests.json.
//
// usage: pnpm record [path/to/wireless-*.js]   (runs vpx tools/record-original.ts)
//   without a path, the module is resolved from https://jetkvm.com/wireless
//
// The original is a minified React route module. Its imports are replaced by inert stubs,
// and the provisioning client class is found by shape, not by its minified name.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import { createDevice, type FakeDevice } from "../tests/fake-device.ts";
import { scenarios, type ClientAdapter } from "../tests/scenarios.ts";

const PAGE = "https://jetkvm.com/wireless";

/** Resolve the current wireless route module from the page's inline route manifest. */
async function fetchOriginal(): Promise<{ source: string; code: string }> {
  const html = await (await fetch(PAGE)).text();
  const m = /"routes\/wireless":\s*\{[^}]*?"module":\s*"([^"]+)"/s.exec(html);
  if (!m) throw new Error(`no routes/wireless module in ${PAGE}`);
  const url = new URL(m[1], PAGE).href;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return { source: url, code: await res.text() };
}

/** Callable, indexable stand-in for anything the module imports. */
function stub(): unknown {
  const fn = function () {};
  return new Proxy(fn, {
    get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : stub()),
    apply: () => stub(),
    construct: () => stub() as object,
  });
}

/** Evaluate the module with stubbed imports and return its provisioning client class. */
export function loadOriginalClient(
  code: string,
): new (transport: object) => Record<string, (...a: unknown[]) => Promise<unknown>> {
  const client = /([\w$]+)=class\{transport;name;session=null/.exec(code)?.[1];
  if (!client)
    throw new Error("provisioning client class not found (class{transport;name;session=null)");
  let body = code.replace(/import\s*\{([^}]*)\}\s*from\s*"[^"]+";?/g, (_, names: string) => {
    const binds = names
      .split(",")
      .map((n) => n.trim().split(/\s+as\s+/))
      .map(([a, b]) => `${a}:${b ?? a}`);
    return `const {${binds.join(",")}}=__stub;`;
  });
  body = body.replace(/import\s*"[^"]+";?/g, "");
  body = body.replace(/\bexport\s*\{[^}]*\};?\s*$/, "");
  if (/\bimport\s*[{"*]|\bexport\b/.test(body))
    throw new Error("unhandled import/export syntax in module");
  // Share this realm's built-ins: with the sandbox's own typed arrays the handshake failed.
  const ctx = vm.createContext({
    Uint8Array,
    ArrayBuffer,
    DataView,
    Map,
    Set,
    Promise,
    BigInt,
    Array,
    Object,
    JSON,
    Error,
    Number,
    String,
    Symbol,
    Math,
    Date,
    __stub: new Proxy({}, { get: () => stub() }),
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    URLSearchParams,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (f: () => void) => setTimeout(f, 0), // skip the client's poll delays
    clearTimeout,
    queueMicrotask,
    DOMException,
    window: undefined,
  });
  vm.runInContext(`${body}\n;globalThis.__client=${client};`, ctx);
  return ctx.__client;
}

/** Wrap the original client in the scenario adapter shape. */
function adapter(Client: ReturnType<typeof loadOriginalClient>, dev: FakeDevice): ClientAdapter {
  const c = new Client({
    deviceName: dev.name,
    send: (ep: string, d: Uint8Array) => dev.handle(ep, d),
    has: (ep: string) => dev.has(ep),
    onUnexpectedDisconnect() {},
    disconnect: async () => {},
  });
  return {
    info: async () => {
      const i = (await c.getInfo()) as {
        needsPop: boolean;
        canScan: boolean;
        mac?: string;
        savedNetworks: boolean;
      };
      return {
        needsPop: i.needsPop,
        canScan: i.canScan,
        mac: i.mac,
        savedNetworks: i.savedNetworks,
      };
    },
    startSession: async (pop) => void (await c.startSession(pop)),
    scan: async () =>
      (await c.scanNetworks(() => {})) as Awaited<ReturnType<ClientAdapter["scan"]>>,
    listSaved: async () => (await c.listSaved()) as { names: string[]; max: number },
    joinSaved: async (s) => void (await c.joinSaved(s)),
    forgetSaved: async (s) => void (await c.forgetSaved(s)),
    provision: async (s, p) => void (await c.provision(s, p)),
    status: async () => (await c.getStatus()) as { state: string },
  };
}

async function main() {
  const path = process.argv[2];
  const { source, code } = path
    ? { source: path, code: readFileSync(path, "utf8") }
    : await fetchOriginal();
  const Client = loadOriginalClient(code);
  const results: Record<string, { requests: unknown; result: unknown }> = {};
  for (const sc of scenarios) {
    const dev = createDevice(sc.device);
    const result = JSON.parse(JSON.stringify(await sc.run(adapter(Client, dev))));
    results[sc.name] = { requests: dev.log, result };
    console.log(`${sc.name}: ${dev.log.length} requests`);
  }
  const out = {
    source: source.startsWith("http") ? source : `file:${source.split("/").pop()}`,
    sha256: createHash("sha256").update(code).digest("hex"),
    recordedAt: new Date().toISOString(),
    scenarios: results,
  };
  writeFileSync(
    new URL("../tests/fixtures/original-requests.json", import.meta.url),
    `${JSON.stringify(out, null, 2)}\n`,
  );
  console.log("wrote tests/fixtures/original-requests.json");
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
