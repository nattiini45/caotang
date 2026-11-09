import { describe, expect, it } from 'vitest';
import { setBody } from '@caotang/store';
import { parseSkillFolder } from '@caotang/skills';
import {
  createAgentPorts, createAgentSession, createMemoryRunLog, createTraceStore, modePolicy, parseRunEvents, RUN_LOG_VERSION,
  type AgentSessionOptions, type PendingCard, type PlanStep, type RunEvent, type SourcedRule,
} from '../../src/index.js';
import { FRIEND, LANDING, makeHarness } from '../fixtures.js';
import { mockGateway } from './gateway.js';
import { prose } from './scripts.js';

const ALLOW: SourcedRule = { effect: 'allow', tool: 'notes.replace', source: 'app', note: 'My reviewed notes workflow' };
const REPLACE: PlanStep = { tool: 'notes.replace', params: { doc: FRIEND, notes: 'The writer’s replacement.' }, expect: 'The notes are replaced.' };

async function rig(rules: readonly SourcedRule[] = [ALLOW], extras: Partial<AgentSessionOptions> = {}) {
  const harness = makeHarness({ ports: createAgentPorts(), rules: () => ({ rules }) });
  const log = createMemoryRunLog();
  const trace = createTraceStore({ sessionId: 'rules' });
  const asked: PendingCard[] = [];
  const session = createAgentSession({
    harness, gateway: await mockGateway([]), mode: 'ask', trace,
    runLog: { port: log, projectId: 'project' },
    decide: async (card) => { asked.push(card); return { action: 'cancel' }; },
    ...extras,
  });
  const run = (steps: readonly PlanStep[] = [REPLACE]) => session.submitPlan('Replace the notes.', { steps });
  return { harness, log, trace, asked, session, run };
}

