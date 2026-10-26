/**
 * `runScan` over a project folder: no model and no network, nothing written unless asked, the writer's own verdicts in
 * `coherence.json` respected, and an honest account of what did not run.
 */

import {
  dismissFinding,
  loadCoherence,
  markFindingFixed,
  saveCoherence,
  type DialogueFacts,
  type DraftFinding,
  type FindingSeverity,
} from '@caotang/coherence';
import { coherenceReportMarkdown } from '@caotang/exporter/coherence-report';
import type { ArtifactFs } from '@caotang/store';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatMarkdown, isContainedPath, runScan } from '../src/index.js';

import { BRANCHES, HARBOUR, NOW, SCRIPT, SHORE, folderHash, seedProject } from './fixture.js';

afterEach(() => vi.unstubAllGlobals());

/** Neither prose scene names Elena, but the screenplay does, so the scan finds two open errors and nothing else. */
const TWO_ERRORS = { [SHORE]: 'Only the sea.', [SCRIPT]: 'INT. LAMP ROOM - NIGHT\n\nELENA\nThe lamp turns.' };

/** An `ArtifactFs` that reads and refuses every write, so a scan that tried to change the folder fails where it tries. */
function readOnly(fs: ArtifactFs): ArtifactFs {
  const refuse = (what: string) => (): never => {
    throw new Error(`the scan wrote to the folder: ${what}`);
  };
  return {
    read: (path) => fs.read(path),
    readBytes: (path) => fs.readBytes(path),
    listFiles: (dir) => fs.listFiles(dir),
    listDirs: (dir) => fs.listDirs(dir),
    exists: (path) => fs.exists(path),
    writeAtomic: refuse('writeAtomic'),
    writeBytesAtomic: refuse('writeBytesAtomic'),
    ensureDir: refuse('ensureDir'),
    remove: refuse('remove'),
  };
}

/** The dialogue module's facts, as `dialogueFactsOf` would hand them over, for one finding of the given severity on the Ink file's third line. */
function facts(severity: FindingSeverity, ink: string): DialogueFacts {
  const from = ink.indexOf('-> END');
  const finding: DraftFinding = {
    checkId: 'branch.loose-end',
    type: 'loose-end',
    severity,
    factGroup: 'start|loose-end',
    evidence: [{ docId: BRANCHES, quote: '-> END', from, to: from + 6 }],
    message: 'The branch "start" runs out without an ending',
  };
  return { findings: [finding], containerIds: [BRANCHES], speakersByContainer: new Map() };
}

