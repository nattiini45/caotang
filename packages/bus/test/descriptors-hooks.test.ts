/**
 * The two hook descriptors and the structural reader behind them (hooks.md §5, §6): what `hook.save` accepts and refuses. Both commands
 * are `never` for an agent; that is held against the gate in permission.test.ts and, through the store's registry, in the store's
 * exit-gate test.
 */

import { describe, expect, it } from 'vitest';

import { COMMAND_REGISTRY, HOOKS_MAX, HOOK_EVENTS, HOOK_EVENTS_RUN, isHookCheckId, isHookId, readHook } from '../src/index.js';
import { makeSnapshot } from './fixtures.js';

const ID = 'h_7K2QX9M4A1';

const DRAFT = {
  name: 'Statuses',
  event: 'tool.before',
  handler: { kind: 'check', check: { kind: 'status', allowed: ['draft', 'revised'] } },
  enabled: true,
};

describe('hook ids and check ids', () => {
  it('reads h_ and ten Crockford characters, and nothing else', () => {
    expect(isHookId(ID)).toBe(true);
    for (const bad of ['m_7K2QX9M4A1', 'h_7K2QX9M4A', 'h_7K2QX9M4AI', 'h_7k2qx9m4a1', '', undefined, 12]) expect(isHookId(bad), String(bad)).toBe(false);
  });

  it('reads a dotted lower-case check id', () => {
    expect(isHookCheckId('pov.coverage')).toBe(true);
    expect(isHookCheckId('timeline.order-drift')).toBe(true);
    for (const bad of ['POV', 'pov coverage', 'pov/coverage', '', 'x'.repeat(61)]) expect(isHookCheckId(bad), bad).toBe(false);
  });
});

describe('readHook', () => {
  it('requires an id only when the load asks for one', () => {
    expect(readHook(DRAFT, false)).toMatchObject({ ok: true });
    expect(readHook(DRAFT, true)).toMatchObject({ ok: false, error: { target: 'hook.id' } });
    expect(readHook({ ...DRAFT, id: ID }, true)).toMatchObject({ ok: true, value: { id: ID } });
    expect(readHook({ ...DRAFT, id: 'nope' }, false)).toMatchObject({ ok: false, error: { target: 'hook.id' } });
  });

  it('defaults enabled to on, and keeps onBlock and failClosed only when given', () => {
    const { enabled: _enabled, ...bare } = DRAFT;
    expect(readHook(bare, false)).toEqual({ ok: true, value: { ...bare, enabled: true } });
    expect(readHook({ ...DRAFT, onBlock: 'block', failClosed: true }, false)).toMatchObject({ ok: true, value: { onBlock: 'block', failClosed: true } });
    expect(readHook({ ...DRAFT, onBlock: 'stop' }, false)).toMatchObject({ ok: false });
  });

  it('declares every event of the spec, and runs two of them', () => {
    expect(HOOK_EVENTS).toEqual(['tool.before', 'tool.after', 'export.before', 'export.after', 'project.save', 'turn.submit', 'turn.end']);
    expect(HOOK_EVENTS_RUN).toEqual(['tool.before', 'tool.after']);
  });

  it('refuses a handler that is not a check, and says a project file holds only checks', () => {
    const result = readHook({ ...DRAFT, handler: { kind: 'mcp', serverKey: 's', toolName: 't' } }, false);
    expect(result).toMatchObject({ ok: false, error: { target: 'hook.handler.kind' } });
    if (!result.ok) expect(result.error.correctiveHint).toContain('only "check"');
  });
});

describe('hook.save and hook.delete validate', () => {
  const save = COMMAND_REGISTRY['hook.save'].descriptor;
  const del = COMMAND_REGISTRY['hook.delete'].descriptor;

  it('are never-class, undoable by inverse, and change the project', () => {
    for (const d of [save, del]) expect([d.agentRisk, d.undo, d.mutates]).toEqual(['never', 'inverse', 'project']);
  });

  it('save refuses the 21st hook, unless it replaces one the project holds', () => {
    const held = Array.from({ length: HOOKS_MAX }, (_, i) => ({ id: `h_${String(i).padStart(10, '0')}` }));
    const snapshot = makeSnapshot({ hooks: held });
    expect(save.validate({ hook: DRAFT }, snapshot)).toMatchObject({ ok: false, error: { code: 'limit-exceeded' } });
    expect(save.validate({ hook: { ...DRAFT, id: held[0]?.id } }, snapshot)).toMatchObject({ ok: true });
  });

  it('delete names an id the project holds, and refuses a malformed one and a missing one', () => {
    const snapshot = makeSnapshot({ hooks: [{ id: ID }] });
    expect(del.validate({ hookId: ID }, snapshot)).toMatchObject({ ok: true, value: { hookId: ID } });
    expect(del.validate({ hookId: 'h_ABCDEFGHJK' }, snapshot)).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(del.validate({ hookId: 'nope' }, snapshot)).toMatchObject({ ok: false, error: { code: 'invalid-params' } });
    expect(del.validate({ hookId: ID, extra: 1 }, snapshot)).toMatchObject({ ok: false, error: { code: 'invalid-params' } });
  });
});
