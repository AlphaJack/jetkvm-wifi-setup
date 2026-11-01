// Setup flow and screens. `start()` mounts into #card and #progress.

import {
  Device,
  type DeviceInfo,
  type ErrorCode,
  type JoinStatus,
  type Network,
  type SavedList,
  SetupError,
  Transport,
  log,
  sleep,
  toSetupError,
} from "./protocol";

const SCAN_ESTIMATE_MS = 22000; // drives the "About N seconds left" countdown
const JOIN_TIMEOUT_MS = 180000;
const JOIN_POLL_MS = 2000;
const TROUBLESHOOTING_URL = "https://jetkvm.com/docs/networking/troubleshooting";

// ---------- texts ----------

/** Inline problem: title plus optional body or numbered steps. */
interface Problem {
  title: string;
  body?: string;
  steps?: string[];
}

/** Content of the failure screen. */
interface Failure {
  title: string;
  message: string;
  detail?: string;
}

const TEXT = {
  wrongCode: {
    title: "Wrong setup code",
    body: "Connect again and enter the code on the JetKVM screen.",
  } satisfies Problem,
  retrying: (n: number) =>
    `No answer yet, ${n} ${n === 1 ? "attempt" : "attempts"} left. A wrong password shows up as a long wait.`,
  wrongPassword: (s: string) => `${s} didn't accept that password.`,
  leftRange: (s: string): Problem => ({
    title: `${s} is out of range`,
    body: "Choose another network.",
  }),
  joinSavedFailed: (s: string, m: string): Problem => ({
    title: `Couldn't join ${s}`,
    body: m.endsWith(".") ? m : `${m}.`,
  }),
  forgetFailed: (s: string, m: string): Problem => ({
    title: `Couldn't forget ${s}`,
    body: m.endsWith(".") ? m : `${m}.`,
  }),
  notFound: (s: string) =>
    `No network named ${s} is in range. Check the spelling and that your router is on.`,
  joinFailed: (s: string): Failure => ({
    title: `Couldn't join ${s}`,
    message: "Check the router and try again.",
  }),
  joinTimeout: (s: string): Failure => ({
    title: `No answer from ${s}`,
    message: "Check the password, and that your router is on and in range.",
  }),
};

/** Failure screen text for an error during setup. */
function failureText(code: ErrorCode): Failure {
  switch (code) {
    case "disconnected":
      return {
        title: "Lost the Bluetooth connection",
        message: "Check that your JetKVM Mini is on and within a few metres.",
      };
    case "crypto-unsupported":
      return {
        title: "Your browser needs an update",
        message: "Update Chrome or Edge to the latest version.",
      };
    default:
      return {
        title: "The device reported a problem",
        message:
          "Unplug your JetKVM Mini and plug it back in. If it keeps happening, tell us on Discord.",
      };
  }
}

/** Inline problem shown on the connect screen. */
function connectProblem(code: ErrorCode): Problem {
  switch (code) {
    case "not-provisioning-device":
      return {
        title: "This JetKVM Mini isn't in setup mode",
        body: "To add a network, start setup from the device menu.",
      };
    case "blocked":
      return {
        title: "Bluetooth is blocked for this site",
        steps: [
          "Click the icon to the left of the address bar.",
          "Allow Bluetooth.",
          "Reload this page.",
        ],
      };
    case "no-adapter":
      return { title: "Bluetooth is off on this computer", body: "Turn it on and connect again." };
    default:
      return {
        title: "Couldn't reach your JetKVM Mini",
        body: "Move closer and check that it's on.",
      };
  }
}

// ---------- state ----------

type UnsupportedReason = "insecure" | "no-api" | "no-adapter";

type Step =
  | { kind: "unsupported"; reason: UnsupportedReason }
  | { kind: "ready"; error?: Problem }
  | { kind: "connecting" }
  | { kind: "auth" }
  | { kind: "authenticating"; pop: string }
  | { kind: "pick"; networks: Network[]; scanStartedAt?: number; notice?: Problem }
  | { kind: "credentials"; network: Network | null; error?: string }
  | {
      kind: "joining";
      ssid: string;
      network: Network | null;
      list?: Network[];
      attemptsLeft?: number;
    }
  | { kind: "connected"; ssid: string; ip?: string }
  | ({ kind: "failed" } & Failure);

interface Session {
  device: Device;
  info: DeviceInfo;
  /** Last scan result. */
  networks: Network[];
  ended: boolean;
  /** Bumped to stop a running scan. */
  scanToken: number;
}

/** Page state; `render()` draws it. */
const state = {
  step: { kind: "ready" } as Step,
  /** Shown once the device has saved networks. */
  saved: undefined as SavedList | undefined,
  /** Saved network being forgotten. */
  forgetting: undefined as string | undefined,
  /** Set after a `?pop=` code from the URL was rejected. */
  urlPopRejected: false,
  filter: "",
  tab: "nearby" as "nearby" | "saved",
};

let session: Session | null = null;

