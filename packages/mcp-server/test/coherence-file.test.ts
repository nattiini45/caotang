/**
 * The server and the app share one set of findings (extensibility.md §9, coherence.md §7 tool 15). The server reads `coherence.json`
 * when it opens the project, on either posture: its scan upserts against the findings the app saved, and a server that was started
 * read-only never writes the file, not even to repair it.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { coherenceSnapshotFile, type CoherenceFile } from '@caotang/coherence';

import { startupLines } from '../src/cli.js';
import {
  connectClient,
  folderBytes,
  removeDir,
  saveAppFindings,
  seedCodexEntry,
  seedProject,
  startOver,
  tempDir,
  type Fixture,
} from './support.js';

const FILE = 'coherence.json';

/** A folder with a project whose codex entry no document names, and the findings the app saved for it. */
async function folderWithAppFindings(label: string): Promise<{ root: string; app: CoherenceFile }> {
  const root = tempDir(label);
  roots.push(root);
  await seedProject(root, 'The Lighthouse Keeper');
  await seedCodexEntry(root);
  return { root, app: await saveAppFindings(root) };
}

/** The coherence files in a folder: the live file, its snapshots and any kept copy. */
function coherenceFiles(root: string): string[] {
  return readdirSync(root).filter((name) => name.startsWith(FILE)).sort();
}

const roots: string[] = [];
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
  for (const root of roots.splice(0)) removeDir(root);
});

async function open(root: string, allowWrites: boolean): Promise<Fixture> {
  const fixture = await startOver(root, allowWrites);
  fixtures.push(fixture);
  return fixture;
}

function idsOf(file: CoherenceFile | undefined): string[] {
  return (file?.findings ?? []).map((finding) => finding.id).sort();
}

describe('the server loads coherence.json at open', () => {
  it('holds the findings the app saved, and a scan reuses their ids instead of adding duplicates', async () => {
    const { root, app } = await folderWithAppFindings('coh-load');
    expect(app.findings.length).toBeGreaterThan(0);

    const fixture = await open(root, false);
    expect(idsOf(fixture.session.state.coherence as CoherenceFile)).toEqual(idsOf(app));

    const client = await connectClient(fixture.url, fixture.token);
    try {
      const result = await client.callTool({ name: 'coherence.scan', arguments: {} });
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close();
    }
    const held = fixture.session.state.coherence as CoherenceFile;
    expect(idsOf(held)).toEqual(idsOf(app));
    expect(held.runs).toHaveLength(app.runs.length + 1);
  });

  it('keeps a finding the writer dismissed in the app dismissed through a scan', async () => {
    const { root, app } = await folderWithAppFindings('coh-dismissed');
    const dismissed = structuredClone(app);
    const target = dismissed.findings[0];
    if (target === undefined) throw new Error('the fixture produced no finding');
    target.status = 'dismissed';
    target.dismissedReason = 'intentional';
    writeFileSync(join(root, FILE), `${JSON.stringify(dismissed, null, 2)}\n`);

    const fixture = await open(root, false);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      await client.callTool({ name: 'coherence.scan', arguments: {} });
    } finally {
      await client.close();
    }
    const held = fixture.session.state.coherence as CoherenceFile;
    expect(held.findings.find((finding) => finding.id === target.id)?.status).toBe('dismissed');
    expect(held.findings).toHaveLength(dismissed.findings.length);
  });

  it('drops a finding whose document is gone, as the app does, and says so', async () => {
    const { root, app } = await folderWithAppFindings('coh-dangling');
    const stale = structuredClone(app);
    const first = stale.findings[0];
    if (first === undefined) throw new Error('the fixture produced no finding');
    first.evidence = [{ docId: 'n_GONE000001', quote: 'gone', from: 0, to: 4 }];
    writeFileSync(join(root, FILE), `${JSON.stringify(stale, null, 2)}\n`);

    const fixture = await open(root, false);
    expect(fixture.session.state.coherence?.findings.some((finding) => finding.id === first.id)).toBe(false);
    expect(fixture.session.notices.some((notice) => notice.path === FILE && notice.message.includes('no longer exists'))).toBe(true);
  });
});

describe('a server started read-only never writes coherence.json', () => {
  it('leaves the file bytes and mtime as they were through a scan, and makes no snapshot', async () => {
    const { root } = await folderWithAppFindings('coh-ro');
    const before = folderBytes(root);
    const mtime = statSync(join(root, FILE)).mtimeMs;
    const listing = coherenceFiles(root);

    const fixture = await open(root, false);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const result = await client.callTool({ name: 'coherence.scan', arguments: {} });
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close();
    }
    await fixture.stop();

    expect(readFileSync(join(root, FILE), 'utf8')).toBe(before[FILE]);
    expect(statSync(join(root, FILE)).mtimeMs).toBe(mtime);
    expect(coherenceFiles(root)).toEqual(listing);
    expect(existsSync(join(root, coherenceSnapshotFile(1)))).toBe(false);
    expect(folderBytes(root)).toEqual(before);
  });

  it('does not repair a corrupt file: the bytes stay, no kept copy appears, and the notice reaches stderr', async () => {
    const { root } = await folderWithAppFindings('coh-corrupt');
    writeFileSync(join(root, FILE), '{"formatVersion": 1, "findings": [');
    const before = folderBytes(root);

    const fixture = await open(root, false);
    expect(fixture.session.state.coherence?.findings).toEqual([]);
    const lines = startupLines(
      fixture.session,
      { project: root, allowWrites: false, port: 0, tokenEnv: 'CAOTANG_MCP_TOKEN', stdio: true },
      { minted: false, token: '' },
    );
    expect(lines.some((line) => line.includes(`notice: ${FILE}`) && line.includes('could not be read'))).toBe(true);
    await fixture.stop();

    expect(folderBytes(root)).toEqual(before);
    expect(readdirSync(root).some((name) => name.includes('.corrupt-'))).toBe(false);
  });
});

describe('a coherence.json that cannot be used never stops the server from opening', () => {
  it('opens on a file from a newer Caotang, reports it, and does not touch it', async () => {
    const { root } = await folderWithAppFindings('coh-newer');
    writeFileSync(join(root, FILE), JSON.stringify({ formatVersion: 99, findings: [] }));
    const before = folderBytes(root);

    const fixture = await open(root, true);
    expect(fixture.session.state.coherence?.findings).toEqual([]);
    expect(fixture.session.notices.some((notice) => notice.path === FILE && notice.message.includes('newer Caotang'))).toBe(true);
    await fixture.stop();
    expect(folderBytes(root)).toEqual(before);
  });

  it('opens when coherence.json cannot be read at all, holds an empty set, and says so', async () => {
    const root = tempDir('coh-unreadable');
    roots.push(root);
    await seedProject(root, 'The Lighthouse Keeper');
    // A directory where the file should be: the port fails, which is not a problem with the file's content.
    mkdirSync(join(root, FILE));

    const fixture = await open(root, true);
    expect(fixture.session.state.coherence?.findings).toEqual([]);
    expect(fixture.session.notices.some((notice) => notice.path === FILE && notice.message.includes('could not be read'))).toBe(true);
    await fixture.stop();
    expect(statSync(join(root, FILE)).isDirectory()).toBe(true);
  });

  it('opens a project with no coherence.json as before: an empty set and no notice', async () => {
    const root = tempDir('coh-absent');
    roots.push(root);
    await seedProject(root, 'The Lighthouse Keeper');

    const fixture = await open(root, false);
    expect(fixture.session.state.coherence?.findings).toEqual([]);
    expect(fixture.session.notices.filter((notice) => notice.path === FILE)).toEqual([]);
  });
});
