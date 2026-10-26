/**
 * The built binary, run as a process: `dist/caotang.mjs` is built here with the package's own Vite config, copied with its `fonts/` and `webp_dec.wasm`
 * to a folder that has no `node_modules` above it, and started with plain `node`. This is the artifact a script runs, so it is what
 * the suite must prove works.
 */

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { acquireProjectLock } from '@caotang/sdk/folder';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { webpFixture } from '../../exporter/test/webp-fixtures.js';

import { folderBytes, removeDir, seedProject, SHOTS_FOLDER, tempDir } from './support.js';

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(PACKAGE, 'dist');

const FONTS = [
  'NotoColorEmoji.bin',
  'NotoEmoji-Regular-common.woff',
  'NotoEmoji-Regular.woff',
  'NotoSansArabic-Regular.ttf',
  'NotoSansDevanagari-Regular.ttf',
  'NotoSansHebrew-Regular.ttf',
  'NotoSansMonoCJKsc-Regular-common.woff',
  'NotoSansMonoCJKsc-Regular.woff',
];

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the bundle at `entry` with a clean environment, and resolves when it exits. */
function run(entry: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv; stdin?: string } = {}): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      env: { PATH: process.env['PATH'] ?? '', SystemRoot: process.env['SystemRoot'] ?? '', ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(options.stdin ?? '');
  });
}