/** URL hash for a step, shown in the address bar (display only, not restored on load). */
function stepHash(step: Step) {
  switch (step.kind) {
    case "auth":
    case "authenticating":
      return "#code";
    case "pick":
      return "#networks";
    case "credentials":
    case "joining":
      return "#password";
    case "connected":
      return "#done";
    default:
      return "";
  }
}

function setStep(step: Step) {
  state.step = step;
  const hash = stepHash(step);
  if (location.hash !== hash)
    history.replaceState(history.state, "", location.pathname + location.search + hash);
  render();
}

/** Update the step unless the session ended meanwhile. */
function stepFor(s: Session, step: Step | ((prev: Step) => Step)) {
  if (s.ended) return;
  setStep(typeof step === "function" ? step(state.step) : step);
}

function endSession() {
  const s = session;
  if (!s) return;
  s.ended = true;
  session = null;
  s.device.close();
}

function showFailure(f: Failure) {
  endSession();
  setStep({ kind: "failed", ...f });
}

function failSession(s: Session, err: unknown) {
  if (s.ended) return;
  const e = toSetupError(err);
  log("FAILED", { code: e.code, message: e.message });
  showFailure({
    ...failureText(e.code),
    detail: e.code === "disconnected" ? undefined : e.message,
  });
}

function reset() {
  state.saved = undefined;
  state.filter = "";
  state.tab = "nearby";
  endSession();
  setStep({ kind: "ready" });
}

/** Setup code from `?pop=`, unless it was already rejected. */
function urlPop() {
  const p = new URLSearchParams(location.search).get("pop")?.replace(/\s/g, "");
  return !state.urlPopRejected && p && /^\d{6}$/.test(p) ? p : undefined;
}

function dropUrlPop() {
  const params = new URLSearchParams(location.search);
  params.delete("pop");
  history.replaceState(
    history.state,
    "",
    location.pathname + (params.size ? `?${params}` : "") + location.hash,
  );
}

// ---------- flow ----------

async function connect() {
  log("connect: begin");
  setStep({ kind: "connecting" });
  let device: Device;
  try {
    device = new Device(await Transport.open());
  } catch (err) {
    const e = toSetupError(err);
    return setStep(
      e.code === "cancelled" ? { kind: "ready" } : { kind: "ready", error: connectProblem(e.code) },
    );
  }
  let info: DeviceInfo;
  try {
    info = await device.info();
  } catch (err) {
    device.close();
    const e = toSetupError(err);
    return showFailure({ ...failureText(e.code), detail: e.message });
  }
  const s: Session = { device, info, networks: [], ended: false, scanToken: 0 };
  session = s;
  device.onUnexpectedDisconnect(() =>
    failSession(s, new SetupError("Device disconnected", "disconnected")),
  );
  if (!info.needsPop) return authenticate(s, "");
  const pop = urlPop();
  if (pop) return authenticate(s, pop);
  stepFor(s, { kind: "auth" });
}

async function authenticate(s: Session, pop: string) {
  log("authenticate: begin", { popLength: pop.length });
  stepFor(s, { kind: "authenticating", pop });
  try {
    await s.device.startSession(pop);
  } catch (err) {
    const e = toSetupError(err);
    log("authenticate: failed", { code: e.code });
    if (e.code !== "auth-failed") return failSession(s, e);
    if (urlPop()) {
      state.urlPopRejected = true;
      dropUrlPop();
    }
    endSession();
    return setStep({ kind: "ready", error: TEXT.wrongCode });
  }
  if (s.info.savedNetworks) await refreshSaved(s);
  return scan(s);
}

async function scan(s: Session) {
  log("scan: begin", { canScan: s.info.canScan });
  if (!s.info.canScan) return stepFor(s, { kind: "credentials", network: null });
  const token = ++s.scanToken;
  const live = () => !s.ended && s.scanToken === token;
  const startedAt = Date.now();
  const show = (list: Network[], scanning: boolean) => {
    if (!live()) return;
    s.networks = list;
    stepFor(s, (prev) => ({
      kind: "pick",
      networks: list,
      scanStartedAt: scanning ? startedAt : undefined,
      notice: prev.kind === "pick" ? prev.notice : undefined,
    }));
  };
  if (live()) stepFor(s, { kind: "pick", networks: [], scanStartedAt: startedAt });
  let list: Network[];
  try {
    list = await s.device.scan(
      (l) => show(l, true),
      () => !live(),
    );
  } catch (err) {
    const e = toSetupError(err);
    if (e.code === "disconnected") return failSession(s, e);
    if (!live()) return;
    if (s.networks.length > 0) show(s.networks, false);
    else stepFor(s, { kind: "credentials", network: null });
    return;
  }
  show(list, false);
}

function stopScan(s: Session) {
  s.scanToken++;
}

function backToNetworks(s: Session) {
  if (s.networks.length === 0) return reset();
  stepFor(s, { kind: "pick", networks: s.networks });
}

/** Errors the device reported on purpose, as opposed to a broken link. */
const isDeviceRefusal = (e: SetupError) => e.code === "device-error" || e.code === "protocol";

