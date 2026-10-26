import { defineConfig, devices } from '@playwright/test';

// One port for the dev server and the suite. CAOTANG_E2E_PORT gives a parallel checkout its
// own server; with it set, an existing server is never reused, because on a shared machine
// the one already listening may be another checkout's build of the app.
const port = Number(process.env['CAOTANG_E2E_PORT'] ?? 5173);
const isolated = process.env['CAOTANG_E2E_PORT'] !== undefined;

// The production preview has its own port, derived from the dev port (a thousand above it), so two checkouts
// running their suites at once never share a preview server. CAOTANG_E2E_PREVIEW_PORT overrides it.
const previewPort = Number(process.env['CAOTANG_E2E_PREVIEW_PORT'] ?? port + 1000);

// The Firefox and WebKit projects exist only when CAOTANG_E2E_BROWSERS=all, so `pnpm test:e2e` on a machine (or a CI job) with only
// Chromium installed keeps working. The e2e-browsers workflow sets it for pull requests, nightly and on-demand runs.
const crossBrowser = process.env['CAOTANG_E2E_BROWSERS'] === 'all';

// CAOTANG_E2E_NO_SERVER=1 starts neither web server, for the one spec that needs none: the real-key round, which runs in the Node
// worker with no page (.github/workflows/provider-smoke.yml). Every other run keeps both servers.
const noServer = process.env['CAOTANG_E2E_NO_SERVER'] === '1';

/** What Firefox and WebKit leave to Chromium: pure model specs (the same in any browser), the build smoke, and the specs that call real provider endpoints. */
const chromiumOnlySpecs = [/[\\/]e2e[\\/]unit[\\/]/, /prod-smoke\.spec\.ts/, /providers-cors\.spec\.ts/, /provider-smoke\.spec\.ts/];

/**
 * E2E wiring. Browsers are installed on demand with
 * `pnpm exec playwright install chromium` (add `firefox webkit` for those projects), once per machine, not every run.
 *
 * Four projects. `chromium` runs the suite against the dev server. `firefox` and `webkit` run it too, minus the specs that are
 * browser-independent or need Chromium (e2e/unit, the production smoke, the provider specs), so a writer in those browsers meets the
 * bundle-only storage path tested (File System Access is Chromium-only). They exist only with CAOTANG_E2E_BROWSERS=all, which the
 * cross-browser workflow .github/workflows/e2e-browsers.yml sets for pull requests, nightly and on-demand runs. `production-preview` runs only
 * e2e/prod-smoke.spec.ts against `vite preview` of a fresh build, so a build-only failure (a root-absolute asset path, a
 * DEV-only hook) is caught here and not by a writer. The preview server builds before it starts, so it tests the source
 * this checkout holds.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: /prod-smoke\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    ...(crossBrowser
      ? [
          { name: 'firefox', testIgnore: chromiumOnlySpecs, use: { ...devices['Desktop Firefox'] } },
          { name: 'webkit', testIgnore: chromiumOnlySpecs, use: { ...devices['Desktop Safari'] } },
        ]
      : []),
    {
      name: 'production-preview',
      testMatch: /prod-smoke\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${previewPort}` },
    },
  ],
  webServer: noServer ? [] : [
    {
      command: 'pnpm --filter @caotang/desktop dev',
      url: `http://127.0.0.1:${port}`,
      reuseExistingServer: !process.env.CI && !isolated,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @caotang/desktop build && pnpm --filter @caotang/desktop preview',
      url: `http://127.0.0.1:${previewPort}`,
      env: { ...process.env, CAOTANG_E2E_PREVIEW_PORT: String(previewPort) },
      reuseExistingServer: !process.env.CI && !isolated,
      timeout: 240_000,
    },
  ],
});
