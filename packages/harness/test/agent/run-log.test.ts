/**
 * The run log (agent-harness §5.1): `planResume`'s verdicts, the writer, and the in-memory port. Every stored row is untrusted, so the
 * log is read back through the same checks a store's rows get.
 */

import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@caotang/gateway';

import {
  createMemoryRunLog,
  createRunWriter,
  newRunRecord,
  planResume,
  structureDigest,
  summarizeRun,
  RUN_LOG_VERSION,
  type RunEvent,
  type RunEventDraft,
} from '../../src/index.js';

const A = 'n_AAAAAAAAAA';
const B = 'n_BBBBBBBBBB';
const STEPS = [
  { tool: 'meta.set', params: { doc: A }, expect: 'one' },
  { tool: 'meta.set', params: { doc: B }, expect: 'two' },
  { tool: 'meta.set', params: { doc: A }, expect: 'three' },
];

/** A log built from drafts, numbered and stamped as the writer would. */
function log(...drafts: readonly RunEventDraft[]): RunEvent[] {
  return drafts.map((draft, seq) => ({ ...draft, seq, at: 1_000 + seq }) as RunEvent);
}

const start: RunEventDraft = { t: 'turn.start', v: RUN_LOG_VERSION, turnId: 't1', intent: 'Rename the scenes', wire: 'planner', native: false };
const card: RunEventDraft = {
  t: 'card.pending',
  turnId: 't1',
  kind: 'plan',
  steps: STEPS,
  proposals: [null, null, null],
  revisions: [null, null, null],
  done: [],
};
const approved: RunEventDraft = { t: 'card.decided', turnId: 't1', decision: 'approved' };
const intent = (index: number, expect: Record<string, number>): RunEventDraft => ({ t: 'step.intent', turnId: 't1', callId: `c.${index}`, index, tool: 'meta.set', expect, structure: 'S1' });
const applied = (index: number, after: Record<string, number>): RunEventDraft => ({ t: 'step.applied', turnId: 't1', callId: `c.${index}`, index, tool: 'meta.set', summary: `step ${index}`, after });
const user: RunEventDraft = { t: 'messages', turnId: 't1', appended: [{ role: 'user', content: 'Request: Rename the scenes' }] };

/** Revisions the project holds, by document. */
const project = (revisions: Record<string, number>) => (id: string) => revisions[id];