/** @param keepEmpty show the saved tab even when the list is empty */
async function refreshSaved(s: Session, keepEmpty = false) {
  try {
    const list = await s.device.listSaved();
    if (!s.ended) {
      state.saved = list.names.length > 0 || keepEmpty ? list : undefined;
      render();
    }
  } catch (err) {
    const e = toSetupError(err);
    log("saved networks: failed", { message: e.message });
    if (!isDeviceRefusal(e)) failSession(s, e);
  }
}

function setNotice(s: Session, notice: Problem | undefined) {
  stepFor(s, (prev) => (prev.kind === "pick" ? { ...prev, notice } : prev));
}

async function forget(s: Session, ssid: string) {
  setNotice(s, undefined);
  state.forgetting = ssid;
  render();
  try {
    await s.device.forgetSaved(ssid);
    if (!s.ended && state.saved)
      state.saved = { ...state.saved, names: state.saved.names.filter((n) => n !== ssid) };
  } catch (err) {
    const e = toSetupError(err);
    if (!isDeviceRefusal(e)) {
      state.forgetting = undefined;
      return failSession(s, e);
    }
    setNotice(s, TEXT.forgetFailed(ssid, e.message));
  }
  await refreshSaved(s, true);
  state.forgetting = undefined;
  render();
}

/**
 * Join a network and wait until the device reports the outcome.
 * @param network the scanned network, if picked from the list
 * @param list set when joining straight from the list
 * @param useSaved join with the password the device already has
 */
async function join(
  s: Session,
  ssid: string,
  pass: string,
  network: Network | null,
  list?: Network[],
  useSaved = false,
) {
  log("join: begin", { ssid, fromList: list !== undefined, useSaved });
  stepFor(s, { kind: "joining", ssid, network, list });
  try {
    if (useSaved) await s.device.joinSaved(ssid);
    else await s.device.provision(ssid, pass);
  } catch (err) {
    const e = toSetupError(err);
    if (useSaved && e.code === "device-error" && !s.ended) {
      stepFor(s, {
        kind: "pick",
        networks: s.networks,
        notice: TEXT.joinSavedFailed(ssid, e.message),
      });
      return refreshSaved(s, true);
    }
    return failSession(s, e);
  }
  const deadline = Date.now() + JOIN_TIMEOUT_MS;
  while (Date.now() < deadline && !s.ended) {
    await sleep(JOIN_POLL_MS);
    let st: JoinStatus;
    try {
      st = await s.device.status();
    } catch (err) {
      return failSession(s, err);
    }
    log("join status", st);
    switch (st.state) {
      case "connecting":
        if (st.attemptsLeft !== undefined && st.attemptsLeft <= 2) {
          stepFor(s, { kind: "joining", ssid, network, list, attemptsLeft: st.attemptsLeft });
        }
        continue;
      case "disconnected":
        continue;
      case "connected":
        endSession();
        return setStep({ kind: "connected", ssid: st.ssid || ssid, ip: st.ip || undefined });
      case "failed":
        if (st.reason === "auth") {
          return stepFor(s, {
            kind: "credentials",
            network: network && { ...network, secured: true },
            error: TEXT.wrongPassword(ssid),
          });
        }
        if (st.reason === "not-found") {
          return network
            ? stepFor(s, { kind: "pick", networks: s.networks, notice: TEXT.leftRange(ssid) })
            : stepFor(s, { kind: "credentials", network, error: TEXT.notFound(ssid) });
        }
        if (!s.ended) showFailure(TEXT.joinFailed(ssid));
        return;
    }
  }
  if (!s.ended) showFailure(TEXT.joinTimeout(ssid));
}

// ---------- UI actions ----------

const actions = {
  connect: () => void connect(),
  authenticate: (pop: string) => session && void authenticate(session, pop),
  selectNetwork: (n: Network) => {
    if (!session) return;
    stopScan(session);
    if (n.secured) stepFor(session, { kind: "credentials", network: n });
    else void join(session, n.ssid, "", n, session.networks);
  },
  joinSaved: (ssid: string) => {
    if (!session) return;
    stopScan(session);
    const n = session.networks.find((x) => x.ssid === ssid) ?? null;
    void join(session, ssid, "", n, session.networks, true);
  },
  forget: (ssid: string) => session && void forget(session, ssid),
  manualNetwork: () => {
    if (!session) return;
    stopScan(session);
    stepFor(session, { kind: "credentials", network: null });
  },
  rescan: () => session && void scan(session),
  backToNetworks: () => session && backToNetworks(session),
  join: (ssid: string, pass: string, network: Network | null) =>
    session && void join(session, ssid, pass, network),
  reset,
};

// ---------- DOM helpers ----------

type Child = Node | string | false | null | undefined;
type PropValue = string | number | boolean | null | undefined | ((e: Event) => unknown);

