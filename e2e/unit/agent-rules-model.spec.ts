import { expect, test } from '@playwright/test';

import { addDocument, addFolder, createEmptyManifest, createProjectState, type PermissionRule } from '../../packages/store/src/index.js';
import { accessOf, describeRule, effectiveAccess, withAccess } from '../../apps/desktop/src/app/agent-rules-model.js';
import { DEFAULT_SETTINGS, applyPatch, normalizeSettings } from '../../apps/desktop/src/app/settings.js';

const NOW = new Date('2026-10-22T09:00:00.000Z');

function project() {
  const state = createProjectState(createEmptyManifest('Rules', NOW));
  const act = addFolder(state, { parentId: 'manuscript', title: 'Act 1', now: NOW });
  const scene = addDocument(state, { parentId: act.id, title: 'Scene', body: 'x', now: NOW });
  return { state, act: act.id, scene: scene.id };
}

test.describe('agent rules in the binder menu and Settings (agent-harness §4)', () => {
  test('a menu choice is one rule on the node’s subtree, and choosing again replaces it', () => {
    const { act } = project();
    const readOnly = withAccess([], act, 'read-only');
    expect(readOnly).toEqual([{ effect: 'deny', tool: '*', scope: { subtree: act }, access: 'write' }]);
    expect(accessOf(readOnly, act)).toBe('read-only');
    const hidden = withAccess(readOnly, act, 'none');
    expect(hidden).toEqual([{ effect: 'deny', tool: '*', scope: { subtree: act }, access: 'read' }]);
    expect(accessOf(hidden, act)).toBe('none');
    expect(withAccess(hidden, act, 'full')).toEqual([]);
  });

  test('a choice leaves every other rule as it was, including the writer’s own rule for the same node', () => {
    const { act, scene } = project();
    const other: PermissionRule = { effect: 'ask', tool: 'meta.set', scope: { subtree: act } };
    const note: PermissionRule = { effect: 'deny', tool: 'scene.draft', scope: { subtree: scene }, note: 'mine' };
    const rules = withAccess([other, note], scene, 'read-only');
    expect(rules).toContainEqual(other);
    expect(rules).toContainEqual(note);
    expect(accessOf([other, note], act)).toBe('full');
    expect(withAccess(rules, scene, 'full')).toEqual([other, note]);
  });

  test('a folder’s rule binds what is inside it, the stricter one wins, and the menu says where it was set', () => {
    const { state, act, scene } = project();
    const rules = withAccess(withAccess([], act, 'read-only'), scene, 'none');
    expect(effectiveAccess(rules, state, scene)).toEqual({ access: 'none' });
    const inherited = effectiveAccess(withAccess([], act, 'read-only'), state, scene);
    expect(inherited.access).toBe('read-only');
    expect(inherited.inheritedFrom?.id).toBe(act);
    expect(effectiveAccess([], state, scene)).toEqual({ access: 'full' });
  });

  test('a rule reads in the writer’s words, and one for a node that is gone says it has no effect', () => {
    const { state, act } = project();
    expect(describeRule({ effect: 'deny', tool: '*', scope: { subtree: act }, access: 'write' }, state)).toEqual({ text: '“Act 1” is read only for the agent', inert: false });
    expect(describeRule({ effect: 'deny', tool: '*', scope: { subtree: act }, access: 'read' }, state).text).toBe('“Act 1” is hidden from the agent');
    expect(describeRule({ effect: 'ask', tool: 'scene.draft' }, state).text).toBe('Asks you before the agent uses scene.draft');
    expect(describeRule({ effect: 'deny', tool: 'codex.*' }, null).text).toBe('Never lets the agent use codex.*');
    expect(describeRule({ effect: 'deny', tool: '*', scope: { subtree: 'n_GONE000001' } }, state).inert).toBe(true);
  });

  test('the settings slice keeps tool-level deny and ask rules, drops the rest field by field, and a patch replaces the list', () => {
    expect(DEFAULT_SETTINGS.agent.rules).toEqual([]);
    const loaded = normalizeSettings({
      agent: {
        rules: [
          { effect: 'ask', tool: 'meta.set', note: 'check' },
          { effect: 'allow', tool: 'scene.draft' },
          { effect: 'deny', tool: '*', scope: { subtree: 'n_A' } },
          { effect: 'deny' },
        ],
      },
    });
    expect(loaded.agent.rules).toEqual([{ effect: 'ask', tool: 'meta.set', note: 'check' }]);
    expect(normalizeSettings({ agent: { rules: 'all' } }).agent.rules).toEqual([]);
    const patched = applyPatch(loaded, { agent: { rules: [{ effect: 'deny', tool: 'codex.write' }] } });
    expect(patched.agent.rules).toEqual([{ effect: 'deny', tool: 'codex.write' }]);
    expect(patched.agent.defaultMode).toBe('ask');
  });
});
