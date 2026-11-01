import { existsSync, readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

/**
 * Locally, use the system Chromium so Playwright needs no browser download.
 * On CI (`CI` is set by GitHub Actions), use Playwright's own Chromium.
 */
export const chromiumPath =
  process.env.CHROMIUM_PATH ??
  (process.env.CI
    ? undefined
    : ["/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => existsSync(p)));

/**
 * Inline the built JS, CSS and logo into index.html, so the build is one portable file
 * that works from GitHub Pages, any static host, or opened locally (file://).
 */
function singleFile(): Plugin {
  const logo = `data:image/svg+xml,${encodeURIComponent(readFileSync("public/logo.svg", "utf8"))}`;
  return {
    name: "single-file",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, { bundle }) {
        if (!bundle) return html;
        const take = (file: string) => {
          const item = bundle[file];
          delete bundle[file];
          return item.type === "chunk" ? item.code : String(item.source);
        };
        const out = html
          .replace(
            /<script type="module" crossorigin src="\.\/([^"]+)"><\/script>/g,
            (_, f: string) => {
              // keep a literal "</script" inside the code from closing the tag early
              return `<script type="module">${take(f).replace(/<\/script/gi, "<\\/script")}</script>`;
            },
          )
          .replace(
            /<link rel="stylesheet" crossorigin href="\.\/([^"]+)">/g,
            (_, f: string) => `<style>${take(f)}</style>`,
          )
          .replaceAll('"./logo.svg"', `"${logo}"`);
        const left = Object.keys(bundle).filter((f) => /\.(js|css)$/.test(f));
        if (left.length) throw new Error(`single-file: not inlined: ${left.join(", ")}`);
        return out;
      },
    },
  };
}

export default defineConfig({
  // relative URLs, so the 404 page and any leftover asset work under GitHub Pages /<repo>/
  base: "./",
  build: { target: "es2022", modulePreload: { polyfill: false } },
  plugins: [singleFile()],
  lint: { options: { typeAware: true, typeCheck: true } },
  // written by `pnpm record`
  fmt: { ignorePatterns: ["tests/fixtures/original-requests.json"] },
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "browser",
          include: ["tests/browser/**/*.test.ts"],
          testTimeout: 120_000,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({
              launchOptions: chromiumPath ? { executablePath: chromiumPath } : {},
            }),
            instances: [{ browser: "chromium" }],
          },
        },
      },
      // Compares against the live jetkvm.com/wireless page: needs network and a build, opt-in.
      ...(process.env.PARITY
        ? [
            {
              test: {
                name: "parity",
                include: ["tests/parity/**/*.test.ts"],
                environment: "node" as const,
                testTimeout: 300_000,
                hookTimeout: 60_000,
              },
            },
          ]
        : []),
    ],
  },
});