/**
 * Create an element. Strings become text nodes, so untrusted text is safe.
 * @param props `on*` → listeners, `class`, `style`, DOM properties (non-string values), or attributes
 */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, PropValue> = {},
  ...children: Array<Child | Child[]>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, "").toLowerCase(), v);
    else if (k === "class") el.className = String(v);
    else if (k === "style") el.setAttribute("style", String(v));
    else if (k in el && typeof v !== "string") (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

/** Drop `false`/`null`/`undefined` so they can be passed to `replaceChildren()`. */
const nodes = (...xs: Child[]) => xs.filter((x): x is Node | string => x != null && x !== false);

/** Fixed, trusted SVG markup. */
const ICONS = {
  lock: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none"/></svg>',
  copy: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" fill="none"/><path d="M3 10.5V3.5A1.5 1.5 0 0 1 4.5 2h6" fill="none"/></svg>',
  check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none"/></svg>',
  more: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>',
  rescan:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" fill="none"/></svg>',
  chevron:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" fill="none"/></svg>',
  arrow:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 11L11 5M6 5h5v5" fill="none"/></svg>',
  away: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6.5a8.5 8.5 0 0 1 12 0M4.5 9a5 5 0 0 1 7 0M2 2l12 12" fill="none"/><circle cx="8" cy="12" r="1"/></svg>',
};

function icon(name: keyof typeof ICONS, cls = "") {
  const span = h("span", { class: `icon ${cls}`.trim() });
  span.innerHTML = ICONS[name];
  return span;
}

const spinner = (label?: string) =>
  h("span", { class: "spinner", role: label ? "status" : null, "aria-label": label ?? null });

/** Copy text, falling back to a hidden textarea where the async API is unavailable. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall back */
  }
  const ta = h("textarea", { readonly: true, style: "position:fixed;opacity:0" });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

/** Icon button that copies `text` and shows a check mark for 1.5 s. */
function copyButton(text: string, label: string) {
  const btn = h(
    "button",
    { type: "button", class: "icon-btn", "aria-label": label, title: label },
    icon("copy"),
  );
  btn.addEventListener("click", async () => {
    if (!(await copyText(text))) return;
    btn.replaceChildren(icon("check", "ok"));
    btn.setAttribute("aria-label", "Copied");
    setTimeout(() => {
      btn.replaceChildren(icon("copy"));
      btn.setAttribute("aria-label", label);
    }, 1500);
  });
  return btn;
}

/** Selectable value with a copy button. */
const copyBox = (value: string, small = false) =>
  h(
    "div",
    { class: `copybox${small ? " small" : ""}` },
    h("code", {}, value),
    copyButton(value, "Copy"),
  );

const problemBox = (p: Problem) =>
  h(
    "div",
    { class: "problem", role: "alert" },
    h("strong", {}, p.title),
    p.body && h("p", {}, p.body),
    p.steps &&
      h(
        "ol",
        {},
        p.steps.map((s) => h("li", {}, s)),
      ),
  );

/** Screen layout: heading, intro, content. */
const screen = (
  title: string | Node,
  body: string | Node | undefined,
  ...children: Array<Child | Child[]>
) =>
  h(
    "div",
    { class: "screen" },
    h("h2", {}, title),
    body && h("p", { class: "lead" }, body),
    ...children,
  );

const em = (text: string) => h("strong", { class: "name" }, text);

const linkCard = (href: string, title: string, description: string) =>
  h(
    "a",
    { class: "link-card", href, target: "_blank", rel: "noopener" },
    h("span", {}, h("strong", {}, title), h("small", {}, description)),
    icon("arrow"),
  );

function signal(rssi: number) {
  const level = rssi >= -60 ? 4 : rssi >= -70 ? 3 : rssi >= -80 ? 2 : 1;
  const el = h("span", { class: `signal s${level}`, title: `${rssi} dBm` });
  el.innerHTML = "<i></i><i></i><i></i><i></i>";
  return el;
}

const bandLabel = (n: Network) => (n.bands.length > 1 ? "2.4 + 5 GHz" : n.bands[0]);

/** "More" menu for a saved network. */
function rowMenu(ssid: string, onUpdate: (() => void) | undefined) {
  const item = (label: string, fn: () => void) =>
    h(
      "button",
      {
        type: "button",
        onClick: (e: Event) => (
          (e.target as HTMLElement).closest("details")?.removeAttribute("open"),
          fn()
        ),
      },
      label,
    );
  return h(
    "details",
    { class: "menu" },
    h("summary", { "aria-label": `More for ${ssid}`, title: `More for ${ssid}` }, icon("more")),
    h(
      "div",
      { class: "menu-items" },
      onUpdate && item("Update password", onUpdate),
      item("Forget network", () => actions.forget(ssid)),
    ),
  );
}

// ---------- views ----------

/** A rendered screen; `update()` refreshes it in place so inputs keep focus. */
interface View {
  el: HTMLElement;
  update?: () => void;
  dispose?: () => void;
}

function viewKey(step: Step) {
  switch (step.kind) {
    case "connecting":
      return "ready";
    case "authenticating":
      return "auth";
    case "joining":
      return step.list ? "pick" : "credentials";
    default:
      return step.kind;
  }
}

/** Progress segment 0-3, or -1 for no progress bar. */
function progressIndex(step: Step) {
  switch (step.kind) {
    case "unsupported":
      return -1;
    case "pick":
      return 1;
    case "credentials":
    case "joining":
      return 2;
    case "connected":
      return 3;
    default:
      return 0;
  }
}

