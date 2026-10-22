/**
 * `openProject` against a real project folder: the acceptance of the SDK (agent-harness.md §11). The model is the demo provider or a
 * scripted endpoint behind the global-fetch seam; the folder is the store's own, written to a temporary directory.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEMO_INTENTS } from '@caotang/gateway/mock';
import type { AgentEvent, TurnReport } from '@caotang/harness';

import { LOCK_FILE, ProjectLockedError, openProject, type ApprovalPolicy, type CaotangProject, type DecisionRecord, type OpenOptions } from '../src/index.js';
import { DRAFT_THE_FRIEND, TEST_PROFILE, endpoint } from './endpoint.js';
import { FRIEND, LANDING, folderBytes, seedProject } from './fixture.js';
import { removeDir, tempDir } from './support.js';

let root = '';
beforeEach(async () => {
  root = tempDir('open');
  await seedProject(root);
});
afterEach(() => removeDir(root));

async function open(options: Partial<OpenOptions> = {}): Promise<CaotangProject> {
  return openProject({ root, provider: 'mock', ...options });
}

async function eventsOf(run: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

const WRITE_INTENTS = [DEMO_INTENTS.draftScene, DEMO_INTENTS.fillSynopses] as const;

describe('the demo provider drives each demo intent', () => {
  it.each(Object.values(DEMO_INTENTS))('%s ends its event stream with the report run().report resolves to', async (intent) => {
    const project = await open({ approval: 'approve-all' });
    try {
      const run = project.run(intent);
      const events = await eventsOf(run);
      const report = await run.report;
      const last = events[events.length - 1];
      expect(last).toMatchObject({ type: 'report', report });
      expect(report.status).not.toBe('failed');
      expect(events.some((event) => event.type === 'turn')).toBe(true);
    } finally {
      await project.close();
    }
  });

  it('reads the events and never the report without an unhandled rejection', async () => {
    await using project = await open();
    const run = project.run(DEMO_INTENTS.continuity);
    expect((await eventsOf(run)).length).toBeGreaterThan(0);
  });
});

describe("approval: 'read-only'", () => {
  it('leaves every file in the folder byte-identical, and a write-confirm card ends the turn needing input', async () => {
    const before = folderBytes(root);
    const project = await open({ write: true });
    const reports: TurnReport[] = [];
    for (const intent of Object.values(DEMO_INTENTS)) reports.push(await project.run(intent).report);
    await project.close();

    expect(folderBytes(root)).toEqual(before);
    const [draft, synopses, continuity, review] = reports;
    for (const report of [draft, synopses, review]) {
      expect(report?.status).toBe('cancelled');
      expect(report?.askBack?.code).toBe('needs_input');
    }
    // A read needs no card, and runs.
    expect(continuity?.askBack).toBeUndefined();
    expect(continuity?.status).toBe('replied');
  });

  it('is the default, and is the reason a write-auto call is refused, in a run and in call()', async () => {
    await using project = await open({ write: true });
    const refused = await project.call('notes.append', { doc: 'The Friend', text: 'x' });
    expect(refused).toMatchObject({ ok: false, error: { code: 'permission-denied' } });
    expect(await project.diff()).toEqual([]);
  });

  it('writes no coherence.json for a scan, even when the project is open for writing', async () => {
    const project = await open({ write: true });
    await project.run(DEMO_INTENTS.continuity).report;
    await project.close();
    expect(existsSync(join(root, 'coherence.json'))).toBe(false);
  });
});

describe('a folder that is not byte-canonical', () => {
  const landing = (): string => join(root, 'docs', `${LANDING}.md`);

  it('is left byte-identical by a read-only run, and diff() reports nothing for it', async () => {
    writeFileSync(landing(), readFileSync(landing(), 'utf8').split(String.fromCharCode(10)).join(String.fromCharCode(13, 10)));
    const before = folderBytes(root);
    const project = await open({ write: true });
    expect(await project.diff()).toEqual([]);
    expect((await project.run(DEMO_INTENTS.continuity).report).status).toBe('replied');
    expect(await project.diff()).toEqual([]);
    await project.close();
    expect(folderBytes(root)).toEqual(before);
  });

  it('keeps a document whose bytes are not UTF-8 as it is, and still saves the turn that changed another', async () => {
    const utf16 = Buffer.from(`${String.fromCharCode(0xfeff)}${readFileSync(landing(), 'utf8')}`, 'utf16le');
    writeFileSync(landing(), utf16);
    const project = await open({ approval: 'approve-all', write: true });
    expect(project.notices.length).toBeGreaterThan(0);
    expect(await project.diff()).toEqual([]);
    expect((await project.run(DEMO_INTENTS.continuity).report).status).toBe('replied');
    expect((await project.run(DEMO_INTENTS.draftScene).report).status).toBe('applied');
    expect((await project.diff()).map((change) => change.path)).not.toContain(`docs/${LANDING}.md`);
    await project.close();
    expect(readFileSync(landing()).equals(utf16)).toBe(true);
    expect(readFileSync(join(root, 'docs', `${FRIEND}.md`), 'utf8')).toContain('friend');
  });

  it('with write: false lists the changes of a project that holds such a document', async () => {
    writeFileSync(landing(), Buffer.from(String.fromCharCode(0xfeff) + readFileSync(landing(), 'utf8'), 'utf16le'));
    await using project = await open({ approval: 'approve-all' });
    await project.run(DEMO_INTENTS.draftScene).report;
    expect((await project.diff()).map((change) => change.path)).toContain(`docs/${FRIEND}.md`);
  });

  it('writes the folder again when a save is followed by an undo of that turn', async () => {
    await using project = await open({ approval: 'approve-all', write: true });
    const report = await project.run(DEMO_INTENTS.draftScene).report;
    expect(project.restore(report.turnId).ok).toBe(true);
    expect((await project.diff()).map((change) => change.path)).toContain(`docs/${FRIEND}.md`);
    await project.close();
    expect(readFileSync(join(root, 'docs', `${FRIEND}.md`), 'utf8')).not.toContain('friend');
  });
});

describe("approval: 'auto'", () => {
  it('runs a write-auto call at once and cancels a write-confirm card', async () => {
    await using project = await open({ approval: 'auto' });
    const noted = await project.call('notes.append', { doc: 'The Friend', text: 'a note' });
    expect(noted.ok).toBe(true);
    const report = await project.run(DEMO_INTENTS.draftScene).report;
    expect(report.status).toBe('cancelled');
    expect(report.askBack?.code).toBe('needs_input');
    expect((await project.diff()).map((change) => change.path)).toEqual(['caotang.json']);
  });
});

describe("approval: 'approve-all'", () => {
  it('with write: false changes nothing on disk, and diff() lists exactly the changed documents', async () => {
    const before = folderBytes(root);
    const project = await open({ approval: 'approve-all' });
    for (const intent of WRITE_INTENTS) expect((await project.run(intent).report).status).toBe('applied');

    expect(folderBytes(root)).toEqual({ ...before, [LOCK_FILE]: expect.any(String) });
    const changes = await project.diff();
    expect(changes.map((change) => [change.path, change.kind])).toEqual([
      ['caotang.json', 'changed'],
      ['docs/n_BEACH00001.md', 'changed'],
      ['docs/n_BRAVE00001.md', 'changed'],
      ['docs/n_TEMPEST001.md', 'changed'],
    ]);
    const friend = changes.find((change) => change.path === `docs/${FRIEND}.md`);
    expect(friend?.before).not.toContain('friend');
    expect(friend?.after).toContain('friend');

    await expect(project.save()).rejects.toThrow(/write: false/);
    await project.close();
    expect(folderBytes(root)).toEqual(before);
  });

  it('with write: true saves after each turn, and reopening the folder shows the change', async () => {
    const project = await open({ approval: 'approve-all', write: true });
    expect((await project.run(DEMO_INTENTS.draftScene).report).status).toBe('applied');
    expect(await project.diff()).toEqual([]);
    expect(readFileSync(join(root, 'docs', `${FRIEND}.md`), 'utf8')).toContain('friend');
    await project.close();

    await using again = await open();
    const friend = [...again.state.documents.values()].find((record) => record.id === FRIEND);
    expect(friend?.body).toContain('friend');
    expect(await again.diff()).toEqual([]);
  });

  it('restore() takes a turn back in memory, and diff() and save() follow it', async () => {
    await using project = await open({ approval: 'approve-all', write: true });
    const report = await project.run(DEMO_INTENTS.draftScene).report;
    expect(readFileSync(join(root, 'docs', `${FRIEND}.md`), 'utf8')).toContain('friend');
    expect(project.restore(report.turnId).ok).toBe(true);
    expect((await project.diff()).map((change) => change.path)).toContain(`docs/${FRIEND}.md`);
    await project.save();
    expect(readFileSync(join(root, 'docs', `${FRIEND}.md`), 'utf8')).not.toContain('friend');
  });

  it('keeps an export out of the folder when the project is not open for writing', async () => {
    const before = folderBytes(root);
    const project = await open({ approval: 'approve-all' });
    await project.run('Export the manuscript as Markdown.').report;
    await project.close();
    expect(folderBytes(root)).toEqual(before);
  });
});

describe('a cut draft is never approved by approve-all', () => {
  it('ends the turn needing input, with the document unchanged', async () => {
    const scripted = endpoint((_request, kind) => {
      if (kind === 'planner') return DRAFT_THE_FRIEND;
      return { kind: 'text', text: 'The friend arrives by boat, soaked, and the', finish: 'length' };
    });
    const project = await open({ provider: { profile: TEST_PROFILE, apiKey: 'sk-cut-draft-123456' }, fetch: scripted.fetch, approval: 'approve-all', write: true });
    const report = await project.run('Draft the opening scene of The Friend.').report;
    await project.close();

    expect(report.status).toBe('cancelled');
    expect(report.askBack?.code).toBe('needs_input');
    expect(report.askBack?.reason).toContain('cut off');
    expect(report.steps.every((step) => step.status !== 'done')).toBe(true);
    expect(readFileSync(join(root, 'docs', `${FRIEND}.md`), 'utf8')).not.toContain('soaked');
  });

  it('is the caller’s to decide with a policy function, which can accept the cut text knowingly', async () => {
    const scripted = endpoint((_request, kind) =>
      kind === 'planner' ? DRAFT_THE_FRIEND : { kind: 'text', text: 'The friend arrives by boat, soaked, and the', finish: 'length' },
    );
    const seen: boolean[] = [];
    const approval: ApprovalPolicy = (pending) => {
      seen.push(pending.card.cut);
      return pending.card.canAcceptCut ? { action: 'approve', acceptTruncated: true } : { action: 'cancel' };
    };
    await using project = await open({ provider: { profile: TEST_PROFILE, apiKey: 'sk-cut-draft-123456' }, fetch: scripted.fetch, approval });
    const report = await project.run('Draft the opening scene of The Friend.').report;
    expect(seen).toContain(true);
    expect(report.status).toBe('applied');
  });
});

describe('a policy function', () => {
  it('is asked for every card, and its answer is the decision', async () => {
    const asked: string[] = [];
    await using project = await open({
      approval: (pending) => {
        asked.push(pending.card.steps.map((step) => step.tool).join(','));
        return { action: 'approve' };
      },
    });
    expect((await project.run(DEMO_INTENTS.draftScene).report).status).toBe('applied');
    expect(asked).toEqual(['scene.draft']);
  });

  it('that throws cancels the card, and the turn’s report rejects with the error once the turn has ended', async () => {
    await using project = await open({
      approval: () => {
        throw new Error('the policy broke');
      },
    });
    await expect(project.run(DEMO_INTENTS.draftScene).report).rejects.toThrow('the policy broke');
    expect(await project.diff()).toEqual([]);
  });

  it('is released when the run is aborted while it waits', async () => {
    const controller = new AbortController();
    await using project = await open({ approval: () => new Promise(() => undefined) });
    const run = project.run(DEMO_INTENTS.draftScene, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const report = await run.report;
    expect(report.status).toBe('cancelled');
    expect(await project.diff()).toEqual([]);
  });
});

describe('the key', () => {
  const KEY = 'sk-live-0123456789abcdefSECRET';

  /** Every string a caller can reach from a run: the report, the events, the diff, and every file the project holds. */
  async function everythingAfter(options: Partial<OpenOptions>, intent: string): Promise<string> {
    const project = await open({ approval: 'approve-all', write: true, ...options });
    const run = project.run(intent);
    const events = await eventsOf(run);
    const report = await run.report;
    const diff = await project.diff();
    const state = JSON.stringify([...project.notices]);
    await project.close();
    const files = readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'));
    return JSON.stringify({ report, events, diff, state, files });
  }

  it('is sent to the profile’s endpoint and appears in no file, report, event or diff', async () => {
    const scripted = endpoint((_request, kind) =>
      kind === 'planner' ? DRAFT_THE_FRIEND : { kind: 'text', text: 'The friend arrives by boat, soaked.' },
    );
    const seen = await everythingAfter({ provider: { profile: TEST_PROFILE, apiKey: KEY }, fetch: scripted.fetch }, 'Draft the opening scene of The Friend.');
    expect(scripted.requests.length).toBeGreaterThan(0);
    expect(scripted.requests.every((request) => request.url.startsWith('https://llm.example.test/'))).toBe(true);
    expect(scripted.requests.every((request) => request.authorization === `Bearer ${KEY}`)).toBe(true);
    expect(seen).not.toContain(KEY);
    expect(seen).toContain('soaked');
  });

  it('appears in no error message when the provider refuses it and echoes it back', async () => {
    const scripted = endpoint(() => ({ kind: 'error', status: 401, body: JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}.` } }) }));
    const seen = await everythingAfter({ provider: { profile: TEST_PROFILE, apiKey: KEY }, fetch: scripted.fetch }, 'Draft the opening scene of The Friend.');
    expect(seen).not.toContain(KEY);
    expect(seen).toContain('needs_input');
  });

  it('is read once from a thunk, and a failed call is a needs_input report rather than a rejection', async () => {
    let reads = 0;
    const scripted = endpoint(() => ({ kind: 'error', status: 400, body: 'the request was refused' }));
    const project = await open({
      provider: {
        profile: TEST_PROFILE,
        apiKey: () => {
          reads += 1;
          return KEY;
        },
      },
      fetch: scripted.fetch,
    });
    const report = await project.run('Check the manuscript for continuity problems.').report;
    await project.close();
    expect(reads).toBe(1);
    expect(report.status).toBe('failed');
    expect(report.askBack?.code).toBe('needs_input');
  });
});

describe('the folder lock', () => {
  it('refuses a second openProject on the same folder while the first is open', async () => {
    const first = await open();
    await expect(open()).rejects.toBeInstanceOf(ProjectLockedError);
    await first.close();
    await (await open()).close();
  });

  it('is released by close() and by disposal, and the lock file leaves the folder', async () => {
    {
      await using project = await open();
      expect(existsSync(join(root, LOCK_FILE))).toBe(true);
      void project;
    }
    expect(existsSync(join(root, LOCK_FILE))).toBe(false);
  });

  it('refuses a folder that holds no project, before taking anything', async () => {
    const empty = tempDir('empty');
    try {
      await expect(openProject({ root: empty, provider: 'mock' })).rejects.toThrow(/no Caotang project/);
      expect(readdirSync(empty)).toEqual([]);
    } finally {
      removeDir(empty);
    }
  });

  it('refuses a provider it cannot build before it locks the folder', async () => {
    await expect(open({ provider: { profile: { ...TEST_PROFILE, baseUrl: 'http://insecure.example.test/v1' }, apiKey: 'k-123456789' } })).rejects.toThrow(/https/i);
    expect(existsSync(join(root, LOCK_FILE))).toBe(false);
  });
});

describe('call()', () => {
  it('is a registry call gated as an MCP caller’s is: reads run, a write-confirm tool is refused with its reason', async () => {
    await using project = await open({ approval: 'approve-all' });
    expect((await project.call('project.overview', {})).ok).toBe(true);
    const refused = await project.call('scene.draft', { doc: 'The Friend', instruction: 'x', mode: 'draft' });
    expect(refused).toMatchObject({ ok: false, error: { code: 'permission-denied' } });
  });

  it('surfaces export.compile as a result, never as an unhandled rejection', async () => {
    await using project = await open({ approval: 'approve-all' });
    const outcome = await project.call('export.compile', { format: 'pdf', scope: { mode: 'manuscript' } });
    expect(outcome.ok).toBe(false);
  });

  it('refuses a call on a closed project', async () => {
    const project = await open();
    await project.close();
    await expect(project.call('project.overview', {})).rejects.toThrow(/closed/);
    expect(() => project.run('hello')).toThrow(/closed/);
    await project.close();
  });
});

describe('turns run one at a time', () => {
  it('a second run waits for the first, and each has its own report', async () => {
    await using project = await open({ approval: 'approve-all' });
    const first = project.run(DEMO_INTENTS.continuity);
    const second = project.run(DEMO_INTENTS.draftScene);
    const [a, b] = await Promise.all([first.report, second.report]);
    expect(a.turnId).not.toBe(b.turnId);
    expect(b.status).toBe('applied');
  });
});

describe('onDecision and a given plan', () => {
  const MIXED_PLAN = {
    steps: [
      { tool: 'synopsis.fill', params: { docs: ['The Landing', 'The Storm'], source: 'text', max_words: 30 }, expect: 'both scenes have a synopsis' },
      { tool: 'binder.restructure', params: { ops: [{ action: 'rename', node: FRIEND, title: 'The Guest' }] }, expect: 'The Friend is renamed' },
    ],
  };

  it('records the answer of a built-in policy to each card, and why', async () => {
    const records: DecisionRecord[] = [];
    await using project = await open({ onDecision: (record) => records.push(record) });
    await project.run(DEMO_INTENTS.draftScene).report;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'confirm', action: 'cancel', reason: 'the "read-only" policy approves no card' });
  });

  it('records the answer of a policy function too', async () => {
    const records: DecisionRecord[] = [];
    await using project = await open({ approval: () => ({ action: 'cancel' }), onDecision: (record) => records.push(record) });
    await project.run(DEMO_INTENTS.draftScene).report;
    expect(records.map((record) => record.action)).toEqual(['cancel']);
  });

  it('runs a plan the caller wrote with no planner call, and cancels a card approveTools does not cover whole', async () => {
    const records: DecisionRecord[] = [];
    const before = folderBytes(root);
    const project = await open({ approval: { approveTools: ['synopsis.fill'] }, write: true, onDecision: (record) => records.push(record) });
    const report = await project.run('Fill the synopses and rename.', { plan: MIXED_PLAN }).report;
    await project.close();
    expect(report.status).toBe('cancelled');
    expect(report.askBack?.code).toBe('needs_input');
    expect(records).toHaveLength(1);
    expect(records[0]?.action).toBe('cancel');
    expect(records[0]?.reason).toContain('binder.restructure is not in the approved tools');
    expect(folderBytes(root)).toEqual(before);
  });

  it('approves the same card when both tools are listed', async () => {
    await using project = await open({ approval: { approveTools: ['synopsis.fill', 'binder.restructure'] } });
    const report = await project.run('Fill the synopses and rename.', { plan: MIXED_PLAN }).report;
    expect(report.status).toBe('applied');
    expect((await project.diff()).map((change) => change.path)).toContain('caotang.json');
  });

  it('refuses a plan that does not parse as a failed report, not a throw', async () => {
    await using project = await open({ approval: 'approve-all' });
    const report = await project.run('Nothing.', { plan: { steps: [] } }).report;
    expect(report.status).toBe('failed');
  });
});
