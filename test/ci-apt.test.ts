/**
 * CI installs Debian packages through tools/ci/apt-install.sh, so a slow mirror is retried within a time limit instead of running out
 * a job's time: the retry setting and a fallback mirror are written before apt runs, the download is limited and started again, the
 * downloaded packages are kept between runs, and no workflow runs apt any other way.
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

const ARCHIVES = '"${archives[@]}"';

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

  it('adds Ubuntu’s own archive after the runner’s mirror, also when it only writes the setting', () => {
    const fallback = script.indexOf("echo 'http://archive.ubuntu.com/ubuntu/' | sudo tee -a /etc/apt/apt-mirrors.txt");
    expect(fallback).toBeGreaterThan(-1);
    expect(fallback).toBeLessThan(script.indexOf('[ "$#" -eq 0 ] && exit 0'));
  });

  it('downloads under a time limit, tries again, and installs only from what was downloaded', () => {
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('for attempt in $(seq 1 "$attempts"); do');
    expect(script).toContain('timeout "$limit" apt-get update');
    expect(script).toContain(`timeout "$limit" apt-get install -y --download-only --no-install-recommends ${ARCHIVES} "$@"`);
    const download = script.indexOf('--download-only');
    const install = script.lastIndexOf(`apt-get install -y --no-install-recommends ${ARCHIVES} "$@"`);
    expect(install).toBeGreaterThan(download);
  });

  it('keeps the downloaded packages in APT_ARCHIVES for both the download and the install', () => {
    expect(script).toContain('archives=(-o "Dir::Cache::archives=$APT_ARCHIVES")');
    expect(script.split(ARCHIVES)).toHaveLength(3);
  });
});

describe('the workflows', () => {
  it('run apt only through the script', () => {
    for (const { name, text } of workflows) {
      const direct = text.split('\n').filter((line) => /\bapt-get\b|\bapt install\b/.test(line) && !line.trimStart().startsWith('#'));
      expect(direct, name).toEqual([]);
    }
  });

  it('restore the kept packages in the same job before an install that names packages, and point the script at them', () => {
    for (const { name, text } of workflows) {
      const lines = text.split('\n');
      lines.forEach((line, at) => {
        if (!/bash tools\/ci\/apt-install\.sh \S/.test(line)) return;
        expect(line, name).toContain('APT_ARCHIVES="$GITHUB_WORKSPACE/.apt-archives"');
        const before = lines.slice(0, at).join('\n');
        const restore = before.lastIndexOf('uses: actions/cache@');
        expect(restore, name).toBeGreaterThan(before.lastIndexOf('\n    steps:'));
        expect(before.slice(restore), name).toContain('.apt-archives/*.deb');
      });
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