function platform(): { os: "ios" | "android" | "linux" | "desktop"; browser: string | null } {
  const ua = navigator.userAgent;
  const iPadOS = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return {
    os:
      /iPhone|iPad|iPod/.test(ua) || iPadOS
        ? "ios"
        : /Android/.test(ua)
          ? "android"
          : /Linux/.test(ua)
            ? "linux"
            : "desktop",
    browser: /Edg\//.test(ua)
      ? "Edge"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : /Safari\//.test(ua)
            ? "Safari"
            : null,
  };
}

function unsupportedView(reason: UnsupportedReason): View {
  const p = platform();
  const here = `${location.host}${location.pathname}`;
  if (reason === "insecure") {
    return {
      el: screen(
        "Open this page over HTTPS",
        "Browsers allow Bluetooth only on secure pages.",
        copyBox(`https://${here}`),
      ),
    };
  }
  if (reason === "no-adapter") {
    return {
      el: screen(
        "This computer has no Bluetooth",
        "Turn Bluetooth on, or use a computer or Android phone that has it. Then reload this page.",
      ),
    };
  }
  if (p.os === "ios") {
    return {
      el: screen(
        "Set up from a computer or Android phone",
        "Browsers on iPhone and iPad can't use Bluetooth.",
        copyBox(here),
        h("p", { class: "muted" }, "Works in Chrome and Edge."),
      ),
    };
  }
  if (p.os === "android") {
    return {
      el: screen(
        "Open this page in Chrome",
        "On Android, only Chrome can use Bluetooth.",
        copyBox(here),
        h(
          "div",
          { class: "links" },
          linkCard(
            "https://play.google.com/store/apps/details?id=com.android.chrome",
            "Chrome",
            "Google Play",
          ),
        ),
      ),
    };
  }
  if (p.os === "linux" && (p.browser === "Chrome" || p.browser === "Edge")) {
    const flag = `${p.browser === "Edge" ? "edge" : "chrome"}://flags/#enable-web-bluetooth`;
    return {
      el: screen(
        `Turn on Web Bluetooth in ${p.browser}`,
        `On Linux, ${p.browser} turns it off by default.`,
        h(
          "ol",
          { class: "steps" },
          h("li", {}, `Open a new tab in ${p.browser} and go to:`, copyBox(flag, true)),
          h("li", {}, "Set Web Bluetooth to Enabled."),
          h("li", {}, `Relaunch ${p.browser} and open this page again.`),
        ),
      ),
    };
  }
  return {
    el: screen(
      "Open this page in Chrome or Edge",
      `${p.browser ?? "This browser"} can't use Bluetooth.`,
      copyBox(here),
      h(
        "div",
        { class: "links" },
        linkCard("https://www.google.com/chrome/", "Chrome", "google.com/chrome"),
        linkCard("https://www.microsoft.com/edge", "Edge", "microsoft.com/edge"),
      ),
    ),
  };
}

function readyView(): View {
  const slot = h("div", { class: "slot" });
  const btn = h("button", { type: "button", class: "primary", onClick: actions.connect });
  const update = () => {
    const step = state.step;
    const connecting = step.kind === "connecting";
    slot.replaceChildren(...(step.kind === "ready" && step.error ? [problemBox(step.error)] : []));
    btn.replaceChildren(...(connecting ? [spinner(), "Connecting…"] : ["Connect to device"]));
    btn.disabled = connecting;
  };
  update();
  return {
    el: screen(
      "Connect to your JetKVM Mini",
      "Power on the device and keep it within a few metres of this computer.",
      slot,
      btn,
    ),
    update,
  };
}

function codeView(): View {
  const input = h("input", {
    id: "code",
    inputMode: "numeric",
    autocomplete: "off",
    autocapitalize: "none",
    spellcheck: "false",
    required: true,
    "aria-describedby": "code-error",
  });
  const error = h("p", { id: "code-error", class: "field-error", hidden: true });
  const submit = h("button", { type: "submit", class: "primary" });
  const cancel = h("button", { type: "button", onClick: actions.reset }, "Cancel");
  input.addEventListener("input", () => {
    error.hidden = true;
    input.removeAttribute("aria-invalid");
  });
  const form = h(
    "form",
    {
      onSubmit: (e: Event) => {
        e.preventDefault();
        if (state.step.kind === "authenticating") return;
        const code = input.value.replace(/\s/g, "");
        if (/^\d{6}$/.test(code)) return actions.authenticate(code);
        error.textContent = "Enter the 6 digits shown on the JetKVM screen.";
        error.hidden = false;
        input.setAttribute("aria-invalid", "true");
      },
    },
    screen(
      "Enter the setup code",
      "Enter the 6-digit code shown on the JetKVM screen.",
      h("label", { for: "code" }, "Setup code"),
      input,
      error,
      h("div", { class: "row" }, submit, cancel),
    ),
  );
  const update = () => {
    const step = state.step;
    const checking = step.kind === "authenticating";
    if (checking) input.value = step.pop || input.value;
    input.disabled = checking;
    cancel.disabled = checking;
    submit.disabled = checking;
    submit.replaceChildren(...(checking ? [spinner(), "Checking code…"] : ["Continue"]));
  };
  update();
  setTimeout(() => input.focus());
  return { el: form, update };
}

