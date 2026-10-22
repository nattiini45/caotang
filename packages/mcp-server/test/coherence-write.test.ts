/**
 * With `--allow-writes` the server saves `coherence.json`: `coherence.scan` appends its run, and `coherence.setFindingStatus` keeps
 * `fixed`, so both survive a restart (extensibility.md §9, coherence.md §7 tool 15). The file is shared with the app, so a change the app
 * made meanwhile is merged and never replaced, and a file that cannot be merged is refused by name.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { serializeCoherenceFile, type CoherenceFile } from '@caotang/coherence';
import type { Client } from '@modelcontextprotocol/client';

import { mergeServerDelta } from '../src/coherence-file.js';
import {
  LANDING,
  coherenceOnDisk,
  connectClient,
  folderBytes,
  removeDir,
  resultJson,
  saveAppFindings,
  seedCodexEntry,
  seedProject,
  startOver,
  tempDir,
  UNNAMED_CHARACTER,
  type Fixture,
} from './support.js';

const FILE = 'coherence.json';

const roots: string[] = [];
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
  for (const root of roots.splice(0)) removeDir(root);
});

/** A project whose one codex entry no document names, with the findings the app saved for it. */
async function folderWithAppFindings(label: string): Promise<{ root: string; app: CoherenceFile }> {
  const root = tempDir(label);
  roots.push(root);
  await seedProject(root, 'The Lighthouse Keeper');
  await seedCodexEntry(root);
  return { root, app: await saveAppFindings(root) };
}

interface Running {
  readonly fixture: Fixture;
  readonly client: Client;
  readonly said: string[];
}

async function run(root: string, allowWrites: boolean): Promise<Running> {
  const said: string[] = [];
  const fixture = await startOver(root, allowWrites, (line) => said.push(line));
  fixtures.push(fixture);
  return { fixture, client: await connectClient(fixture.url, fixture.token), said };
}

async function scan(client: Client): Promise<void> {
  const result = await client.callTool({ name: 'coherence.scan', arguments: {} });
  expect(result.isError).not.toBe(true);
}

/** The app's write to the folder: the file replaced by one with `change` applied, as a save from the app does. */
function appWrites(root: string, change: (file: CoherenceFile) => void): void {
  const file = structuredClone(coherenceOnDisk(root));
  change(file);
  writeFileSync(join(root, FILE), serializeCoherenceFile(file));
}

describe('with writes allowed, the server saves coherence.json', () => {
  it('appends the scan’s run, and the run is there after a restart', async () => {
    const { root, app } = await folderWithAppFindings('cw-scan');
    const first = await run(root, true);
    await scan(first.client);
    await first.client.close();
    await first.fixture.stop();

    const saved = coherenceOnDisk(root);
    expect(saved.runs).toHaveLength(app.runs.length + 1);
    expect(saved.findings.map((finding) => finding.id).sort()).toEqual(app.findings.map((finding) => finding.id).sort());

    const second = await run(root, true);
    expect(second.fixture.session.state.coherence?.runs).toHaveLength(app.runs.length + 1);
    await second.client.close();
  });

  it('keeps fixed after setFindingStatus, through a restart, and leaves a snapshot of the file it replaced', async () => {
    const { root, app } = await folderWithAppFindings('cw-fixed');
    const target = app.findings.find((finding) => finding.checkId === 'codex.never-mentioned');
    if (target === undefined) throw new Error('the fixture produced no codex finding');

    const first = await run(root, true);
    // The scene now names the character, so the finding's evidence is gone and the agent may mark it fixed.
    const landing = first.fixture.session.state.documents.get(LANDING);
    if (landing === undefined) throw new Error('the fixture has no scene');
    landing.body = `${UNNAMED_CHARACTER} waved from the pier.`;
    const result = await first.client.callTool({ name: 'coherence.setFindingStatus', arguments: { findingId: target.id, status: 'fixed', note: 'Named in the landing.' } });
    expect(result.isError).not.toBe(true);
    expect(resultJson(result)).toMatchObject({ data: { status: 'fixed' } });
    await first.client.close();
    await first.fixture.stop();

    const saved = coherenceOnDisk(root).findings.find((finding) => finding.id === target.id);
    expect(saved?.status).toBe('fixed');
    expect(saved?.note).toBe('Named in the landing.');
    expect(readdirSync(root)).toContain('coherence.json.bak.1');

    const second = await run(root, true);
    expect(second.fixture.session.state.coherence?.findings.find((finding) => finding.id === target.id)?.status).toBe('fixed');
    await second.client.close();
  });

  it('writes nothing else: the manuscript, codex and manifest bytes are those the scan found', async () => {
    const { root } = await folderWithAppFindings('cw-only');
    const before = folderBytes(root);
    const running = await run(root, true);
    await scan(running.client);
    await running.client.close();
    await running.fixture.stop();

    const after = folderBytes(root);
    const changed = Object.keys(after).filter((name) => after[name] !== before[name]);
    expect(changed.filter((name) => !name.startsWith(FILE))).toEqual([]);
    expect(changed).toContain(FILE);
  });
});