describe('the built caotang binary', () => {
  let root: string;
  /** The bundle and its fonts, copied where nothing above them holds a node_modules. */
  let entry: string;

  beforeAll(async () => {
    await build({ root: PACKAGE, configFile: join(PACKAGE, 'vite.config.ts'), logLevel: 'silent' });
    root = tempDir('binary');
    mkdirSync(join(root, 'bundle'));
    cpSync(DIST, join(root, 'bundle'), { recursive: true });
    entry = join(root, 'bundle', 'caotang.mjs');
  }, 240_000);

  afterAll(() => {
    removeDir(root);
  });

  it('is a single file with the PDFs’ fallback fonts in fonts/ and the WebP decoder beside it, and nothing else', () => {
    expect(readdirSync(DIST).sort()).toEqual(['caotang.mjs', 'fonts', 'webp_dec.wasm']);
    expect(readdirSync(join(DIST, 'fonts')).sort()).toEqual(FONTS);
    expect(statSync(join(DIST, 'caotang.mjs')).size).toBeGreaterThan(100_000);
    expect(readFileSync(join(DIST, 'caotang.mjs'), 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it('prints its usage on stdout for --help and exits 0, for the front door and for each command', async () => {
    const front = await run(entry, ['--help']);
    expect(front).toMatchObject({ code: 0, stderr: '' });
    expect(front.stdout).toContain('usage: caotang agent');
    expect((await run(entry, ['agent', '--help'])).stdout).toContain('--permission <mode>');
    // `mcp` hands the rest to the MCP server's own command line.
    const mcp = await run(entry, ['mcp', '--help']);
    expect(mcp.code).toBe(0);
    expect(mcp.stdout).toContain('usage: caotang-mcp serve');
  }, 60_000);

  it('runs the demo intent read-only: the reply on stdout, exit 0, and the folder byte-identical', async () => {
    const folder = join(root, 'demo');
    await seedProject(folder);
    const before = folderBytes(folder);
    const ran = await run(entry, ['agent', '-p', 'Check the manuscript for continuity problems.', '--mock', '--project', folder]);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toMatch(/\S/);
    expect(folderBytes(folder)).toEqual(before);
  }, 60_000);

  it('reads the intent from stdin, and with --output-format json writes one object and nothing else to stdout', async () => {
    const folder = join(root, 'stdin');
    await seedProject(folder);
    const ran = await run(entry, ['agent', '-p', '-', '--mock', '--project', folder, '--output-format', 'json'], { stdin: 'Check the manuscript for continuity problems.\n' });
    expect(ran.code).toBe(0);
    expect(ran.stdout.endsWith('\n')).toBe(true);
    expect(ran.stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(ran.stdout)).toMatchObject({ type: 'result', version: 1, exitCode: 0, written: false, permission: 'read-only' });
  }, 60_000);

  it('exits 4 when read-only meets a card, 2 for a usage error with the usage on stderr, and 3 for a folder another writer holds', async () => {
    const folder = join(root, 'codes');
    await seedProject(folder);
    const before = folderBytes(folder);
    const card = await run(entry, ['agent', '-p', 'Draft the opening scene of The Friend.', '--mock', '--project', folder, '--output-format', 'stream-json']);
    expect(card.code).toBe(4);
    const lines = card.stdout.trimEnd().split('\n').map((line) => JSON.parse(line) as { type: string });
    expect(lines[0]?.type).toBe('start');
    expect(lines.some((line) => line.type === 'decision')).toBe(true);
    expect(lines[lines.length - 1]?.type).toBe('result');
    expect(folderBytes(folder)).toEqual(before);

    const usage = await run(entry, ['agent', '--mock']);
    expect(usage.code).toBe(2);
    expect(usage.stdout).toBe('');
    expect(usage.stderr).toContain('usage: caotang agent');

    const lock = await acquireProjectLock(folder);
    try {
      const locked = await run(entry, ['agent', '-p', 'Check the manuscript for continuity problems.', '--mock', '--project', folder]);
      expect(locked.code).toBe(3);
      expect(locked.stdout).toBe('');
    } finally {
      await lock.release();
    }
  }, 120_000);

  it.each([
    ['Chinese', '港口空无一人。', '/FontFile2'],
    // The contact sheet's emoji are in colour by default: the Type 3 fonts come from fonts/NotoColorEmoji.bin beside the bundle.
    ['emoji', 'Harbour 🌊 at dawn 👨‍👩‍👧 🇩🇪 1️⃣', '/Subtype /Type3'],
  ])('compiles a storyboard contact sheet with %s text, in the fallback font from fonts/ beside the bundle', async (_name, action, embedded) => {
    const folder = join(root, `sheet-${embedded.length}`);
    await seedProject(folder, action);
    const plan = join(root, `plan-${embedded.length}.json`);
    writeFileSync(
      plan,
      JSON.stringify({ steps: [{ tool: 'export.compile', params: { selection: { root: SHOTS_FOLDER, includeSubtrees: true }, format: 'contact-sheet-pdf' }, expect: 'a contact sheet in exports/' }] }),
    );
    const ran = await run(entry, ['agent', '-p', 'Compile the contact sheet.', '--mock', '--project', folder, '--plan-file', plan, '--permission', 'approve-all', '--write']);
    expect(ran.stderr).not.toContain('drawn as');
    expect(ran.code, ran.stderr).toBe(0);
    const pdf = existsSync(join(folder, 'exports')) ? readdirSync(join(folder, 'exports')).filter((name) => name.endsWith('.pdf')) : [];
    expect(pdf).toHaveLength(1);
    const bytes = readFileSync(join(folder, 'exports', pdf[0] ?? '')).toString('latin1');
    expect(bytes.startsWith('%PDF')).toBe(true);
    expect(bytes).toContain(embedded);
  }, 120_000);

  it('compiles a storyboard contact sheet with a WebP picture, decoded with the webp_dec.wasm beside the bundle', async () => {
    const folder = join(root, 'sheet-webp');
    await seedProject(folder, 'The harbour, empty.', 'a_7WEBP4K2QX');
    mkdirSync(join(folder, 'assets'), { recursive: true });
    writeFileSync(join(folder, 'assets', 'a_7WEBP4K2QX.webp'), webpFixture('lossless'));
    const plan = join(root, 'plan-webp.json');
    writeFileSync(
      plan,
      JSON.stringify({ steps: [{ tool: 'export.compile', params: { selection: { root: SHOTS_FOLDER, includeSubtrees: true }, format: 'contact-sheet-pdf' }, expect: 'a contact sheet in exports/' }] }),
    );
    const ran = await run(entry, ['agent', '-p', 'Compile the contact sheet.', '--mock', '--project', folder, '--plan-file', plan, '--permission', 'approve-all', '--write']);
    expect(ran.code, ran.stderr).toBe(0);
    const pdf = readdirSync(join(folder, 'exports')).filter((name) => name.endsWith('.pdf'));
    expect(pdf).toHaveLength(1);
    const bytes = readFileSync(join(folder, 'exports', pdf[0] ?? '')).toString('latin1');
    expect(bytes.match(/\/Subtype \/Image/g)).toHaveLength(1);
    expect(bytes).toMatch(/\/Width 80\b/);
  }, 120_000);
});