function pickView(): View {
  const title = h("h2");
  const notice = h("div", { class: "slot" });
  const filter = h("input", {
    type: "search",
    class: "filter",
    placeholder: "Filter networks",
    "aria-label": "Filter networks",
    autocomplete: "off",
    autocapitalize: "none",
    spellcheck: "false",
  });
  const header = h("div", { class: "list-header" });
  const list = h("div", { class: "list" });
  const manual = h(
    "button",
    { type: "button", class: "manual", onClick: actions.manualNetwork },
    "Enter network manually",
    icon("chevron"),
  );
  const footer = h("div", { class: "slot" });
  const mac = h("div", { class: "slot" });
  filter.value = state.filter;
  filter.addEventListener("input", () => {
    state.filter = filter.value;
    update();
  });
  let timer = 0;

  const update = () => {
    const step = state.step;
    const joiningStep = step.kind === "joining" ? step : null;
    const networks = step.kind === "pick" ? step.networks : (joiningStep?.list ?? []);
    const scanStartedAt = step.kind === "pick" ? step.scanStartedAt : undefined;
    const scanning = scanStartedAt !== undefined;
    const busy = joiningStep?.ssid ?? state.forgetting; // row with a spinner; everything else locked
    const q = state.filter.trim().toLowerCase();
    const savedNames = state.saved?.names;
    const hasSaved = (savedNames?.length ?? 0) > 0;
    const onSavedTab = hasSaved && state.tab === "saved";

    title.textContent = state.saved ? "Add a network" : "Choose your network";
    notice.replaceChildren(
      ...(step.kind === "pick" && step.notice ? [problemBox(step.notice)] : []),
    );

    // header: tabs and/or scan status
    const elapsed = scanStartedAt !== undefined ? Date.now() - scanStartedAt : 0;
    const secondsLeft = Math.ceil((SCAN_ESTIMATE_MS - elapsed) / 1000);
    const countdown = secondsLeft > 1 ? `About ${secondsLeft} seconds left` : "Almost done";
    const bar =
      scanning &&
      h("span", {
        class: "scanbar",
        style: `width:${Math.min(elapsed / SCAN_ESTIMATE_MS, 0.95) * 100}%`,
      });
    const rescan =
      busy === undefined &&
      h(
        "button",
        { type: "button", class: "link", onClick: actions.rescan },
        icon("rescan"),
        "Scan again",
      );
    if (hasSaved && savedNames) {
      const tab = (id: "nearby" | "saved", label: string, count: number) =>
        h(
          "button",
          {
            type: "button",
            class: "tab",
            "aria-pressed": String(state.tab === id),
            onClick: () => ((state.tab = id), update()),
          },
          label,
          h("span", { class: "count" }, String(count)),
        );
      header.replaceChildren(
        ...nodes(
          h(
            "div",
            { class: "tabs", role: "group" },
            tab("nearby", "Nearby", networks.length),
            tab("saved", "Saved", savedNames.length),
          ),
          !onSavedTab &&
            (scanning ? h("span", { class: "muted status" }, spinner(), countdown) : rescan),
          !onSavedTab && bar,
        ),
      );
    } else if (scanning) {
      header.replaceChildren(
        ...nodes(
          spinner(),
          h("span", { role: "status" }, "Scanning for networks"),
          h("span", { class: "muted status" }, countdown),
          bar,
        ),
      );
    } else {
      const found =
        networks.length === 0
          ? "No networks found"
          : networks.length === 1
            ? "1 network found"
            : `${networks.length} networks found`;
      header.replaceChildren(...nodes(h("span", { role: "status" }, found), rescan));
    }

    const row = (n: Network) => {
      const saved = !!savedNames?.includes(n.ssid); // the saved-networks endpoint exists whenever names are listed
      const btn = h(
        "button",
        {
          type: "button",
          class: "row-btn",
          disabled: busy !== undefined,
          onClick: () => (saved ? actions.joinSaved(n.ssid) : actions.selectNetwork(n)),
        },
        signal(n.rssi),
        h(
          "span",
          { class: "row-text" },
          h(
            "span",
            { class: "ssid" },
            h("span", { class: "ssid-text" }, n.ssid),
            n.secured &&
              h(
                "span",
                { class: "lock", "aria-label": "Password protected", role: "img" },
                icon("lock"),
              ),
          ),
          h(
            "span",
            { class: "meta" },
            bandLabel(n),
            n.secured ? "" : " · Open",
            saved ? " · Saved" : "",
          ),
        ),
        busy === n.ssid ? spinner() : icon("chevron", "chev"),
      );
      return h(
        "li",
        { class: busy === n.ssid ? "busy" : "" },
        btn,
        saved &&
          busy === undefined &&
          rowMenu(n.ssid, n.secured ? () => actions.selectNetwork(n) : undefined),
      );
    };
    const awayRow = (name: string) =>
      h(
        "li",
        {},
        h(
          "div",
          { class: "row-btn away" },
          icon("away", "away-icon"),
          h(
            "span",
            { class: "row-text" },
            h("span", { class: "ssid" }, h("span", { class: "ssid-text" }, name)),
            h("span", { class: "meta" }, scanning ? "Not found yet" : "Not in range"),
          ),
          busy === name ? spinner() : h("span"),
        ),
        busy === undefined && rowMenu(name, undefined),
      );

    if (onSavedTab && savedNames) {
      const names = savedNames.filter((n) => !q || n.toLowerCase().includes(q));
      list.replaceChildren(
        names.length > 0
          ? h(
              "ul",
              {},
              names.map((name) => {
                const n = networks.find((x) => x.ssid === name);
                return n ? row(n) : awayRow(name);
              }),
            )
          : h("p", { class: "empty" }, `No saved networks match “${state.filter.trim()}”.`),
      );
    } else {
      const shown = q ? networks.filter((n) => n.ssid.toLowerCase().includes(q)) : networks;
      if (shown.length > 0) {
        list.replaceChildren(
          h(
            "ul",
            {},
            shown.map(row),
            scanning &&
              !q &&
              h("li", { class: "hint" }, "5 GHz networks appear when the scan finishes."),
          ),
        );
      } else if (scanning && !q) {
        list.replaceChildren(
          h(
            "ul",
            { class: "skeleton", "aria-hidden": "true" },
            [60, 44, 72, 52, 38, 64].map((w) => h("li", {}, h("span", { style: `width:${w}%` }))),
          ),
        );
      } else if (networks.length === 0) {
        list.replaceChildren(
          h(
            "div",
            { class: "empty" },
            h("strong", {}, "No networks in range"),
            h("p", {}, "Move the device closer to your router, then scan again."),
          ),
        );
      } else {
        list.replaceChildren(
          h("p", { class: "empty" }, `No networks match “${state.filter.trim()}”.`),
        );
      }
    }

    manual.disabled = busy !== undefined;
    footer.replaceChildren(
      ...(joiningStep?.attemptsLeft !== undefined
        ? [h("p", { class: "muted" }, TEXT.retrying(joiningStep.attemptsLeft))]
        : []),
    );
    const macAddr = session?.info.mac;
    mac.replaceChildren(
      ...(macAddr
        ? [
            h(
              "p",
              { class: "mac" },
              h("span", { class: "muted" }, "MAC address"),
              h("code", {}, macAddr),
              copyButton(macAddr, "Copy MAC address"),
            ),
          ]
        : []),
    );

    clearInterval(timer);
    if (scanning) timer = window.setInterval(update, 250);
  };
  update();
  return {
    el: h(
      "div",
      { class: "screen" },
      title,
      h("p", { class: "lead" }, "Networks your JetKVM Mini can see, strongest first."),
      notice,
      filter,
      header,
      list,
      manual,
      footer,
      mac,
    ),
    update,
    dispose: () => clearInterval(timer),
  };
}

