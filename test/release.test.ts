/**
 * The release path and the maker's name (issue 33): what a `v*` tag publishes, and the wording the owner chose for who makes Caotang.
 *
 * The tag workflow cannot run here, so these tests hold the parts it relies on: the tag check and the changelog notes in
 * tools/release.mjs, the workflow's shape, and the files that must agree on a version (package.json, manifest.json, server.json).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changelogSection, tagProblems } from '../tools/release.mjs';

const root = resolve(__dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8').split('\r\n').join('\n');
const readJson = (path: string): Record<string, unknown> => JSON.parse(read(path)) as Record<string, unknown>;

/** The text of one top-level job of a workflow, from its `  id:` line to the next job (or the end). */
function jobBlock(workflow: string, id: string): string {
  const jobs = workflow.slice(workflow.indexOf('\njobs:\n'));
  const start = new RegExp(`^ {2}${id}:\\s*$`, 'm').exec(jobs);
  if (!start) throw new Error(`workflow has no top-level ${id} job`);
  const from = start.index + start[0].length;
  const next = /^ {2}[A-Za-z0-9_-]+:\s*$/m.exec(jobs.slice(from));
  return jobs.slice(start.index, next ? from + next.index : jobs.length);
}

/** The entries under a `permissions:` key at the given indentation (the workflow's or one job's), in order. */
function permissionEntries(block: string, indent: string): string[] {
  const lines = block.split('\n');
  const at = lines.indexOf(`${indent}permissions:`);
  if (at < 0) return [];
  const entries: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith(`${indent}  `)) break;
    entries.push(line.trim());
  }
  return entries;
}

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

  it('keeps the workflow-level default at contents: read, so a job has only what it names', () => {
    expect(permissionEntries(workflow.slice(workflow.indexOf('\npermissions:') + 1), '')).toEqual(['contents: read']);
  });

  it('gives the release job contents: write and no id-token, and runs it for a tag push only', () => {
    const release = jobBlock(workflow, 'release');
    expect(permissionEntries(release, '    ')).toEqual(['contents: write']);
    expect(release).not.toContain('id-token');
    expect(release).toContain("if: github.event_name == 'push'");
  });

  it('checks the tag, verifies, packs, hashes and uploads, in that order', () => {
    const release = jobBlock(workflow, 'release');
    const steps = ['tools/release.mjs check', 'pnpm verify', 'run pack', 'pnpm --filter @caotang/cli run build', 'sha256sum', 'gh release create'].map((step) => release.indexOf(step));
    expect(steps.every((at) => at >= 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(workflow).toContain('SHA256SUMS');
  });

  it('builds the command-line bundle, lists it in SHA256SUMS and attaches it under the name the scan template downloads', () => {
    const template = read('docs/ci/continuity-scan.yml');
    const asset = /releases\/download\/\$\{CAOTANG_VERSION\}\/([^"\s]+)/.exec(template)?.[1] ?? '';
    expect(asset).toBe('caotang.mjs');
    const create = workflow.slice(workflow.indexOf('gh release create'));
    expect(create.split('\n')[0]).toContain(`packages/cli/dist/${asset}`);
    expect(workflow).toContain(`sha256sum ${asset}`);
    expect(workflow).toMatch(/\(cd packages\/cli\/dist && sha256sum caotang\.mjs\) >> /);
  });

  it('takes the notes from the changelog and uses no third-party action', () => {
    expect(workflow).toContain('tools/release.mjs notes');
    const uses = workflow.split('\n').filter((line) => line.includes('uses:'));
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((line) => line.trimStart().startsWith('- uses: actions/'))).toBe(true);
  });
});

describe('the registry job of the release workflow', () => {
  const workflow = read('.github/workflows/release.yml');
  const registry = jobBlock(workflow, 'registry');
  const steps = [...registry.matchAll(/^ {6}- (?:name: .+|uses: .+)$/gm)];
  const at = (text: string): number => registry.indexOf(text);

  it('can be started by hand with a required tag, and by no pull request', () => {
    const trigger = workflow.slice(workflow.indexOf('\non:\n'), workflow.indexOf('\npermissions:'));
    expect(trigger).toMatch(/workflow_dispatch:\n {4}inputs:\n {6}tag:\n(?: {8}.+\n)*? {8}required: true\n/);
    expect(workflow).not.toContain('pull_request_target');
    expect(workflow).not.toContain('secrets.');
  });

  it('holds id-token: write and contents: read, and no other job holds id-token', () => {
    expect(permissionEntries(registry, '    ')).toEqual(['id-token: write', 'contents: read']);
    expect(jobBlock(workflow, 'release')).not.toContain('id-token');
    expect(workflow.match(/^ +id-token:/gm)).toHaveLength(1);
    expect(registry).not.toContain('contents: write');
  });

  it('needs the release job, and by hand runs only from main, with the release job skipped', () => {
    expect(registry).toMatch(/^ {4}needs: release$/m);
    const condition = /^ {4}if: (.+)$/m.exec(registry)?.[1] ?? '';
    expect(condition).toContain('!cancelled()');
    expect(condition).toContain("github.event_name == 'push' && needs.release.result == 'success'");
    expect(condition).toContain("github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'");
    expect(jobBlock(workflow, 'release')).toContain("if: github.event_name == 'push'");
  });

  it('takes the tag from the dispatch input or the pushed tag, and checks out that tag without keeping the token', () => {
    expect(registry).toContain('TAG: ${{ inputs.tag || github.ref_name }}');
    expect(registry).toContain("ref: ${{ github.event_name == 'push' && github.sha || format('refs/tags/{0}', inputs.tag) }}");
    expect(registry).toContain('persist-credentials: false');
  });

  it('pins mcp-publisher to a release at least 14 days old and checks the tarball against a 64-hex SHA-256', () => {
    const version = /MCP_PUBLISHER_VERSION: '(v\d+\.\d+\.\d+)'/.exec(registry)?.[1];
    const sha = /MCP_PUBLISHER_SHA256: '([0-9a-f]{64})'/.exec(registry)?.[1];
    expect(version).toBeDefined();
    expect(sha).toBeDefined();
    expect(sha).not.toMatch(/^0+$/);
    expect(registry).toContain(`registry_${(version ?? '').slice(1)}_checksums.txt`);
    expect(registry).toContain('releases/download/${MCP_PUBLISHER_VERSION}/mcp-publisher_linux_amd64.tar.gz');
    expect(registry).not.toMatch(/releases\/latest|@latest/);
    expect(registry).toContain('sha256sum --check --strict -');
    const published = /published (\d{4}-\d{2}-\d{2}), so it was more than 14 days old/.exec(registry)?.[1];
    expect(published).toBeDefined();
    expect(Date.now() - Date.parse(`${published}T00:00:00Z`)).toBeGreaterThanOrEqual(14 * 86_400_000);
  });

  it('runs no third-party action, only first-party ones', () => {
    const uses = registry.split('\n').filter((line) => line.includes('uses:'));
    expect(uses).toHaveLength(2);
    expect(uses.every((line) => line.trimStart().startsWith('- uses: actions/'))).toBe(true);
    expect(steps).toHaveLength(8);
  });

  it('checks the tag, downloads SHA256SUMS, stamps server.json, verifies the binary, then signs in and publishes, in that order', () => {
    const order = [
      'node tools/release.mjs check "$TAG"',
      'gh release download "$TAG"',
      'entry.fileSha256 = hash',
      'sha256sum --check --strict -',
      'mcp-publisher" login github-oidc',
      'mcp-publisher" publish',
    ].map(at);
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(registry).toContain('--pattern SHA256SUMS');
  });

  it('gives the GitHub token to the download step alone', () => {
    expect(registry.match(/GH_TOKEN:/g)).toHaveLength(1);
    const download = registry.slice(at('Download the release'), at('Write the release'));
    expect(download).toContain('GH_TOKEN: ${{ github.token }}');
  });

  describe('the step that writes the release hash into server.json', () => {
    const script = /<<'EOF'\n([\s\S]*?)\n {10}EOF\n/.exec(registry)?.[1]?.replace(/^ {10}/gm, '') ?? '';
    const hash = 'a'.repeat(64);
    const zero = '0'.repeat(64);
    const identifier = 'https://github.com/nattiini45/caotang/releases/download/v1.2.3/caotang-mcp-1.2.3.mcpb';
    const serverJson = (fileSha256: string, id = identifier): string =>
      JSON.stringify({ name: 'io.github.nattiini45/caotang', version: '1.2.3', packages: [{ registryType: 'mcpb', identifier: id, fileSha256, transport: { type: 'stdio' } }] });
    const sums = `${'b'.repeat(64)}  caotang.mjs\n${hash}  caotang-mcp-1.2.3.mcpb\n`;

    function run(sumsText: string, server: string): { status: number | null; stderr: string; stamped: string | undefined } {
      const dir = mkdtempSync(join(tmpdir(), 'caotang-stamp-'));
      try {
        writeFileSync(join(dir, 'SHA256SUMS'), sumsText);
        writeFileSync(join(dir, 'server.json'), server);
        const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
          cwd: dir,
          input: script,
          encoding: 'utf8',
          env: { PATH: process.env['PATH'] ?? '', TAG: 'v1.2.3', SUMS: join(dir, 'SHA256SUMS') },
        });
        const after = JSON.parse(readFileSync(join(dir, 'server.json'), 'utf8')) as { packages: { fileSha256?: string }[] };
        return { status: result.status, stderr: result.stderr, stamped: after.packages[0]?.fileSha256 };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('is a script that the workflow carries inline', () => {
      expect(script).toContain("import { readFileSync, writeFileSync } from 'node:fs';");
    });

    it('replaces the placeholder with the hash of the .mcpb line', () => {
      const result = run(sums, serverJson(zero));
      expect(result.status).toBe(0);
      expect(result.stamped).toBe(hash);
    });

    it('accepts a committed hash that equals the release, and a binary-mode line', () => {
      expect(run(sums, serverJson(hash)).status).toBe(0);
      expect(run(`${hash} *caotang-mcp-1.2.3.mcpb\n`, serverJson(zero)).stamped).toBe(hash);
    });

    it('stops when the committed hash is a different non-zero hash, and leaves server.json as it was', () => {
      const other = 'c'.repeat(64);
      const result = run(sums, serverJson(other));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('disagree');
      expect(result.stamped).toBe(other);
    });

    it('stops when SHA256SUMS has no line for the .mcpb of this tag, or two', () => {
      expect(run(`${'b'.repeat(64)}  caotang.mjs\n`, serverJson(zero)).status).toBe(1);
      expect(run(`${hash}  caotang-mcp-1.2.4.mcpb\n`, serverJson(zero)).status).toBe(1);
      expect(run(`${sums}${hash}  caotang-mcp-1.2.3.mcpb\n`, serverJson(zero)).status).toBe(1);
    });

    it('stops when SHA256SUMS gives the placeholder, or server.json names another file', () => {
      expect(run(`${zero}  caotang-mcp-1.2.3.mcpb\n`, serverJson(zero)).status).toBe(1);
      expect(run(sums, serverJson(zero, 'https://example.com/other.mcpb')).status).toBe(1);
    });
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