describe('planResume', () => {
  it('reports the nodes a read rule kept from the conversation when its last turn began, none for a log that recorded nothing', () => {
    const resumed: RunEventDraft = { ...start, turnId: 't2', resumedFrom: 't1', withheld: [A] };
    const recorded = planResume(log(start, user, resumed), project({}));
    expect(recorded.ok && recorded.replay.withheld).toEqual([A]);
    const bare = planResume(log(start, user), project({}));
    expect(bare.ok && bare.replay.withheld).toEqual([]);
    expect(planResume(log({ ...start, withheld: [1] } as unknown as RunEventDraft), project({}))).toMatchObject({ ok: false, reason: 'schema' });
  });

  it('resumes cleanly after a step applied: the card comes back with that step done', () => {
    const events = log(start, user, card, approved, intent(0, { [A]: 1, [B]: 1 }), applied(0, { [A]: 2 }));
    const verdict = planResume(events, project({ [A]: 2, [B]: 1 }));
    expect(verdict).toMatchObject({ ok: true, kind: 'clean' });
    if (!verdict.ok) return;
    expect(verdict.replay.card?.completed).toEqual([0]);
    expect(verdict.replay.applied.map((step) => step.index)).toEqual([0]);
    expect(verdict.replay.intent).toBe('Rename the scenes');
  });

  it('re-runs a step the log began and never recorded, when no document moved since it began', () => {
    const events = log(start, user, card, approved, intent(0, { [A]: 1, [B]: 1 }), applied(0, { [A]: 2 }), intent(1, { [A]: 2, [B]: 1 }));
    const verdict = planResume(events, project({ [A]: 2, [B]: 1 }));
    expect(verdict).toMatchObject({ ok: true, kind: 're-run', rerun: { callId: 'c.1', index: 1 } });
  });

  it('refuses a step that began when the project’s structure moved, though no document did: a label or a node may have landed', () => {
    const events = log(start, user, card, approved, intent(0, { [A]: 1 }));
    expect(planResume(events, project({ [A]: 1 }), { structure: () => 'S1' })).toMatchObject({ ok: true, kind: 're-run' });
    expect(planResume(events, project({ [A]: 1 }), { structure: () => 'S2' })).toMatchObject({ ok: false, reason: 'revision-drift' });
  });

  it('refuses a step that began and whose document has moved: it may have landed, so it is not run twice', () => {
    const events = log(start, user, card, approved, intent(0, { [A]: 1, [B]: 1 }));
    const verdict = planResume(events, project({ [A]: 1, [B]: 2 }), { nameOf: (id) => (id === B ? 'Scene B' : id) });
    expect(verdict).toMatchObject({ ok: false, reason: 'revision-drift', docs: [B] });
    if (!verdict.ok) expect(verdict.detail).toContain('Scene B');
  });

  it('reports write-lost when a step the log says applied left a revision the project does not hold', () => {
    const events = log(start, user, card, approved, intent(0, { [A]: 1 }), applied(0, { [A]: 5 }));
    expect(planResume(events, project({ [A]: 4 }))).toMatchObject({ ok: false, reason: 'write-lost', docs: [A] });
    expect(planResume(events, project({}))).toMatchObject({ ok: false, reason: 'write-lost', docs: [A] });
  });

  it('reports revision-drift naming the document when the writer edited it after the agent’s write', () => {
    const events = log(start, user, card, approved, intent(0, { [A]: 1 }), applied(0, { [A]: 2 }));
    const verdict = planResume(events, project({ [A]: 3 }), { nameOf: () => 'The Landing' });
    expect(verdict).toMatchObject({ ok: false, reason: 'revision-drift', docs: [A] });
    if (!verdict.ok) expect(verdict.detail).toContain('The Landing');
  });

  it('does not let the writer’s edit to a document an earlier, closed card wrote block a run that is between cards', () => {
    const closed = log(start, user, card, approved, intent(0, { [A]: 1 }), applied(0, { [A]: 2 }), {
      t: 'messages',
      turnId: 't1',
      appended: [{ role: 'tool', toolCallId: 'x', content: '{}' }],
    });
    expect(planResume(closed, project({ [A]: 9 }))).toMatchObject({ ok: true, kind: 'clean' });
    // A write that did not land still stops it, whichever card made it.
    expect(planResume(closed, project({ [A]: 1 }))).toMatchObject({ ok: false, reason: 'write-lost' });
  });

  it('never re-sends an external step that began and was not recorded: it asks back', () => {
    const external: RunEventDraft = { t: 'step.intent', turnId: 't1', callId: 'c.0', index: 0, tool: 'mcp__notes__append', expect: { [A]: 1 }, structure: 'S1' };
    const verdict = planResume(log(start, user, card, approved, external), project({ [A]: 1 }));
    expect(verdict).toMatchObject({ ok: false, reason: 'ask-back' });
    if (!verdict.ok) expect(verdict.detail).toContain('mcp__notes__append');
  });

  it('refuses a log with an event kind, a version or a shape it does not know', () => {
    const base = log(start, user, card);
    expect(planResume([...base, { t: 'future.event', seq: 9, at: 1 }], project({}))).toMatchObject({ ok: false, reason: 'schema' });
    expect(planResume(log({ ...start, v: 2 as never }), project({}))).toMatchObject({ ok: false, reason: 'schema' });
    expect(planResume(log(start, { ...card, proposals: [null] } as RunEventDraft), project({}))).toMatchObject({ ok: false, reason: 'schema' });
    expect(planResume([], project({}))).toMatchObject({ ok: false, reason: 'schema' });
    expect(planResume([{ t: 'turn.end', seq: 0 }, 7], project({}))).toMatchObject({ ok: false, reason: 'schema' });
  });

  it.each(['cancelled', 'refused'] as const)('keeps a %s decision on the card, so a resume knows the writer closed it', (decision) => {
    const verdict = planResume(log(start, user, card, { t: 'card.decided', turnId: 't1', decision }), project({}));
    expect(verdict.ok && verdict.replay.card?.decision).toBe(decision);
  });

  it('refuses an event that carries no turn id, whichever kind it is', () => {
    const base = log(start, user, card, approved);
    const spend = { modelCalls: 1, promptTokens: 1, completionTokens: 1, estimatedTokens: 0, steps: 0, activeMs: 1 };
    const rows: readonly RunEventDraft[] = [
      intent(0, { [A]: 1 }),
      applied(0, { [A]: 2 }),
      { t: 'step.failed', turnId: 't1', callId: 'c.0', index: 0, tool: 'meta.set', error: 'It did not apply.' },
      { t: 'spend', turnId: 't1', spend, reservedCalls: 0 },
      { t: 'turn.end', turnId: 't1', status: 'applied', summary: 'Done.' },
    ];
    for (const row of rows) {
      const withoutTurn = { ...row, seq: base.length, at: 2_000 } as Record<string, unknown>;
      delete withoutTurn['turnId'];
      expect(planResume([...base, withoutTurn], project({})), row.t).toMatchObject({ ok: false, reason: 'schema' });
      expect(planResume([...base, { ...row, seq: base.length, at: 2_000 }], project({})), row.t).not.toMatchObject({ reason: 'schema' });
    }
  });

  it('refuses a spend that is negative, not a number or not finite, and keeps a fractional one', () => {
    const spend = { modelCalls: 2, promptTokens: 100, completionTokens: 30, estimatedTokens: 0, steps: 0, activeMs: 5 };
    const logged = (changed: Record<string, unknown>) => planResume(log(start, user, { t: 'spend', turnId: 't1', spend: { ...spend, ...changed }, reservedCalls: 0 }), project({}));
    for (const changed of [{ modelCalls: -1 }, { promptTokens: Number.NaN }, { steps: Number.POSITIVE_INFINITY }, { activeMs: -0.5 }, { costUsd: -0.5 }, { costUsd: Number.NaN }]) {
      const verdict = logged(changed);
      expect(verdict, JSON.stringify(changed)).toMatchObject({ ok: false, reason: 'schema' });
      if (!verdict.ok) expect(verdict.detail).toContain('damaged or from another version');
    }
    expect(logged({ activeMs: 1234.5, costUsd: 0.0125 })).toMatchObject({ ok: true });
  });

  it('asks back when a plan the app built stopped before its card, since there is no conversation to continue', () => {
    const verdict = planResume(log({ ...start, wire: 'plan' }), project({}));
    expect(verdict).toMatchObject({ ok: false, reason: 'ask-back' });
  });

  it('reads the conversation back byte for byte, reasoning signatures included', () => {
    const reply: ChatMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'meta.set', arguments: '{"doc":"n_A"}' }],
      reasoning: [{ kind: 'thinking', text: 'The scene needs a title.', signature: 'sig==/+Zk0 "quoted"' }],
    } as unknown as ChatMessage;
    const port = createMemoryRunLog();
    const events = log(start, { t: 'messages', turnId: 't1', appended: [user.t === 'messages' ? (user.appended[0] as ChatMessage) : reply, reply] });
    return port.create(newRunRecord('run_X', { projectId: 'p', intent: 'x', now: 1 })).then(async () => {
      await port.append('run_X', events);
      const stored = await port.events('run_X');
      const verdict = planResume(stored, project({}));
      expect(verdict.ok).toBe(true);
      if (!verdict.ok) return;
      expect(JSON.stringify(verdict.replay.messages[1])).toBe(JSON.stringify(reply));
      expect(verdict.replay.messages[1]).toEqual(reply);
    });
  });

  it('adds the model calls a crash lost to the spend the run started from', () => {
    const spend = { modelCalls: 2, promptTokens: 100, completionTokens: 30, estimatedTokens: 0, steps: 0, activeMs: 5 };
    const verdict = planResume(log(start, user, { t: 'spend', turnId: 't1', spend, reservedCalls: 1 }), project({}));
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.replay.spend).toEqual(spend);
      expect(verdict.replay.reservedCalls).toBe(1);
    }
  });
});