function credentialsView(): View {
  const step = state.step as Extract<Step, { kind: "credentials" | "joining" }>;
  const network = step.network;
  const known = !!network && !!state.saved?.names.includes(network.ssid);
  const ssidInput = h("input", {
    id: "ssid",
    autocomplete: "off",
    autocapitalize: "none",
    spellcheck: "false",
    required: true,
  });
  const pass = h("input", {
    id: "password",
    type: "password",
    autocomplete: "off",
    spellcheck: "false",
    "aria-describedby": "password-error",
  });
  const toggle = h(
    "button",
    { type: "button", class: "icon-btn reveal", "aria-label": "Show password" },
    "Show",
  );
  toggle.addEventListener("click", () => {
    const show = pass.type === "password";
    pass.type = show ? "text" : "password";
    toggle.textContent = show ? "Hide" : "Show";
    toggle.setAttribute("aria-label", show ? "Hide password" : "Show password");
  });
  const error = h("p", { id: "password-error", class: "field-error", hidden: true });
  const submit = h("button", { type: "submit", class: "primary" });
  const back = h("button", { type: "button", onClick: actions.backToNetworks }, "Back");
  const full = h("p", { class: "muted" });
  const retry = h("p", { class: "muted" });
  const title = network
    ? h(
        "span",
        {},
        known ? "Update the password for " : "Enter the password for ",
        em(network.ssid),
      )
    : "Enter your network details";
  const lead = network
    ? known
      ? "Enter the new password."
      : "The same password your phone or laptop uses on this network."
    : "Type the name exactly as it's set on your router.";

  const form = h(
    "form",
    {
      onSubmit: (e: Event) => {
        e.preventDefault();
        if (state.step.kind === "joining") return;
        const ssid = network ? network.ssid : ssidInput.value;
        actions.join(ssid, network?.secured === false ? "" : pass.value, network);
      },
    },
    screen(
      title,
      lead,
      !network && [h("label", { for: "ssid" }, "Network name"), ssidInput],
      network?.secured !== false && [
        h("label", { for: "password" }, "Password"),
        h("div", { class: "input-group" }, pass, toggle),
      ],
      error,
      h("div", { class: "row" }, submit, back),
      full,
      retry,
    ),
  );

  const update = () => {
    const s = state.step;
    const joining = s.kind === "joining" ? s : null;
    const err = s.kind === "credentials" ? s.error : undefined;
    error.textContent = err ?? "";
    error.hidden = !err;
    pass.toggleAttribute("aria-invalid", !!err);
    for (const el of [ssidInput, pass, toggle, back]) el.disabled = !!joining;
    if (joining && !network) ssidInput.value = joining.ssid;
    submit.disabled = !!joining;
    submit.replaceChildren(
      ...(joining
        ? [spinner(), `Joining ${joining.ssid}…`]
        : [known ? "Save and join" : "Join network"]),
    );
    const ssid = network?.ssid ?? ssidInput.value;
    const saved = state.saved;
    const replaces =
      saved && saved.names.length >= saved.max && !saved.names.includes(ssid)
        ? saved.names[0]
        : undefined;
    full.textContent = replaces && !joining ? `Saved list full. This replaces ${replaces}.` : "";
    full.hidden = !full.textContent;
    retry.textContent =
      joining?.attemptsLeft !== undefined ? TEXT.retrying(joining.attemptsLeft) : "";
    retry.hidden = !retry.textContent;
  };
  ssidInput.addEventListener("input", update);
  pass.addEventListener("input", () => {
    error.hidden = true;
    pass.removeAttribute("aria-invalid");
  });
  update();
  setTimeout(() => (network ? pass : ssidInput).focus());
  return { el: form, update };
}

