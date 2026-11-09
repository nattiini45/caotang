import { describe, expect, it } from 'vitest';
import type { ProjectHook } from '@caotang/bus';
import { createHookRunner, exportHookNodes, type HookInput } from '../src/index.js';
import { CHAPTER_ONE, LANDING, STORM, makeState } from './fixtures.js';

const hook = (event: ProjectHook['event'], extra: Partial<ProjectHook> = {}): ProjectHook => ({
  id: 'h_0123456789', name: 'No filler', event, enabled: true, onBlock: 'block',
  handler: { kind: 'check', check: { kind: 'status', allowed: ['Not a status'] } }, ...extra,
});
const input = (event: HookInput['event'], extra: Partial<HookInput> = {}): HookInput => ({
  event, issuedBy: 'user', tool: 'export.compile', params: {}, affected: [LANDING], ...extra,
});

describe('lifecycle hooks', () => {
  it('defaults export and save to both issuers, while tool and turn events default to the agent', () => {
    for (const event of ['export.before', 'export.after', 'project.save'] as const) {
      const runner = createHookRunner([hook(event)], { state: makeState() });
      for (const issuedBy of ['user', 'agent'] as const) expect(runner.run(input(event, { issuedBy }))).toHaveLength(1);
    }
    for (const event of ['tool.before', 'tool.after', 'turn.submit', 'turn.end'] as const) {
      const runner = createHookRunner([hook(event)], { state: makeState() });
      expect(runner.run(input(event))).toEqual([]);
      expect(runner.run(input(event, { issuedBy: 'agent' }))).toHaveLength(1);
    }
  });

  it('keeps saves and completed events warn-only, even when a check fails closed', () => {
    for (const event of ['project.save', 'turn.end', 'export.after'] as const) {
      const runner = createHookRunner([hook(event, { failClosed: true, handler: { kind: 'check', check: { kind: 'coherence', checks: ['unknown.check'] } } })], { state: makeState() });
      expect(runner.run(input(event, { issuedBy: 'agent' }))[0]?.decision.action).toBe('warn');
    }
  });

  it('checks document bodies for export patterns and keeps read-denied text out of agent checks', () => {
    const state = makeState();
    const hooks = [hook('export.before', { handler: { kind: 'check', check: { kind: 'pattern', patterns: [{ match: 'ferry', message: 'Use another word.' }] } } })];
    const checked = input('export.before', { affected: [LANDING] });
    expect(createHookRunner(hooks, { state }).run(checked)[0]?.decision.action).toBe('block');
    expect(createHookRunner(hooks, { state, withheld: () => new Set([LANDING]) }).run(checked)[0]?.decision.action).toBe('allow');
    expect(createHookRunner(hooks, { state }).run({ ...checked, affected: [] })[0]?.decision.action).toBe('allow');
  });

  it('checks exactly the selected export subtree, or the saved recipe roots', () => {
    const state = makeState();
    const docs = exportHookNodes(state, { selection: { root: CHAPTER_ONE } });
    expect(docs).toContain(LANDING);
    state.manifest.recipes = [{ name: 'One scene', format: 'md', includeRootIds: [STORM] }];
    expect(exportHookNodes(state, { recipeName: 'One scene' })).toEqual([STORM]);
    expect(exportHookNodes(state, { includeRootIds: [LANDING], recipeName: 'One scene' })).toEqual([LANDING]);
  });

  it('does not match a tool-filtered hook on a turn or a save', () => {
    const runner = createHookRunner([hook('project.save', { matcher: { tools: ['scene.draft'] } })], { state: makeState() });
    expect(runner.run(input('project.save', { tool: '' }))).toEqual([]);
  });
});
