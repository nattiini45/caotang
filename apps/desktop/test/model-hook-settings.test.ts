import { describe, expect, it } from 'vitest';
import { MODEL_HOOK_LIMIT, MODEL_HOOK_PROMPT_MAX, type ModelHook } from '@caotang/harness';
import { HOOK_NAME_MAX } from '@caotang/bus';
import { modelHooksForProject, readModelHooks } from '../src/app/model-hooks.js';
import { applyPatch, DEFAULT_SETTINGS, normalizeSettings } from '../src/app/settings.js';

const projectId = 'p_123456789A';
const otherProjectId = 'p_023456789A';
const hook: ModelHook = {
  id: 'r_123456789A', name: 'Check the note', enabled: true, event: 'tool.before',
  tool: 'notes.append', prompt: 'Does this note contain a decision?', failClosed: true,
};

describe('private model hook settings', () => {
  it('round trips definitions by project and clears only the selected project', () => {
    const rewrite: ModelHook = { ...hook, canTransform: true };
    const turn: ModelHook = { ...hook, id: 'r_023456789A', event: 'turn.end', tool: '', failClosed: false };
    const first = applyPatch(DEFAULT_SETTINGS, { modelHooks: { [projectId]: [rewrite, turn] } });
    const other = { ...hook, enabled: false };
    const second = applyPatch(first, { modelHooks: { [otherProjectId]: [other] } });
    const reload = normalizeSettings(JSON.parse(JSON.stringify(second)));
    expect(modelHooksForProject(reload.modelHooks, projectId)).toEqual([rewrite, turn]);
    expect(modelHooksForProject(reload.modelHooks, otherProjectId)).toEqual([other]);
    expect(modelHooksForProject(reload.modelHooks, 'constructor')).toEqual([]);
    expect(modelHooksForProject(reload.modelHooks, 'p_0000000000')).toEqual([]);
    const cleared = applyPatch(reload, { modelHooks: { [projectId]: [] } });
    expect(cleared.modelHooks).toEqual({ [otherProjectId]: [other] });
  });

  it('retains only supported, normalized fields and prevents after hooks from failing closed', () => {
    const after = { ...hook, event: 'tool.after', id: 'r_223456789A' };
    expect(readModelHooks({
      constructor: [hook],
      [projectId]: [
        { ...hook, name: ` ${hook.name} `, prompt: ` ${hook.prompt} `, credentials: 'extra field', args: { text: 'extra field' } },
        { ...hook, name: 'Duplicate' },
        { ...hook, id: 'r_023456789A', event: 'turn.submit' },
        { ...hook, id: 'r_323456789A', tool: 'not-a-real-tool' },
        { ...hook, id: 'r_423456789A', prompt: '   ' },
        { ...hook, id: 'r_523456789A', name: ' ' },
        { ...hook, id: 'r_623456789A', enabled: 'yes' },
        { ...hook, id: 'invalid-id' },
        after,
      ],
    })).toEqual({ [projectId]: [hook, { ...after, failClosed: false }] });
  });

  it('keeps explicit rewrites only for supported before hooks and clears unused turn fields', () => {
    const turn = { ...hook, id: 'r_023456789A', event: 'turn.end', tool: 'stale-tool', canTransform: true };
    const after = { ...hook, id: 'r_223456789A', event: 'tool.after', canTransform: true };
    const unsupported = { ...hook, id: 'r_323456789A', tool: 'scene.draft', canTransform: true };
    const falseOptIn = { ...hook, id: 'r_423456789A', canTransform: false };
    const malformedOptIn = { ...hook, id: 'r_523456789A', canTransform: 'true' };
    const rewrite = { ...hook, id: 'r_623456789A', tool: 'notes.replace', canTransform: true };
    expect(readModelHooks({ [projectId]: [turn, after, unsupported, falseOptIn, malformedOptIn, rewrite] })).toEqual({
      [projectId]: [
        { ...hook, id: turn.id, event: 'turn.end', tool: '', failClosed: false },
        { ...hook, id: after.id, event: 'tool.after', failClosed: false },
        { ...hook, id: unsupported.id, tool: 'scene.draft' },
        { ...hook, id: falseOptIn.id },
        { ...hook, id: malformedOptIn.id },
        rewrite,
      ],
    });
  });

  it('enforces text and project count caps on reload', () => {
    const atLimit = { ...hook, name: 'a'.repeat(HOOK_NAME_MAX), prompt: 'b'.repeat(MODEL_HOOK_PROMPT_MAX) };
    expect(readModelHooks({ [projectId]: [
      { ...hook, id: 'r_023456789A', prompt: `${atLimit.prompt}x` },
      { ...hook, id: 'r_223456789A', name: `${atLimit.name}x` },
      atLimit,
    ] })).toEqual({ [projectId]: [atLimit] });
    const hooks = Array.from({ length: MODEL_HOOK_LIMIT + 1 }, (_, index) => ({ ...hook, id: `r_${String(index).padStart(10, '0')}` }));
    expect(readModelHooks({ [projectId]: hooks })[projectId]).toEqual(hooks.slice(0, MODEL_HOOK_LIMIT));
  });
});
