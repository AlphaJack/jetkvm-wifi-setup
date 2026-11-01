import { beforeEach, describe, expect, it } from "vite-plus/test";
import { install } from "../fake-device";
import "../../src/style.css";
import { start, stop } from "../../src/ui";

const card = () => document.getElementById("card")!;
const text = () => card().innerText.replace(/\s+/g, " ");
const button = (label: string) =>
  [...card().querySelectorAll("button")].find(
    (b) => b.textContent?.trim().startsWith(label) && !b.disabled,
  ) as HTMLButtonElement | undefined;
const rowButton = (ssid: string) =>
  [...card().querySelectorAll<HTMLButtonElement>(".row-btn")].find(
    (b) => b.querySelector(".ssid-text")?.textContent === ssid,
  );
const input = (sel: string) => card().querySelector<HTMLInputElement>(sel)!;
const type = (el: HTMLInputElement, v: string) => {
  el.value = v;
  el.dispatchEvent(new Event("input"));
};
const submit = () => card().querySelector("form")!.requestSubmit();
const menuItem = (ssid: string, label: string) => {
  const summary = card().querySelector<HTMLElement>(`summary[aria-label="More for ${ssid}"]`)!;
  summary.click();
  return [...summary.parentElement!.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  )!;
};

/** Wait until `cond` holds (the UI polls the fake device with real delays). */
async function until(cond: () => unknown, what: string, timeout = 30_000) {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      if (cond()) return;
    } catch {
      /* not rendered yet */
    }
    if (Date.now() > end)
      throw new Error(`timed out waiting for ${what}; screen: ${text().slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeEach(() => {
  stop();
  history.replaceState(null, "", location.pathname);
  document.body.innerHTML = `
    <div id="progress" class="progress" hidden><span></span><span></span><span></span><span></span></div>
    <section id="card"></section>`;
});

describe("without Web Bluetooth", () => {
  it("explains how to enable it", async () => {
    Object.defineProperty(navigator, "bluetooth", { value: undefined, configurable: true });
    await start();
    // headless Chromium on Linux: the flag instructions
    expect(text()).toMatch(/Turn on Web Bluetooth in Chrome|Open this page in Chrome or Edge/);
    expect(document.getElementById("progress")!.hidden).toBe(true);
  });
});

describe("setup flow", () => {
  it("covers code, saved networks, filter, errors and joining", async () => {
    install({
      networks: [
        ["home", 6, -45, 3],
        ["cafe", 1, -70, 0],
        ["<b>x</b>", 11, -80, 3],
        ["home", 40, -65, 3],
      ],
      saved: ["home", "gone"],
      savedMax: 1,
      mac: "aa:bb:cc:dd:ee:ff",
    });
    await start();

    await until(() => button("Connect to device"), "connect screen");
    button("Connect to device")!.click();
    await until(() => card().querySelector("#code"), "setup code screen");
    expect(location.hash).toBe("#code");

    type(input("#code"), "12345");
    submit();
    expect(text()).toMatch(/Enter the 6 digits shown on the JetKVM screen/);

    type(input("#code"), "111111");
    submit();
    await until(() => /Wrong setup code/.test(text()), "wrong code problem");

    button("Connect to device")!.click();
    await until(() => card().querySelector("#code"), "setup code screen again");
    type(input("#code"), "123 456");
    submit();

    await until(
      () => /Add a network/.test(text()) && /About \d+ seconds left|Almost done/.test(text()),
      "scanning with saved tabs",
    );
    expect(text()).toMatch(/Nearby/);
    expect(text()).toMatch(/Saved\s*2/);
    expect(location.hash).toBe("#networks");

    await until(() => button("Scan again"), "scan finished");
    expect([...card().querySelectorAll(".ssid-text")].map((e) => e.textContent)).toEqual([
      "home",
      "cafe",
      "<b>x</b>",
    ]);
    expect(card().querySelector(".ssid-text b")).toBeNull(); // SSIDs are text, not HTML
    expect(text()).toMatch(/2\.4 \+ 5 GHz · Saved/);
    expect(text()).toMatch(/2\.4 GHz · Open/);
    expect(text()).toMatch(/MAC address AA:BB:CC:DD:EE:FF/);

    const filter = input(".filter");
    type(filter, "caf");
    expect([...card().querySelectorAll(".ssid-text")].map((e) => e.textContent)).toEqual(["cafe"]);
    type(filter, "zzz");
    expect(text()).toMatch(/No networks match “zzz”/);
    type(filter, "");

    [...card().querySelectorAll<HTMLButtonElement>(".tab")]
      .find((t) => /Saved/.test(t.textContent ?? ""))!
      .click();
    expect(text()).toMatch(/gone\s*Not in range/);
    menuItem("gone", "Forget network").click();
    await until(() => /Saved\s*1/.test(text()) && !/gone/.test(text()), "network forgotten");

    [...card().querySelectorAll<HTMLButtonElement>(".tab")]
      .find((t) => /Nearby/.test(t.textContent ?? ""))!
      .click();
    rowButton("cafe")!.click(); // open network, fake device reports "not found"
    await until(() => /cafe is out of range/.test(text()), "out of range notice");

    rowButton("<b>x</b>")!.click();
    await until(() => card().querySelector("#password"), "password screen");
    expect(location.hash).toBe("#password");
    expect(text()).toMatch(/Enter the password for <b>x<\/b>/);
    expect(text()).toMatch(/Saved list full\. This replaces home\./);
    type(input("#password"), "wrong");
    submit();
    await until(() => /didn't accept that password/.test(text()), "wrong password error");

    button("Back")!.click();
    await until(() => button("Scan again"), "back on the list");
    menuItem("home", "Update password").click();
    await until(
      () => /Update the password for home/.test(text()) && button("Save and join"),
      "update password screen",
    );
    button("Back")!.click();
    await until(() => button("Scan again"), "back on the list again");

    rowButton("home")!.click(); // saved network: joins with the stored password
    await until(() => /Your JetKVM Mini is on home/.test(text()), "connected screen", 60_000);
    expect(text()).toMatch(/open 192\.168\.1\.50/);
    expect(card().querySelector('a[href="http://192.168.1.50"]')).not.toBeNull();
    expect(location.hash).toBe("#done");
    expect(document.querySelectorAll("#progress span.on").length).toBe(4);
  });
});
