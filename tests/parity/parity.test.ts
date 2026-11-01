// Drives the live https://jetkvm.com/wireless page and our build through the same UI
// scenarios, with the same fake device injected as navigator.bluetooth, and compares what
// the device received. Opt-in: `pnpm test:parity` (needs network and `vp build`).
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { chromiumPath } from "../../vite.config";
import { fileURLToPath } from "node:url";
import { build } from "vite-plus";
import type { FakeOptions } from "../fake-device";

const ORIGINAL = "https://jetkvm.com/wireless";
const DIST = new URL("../../dist/", import.meta.url).pathname;
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

let server: Server;
let ours = "";
let browser: Browser;
/** tests/fake-device.ts bundled into one script that defines `FakeJetKVM`. */
let fakeDevice = "";

/** Bundle the fake device in memory (IIFE) so it can be injected with addInitScript. */
async function bundleFakeDevice(): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL("../fake-device.ts", import.meta.url)),
        formats: ["iife"],
        name: "FakeJetKVM",
        fileName: "fake-device",
      },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!("output" in output)) throw new Error("unexpected build result");
  return output.output[0].code;
}

/** Minimal static server for dist/. */
function serve(): Promise<string> {
  server = createServer((req, res) => {
    const path = normalize(
      decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname),
    ).replace(/^(\.\.[/\\])+/, "");
    let file = join(DIST, path);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/`),
    ),
  );
}

beforeAll(async () => {
  if (!existsSync(join(DIST, "index.html")))
    throw new Error("dist/ missing: run `vp build` first (pnpm test:parity does)");
  ours = await serve();
  fakeDevice = await bundleFakeDevice();
  browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
});

afterAll(async () => {
  await browser?.close();
  server?.close();
});

interface UiScenario {
  name: string;
  device: FakeOptions;
  drive(page: Page): Promise<void>;
}

async function enterCode(page: Page) {
  await page.getByRole("button", { name: "Connect to device" }).click();
  await page.getByLabel("Setup code").fill("123456");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /Scan again/ }).waitFor({ timeout: 60_000 });
}

async function joinWith(page: Page, ssid: string, pass: string) {
  await page.locator("button", { hasText: ssid }).first().click();
  await page.getByLabel("Password", { exact: true }).fill(pass);
  await page.getByRole("button", { name: "Join network" }).click();
}

const savedRequests = (page: Page) =>
  page.evaluate(() => (globalThis.__fakeLog ?? []).filter((l) => l[0] === "saved").length);

const uiScenarios: UiScenario[] = [
  {
    name: "join a new network",
    device: {},
    async drive(page) {
      await enterCode(page);
      await joinWith(page, "neighbour", "secret pw");
      await page.getByText(/is on neighbour/).waitFor({ timeout: 60_000 });
    },
  },
  {
    name: "wrong password, then the right one",
    device: {},
    async drive(page) {
      await enterCode(page);
      await joinWith(page, "neighbour", "wrong");
      await page.getByText(/didn't accept that password/).waitFor({ timeout: 60_000 });
      await page.getByLabel("Password", { exact: true }).fill("secret pw");
      await page.getByRole("button", { name: "Join network" }).click();
      await page.getByText(/is on neighbour/).waitFor({ timeout: 60_000 });
    },
  },
  {
    name: "join a saved network",
    device: {},
    async drive(page) {
      await enterCode(page);
      await page.locator("button", { hasText: "home" }).first().click();
      await page.getByText(/is on home/).waitFor({ timeout: 60_000 });
    },
  },
  {
    name: "forget a saved network",
    device: {},
    async drive(page) {
      await enterCode(page);
      const before = await savedRequests(page);
      await page.getByLabel("More for home").click();
      await page.getByText("Forget network", { exact: true }).click();
      await page.waitForFunction(
        (n) => (globalThis.__fakeLog ?? []).filter((l) => l[0] === "saved").length >= n + 2,
        before,
      );
    },
  },
];

/** Run one scenario on a page and return the fake device's request log. */
async function record(url: string, sc: UiScenario) {
  const context = await browser.newContext();
  // only the page under test; no analytics, captcha or other third parties
  const allowed = new URL(url).host;
  await context.route("**/*", (route) =>
    new URL(route.request().url()).host === allowed ? route.continue() : route.abort(),
  );
  await context.addInitScript(`${fakeDevice}\n;FakeJetKVM.install(${JSON.stringify(sc.device)});`);
  const page = await context.newPage();
  try {
    await page.goto(url);
    await sc.drive(page);
    return await page.evaluate(() => globalThis.__fakeLog);
  } finally {
    await context.close();
  }
}

describe(`same device traffic as ${ORIGINAL}`, () => {
  for (const sc of uiScenarios) {
    it(sc.name, async () => {
      const theirs = await record(ORIGINAL, sc);
      const mine = await record(ours, sc);
      expect(mine).toEqual(theirs);
    });
  }
});