describe('a server started without --allow-writes writes nothing to coherence.json', () => {
  it('does not list the status tool, and its scan leaves the folder as it was', async () => {
    const { root } = await folderWithAppFindings('cw-readonly');
    const before = folderBytes(root);
    const running = await run(root, false);
    await scan(running.client);
    const tools = (await running.client.listTools()).tools.map((tool) => tool.name);
    expect(tools).not.toContain('coherence.setFindingStatus');
    await running.client.close();
    await running.fixture.stop();
    expect(folderBytes(root)).toEqual(before);
  });
});

describe('a coherence.json the app changed meanwhile is merged, never replaced', () => {
  it('keeps a dismissal the app made after the server opened, and still saves the scan', async () => {
    const { root, app } = await folderWithAppFindings('cw-dismissal');
    const target = app.findings[0];
    if (target === undefined) throw new Error('the fixture produced no finding');

    const running = await run(root, true);
    appWrites(root, (file) => {
      const finding = file.findings.find((candidate) => candidate.id === target.id);
      if (finding === undefined) throw new Error('the finding is not on disk');
      finding.status = 'dismissed';
      finding.dismissedReason = 'intentional';
    });
    await scan(running.client);
    await running.client.close();

    const saved = coherenceOnDisk(root);
    expect(saved.findings.find((finding) => finding.id === target.id)).toMatchObject({ status: 'dismissed', dismissedReason: 'intentional' });
    expect(saved.runs).toHaveLength(app.runs.length + 1);
    // The merged file is what the server holds from then on, so a later scan sees the dismissal.
    expect(running.fixture.session.state.coherence?.findings.find((finding) => finding.id === target.id)?.status).toBe('dismissed');
    expect(running.said).toEqual([]);
  });

  it('keeps the scene declarations the app saved in between', async () => {
    const { root } = await folderWithAppFindings('cw-scene-meta');
    const running = await run(root, true);
    appWrites(root, (file) => {
      file.sceneMeta[LANDING] = { dayOffset: 4 };
    });
    await scan(running.client);
    await running.client.close();
    expect(coherenceOnDisk(root).sceneMeta[LANDING]).toEqual({ dayOffset: 4 });
  });

  it('does not let a changed coherence.json stop a manuscript write', async () => {
    const { root } = await folderWithAppFindings('cw-drift');
    const running = await run(root, true);
    appWrites(root, (file) => {
      file.sceneMeta[LANDING] = { dayOffset: 1 };
    });
    const result = await running.client.callTool({ name: 'synopsis.set', arguments: { doc: LANDING, synopsis: 'Elena returns by ferry.' } });
    expect(result.isError).not.toBe(true);
    await running.client.close();
  });
});

describe('a coherence.json that cannot be merged is refused by name, and never replaced', () => {
  it('stops at a file that a newer Caotang wrote meanwhile', async () => {
    const { root } = await folderWithAppFindings('cw-newer');
    const running = await run(root, true);
    const newer = JSON.stringify({ formatVersion: 99, findings: [] });
    writeFileSync(join(root, FILE), newer);

    await scan(running.client);
    expect(readFileSync(join(root, FILE), 'utf8')).toBe(newer);
    expect(running.said.some((line) => line.includes(FILE) && line.includes('newer Caotang'))).toBe(true);
    expect(running.fixture.session.notices.some((notice) => notice.path === FILE && notice.message.includes('Nothing was written'))).toBe(true);
    await running.client.close();
  });

  it('stops at a file that cannot be read meanwhile, says so once, and keeps the bytes', async () => {
    const { root } = await folderWithAppFindings('cw-unreadable');
    const running = await run(root, true);
    const damaged = '{"formatVersion": 1, "findings": [';
    writeFileSync(join(root, FILE), damaged);

    await scan(running.client);
    // Writes to the file are stopped until restart, so a second scan neither writes nor says it again.
    await scan(running.client);
    expect(readFileSync(join(root, FILE), 'utf8')).toBe(damaged);
    expect(readdirSync(root).some((name) => name.includes('.corrupt-'))).toBe(false);
    expect(running.said).toHaveLength(1);
    expect(running.said[0]).toContain(FILE);
    expect(running.fixture.session.notices.filter((notice) => notice.path === FILE && notice.message.includes('stopped'))).toHaveLength(1);
    await running.client.close();
  });

  it('never overwrites a file from a newer Caotang that was there at open, even with writes on', async () => {
    const { root } = await folderWithAppFindings('cw-newer-open');
    const newer = JSON.stringify({ formatVersion: 99, findings: [] });
    writeFileSync(join(root, FILE), newer);

    const running = await run(root, true);
    await scan(running.client);
    await running.client.close();
    await running.fixture.stop();
    expect(readFileSync(join(root, FILE), 'utf8')).toBe(newer);
  });
});

