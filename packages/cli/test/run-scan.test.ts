/**
 * `caotang scan` in process, over a copy of the committed fixture project (test/fixtures/continuity-project: one open error, an
 * Ink file with one note). The built bundle is run as a process in binary.test.ts.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dismissFinding, loadCoherence, saveCoherence } from '@caotang/coherence';
import { LOCK_FILE, NodeArtifactFs, acquireProjectLock } from '@caotang/sdk/folder';
import { loadInkCompiler } from '@caotang/mcp-server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from '../src/cli.js';
import { runScanCommand } from '../src/run-scan.js';
import { capture, folderBytes, removeDir, tempDir } from './support.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/continuity-project', import.meta.url));
const ERROR_LINE = '::error file=docs/n_7K2QX9M4A1.md,line=10,endLine=11,title=presence.expected::"Elena" is expected in "The Harbour" but is never named there';
const NOTE_LINE = '::notice file=docs/n_AQ5T03R7D4.ink,line=1,endLine=1,title=branch.dead-end::"start" is never diverted to, so no path in the story reaches it.';

const BAD_BYTES = [0xff, 0xfe, 0xfa, 0x20, 0x62, 0x61, 0x64];

let root = '';
beforeAll(async () => {
  // The dialogue checks compile Ink synchronously; `main` loads the compiler before it opens a project.
  await loadInkCompiler();
});
beforeEach(() => {
  root = tempDir('scan');
  cpSync(FIXTURE, root, { recursive: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  removeDir(root);
});

async function scan(args: readonly string[], env: NodeJS.ProcessEnv = {}, cwd?: string) {
  const io = capture({ env, ...(cwd === undefined ? {} : { cwd }) });
  const code = await runScanCommand(['--project', root, ...args], io);
  return { code, out: io.out.join(''), err: io.err.join('') };
}

describe('caotang scan, read-only', () => {
  it('runs with no provider and no network, exits 7 on the open error, and leaves the folder byte-identical', async () => {
    const fetch = vi.fn(() => {
      throw new Error('the scan reached for the network');
    });
    vi.stubGlobal('fetch', fetch);
    const before = folderBytes(root);
    const ran = await scan(['--format', 'github']);
    expect(ran.code).toBe(7);
    expect(ran.out).toBe(`${ERROR_LINE}\n${NOTE_LINE}\n`);
    expect(fetch).not.toHaveBeenCalled();
    expect(folderBytes(root)).toEqual(before);
    expect(existsSync(join(root, LOCK_FILE))).toBe(false);
  });

  it('runs the dialogue checks, so the scan is complete', async () => {
    const ran = await scan(['--format', 'json']);
    const result = JSON.parse(ran.out) as { status: string; checks: string[]; exitCode: number };
    expect(result.status).toBe('complete');
    expect(result.checks).toContain('branch.dead-end');
    expect(result.exitCode).toBe(7);
    expect(ran.err).toBe('');
  });

  it('prints text by default, one line per finding and a summary', async () => {
    const ran = await scan([]);
    expect(ran.out).toContain('docs/n_7K2QX9M4A1.md:10: error presence.expected');
    expect(ran.out).toContain('2 open findings (1 error, 0 warnings, 1 note) in 4 documents.');
  });

  it('exits 0 for --fail-on never, and 7 at the threshold that is met and 0 at the one that is not', async () => {
    expect((await scan(['--fail-on', 'never'])).code).toBe(0);
    // The one note: below error, at info.
    expect((await scan(['--checks', 'branch.dead-end'])).code).toBe(0);
    expect((await scan(['--checks', 'branch.dead-end', '--fail-on', 'warning'])).code).toBe(0);
    expect((await scan(['--checks', 'branch.dead-end', '--fail-on', 'info'])).code).toBe(7);
  });

  it('writes the same Markdown as the markdown format to --summary, and appends to $GITHUB_STEP_SUMMARY', async () => {
    const file = `${root}-summary.md`;
    try {
      const first = await scan(['--format', 'markdown', '--summary', file]);
      expect(first.out).toContain('# Coherence report');
      expect(readFileSync(file, 'utf8')).toBe(first.out);

      writeFileSync(file, 'earlier step\n');
      const second = await scan(['--format', 'github', '--summary', file], { GITHUB_STEP_SUMMARY: file });
      expect(readFileSync(file, 'utf8')).toMatch(/^earlier step\n# Coherence report/);
      expect(second.out).toContain('::error');
    } finally {
      removeDir(file);
    }
  });

  it('refuses a --summary inside the folder without --write, before it scans, and changes nothing', async () => {
    const before = folderBytes(root);
    for (const target of ['report.md', 'caotang.json', 'docs/new.md', '.', './report.md']) {
      const ran = await scan(['--summary', target], {}, root);
      expect(ran.code).toBe(2);
      expect(ran.out).toBe('');
      expect(ran.err).toContain('--summary must not write inside the project folder without --write');
    }
    expect(folderBytes(root)).toEqual(before);
    expect(existsSync(join(root, 'report.md'))).toBe(false);
  });

  it('writes a --summary beside the folder, named relative to the working directory, without --write', async () => {
    const before = folderBytes(root);
    const beside = `${root}-beside.md`;
    try {
      const ran = await scan(['--summary', `../${basename(beside)}`], {}, root);
      expect(ran.code).toBe(7);
      expect(readFileSync(beside, 'utf8')).toContain('# Coherence report');
    } finally {
      removeDir(beside);
    }
    expect(folderBytes(root)).toEqual(before);
  });

  it('keeps the exit code and the notes when the --summary file cannot be written, and says so', async () => {
    writeFileSync(join(root, 'docs', 'n_7K2QX9M4A1.md'), Buffer.from(BAD_BYTES));
    const missing = join(`${root}-nowhere`, 'report.md');
    const ran = await scan(['--format', 'json', '--summary', missing]);
    expect(ran.code).toBe(8);
    expect(ran.err).toContain('were not checked');
    expect(ran.err).toContain('could not write the summary to');
    expect(() => JSON.parse(ran.out)).not.toThrow();
  });

  it('exits 1 when the --summary of an otherwise clean scan cannot be written', async () => {
    const ran = await scan(['--fail-on', 'never', '--summary', join(`${root}-nowhere`, 'report.md')]);
    expect(ran.code).toBe(1);
    expect(ran.err).toContain('could not write the summary to');
  });

  it('neither prints nor fails on a finding the writer dismissed in the committed coherence.json', async () => {
    expect((await scan(['--write'])).code).toBe(7);
    const fs = new NodeArtifactFs(root);
    const load = await loadCoherence(fs, { readOnly: true });
    const open = load.file.findings.find((finding) => finding.checkId === 'presence.expected');
    expect(open?.status).toBe('open');
    await saveCoherence(fs, load, dismissFinding(load.file, open?.id ?? '', { reason: 'intentional' }, new Date()), { now: new Date() });

    const before = folderBytes(root);
    const ran = await scan(['--format', 'github']);
    expect(ran.code).toBe(0);
    expect(ran.out).toBe(`${NOTE_LINE}\n`);
    expect(folderBytes(root)).toEqual(before);
  });

  it('says a coherence.json it cannot read lost its dismissals, and does not touch it', async () => {
    writeFileSync(join(root, 'coherence.json'), '{ not json');
    const before = folderBytes(root);
    const ran = await scan(['--format', 'json']);
    const result = JSON.parse(ran.out) as { notices: string[] };
    // The scene declarations were in the file, so the error they made is gone with them; the notice says why.
    expect(ran.code).toBe(0);
    expect(result.notices.join(' ')).toContain('Dismissal decisions are lost');
    expect(folderBytes(root)).toEqual(before);
  });

  it('exits 8 and says so when a document is not UTF-8, instead of reporting a clean scan', async () => {
    writeFileSync(join(root, 'docs', 'n_7K2QX9M4A1.md'), Buffer.from([0xff, 0xfe, 0xfa, 0x20, 0x62, 0x61, 0x64]));
    const ran = await scan(['--format', 'json', '--fail-on', 'warning']);
    const result = JSON.parse(ran.out) as { status: string; unread: string[]; exitCode: number; notices: string[] };
    expect(result.status).toBe('partial');
    expect(result.unread).toEqual(['docs/n_7K2QX9M4A1.md']);
    expect(result.notices.join(' ')).toContain('not UTF-8');
    expect(ran.code).toBe(8);
    expect(ran.code).toBe(result.exitCode);
    expect(ran.err).toContain('were not checked');
  });

  it('names the unread file without blaming a check when every check ran', async () => {
    writeFileSync(join(root, 'docs', 'n_7K2QX9M4A1.md'), Buffer.from(BAD_BYTES));
    const ran = await scan(['--format', 'json']);
    expect(ran.code).toBe(8);
    expect(ran.err).toContain('1 file(s) are not UTF-8 text and were not checked: docs/n_7K2QX9M4A1.md');
    expect(ran.err).toContain('this was a partial scan');
    expect(ran.err).not.toContain('did not run');
  });

  it('exits 8 for a codex file that is not UTF-8 and is not in the manifest, and names it', async () => {
    writeFileSync(join(root, 'codex', 'c_ZZZZZZZZZZ.md'), Buffer.from(BAD_BYTES));
    const ran = await scan(['--format', 'json', '--checks', 'codex.alias-collisions']);
    const result = JSON.parse(ran.out) as { status: string; unread: string[] };
    expect(result.unread).toEqual(['codex/c_ZZZZZZZZZZ.md']);
    expect(result.status).toBe('partial');
    expect(ran.code).toBe(8);
    expect(ran.err).toContain('were not checked');
  });

  it('does not count an agent file that is not UTF-8 as unread', async () => {
    writeFileSync(join(root, 'CAOTANG.md'), Buffer.from(BAD_BYTES));
    const ran = await scan(['--format', 'json', '--checks', 'codex.alias-collisions']);
    const result = JSON.parse(ran.out) as { status: string; unread: string[] };
    expect(result.unread).toEqual([]);
    expect(result.status).toBe('complete');
    expect(ran.code).toBe(0);
  });

  it('is not stopped by a lock another writer holds, because it writes nothing', async () => {
    const lock = await acquireProjectLock(root);
    try {
      expect((await scan(['--fail-on', 'never'])).code).toBe(0);
    } finally {
      await lock.release();
    }
  });
});

describe('caotang scan --write', () => {
  it('saves coherence.json with the run in it, under the lock, and releases the lock', async () => {
    const ran = await scan(['--write', '--format', 'json']);
    expect(ran.code).toBe(7);
    expect(ran.err).toContain('coherence.json was saved');
    expect(existsSync(join(root, LOCK_FILE))).toBe(false);
    const saved = JSON.parse(readFileSync(join(root, 'coherence.json'), 'utf8')) as { runs: unknown[]; findings: unknown[] };
    expect(saved.runs).toHaveLength(1);
    expect(saved.findings.length).toBeGreaterThan(0);
  });

  it('writes a --summary inside the folder when --write is given', async () => {
    const ran = await scan(['--write', '--summary', 'report.md'], {}, root);
    expect(ran.code).toBe(7);
    expect(readFileSync(join(root, 'report.md'), 'utf8')).toContain('# Coherence report');
  });

  it('exits 3 and changes nothing when another writer holds the folder', async () => {
    const lock = await acquireProjectLock(root);
    try {
      const before = folderBytes(root);
      const ran = await scan(['--write']);
      expect(ran.code).toBe(3);
      expect(ran.out).toBe('');
      expect(ran.err).toContain('in use by another writer');
      expect(folderBytes(root)).toEqual(before);
    } finally {
      await lock.release();
    }
  });
});

describe('caotang scan, refusals', () => {
  it('exits 2 with the usage on stderr and nothing on stdout for a bad flag', async () => {
    const ran = await scan(['--fail-on', 'fatal']);
    expect(ran.code).toBe(2);
    expect(ran.out).toBe('');
    expect(ran.err).toContain('--fail-on must be one of');
    expect(ran.err).toContain('usage: caotang scan');
  });

  it('exits 2 for a folder that holds no project, and for one that does not exist', async () => {
    const empty = tempDir('scan-empty');
    try {
      for (const folder of [empty, join(empty, 'missing')]) {
        const io = capture();
        expect(await runScanCommand(['--project', folder], io)).toBe(2);
        expect(io.out).toEqual([]);
        expect(io.err.join('')).toContain('no Caotang project');
      }
    } finally {
      removeDir(empty);
    }
  });

  it('says the folder could not be opened, with the cause, for one that does not exist', async () => {
    const io = capture();
    expect(await runScanCommand(['--project', join(root, 'missing')], io)).toBe(2);
    expect(io.err.join('')).toMatch(/the folder could not be opened \(.*ENOENT/);
  });

  it('says there is no caotang.json in an existing folder that holds none', async () => {
    const empty = tempDir('scan-empty');
    try {
      const io = capture();
      expect(await runScanCommand(['--project', empty], io)).toBe(2);
      expect(io.err.join('')).toContain('there is no caotang.json in it');
    } finally {
      removeDir(empty);
    }
  });

  it('names the cause when caotang.json is there but cannot be read, and does not say it is missing', async () => {
    rmSync(join(root, 'caotang.json'));
    mkdirSync(join(root, 'caotang.json'));
    const io = capture();
    expect(await runScanCommand(['--project', root], io)).toBe(2);
    expect(io.out).toEqual([]);
    expect(io.err.join('')).toContain('no Caotang project at');
    expect(io.err.join('')).toContain('caotang.json could not be read (');
    expect(io.err.join('')).not.toContain('there is no caotang.json');
  });

  it('prints the usage for --help and exits 0', async () => {
    const io = capture();
    expect(await runScanCommand(['--help'], io)).toBe(0);
    expect(io.out.join('')).toContain('usage: caotang scan');
  });
});

describe('caotang scan as a function', () => {
  it('loads the Ink compiler itself, so a host that calls it directly gets the dialogue checks', async () => {
    vi.resetModules();
    const fresh = await import('../src/run-scan.js');
    const io = capture({ env: {} });
    const code = await fresh.runScanCommand(['--project', root, '--format', 'json'], io);
    expect(io.err.join('')).not.toContain('Ink compiler is not loaded');
    expect(code).toBe(7);
    expect((JSON.parse(io.out.join('')) as { checks: string[] }).checks).toContain('branch.dead-end');
  });
});

describe('caotang scan through the router', () => {
  it('is reached by the word scan, and listed in the usage', async () => {
    const io = { ...capture(), untilDone: () => Promise.resolve() };
    expect(await main(['scan', '--project', root, '--format', 'github'], io)).toBe(7);
    expect(io.out.join('')).toBe(`${ERROR_LINE}\n${NOTE_LINE}\n`);

    const usage = capture();
    await main([], { ...usage, untilDone: () => Promise.resolve() });
    expect(usage.out.join('')).toContain('caotang scan');
  });
});