describe('runScan', () => {
  it('runs with no provider and no network: a fetch that throws is never called', async () => {
    const fetch = vi.fn(() => {
      throw new Error('the scan reached for the network');
    });
    vi.stubGlobal('fetch', fetch);
    const { fs } = await seedProject();
    const result = await runScan(fs, { now: NOW });
    expect(fetch).not.toHaveBeenCalled();
    expect(result.counts).toEqual({ error: 1, warning: 0, info: 0 });
  });

  it('leaves every file of the folder byte-identical without write', async () => {
    const { fs } = await seedProject();
    const before = folderHash(fs);
    await runScan(fs, { now: NOW });
    await runScan(fs, { now: NOW, scope: 'changed' });
    expect(folderHash(fs)).toBe(before);
  });

  it('never calls a write on the port without write, even when coherence.json is unreadable', async () => {
    const { fs } = await seedProject();
    fs.putFile('coherence.json', '{ not json');
    const result = await runScan(readOnly(fs), { now: NOW });
    expect(result.written).toBe(false);
  });

  it('places an open error on the first line of the body, after the front matter', async () => {
    const { fs } = await seedProject();
    const result = await runScan(fs, { now: NOW });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      severity: 'error',
      checkId: 'presence.expected',
      file: `docs/${HARBOUR}.md`,
      line: 10,
      endLine: 11,
      docTitle: 'The Harbour',
    });
  });

  it('places the same finding on the same line in a CRLF folder', async () => {
    const { fs } = await seedProject({ newline: '\r\n', bodies: { [HARBOUR]: 'Gulls only.\r\nThe tide came in.' } });
    const result = await runScan(fs, { now: NOW });
    expect(result.findings[0]).toMatchObject({ file: `docs/${HARBOUR}.md`, line: 10, endLine: 11 });
  });

  it('places the finding on the same line when the file starts with a byte order mark, as the loader reads it', async () => {
    const { fs } = await seedProject();
    const path = `docs/${HARBOUR}.md`;
    fs.putFile(path, `\uFEFF${await fs.read(path)}`);
    const result = await runScan(fs, { now: NOW });
    expect(result.findings[0]).toMatchObject({ file: path, line: 10, endLine: 11 });
  });

  it('reports a finding without a place when its file is not UTF-8', async () => {
    const { fs } = await seedProject();
    await fs.writeBytesAtomic(`docs/${HARBOUR}.md`, new Uint8Array([0xff, 0xfe, 0x00]));
    const result = await runScan(fs, { now: NOW });
    expect(result.findings.filter((finding) => finding.file === `docs/${HARBOUR}.md`)).toEqual([]);
  });

  it('is partial and exits 8 when a document is not UTF-8, because that document was never checked', async () => {
    const { fs } = await seedProject({ bodies: { [HARBOUR]: 'Elena waits.' } });
    const path = `docs/${HARBOUR}.md`;
    await fs.writeBytesAtomic(path, new Uint8Array([0xff, 0xfe, 0xfa, 0x20, 0x62, 0x61, 0x64]));
    const result = await runScan(fs, { now: NOW });
    expect(result.status).toBe('partial');
    expect(result.unread).toEqual([path]);
    expect(result.notices.some((notice) => notice.includes('not UTF-8') && notice.includes('The Harbour'))).toBe(true);
    expect(result.exitCode).toBe(8);
    // The outcome is not hidden when every finding is dismissed or none is open: --fail-on never still only reports.
    expect((await runScan(fs, { now: NOW, failOn: 'never' })).exitCode).toBe(0);
  });

  it('exits 7 rather than 8 when a document is unread and a finding also fails the run', async () => {
    const { fs } = await seedProject();
    await fs.writeBytesAtomic(`docs/${SHORE}.md`, new Uint8Array([0xff, 0xfe, 0xfa]));
    const result = await runScan(fs, { now: NOW });
    expect(result.counts.error).toBeGreaterThan(0);
    expect(result.exitCode).toBe(7);
    expect(result.status).toBe('partial');
  });

  it('is complete, with no notice and an empty unread list, when every file reads', async () => {
    const { fs } = await seedProject();
    const result = await runScan(fs, { now: NOW }, { dialogueFacts: () => ({ findings: [], containerIds: [], speakersByContainer: new Map() }) });
    expect(result.unread).toEqual([]);
    expect(result.notices).toEqual([]);
    expect(result.status).toBe('complete');
  });

  it('places a screenplay finding in its .fountain file, and a legacy .md body in the .md the loader read', async () => {
    const { fs } = await seedProject({ expecting: [SCRIPT] });
    const fountain = await runScan(fs, { now: NOW });
    expect(fountain.findings[0]).toMatchObject({ file: `docs/${SCRIPT}.fountain`, line: 10 });

    const stored = await fs.read(`docs/${SCRIPT}.fountain`);
    await fs.remove(`docs/${SCRIPT}.fountain`);
    fs.putFile(`docs/${SCRIPT}.md`, stored);
    const legacy = await runScan(fs, { now: NOW });
    expect(legacy.findings[0]).toMatchObject({ file: `docs/${SCRIPT}.md`, line: 10 });
  });

  it('places a dialogue finding in its Ink file from the first line', async () => {
    const ink = '=== start ===\nHello.\n-> END\n';
    const { fs } = await seedProject({ expecting: [], bodies: { [BRANCHES]: ink } });
    const result = await runScan(fs, { now: NOW, failOn: 'warning' }, { dialogueFacts: () => facts('warning', ink) });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ severity: 'warning', checkId: 'branch.loose-end', file: `docs/${BRANCHES}.ink`, line: 3 });
    expect(result.exitCode).toBe(7);
  });

  it('exits 7 for an open error, and 0 when only warnings are open', async () => {
    const ink = '=== start ===\nHello.\n-> END\n';
    const withError = await seedProject();
    expect((await runScan(withError.fs, { now: NOW })).exitCode).toBe(7);

    const onlyWarning = await seedProject({ expecting: [], bodies: { [BRANCHES]: ink } });
    const result = await runScan(onlyWarning.fs, { now: NOW }, { dialogueFacts: () => facts('warning', ink) });
    expect(result.counts).toEqual({ error: 0, warning: 1, info: 0 });
    expect(result.exitCode).toBe(0);
    expect((await runScan(onlyWarning.fs, { now: NOW, failOn: 'warning' }, { dialogueFacts: () => facts('warning', ink) })).exitCode).toBe(7);
  });

  it('exits 0 for --fail-on never, whatever is open', async () => {
    const { fs } = await seedProject();
    const result = await runScan(fs, { now: NOW, failOn: 'never' });
    expect(result.counts.error).toBe(1);
    expect(result.exitCode).toBe(0);
  });

  it('neither prints nor fails on a finding the writer dismissed or marked fixed', async () => {
    const { fs } = await seedProject({ bodies: TWO_ERRORS });
    await runScan(fs, { now: NOW, write: true });

    const load = await loadCoherence(fs, { readOnly: true });
    const [harbour, shore] = load.file.findings;
    expect(load.file.findings.filter((finding) => finding.status === 'open')).toHaveLength(2);
    const dismissed = dismissFinding(load.file, harbour?.id ?? '', { reason: 'intentional' }, NOW);
    const both = markFindingFixed(dismissed, shore?.id ?? '', undefined, NOW);
    await saveCoherence(fs, load, both, { now: NOW });

    const before = folderHash(fs);
    const result = await runScan(fs, { now: new Date('2026-10-21T09:00:00.000Z') });
    expect(result.findings).toEqual([]);
    expect(result.counts).toEqual({ error: 0, warning: 0, info: 0 });
    expect(result.exitCode).toBe(0);
    expect(folderHash(fs)).toBe(before);
    // The record still holds them, with their verdicts, for the report.
    expect(result.file.findings.map((finding) => finding.status).sort()).toEqual(['dismissed', 'fixed']);
  });

  it('recomputes when coherence.json is corrupt and says the dismissals are lost, without repairing the file', async () => {
    const { fs } = await seedProject();
    fs.putFile('coherence.json', '{ "formatVersion": 1, "findings": [');
    const before = folderHash(fs);
    const result = await runScan(fs, { now: NOW });
    // The scene declarations lived in the unreadable file too, so nothing is expected anywhere; the checks still ran.
    expect(result.checks).toContain('presence.expected');
    expect(result.file.runs).toHaveLength(1);
    expect(result.notices.some((notice) => notice.includes('could not be read') && notice.includes('Dismissal decisions are lost'))).toBe(true);
    expect(folderHash(fs)).toBe(before);
  });

  it('says so when coherence.json comes from a newer Caotang, and refuses to write over it', async () => {
    const { fs } = await seedProject();
    fs.putFile('coherence.json', JSON.stringify({ formatVersion: 99, findings: [] }));
    const result = await runScan(fs, { now: NOW });
    expect(result.notices.some((notice) => notice.includes('newer Caotang'))).toBe(true);
    await expect(runScan(fs, { now: NOW, write: true })).rejects.toThrow(/newer Caotang/);
    expect(await fs.read('coherence.json')).toBe(JSON.stringify({ formatVersion: 99, findings: [] }));
  });

  it('is partial, and says the dialogue checks did not run, when no dialogue facts are supplied', async () => {
    const { fs } = await seedProject();
    const result = await runScan(fs, { now: NOW });
    expect(result.status).toBe('partial');
    expect(result.skipped).toEqual(expect.arrayContaining(['branch.loose-end', 'branch.dead-end', 'dialogue.speaker-unknown', 'medium.speaker-parity']));
    expect(result.notes.some((note) => note.startsWith('dialogue checks not run'))).toBe(true);
  });

  it('is complete when the dialogue facts are supplied and every check ran', async () => {
    const ink = '=== start ===\nHello.\n-> END\n';
    const { fs } = await seedProject({ bodies: { [BRANCHES]: ink } });
    const result = await runScan(fs, { now: NOW }, { dialogueFacts: () => ({ findings: [], containerIds: [BRANCHES], speakersByContainer: new Map() }) });
    expect(result.status).toBe('complete');
    expect(result.skipped).toEqual([]);
  });

  it('is complete for a run of named checks that all ran, and runs only those', async () => {
    const { fs } = await seedProject();
    const result = await runScan(fs, { now: NOW, checks: ['presence.expected'] });
    expect(result.status).toBe('complete');
    expect(result.checks).toEqual(['presence.expected']);
  });

  it('keeps reporting the same documents for the changed scope while nothing is written', async () => {
    const { fs } = await seedProject();
    const first = await runScan(fs, { now: NOW, scope: 'changed' });
    const second = await runScan(fs, { now: new Date('2026-10-21T09:00:00.000Z'), scope: 'changed' });
    expect(first.documents).toBeGreaterThan(0);
    expect(second.documents).toBe(first.documents);
  });

  it('saves coherence.json with the run in it only with write, and the next scan reads it', async () => {
    const { fs } = await seedProject({ bodies: TWO_ERRORS });
    const written = await runScan(fs, { now: NOW, write: true });
    expect(written.written).toBe(true);
    const load = await loadCoherence(fs, { readOnly: true });
    expect(load.file.runs).toHaveLength(1);
    expect(load.file.findings.filter((finding) => finding.status === 'open')).toHaveLength(2);
    expect(await fs.exists('coherence.json.bak.1')).toBe(true);

    const before = folderHash(fs);
    const again = await runScan(fs, { now: new Date('2026-10-21T09:00:00.000Z') });
    expect(again.written).toBe(false);
    expect(again.findings.map((finding) => finding.id).sort()).toEqual(written.findings.map((finding) => finding.id).sort());
    expect(folderHash(fs)).toBe(before);
  });

  it('writes the exporter’s Markdown report for the file after the run, unchanged', async () => {
    const { fs } = await seedProject();
    const result = await runScan(fs, { now: NOW });
    expect(formatMarkdown(result)).toBe(coherenceReportMarkdown(result.report));
    expect(result.report).toMatchObject({ title: 'The Lighthouse Keeper', date: '2026-10-20' });
    expect(result.report.docTitle(SHORE)).toBe('The Shore');
    expect(result.report.docTitle('n_ZZZZZZZZZZ')).toBe('(a document that is no longer in the project)');
  });
});

describe('isContainedPath', () => {
  it.each(['docs/n_7K2QX9M4A1.md', 'docs/n_AQ5T03R7D4.ink'])('keeps %s', (path) => {
    expect(isContainedPath(path)).toBe(true);
  });

  it.each(['', '/etc/passwd', 'docs/../../etc/passwd', '../x.md', 'C:/Windows/x.md', 'docs\\..\\x.md', 'docs//x.md', 'docs/x\0.md'])('refuses %j', (path) => {
    expect(isContainedPath(path)).toBe(false);
  });
});
