import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { Device, mergeNetworks, PB, parse } from "../../src/protocol";
import original from "../fixtures/original-requests.json";
import { createDevice, type FakeDevice } from "../fake-device";
import { scenarios, type ClientAdapter } from "../scenarios";

/** Our client in the shared scenario shape. */
function adapter(dev: FakeDevice): ClientAdapter {
  const d = new Device({
    name: dev.name,
    has: (ep) => dev.has(ep),
    send: (ep, data) => dev.handle(ep, data),
    onUnexpectedDisconnect() {},
    close() {},
  });
  return {
    info: async () => {
      const i = await d.info();
      return {
        needsPop: i.needsPop,
        canScan: i.canScan,
        mac: i.mac,
        savedNetworks: i.savedNetworks,
      };
    },
    startSession: (pop) => d.startSession(pop),
    scan: () =>
      d.scan(
        () => {},
        () => false,
      ),
    listSaved: () => d.listSaved(),
    joinSaved: (s) => d.joinSaved(s),
    forgetSaved: (s) => d.forgetSaved(s),
    provision: (s, p) => d.provision(s, p),
    status: () => d.status(),
  };
}

// The client sleeps between scan/status polls; skip the waits.
const realSetTimeout = globalThis.setTimeout;
beforeAll(() => {
  vi.stubGlobal("setTimeout", (fn: () => void, _ms?: number, ...args: unknown[]) =>
    realSetTimeout(fn, 0, ...args),
  );
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe("matches the original jetkvm.com client", () => {
  const recorded = original.scenarios as Record<string, { requests: unknown; result: unknown }>;
  for (const sc of scenarios) {
    it(sc.name, async () => {
      const dev = createDevice(sc.device);
      const result = JSON.parse(JSON.stringify(await sc.run(adapter(dev))));
      expect(
        recorded[sc.name],
        "scenario missing from fixture; rerun tools/record-original.ts",
      ).toBeDefined();
      expect(dev.log).toEqual(recorded[sc.name].requests);
      expect(result).toEqual(recorded[sc.name].result);
    });
  }
});

describe("protobuf", () => {
  it("round-trips varints, bytes and nested messages", () => {
    const inner = new PB().uint(1, 300).done();
    const msg = new PB()
      .uint(1, 5)
      .bytes(2, new Uint8Array([1, 2]))
      .msg(3, inner)
      .done();
    const m = parse(msg);
    expect(m.get(1)).toEqual([5n]);
    expect(m.get(2)).toEqual([new Uint8Array([1, 2])]);
    expect(parse(m.get(3)?.[0] as Uint8Array).get(1)).toEqual([300n]);
  });

  it("omits zero varints and empty bytes, keeps empty messages", () => {
    expect([...new PB().uint(1, 0).bytes(2, new Uint8Array()).done()]).toEqual([]);
    expect([...new PB().msg(3).done()]).toEqual([0x1a, 0]);
  });

  it("rejects truncated input", () => {
    expect(() => parse(new Uint8Array([0x08]))).toThrow(/truncated varint/);
    expect(() => parse(new Uint8Array([0x12, 5, 1]))).toThrow(/truncated field/);
  });
});

describe("mergeNetworks", () => {
  it("keeps the strongest BSS per SSID, collects bands, drops hidden, sorts by signal", () => {
    const list = mergeNetworks([
      { ssid: "a", channel: 6, rssi: -70, bssid: "1", auth: 3 },
      { ssid: "a", channel: 36, rssi: -50, bssid: "2", auth: 3 },
      { ssid: "", channel: 1, rssi: -10, bssid: "3", auth: 0 },
      { ssid: "b", channel: 1, rssi: -60, bssid: "4", auth: 0 },
    ]);
    expect(list.map((n) => [n.ssid, n.bssid, n.bands, n.secured])).toEqual([
      ["a", "2", ["2.4 GHz", "5 GHz"], true],
      ["b", "4", ["2.4 GHz"], false],
    ]);
  });
});
