// Protocol scenarios shared by the unit tests (our client) and tools/record-original.ts
// (the original jetkvm.com client), so both produce comparable request logs.

import type { FakeOptions } from "./fake-device.ts";

/** The operations both clients offer, in a common shape. */
export interface ClientAdapter {
  info(): Promise<{ needsPop: boolean; canScan: boolean; mac?: string; savedNetworks: boolean }>;
  startSession(pop: string): Promise<void>;
  scan(): Promise<
    Array<{
      ssid: string;
      rssi: number;
      bands: string[];
      secured: boolean;
      bssid: string;
      channel: number;
    }>
  >;
  listSaved(): Promise<{ names: string[]; max: number }>;
  joinSaved(ssid: string): Promise<void>;
  forgetSaved(ssid: string): Promise<void>;
  provision(ssid: string, pass: string): Promise<void>;
  status(): Promise<{ state: string; [k: string]: unknown }>;
}

export interface Scenario {
  name: string;
  device: FakeOptions;
  /** Runs the client calls and returns a JSON-comparable summary. */
  run(c: ClientAdapter): Promise<unknown>;
}

/** Poll status until connected or failed (at most `max` times). */
async function waitJoin(c: ClientAdapter, max = 6) {
  let s: Awaited<ReturnType<ClientAdapter["status"]>> = { state: "none" };
  for (let i = 0; i < max; i++) {
    s = await c.status();
    if (s.state === "connected" || s.state === "failed") break;
  }
  return s;
}

/** Error messages differ in wording between the clients, so only record that it failed. */
async function failed(p: Promise<unknown>) {
  try {
    await p;
    return false;
  } catch {
    return true;
  }
}

const nets = (list: Awaited<ReturnType<ClientAdapter["scan"]>>) =>
  list.map((n) => [n.ssid, n.rssi, n.bands, n.secured, n.bssid, n.channel]);

export const scenarios: Scenario[] = [
  {
    name: "setup code, scan, join",
    device: {},
    async run(c) {
      const info = await c.info();
      await c.startSession("123456");
      const saved = await c.listSaved();
      const list = await c.scan();
      await c.provision("lab", "secret pw");
      return { info, saved, nets: nets(list), status: await waitJoin(c) };
    },
  },
  {
    name: "wrong setup code",
    device: {},
    async run(c) {
      const info = await c.info();
      return { info, rejected: await failed(c.startSession("000000")) };
    },
  },
  {
    name: "no setup code, no saved networks",
    device: { pop: "", saved: null },
    async run(c) {
      const info = await c.info();
      await c.startSession("");
      const list = await c.scan();
      await c.provision("home", "pw");
      return { info, nets: nets(list), status: await waitJoin(c) };
    },
  },
  {
    name: "wrong Wi-Fi password",
    device: {},
    async run(c) {
      await c.startSession("123456");
      await c.provision("lab", "wrong");
      return { status: await waitJoin(c) };
    },
  },
  {
    name: "network not found",
    device: {},
    async run(c) {
      await c.startSession("123456");
      await c.provision("cafe", "x");
      return { status: await waitJoin(c) };
    },
  },
  {
    name: "saved networks",
    device: { saved: ["home", "office", "old"], savedMax: 3 },
    async run(c) {
      await c.startSession("123456");
      const before = await c.listSaved();
      await c.joinSaved("home");
      const joined = await waitJoin(c);
      await c.forgetSaved("old");
      const forgetMissing = await failed(c.forgetSaved("nope"));
      return { before, joined, forgetMissing, after: await c.listSaved() };
    },
  },
];