describe('Settings-authored allow rules', () => {
  it('approves an eligible Ask card and durably names its exact rule in both audit streams before the call', async () => {
    const r = await rig();
    const report = await r.run();
    expect(report.status).toBe('applied');
    expect(r.asked).toHaveLength(0);
    expect(report.cards).toMatchObject([{ kind: 'auto', decision: 'auto' }]);
    const events = (JSON.parse(r.log.dump()) as RunEvent[][])[0]!;
    const approval = events.find((event) => event.t === 'rule.approved')!;
    expect(approval).toMatchObject({ tool: REPLACE.tool, rule: ALLOW });
    expect(events.indexOf(approval)).toBeLessThan(events.findIndex((event) => event.t === 'step.intent'));
    expect(r.trace.records().find((event) => event.kind === 'rule.approved')).toMatchObject({ callId: report.trace[0]!.callId, rule: ALLOW });
    expect(parseRunEvents(events).ok).toBe(true);
    expect(r.trace.toJsonl({ omitText: true })).not.toContain(ALLOW.note);
    for (const rule of [{ ...ALLOW, source: 'project' }, { ...ALLOW, effect: 'deny' }, { ...ALLOW, scope: { subtree: FRIEND } }]) {
      expect(parseRunEvents(events.map((event) => event.t === 'rule.approved' ? { ...event, rule } : event)).ok).toBe(false);
    }
  });

  it.each(['project', 'session'] as const)('never takes approval from a %s rule', async (source) => {
    const r = await rig([{ ...ALLOW, source }]);
    expect((await r.run()).status).toBe('cancelled');
    expect(r.asked).toHaveLength(1);
    expect(r.log.dump()).not.toContain('rule.approved');
  });

  it.each(['deny', 'ask'] as const)('gives %s precedence over a Settings allow, independent of source or list order', async (effect) => {
    for (const rules of [[ALLOW, { ...ALLOW, effect, source: 'project' as const }], [{ ...ALLOW, effect, source: 'project' as const }, ALLOW]]) {
      const r = await rig(rules);
      expect((await r.run()).status).not.toBe('applied');
      expect(r.asked).toHaveLength(effect === 'ask' ? 1 : 0);
      expect(r.log.dump()).not.toContain('rule.approved');
    }
  });

  it('does not widen Plan only or a tainted turn', async () => {
    for (const extras of [{ mode: 'plan-only' as const }, { taint: () => true }]) {
      const r = await rig([ALLOW], extras);
      expect((await r.run()).status).not.toBe('applied');
      expect(r.log.dump()).not.toContain('rule.approved');
    }
  });

  it('does not widen Accept edits to a restructure that mode leaves for the writer', async () => {
    const r = await rig([{ ...ALLOW, tool: 'binder.restructure' }], { mode: 'accept-edits' });
    const step: PlanStep = { tool: 'binder.restructure', params: { ops: [{ action: 'create', parent: 'manuscript', type: 'folder', title: 'Never auto-created' }] }, expect: 'A chapter is created.' };
    expect((await r.run([step])).status).toBe('cancelled');
    expect(r.asked).toHaveLength(1);
    expect(r.log.dump()).not.toContain('rule.approved');
    expect(r.harness.state.manifest.tree.some((node) => node.title === 'Never auto-created')).toBe(false);
  });

  it.each(['unchanged', 'rule', 'mode'] as const)('keeps mixed-plan authority tied to the original step after an awaited read: %s', async (changed) => {
    let rules: readonly SourcedRule[] = [ALLOW];
    let mode: 'ask' | 'plan-only' = 'ask';
    let views = 0;
    const harness = makeHarness({ ports: createAgentPorts(), rules: () => ({ rules }), asyncPorts: { 'pictures.view': async () => {
      views += 1;
      await Promise.resolve();
      if (changed === 'rule') rules = [];
      if (changed === 'mode') mode = 'plan-only';
      return { ok: true, value: { data: {}, summary: 'Viewed.', affected: [] } };
    } } });
    const r = await rig([], { harness, mode: () => mode });
    const last = { ...REPLACE, params: { doc: LANDING, notes: 'The later replacement.' } };
    const report = await r.run([REPLACE, { tool: 'pictures.view', params: { assetIds: ['a_0000000001'] }, expect: 'The picture is read.' }, last]);
    expect(views).toBe(1);
    expect(harness.state.manifest.tree.find((node) => node.id === FRIEND)?.notes).toBe(REPLACE.params['notes']);
    expect(report.undoGroupId).toBeDefined();
    if (changed === 'unchanged') {
      expect(report.status).toBe('applied');
      expect(harness.state.manifest.tree.find((node) => node.id === LANDING)?.notes).toBe(last.params.notes);
    } else {
      expect(report.status).toBe('failed');
      expect(harness.state.manifest.tree.find((node) => node.id === LANDING)?.notes).not.toBe(last.params.notes);
    }
  });

  it('requires every write in an Ask plan to be allowed and records every approved call separately', async () => {
    const second: PlanStep = { tool: 'meta.set', params: { targets: [LANDING], status: 'final' }, expect: 'The status is final.' };
    const partial = await rig();
    expect((await partial.run([REPLACE, second])).status).toBe('cancelled');
    const complete = await rig([ALLOW, { effect: 'allow', tool: 'meta.set', source: 'app' }]);
    expect((await complete.run([REPLACE, second])).status).toBe('applied');
    const events = (JSON.parse(complete.log.dump()) as RunEvent[][])[0]!;
    const approvals = events.filter((event) => event.t === 'rule.approved');
    expect(approvals.map((event) => event.tool)).toEqual(['notes.replace', 'meta.set']);
    expect(new Set(approvals.map((event) => event.callId)).size).toBe(2);
  });

  it('does not let a caller use allow as a confirmation at the harness gate', async () => {
    const r = await rig();
    const outcome = r.harness.call({ name: REPLACE.tool, params: REPLACE.params, callId: 'direct' }, { turnId: 'direct' });
    expect(outcome).toMatchObject({ ok: false, error: { code: 'permission-denied' } });
  });

  it('does not approve a refused preflight or a card beyond the automatic-write budget', async () => {
    const refused = await rig();
    expect((await refused.run([{ ...REPLACE, params: { ...REPLACE.params, doc: 'missing-document' } }])).status).not.toBe('applied');
    expect(refused.log.dump()).not.toContain('rule.approved');
    const limited = await rig([ALLOW], { budget: { maxSteps: 0 } });
    expect((await limited.run()).status).not.toBe('applied');
    expect(limited.log.dump()).not.toContain('rule.approved');
    expect(limited.asked).toHaveLength(0);
  });

  it('asks the writer when the run log is unavailable or the rule audit append fails', async () => {
    const missing = await rig([ALLOW], { runLog: undefined });
    expect((await missing.run()).status).toBe('cancelled');
    expect(missing.asked).toHaveLength(1);
    const log = createMemoryRunLog();
    const failing = await rig([ALLOW], { runLog: { projectId: 'project', port: { ...log, append: async (id, events, patch) => {
      if (events.some((event) => event.t === 'rule.approved')) throw new Error('Disk full');
      await log.append(id, events, patch);
    } } } });
    expect((await failing.run()).status).toBe('cancelled');
    expect(failing.asked).toHaveLength(1);
    expect(failing.trace.records().some((event) => event.kind === 'rule.approved')).toBe(false);
  });

  it('waits for the audit transaction before making a call', async () => {
    let release = (): void => {};
    let reached = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = new Promise<void>((resolve) => { reached = resolve; });
    const log = createMemoryRunLog();
    const r = await rig([ALLOW], { runLog: { projectId: 'project', port: { ...log, append: async (id, events, patch) => {
      if (events.some((event) => event.t === 'rule.approved')) { reached(); await gate; }
      await log.append(id, events, patch);
    } } } });
    const run = r.run();
    await pending;
    expect(log.dump()).not.toContain('step.applied');
    expect(r.harness.state.manifest.tree.find((node) => node.id === FRIEND)?.notes).not.toBe(REPLACE.params['notes']);
    release();
    expect((await run).status).toBe('applied');
  });

  it.each(['rule', 'mode'] as const)('rechecks the %s after awaited logging before applying an automatically approved step', async (changed) => {
    let rules: readonly SourcedRule[] = [ALLOW];
    let mode: 'ask' | 'plan-only' = 'ask';
    const log = createMemoryRunLog();
    const harness = makeHarness({ ports: createAgentPorts(), rules: () => ({ rules }) });
    const r = await rig([], { harness, mode: () => mode, runLog: { projectId: 'project', port: { ...log, append: async (id, events, patch) => {
      await log.append(id, events, patch);
      if (events.some((event) => event.t === 'step.intent')) {
        if (changed === 'rule') rules = [];
        else mode = 'plan-only';
      }
    } } } });
    expect((await r.run()).status).toBe('failed');
    expect(log.dump()).not.toContain('step.applied');
    expect(harness.state.manifest.tree.find((node) => node.id === FRIEND)?.notes).not.toBe(REPLACE.params['notes']);
  });

  it.each(['rule', 'mode'] as const)('does not record an approval when the %s changes during the pre-apply save', async (changed) => {
    const rules: SourcedRule[] = [ALLOW];
    let mode: 'ask' | 'plan-only' = 'ask';
    const r = await rig(rules, { mode: () => mode, beforeAutoApply: async () => {
      if (changed === 'rule') rules.length = 0;
      else mode = 'plan-only';
    } });
    expect((await r.run()).status).toBe('failed');
    expect(r.log.dump()).not.toContain('rule.approved');
    expect(r.log.dump()).not.toContain('step.applied');
    expect(r.asked).toHaveLength(0);
  });

  it('does not treat an earlier rule audit as permission to resume after the rule is removed', async () => {
    const original = await rig();
    await original.run();
    const rows = (JSON.parse(original.log.dump()) as RunEvent[][])[0]!.filter((event) => !event.t.startsWith('step.') && event.t !== 'turn.end').map((event, seq) => ({ ...event, seq }));
    const id = 'run_approved';
    const replayLog = createMemoryRunLog();
    await replayLog.create({ schema: RUN_LOG_VERSION, kind: 'turn', runId: id, projectId: 'project', intent: 'Replace the notes.', status: 'interrupted', createdAt: 0, updatedAt: 0 });
    await replayLog.append(id, rows);
    const resumed = await rig([], { runLog: { projectId: 'project', port: replayLog } });
    expect((await resumed.session.resume(id)).status).toBe('cancelled');
    expect(resumed.asked).toHaveLength(1);
  });

  it('does not keep an old automatic grant after the writer manually approves a retried draft', async () => {
    let rules: readonly SourcedRule[] = [{ ...ALLOW, tool: 'scene.draft' }];
    const harness = makeHarness({ ports: createAgentPorts(), rules: () => ({ rules }) });
    let decisions = 0;
    const r = await rig([], {
      harness,
      gateway: await mockGateway([prose('Brief: Open.', 'The approved replacement.')]),
      beforeAutoApply: async () => { setBody(harness.state, FRIEND, 'The writer changed this.'); },
      decide: async () => {
        rules = [];
        return { action: decisions++ === 0 ? 'retry' : 'approve' };
      },
    });
    const report = await r.run([{ tool: 'scene.draft', params: { doc: FRIEND, instruction: 'Open.', mode: 'continue' }, expect: 'The scene is drafted.' }]);
    expect(report.status, report.summary).toBe('applied');
    expect(decisions).toBe(2);
    expect(harness.state.documents.get(FRIEND)?.body).toBe('The writer changed this.\n\nThe approved replacement.');
  });

  it('rechecks a grant against the turn’s skill restriction loaded earlier in the same plan', async () => {
    const files = [{ path: 'SKILL.md', bytes: new TextEncoder().encode('---\nname: read-only\ndescription: Read the binder.\nallowed-tools: binder.read_tree\n---\nRead without changing anything.\n') }];
    const pin = parseSkillFolder('read-only', files).skill?.pin;
    expect(pin).toBeDefined();
    const harness = makeHarness({ ports: createAgentPorts(), rules: () => ({ rules: [ALLOW] }), skills: { reviewedPin: () => pin } });
    harness.state.skills.set('read-only', files);
    const before = harness.state.manifest.tree.find((node) => node.id === FRIEND)?.notes;
    const r = await rig([], { harness, maxRetries: 0 });
    const report = await r.run([{ tool: 'skill.load', params: { name: 'read-only' }, expect: 'The reviewed skill is loaded.' }, REPLACE]);
    expect(report.status).toBe('failed');
    expect(report.askBack?.reason).toContain('The automatic approval is no longer valid');
    expect(harness.state.manifest.tree.find((node) => node.id === FRIEND)?.notes).toBe(before);
    expect(report.modelCalls).toBe(0);
  });

  it.each([2, 3])('holds %i identical rule-approved writes to the repeat limit', async (count) => {
    const statuses = new Map<string, string>();
    const r = await rig([ALLOW], { emit: (event) => { if (event.type === 'card') statuses.set(event.card.id, event.card.status); } });
    const before = r.harness.state.manifest.tree.find((node) => node.id === FRIEND)?.notes;
    const report = await r.run(Array.from({ length: count }, () => REPLACE));
    expect(report.status).toBe(count === 2 ? 'applied' : 'failed');
    expect(r.harness.state.manifest.tree.find((node) => node.id === FRIEND)?.notes).toBe(count === 2 ? REPLACE.params['notes'] : before);
    if (count === 3) expect(report.askBack?.reason).toContain('notes.replace with the same parameters 3 times');
    expect(r.asked).toHaveLength(0);
    expect([...statuses.values()]).toEqual(Array.from({ length: count }, () => count === 2 ? 'done' : 'cancelled'));
  });

  it('does not automatically append three copies of the same note', async () => {
    const r = await rig([{ ...ALLOW, tool: 'notes.append' }]);
    const before = r.harness.state.manifest.tree.find((node) => node.id === FRIEND)?.notes;
    const step: PlanStep = { tool: 'notes.append', params: { doc: FRIEND, text: 'A repeated note.' }, expect: 'The note is appended.' };
    const report = await r.run([step, step, step]);
    expect(report.status).toBe('failed');
    expect(report.askBack?.reason).toContain('notes.append with the same parameters 3 times');
    expect(r.harness.state.manifest.tree.find((node) => node.id === FRIEND)?.notes).toBe(before);
  });

  it.each(['manual', 'held'] as const)('does not count an Ask card the writer must decide: %s', async (kind) => {
    const r = await rig(kind === 'manual' ? [] : [ALLOW], kind === 'held' ? { beforeAutoApply: async () => 'Review this card yourself.' } : {});
    expect((await r.run([REPLACE, REPLACE, REPLACE])).status).toBe('cancelled');
    expect(r.asked).toHaveLength(1);
  });

  it('keeps the required run-log audit when optional Trace recording is off', async () => {
    const r = await rig([ALLOW], { trace: undefined });
    expect((await r.run()).status).toBe('applied');
    expect(r.log.dump()).toContain('rule.approved');
    expect(r.trace.records().some((event) => event.kind === 'rule.approved')).toBe(false);
  });
});

describe('allow never widens a mode’s forbidden operations', () => {
  it.each(['ask', 'accept-edits', 'auto', 'plan-only'] as const)('preserves the hard stops in %s', (mode) => {
    const policy = modePolicy(mode);
    for (const tool of ['memory.write', 'instructions.propose']) expect(policy.approves({ tools: [tool], external: false, allowedTools: [tool] })).toBe(false);
    expect(policy.approves({ tools: ['mcp__server__write'], external: true, allowedTools: ['mcp__server__write'] })).toBe(false);
    if (mode === 'accept-edits') {
      for (const tool of ['binder.restructure', 'export.compile']) expect(policy.approves({ tools: [tool], external: false, allowedTools: [tool] })).toBe(false);
    }
    if (mode === 'plan-only') expect(policy.approves({ tools: ['notes.replace'], external: false, allowedTools: ['notes.replace'] })).toBe(false);
  });
});
