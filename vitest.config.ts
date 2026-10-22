import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default environment is node: the mock provider must be
    // importable headless, so nothing may silently require a DOM.
    environment: 'node',
    // `test/` is the repo-level suite — guards whose subject is the repository
    // rather than a package. It is listed explicitly because a `packages/*` glob
    // does not match it, and a guard that verify never collects is a guard that
    // is green because it never ran.
    include: ['packages/*/test/**/*.test.ts', 'test/**/*.test.ts'],
    // The Ink compiler loads on demand, so every test file starts with it loaded, as a Node host's entry does.
    setupFiles: ['test/setup-ink-compiler.ts'],
    reporters: ['default'],
  },
});
