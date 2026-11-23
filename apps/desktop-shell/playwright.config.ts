import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  forbidOnly: Boolean(process.env.CI),
});