describe('structureDigest', () => {
  /** A manifest of the real shape: a project stamp and a tree whose order is the order of its nodes. */
  const manifest = (stamp: string, tree: readonly Record<string, unknown>[]) => ({
    project: { title: 'The Book', modifiedAt: stamp },
    tree,
  });
  const nodes = [
    { id: 'n_PARENT0000', parent: null, title: 'Chapter 1', kind: 'folder' },
    { id: 'n_FIRST00000', parent: 'n_PARENT0000', title: 'Opening', kind: 'doc' },
    { id: 'n_SECOND0000', parent: 'n_PARENT0000', title: 'Landing', kind: 'doc' },
  ];

  it('ignores the modified stamp every save moves, so a save does not look like a change to the project', () => {
    expect(structureDigest(manifest('2026-01-01T00:00:00Z', nodes))).toBe(structureDigest(manifest('2026-02-02T09:30:00Z', nodes)));
  });

  it('changes when a node is renamed, when siblings swap places and when a node moves to another parent', () => {
    const before = structureDigest(manifest('t', nodes));
    const renamed = nodes.map((node) => (node.id === 'n_FIRST00000' ? { ...node, title: 'Prologue' } : node));
    const reordered = [nodes[0]!, nodes[2]!, nodes[1]!];
    const moved = nodes.map((node) => (node.id === 'n_SECOND0000' ? { ...node, parent: null } : node));
    for (const changed of [renamed, reordered, moved]) expect(structureDigest(manifest('t', changed))).not.toBe(before);
  });

  it('does not depend on the order keys were written in', () => {
    const shuffled = nodes.map((node) => Object.fromEntries(Object.entries(node).reverse()));
    const other = { tree: shuffled, project: { modifiedAt: 't', title: 'The Book' } };
    expect(structureDigest(other)).toBe(structureDigest(manifest('t', nodes)));
  });

  it('lets a step that began before a save be re-run, and refuses it when the structure moved', () => {
    const recorded = log(start, user, card, approved, { ...intent(0, { [A]: 1 }), structure: structureDigest(manifest('old', nodes)) } as RunEventDraft);
    expect(planResume(recorded, project({ [A]: 1 }), { structure: () => structureDigest(manifest('new', nodes)) })).toMatchObject({ ok: true, kind: 're-run' });
    expect(planResume(recorded, project({ [A]: 1 }), { structure: () => structureDigest(manifest('new', nodes.slice(1))) })).toMatchObject({ ok: false, reason: 'revision-drift' });
  });
});

