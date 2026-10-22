/**
 * The release path and the maker's name (issue 33): what a `v*` tag publishes, and the wording the owner chose for who makes Caotang.
 *
 * The tag workflow cannot run here, so these tests hold the parts it relies on: the tag check and the changelog notes in
 * tools/release.mjs, the workflow's shape, and the files that must agree on a version (package.json, manifest.json, server.json).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changelogSection, tagProblems } from '../tools/release.mjs';

const root = resolve(__dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8').split('\r\n').join('\n');
const readJson = (path: string): Record<string, unknown> => JSON.parse(read(path)) as Record<string, unknown>;

const OWNER = { name: 'nattiini45', url: 'https://github.com/nattiini45' };
const versions = { packageVersion: '0.1.0', manifestVersion: '0.1.0', serverVersion: '0.1.0' };

describe('tagProblems', () => {
  it('accepts a tag that names the version all three files carry', () => {
    expect(tagProblems('v0.1.0', versions)).toEqual([]);
  });

  it('refuses a tag without the leading v', () => {
    expect(tagProblems('0.1.0', versions)).toEqual([expect.stringContaining('must look like v1.2.3')]);
  });

  it('refuses a tag that is not a plain version', () => {
    expect(tagProblems('v0.1', versions)).not.toEqual([]);
    expect(tagProblems('v0.1.0-rc1', versions)).not.toEqual([]);
    expect(tagProblems('v0.1.0.0', versions)).not.toEqual([]);
  });

  it('names each file whose version differs from the tag', () => {
    const problems = tagProblems('v0.2.0', versions);
    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toContain('package.json');
    expect(problems.join('\n')).toContain('manifest.json');
    expect(problems.join('\n')).toContain('server.json');
  });

  it('flags only the file that is out of step', () => {
    const problems = tagProblems('v0.1.0', { ...versions, serverVersion: '0.0.9' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('server.json');
  });
});

describe('changelogSection', () => {
  const log = ['# Changelog', '', '## Unreleased', '', '- next', '', '## 0.1.0', '', 'First.', '', '### Added', '', '- a', '', '## 0.0.9', '', 'Old.', ''].join('\n');

  it('returns the section up to the next version heading, subsections included', () => {
    expect(changelogSection(log, '0.1.0')).toBe('First.\n\n### Added\n\n- a');
  });

  it('returns the last section to the end of the file', () => {
    expect(changelogSection(log, '0.0.9')).toBe('Old.');
  });

  it('returns undefined for a version the changelog does not have', () => {
    expect(changelogSection(log, '0.2.0')).toBeUndefined();
  });

  it('does not take a version that only starts with the one asked for', () => {
    expect(changelogSection('## 0.1.01\n\nx\n', '0.1.0')).toBeUndefined();
  });

  it('reads a changelog with Windows line endings', () => {
    expect(changelogSection('## 0.1.0\r\n\r\nFirst.\r\n', '0.1.0')).toBe('First.');
  });

  it('finds the real 0.1.0 section', () => {
    expect(changelogSection(read('CHANGELOG.md'), '0.1.0')).toContain('first public version');
  });
});

describe('the files a release agrees on', () => {
  const pkg = readJson('packages/mcp-server/package.json');
  const manifest = readJson('packages/mcp-server/manifest.json');
  const server = readJson('server.json') as {
    name: string;
    version: string;
    packages: { registryType: string; identifier: string; fileSha256: string; transport: { type: string } }[];
  };

  it('has one version in package.json, manifest.json and server.json', () => {
    expect(
      tagProblems(`v${String(pkg['version'])}`, {
        packageVersion: String(pkg['version']),
        manifestVersion: String(manifest['version']),
        serverVersion: server.version,
      }),
    ).toEqual([]);
  });

  it('points server.json at the release asset the workflow uploads', () => {
    const [entry] = server.packages;
    expect(server.name).toBe('io.github.nattiini45/caotang');
    expect(entry?.registryType).toBe('mcpb');
    expect(entry?.transport.type).toBe('stdio');
    expect(entry?.identifier).toBe(
      `https://github.com/nattiini45/caotang/releases/download/v${server.version}/caotang-mcp-${server.version}.mcpb`,
    );
  });

  it('keeps the server.json hash either the all-zero placeholder or a real SHA-256', () => {
    expect(server.packages[0]?.fileSha256).toMatch(/^(0{64}|[0-9a-f]{64})$/);
  });

  it('names the maker in the bundle manifest by handle, with the profile link', () => {
    expect(manifest['author']).toEqual(OWNER);
  });
});

describe('the release workflow', () => {
  const workflow = read('.github/workflows/release.yml');

  it('runs on v* tags only', () => {
    expect(workflow).toContain("tags: ['v*']");
    expect(workflow).not.toContain('pull_request');
    expect(workflow).not.toContain('branches:');
  });

  it('asks for contents: write and nothing else', () => {
    const block = workflow.slice(workflow.indexOf('permissions:'), workflow.indexOf('concurrency:'));
    expect(block.split('\n').filter((line) => line.startsWith('  '))).toEqual(['  contents: write']);
  });

  it('checks the tag, verifies, packs, hashes and uploads, in that order', () => {
    const steps = ['tools/release.mjs check', 'pnpm verify', 'run pack', 'sha256sum', 'gh release create'].map((step) => workflow.indexOf(step));
    expect(steps.every((at) => at >= 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(workflow).toContain('SHA256SUMS');
  });

  it('takes the notes from the changelog and uses no third-party action', () => {
    expect(workflow).toContain('tools/release.mjs notes');
    const uses = workflow.split('\n').filter((line) => line.includes('uses:'));
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((line) => line.trimStart().startsWith('- uses: actions/'))).toBe(true);
  });
});

describe('who makes Caotang', () => {
  const site = read('site/index.html');
  const start = site.indexOf('<script type="application/ld+json">');
  const jsonLd = JSON.parse(site.slice(site.indexOf('>', start) + 1, site.indexOf('</script>', start))) as { author: unknown };

  it('credits the JSON-LD author to the handle as a Person', () => {
    expect(jsonLd.author).toEqual({ '@type': 'Person', ...OWNER });
  });

  it('says "@nattiini45 and contributors" on the page, linking the handle, with no company name', () => {
    expect(site).toContain('<a href="https://github.com/nattiini45">@nattiini45</a> and contributors');
    expect(site).not.toContain('The Caotang Authors');
  });

  it('keeps the licence holder as The Caotang Authors, and records the wording as an owner decision beside it', () => {
    expect(read('LICENSE')).toContain('Copyright (c) 2026 The Caotang Authors');
    const lines = read('docs/decisions.md').split('\n');
    const licence = lines.findIndex((line) => line.startsWith('- Licence MIT, "Copyright (c) 2026 The Caotang Authors"'));
    expect(licence).toBeGreaterThan(-1);
    const wording = lines[licence + 1] ?? '';
    expect(wording).toContain('@nattiini45 and contributors');
    expect(wording.endsWith('[owner]')).toBe(true);
  });
});
