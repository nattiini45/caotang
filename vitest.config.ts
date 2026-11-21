import { lingui } from '@lingui/vite-plugin';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  // The same macro transform as the app's build (apps/desktop/vite.config.ts): Lingui's native transform
  // reads lingui.config.ts, compiles a `.po` import to its message catalogue, and turns `msg`/`<Trans>`
  // into descriptors here too. `test/i18n-build.test.ts` proves it on a real fixture, and
  // `failOnCompileError` makes a broken ICU message fail `pnpm verify` rather than warn into a log.
  plugins: [lingui({ macroTransform: true, failOnCompileError: true })],
  test: {
    // Default environment is node: the mock provider must be
    // importable headless, so nothing may silently require a DOM.
    environment: 'node',
    // `test/` is the repo-level suite — guards whose subject is the repository
    // rather than a package. It is listed explicitly because a `packages/*` glob
    // does not match it, and a guard that verify never collects is a guard that
    // is green because it never ran. `apps/desktop/test` holds the app's own
    // component-level checks (the React bidi helper, I4), which need the app's
    // React dependency and therefore cannot live under the root package.
    include: ['packages/*/test/**/*.test.ts', 'test/**/*.test.ts', 'apps/desktop/test/**/*.test.{ts,tsx}'],
    // The Ink compiler loads on demand, so every test file starts with it loaded, as a Node host's entry does.
    setupFiles: ['test/setup-ink-compiler.ts'],
    reporters: ['default'],
    // Two suites start a Miniflare Worker runtime for each case, which takes longer on a loaded runner than the default case
    // deadline allows: `packages/sync-server/test/account-mode.test.ts` took 55 s for its 19 cases on GitHub's Windows runner and
    // six of them timed out at five seconds. Windows is where that bites, so the Windows leg sets this variable and runs the rest
    // of the gate; every other runner runs them, and #815 tracks moving those two files onto one shared runtime so the exclusion
    // can go. Nothing is skipped silently: the job that sets it says so in its name.
    exclude: [
      ...configDefaults.exclude,
      ...(process.env['CAOTANG_SKIP_WORKER_SUITES'] === '1'
        ? ['packages/sync-server/test/account-mode.test.ts', 'packages/sync-server/test/storage.test.ts']
        : []),
    ],
  },
});