function connectedView(): View {
  const step = state.step as Extract<Step, { kind: "connected" }>;
  const body = step.ip
    ? h(
        "span",
        {},
        "On a computer on the same network, open ",
        em(step.ip),
        ". It's also on the Mini's display.",
      )
    : "Its address is on the Mini's display.";
  return {
    el: screen(
      h("span", {}, "Your JetKVM Mini is on ", em(step.ssid)),
      body,
      h(
        "div",
        { class: "links" },
        step.ip && linkCard(`http://${step.ip}`, "Open your JetKVM Mini", step.ip),
        linkCard(
          TROUBLESHOOTING_URL,
          "Can't reach it?",
          "Another Wi-Fi network, a guest network or a VLAN.",
        ),
      ),
    ),
  };
}

function failedView(): View {
  const step = state.step as Extract<Step, { kind: "failed" }>;
  return {
    el: screen(
      step.title,
      step.message,
      h("button", { type: "button", class: "primary", onClick: actions.reset }, "Try again"),
      step.detail &&
        h(
          "details",
          { class: "detail" },
          h("summary", {}, "Technical details"),
          h("p", {}, step.detail),
        ),
    ),
  };
}

// ---------- render ----------

let current: { key: string; view: View } | null = null;

function render() {
  const step = state.step;
  const key = viewKey(step);
  const card = document.getElementById("card");
  const progress = document.getElementById("progress");
  if (!card || !progress) throw new Error("missing #card or #progress");
  if (current?.key === key && current.view.update) {
    current.view.update();
  } else {
    current?.view.dispose?.();
    let view: View;
    switch (step.kind) {
      case "unsupported":
        view = unsupportedView(step.reason);
        break;
      case "ready":
      case "connecting":
        view = readyView();
        break;
      case "auth":
      case "authenticating":
        view = codeView();
        break;
      case "pick":
        view = pickView();
        break;
      case "joining":
        view = step.list ? pickView() : credentialsView();
        break;
      case "credentials":
        view = credentialsView();
        break;
      case "connected":
        view = connectedView();
        break;
      case "failed":
        view = failedView();
        break;
    }
    current = { key, view };
    card.replaceChildren(view.el);
    if (key !== "auth" && key !== "credentials")
      view.el.querySelector<HTMLElement>("button.primary:not([disabled])")?.focus();
  }
  const at = progressIndex(step);
  progress.hidden = at < 0;
  progress.setAttribute("aria-valuenow", String(at + 1));
  for (const [i, seg] of [...progress.children].entries()) seg.classList.toggle("on", i <= at);
}

// ---------- start ----------

/** Mount the setup flow into #card / #progress and show the first screen. */
export async function start() {
  endSession();
  current?.view.dispose?.();
  current = null;
  Object.assign(state, {
    step: { kind: "ready" },
    saved: undefined,
    forgetting: undefined,
    urlPopRejected: false,
    filter: "",
    tab: "nearby",
  });
  let reason: UnsupportedReason | null = null;
  if (!window.isSecureContext) reason = "insecure";
  else if (!navigator.bluetooth) reason = "no-api";
  else if (!(await navigator.bluetooth.getAvailability().catch(() => true))) reason = "no-adapter";
  setStep(reason ? { kind: "unsupported", reason } : { kind: "ready" });
}

/** Close the Bluetooth link, e.g. when the page goes away. */
export const stop = endSession;