describe('summarizeRun', () => {
  it('counts the steps applied of the card’s, and says when a draft is out of date', () => {
    const drafted: RunEventDraft = { ...card, revisions: [{ [A]: 1 }, null, null] } as RunEventDraft;
    const events = log(start, user, drafted, approved, intent(1, { [A]: 1, [B]: 1 }), applied(1, { [B]: 2 }));
    const summary = summarizeRun(events, project({ [A]: 2, [B]: 2 }));
    expect(summary).toMatchObject({ intent: 'Rename the scenes', applied: 1, total: 3, resumable: true });
    expect(summary?.note).toContain('out of date');
  });

  it('says why a run cannot be resumed', () => {
    const events = log(start, user, card, approved, intent(0, { [A]: 1 }), applied(0, { [A]: 4 }));
    const summary = summarizeRun(events, project({ [A]: 2 }), { nameOf: () => 'The Landing' });
    expect(summary).toMatchObject({ resumable: false });
    expect(summary?.note).toContain('The Landing');
  });
});

describe('the run writer', () => {
  it('numbers and stamps events in the order they are given, one append each', async () => {
    const port = createMemoryRunLog();
    await port.create(newRunRecord('run_W', { projectId: 'p', intent: 'x', now: 1 }));
    const writer = createRunWriter({ port, runId: 'run_W', nextSeq: 0, clock: () => 77 });
    await Promise.all([writer.append(start), writer.append(user), writer.append(card, { status: 'awaiting-approval' })]);
    const stored = (await port.events('run_W')) as RunEvent[];
    expect(stored.map((event) => [event.seq, event.t, event.at])).toEqual([
      [0, 'turn.start', 77],
      [1, 'messages', 77],
      [2, 'card.pending', 77],
    ]);
    expect((await port.open('p'))[0]?.status).toBe('awaiting-approval');
  });

  it('keeps the run going when an append fails: it says so once, marks the run as unable to resume, and writes nothing more', async () => {
    const port = createMemoryRunLog();
    await port.create(newRunRecord('run_F', { projectId: 'p', intent: 'x', now: 1 }));
    const notices: string[] = [];
    const writer = createRunWriter({ port, runId: 'run_F', nextSeq: 0, onNotice: (message) => notices.push(message) });
    await writer.append(start);
    port.failNextAppend();
    await writer.append(user);
    await writer.append(card);
    expect(writer.broken).toBe(true);
    expect(notices).toHaveLength(1);
    expect((await port.events('run_F')).length).toBe(1);
    expect((await port.open('p'))[0]).toMatchObject({ cannotResume: true });
  });
});
