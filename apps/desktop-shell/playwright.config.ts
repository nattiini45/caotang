import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  // The shell's suite is the launched app. Its `*.test.ts` files are the port's unit checks, which run under vitest from the
  // repository's gate; Playwright's default pattern would claim them and fail on an import of a runner it does not have.
  testMatch: /.*\.spec\.ts$/,
  forbidOnly: Boolean(process.env.CI),
});
