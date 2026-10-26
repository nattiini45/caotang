/**
 * CI installs Debian packages through tools/ci/apt-install.sh, so a slow mirror is retried within a time limit instead of running out
 * a job's time: the retry setting is written before apt runs, the download is limited and started again, and no workflow runs apt
 * any other way.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8').split('\r\n').join('\n');
const script = read('tools/ci/apt-install.sh');
const workflows = readdirSync(resolve(root, '.github/workflows'))
  .filter((name) => name.endsWith('.yml'))
  .map((name) => ({ name, text: read(`.github/workflows/${name}`) }));

describe('tools/ci/apt-install.sh', () => {
  it('writes the retry setting before apt runs at all', () => {
    const setting = script.indexOf('/etc/apt/apt.conf.d/80-ci-retries');
    expect(setting).toBeGreaterThan(-1);
    expect(script).toContain('Acquire::Retries "5"');
    expect(script).toContain('Acquire::http::Timeout "30"');
    expect(setting).toBeLessThan(script.indexOf('apt-get update'));
    // The setting is printed into the step's log, so a run shows what apt was told.
    expect(script).not.toMatch(/80-ci-retries\s*>\s*\/dev\/null/);
  });

  it('downloads under a time limit, tries again, and installs only from what was downloaded', () => {
    expect(script).toContain('set -euo pipefail');
    expect(script).toMatch(/for attempt in 1 2 3; do/);
    expect(script).toMatch(/timeout "\$limit" apt-get update/);
    expect(script).toMatch(/timeout "\$limit" apt-get install -y --download-only --no-install-recommends "\$@"/);
    const download = script.indexOf('--download-only');
    const install = script.lastIndexOf('apt-get install -y --no-install-recommends "$@"');
    expect(install).toBeGreaterThan(download);
  });
});

describe('the workflows', () => {
  it('run apt only through the script', () => {
    for (const { name, text } of workflows) {
      const direct = text.split('\n').filter((line) => /\bapt-get\b|\bapt install\b/.test(line) && !line.trimStart().startsWith('#'));
      expect(direct, name).toEqual([]);
    }
  });

  it('write the retry setting before a Playwright install that pulls system packages', () => {
    for (const { name, text } of workflows) {
      for (const match of text.matchAll(/playwright install --with-deps/g)) {
        const at = match.index;
        const before = text.slice(Math.max(0, at - 400), at);
        expect(before, name).toContain('bash tools/ci/apt-install.sh');
      }
    }
  });
});