describe('mergeServerDelta', () => {
  const finding = (id: string, status: 'open' | 'fixed' | 'dismissed', extra: Partial<CoherenceFile['findings'][number]> = {}): CoherenceFile['findings'][number] => ({
    id,
    runId: 'r_AAAAAAAAAA',
    class: 'deterministic',
    checkId: 'codex.never-mentioned',
    type: 'never-mentioned',
    severity: 'info',
    status,
    factGroup: id,
    evidence: [],
    createdAt: '2026-10-08T09:00:00.000Z',
    updatedAt: '2026-10-08T09:00:00.000Z',
    message: id,
    ...extra,
  });
  const file = (findings: CoherenceFile['findings'], runIds: string[] = []): CoherenceFile => ({
    formatVersion: 1,
    findings,
    runs: runIds.map((id) => ({ id, at: '2026-10-08T09:00:00.000Z', kind: 'deterministic', checkIds: [], scope: { docIds: [] }, findingsUpserted: [], status: 'complete' })),
    sceneMeta: {},
    worldRules: [],
    knowledge: [],
    reviewState: {},
  });

  it('never reopens a finding, never changes a disk-side dismissal, and moves open to fixed only where the disk still has it open', () => {
    const base = file([finding('f_AAAAAAAAA1', 'open'), finding('f_AAAAAAAAA2', 'open'), finding('f_AAAAAAAAA3', 'open')]);
    const mine = file([
      finding('f_AAAAAAAAA1', 'fixed', { note: 'Done.', updatedAt: '2026-10-09T09:00:00.000Z' }),
      finding('f_AAAAAAAAA2', 'fixed'),
      finding('f_AAAAAAAAA3', 'open'),
    ]);
    const disk = file([finding('f_AAAAAAAAA1', 'open'), finding('f_AAAAAAAAA2', 'dismissed'), finding('f_AAAAAAAAA3', 'fixed')]);

    const merged = mergeServerDelta(disk, base, mine);
    const status = (id: string): string | undefined => merged.findings.find((candidate) => candidate.id === id)?.status;
    expect(status('f_AAAAAAAAA1')).toBe('fixed');
    expect(merged.findings.find((candidate) => candidate.id === 'f_AAAAAAAAA1')).toMatchObject({ note: 'Done.', updatedAt: '2026-10-09T09:00:00.000Z' });
    expect(status('f_AAAAAAAAA2')).toBe('dismissed');
    expect(status('f_AAAAAAAAA3')).toBe('fixed');
  });

  it('adds the findings and runs the server made, once, and does not bring back what the disk copy dropped', () => {
    const base = file([finding('f_AAAAAAAAA1', 'open')], ['r_AAAAAAAAA1']);
    const mine = file([finding('f_AAAAAAAAA1', 'open'), finding('f_AAAAAAAAA4', 'open')], ['r_AAAAAAAAA1', 'r_AAAAAAAAA2']);
    const disk = file([], ['r_AAAAAAAAA1', 'r_AAAAAAAAA3']);

    const merged = mergeServerDelta(disk, base, mine);
    expect(merged.findings.map((candidate) => candidate.id)).toEqual(['f_AAAAAAAAA4']);
    expect(merged.runs.map((candidate) => candidate.id)).toEqual(['r_AAAAAAAAA1', 'r_AAAAAAAAA3', 'r_AAAAAAAAA2']);
    expect(mergeServerDelta(merged, base, mine)).toEqual(merged);
  });
});
