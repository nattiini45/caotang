import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, resolveConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import { generateNotices, NOTICES_FILE } from '../tools/third-party-notices.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

describe('the app build notices', () => {
  it('emits the production notices inside a fresh custom output directory', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'caotang-notices-'));
    try {
      const app = await resolveConfig({ configFile: join(root, 'apps/desktop/vite.config.ts'), logLevel: 'silent' }, 'build');
      const notices = app.plugins.find((plugin) => plugin.name === 'caotang-third-party-notices');
      expect(notices).toBeDefined();
      writeFileSync(join(fixture, 'index.html'), '<script type="module" src="/main.js"></script>');
      writeFileSync(join(fixture, 'main.js'), 'export const message = "A build fixture.";');
      const output = join(fixture, 'output', 'custom');
      await build({ configFile: false, root: fixture, plugins: [notices], logLevel: 'silent', build: { outDir: output } });
      expect(readFileSync(join(output, NOTICES_FILE), 'utf8')).toBe(generateNotices({ root, filters: ['./apps/desktop'] }));
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
