import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectLockfile } from './lockfile';

const root = resolve(__dirname, '..');

describe('the standalone server boundary', () => {
  it('keeps the server and its runtime out of the browser package dependencies', () => {
    const app = JSON.parse(readFileSync(resolve(root, 'apps/desktop/package.json'), 'utf8'));
    const server = JSON.parse(readFileSync(resolve(root, 'packages/sync-server/package.json'), 'utf8'));
    expect(server.dependencies).toBeUndefined();
    expect(server.devDependencies.miniflare).toBeDefined();
    for (const name of ['@caotang/sync-server', 'miniflare', 'workerd', '@cloudflare/workers-types']) {
      expect(app.dependencies?.[name]).toBeUndefined();
    }
  });

  it('approves the installed Worker binary and no absent build-script package', () => {
    const workspace = readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8');
    const block = /^allowBuilds:\s*\n((?:[ \t]+[^\n]*\n?)*)/m.exec(workspace)?.[1] ?? '';
    const approved = [...block.matchAll(/^\s{2}([^:]+):\s*true\s*$/gm)].map((match) => match[1]!);
    expect(approved).toContain('workerd');
    const lockfile = projectLockfile(readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8'));
    for (const name of approved) expect(lockfile).toContain(`  ${name}@`);
  });
});
