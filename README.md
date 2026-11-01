# JetKVM Mini Wi-Fi setup over Web Bluetooth

Connects a JetKVM Mini W to a wireless network from the browser over Web Bluetooth.
Static site without backend, works in Chrome and Edge desktop and Android.

Unofficial community tool, not affiliated with JetKVM.

Live: https://alphajack.github.io/jetkvm-wifi-setup/

## Commands

```sh
pnpm install
pnpm dev            # local dev server
pnpm check          # format, lint, type check
pnpm test           # unit (Node) + UI (headless Chromium) tests
pnpm build          # dist/index.html: one self-contained file, also works opened locally
pnpm test:parity    # build, then compare with the live jetkvm.com/wireless page (needs network)
```

## Tests

- `tests/fake-device.ts`: a fake device (provisioning protocol, setup code, scan,
  saved networks) used from Node and Vitest's browser mode, and bundled into a script
  that the parity test injects into the page.
- `tests/unit`: protocol client implementation against the fake device; every request must match
  `tests/fixtures/original-requests.json`, recorded from the original jetkvm.com client.
- `tests/browser`: the full UI flow with the fake device as `navigator.bluetooth`.
- `tests/parity` (opt-in): the live jetkvm.com page and our build, driven through the same
  UI steps, must send the fake device the same requests.

To re-record the fixture from the current jetkvm.com version:

```sh
pnpm record            # resolves the module from https://jetkvm.com/wireless
pnpm record file.js    # or from a saved copy
```
