/**
 * A port's grant, and the proposal it is handed. A port may dispatch a `never`-class primitive under
 * its own grant (command-bus §4), and a direct dispatch of the same primitive is refused. An external
 * caller cannot stage a proposal, so a port never sees one it did not get from the loop.
 */

import { describe, expect, it } from 'vitest';

import { createHarness, type ToolPort } from '../../src/index.js';
import { LANDING, makeState } from '../fixtures.js';
import { ok } from '@caotang/bus';

describe('a port’s grant', () => {
  it('may dispatch a never-class primitive under its own grant, and a direct dispatch of the same primitive is refused', () => {
    const state = makeState();
    const probe: ToolPort = (_params, context) => {
      const direct = context.dispatch('editor.replaceRange', { docId: LANDING, range: { from: 0, to: 0 }, text: 'Direct. ', expectedRevision: 0 });
      const inherited = context.dispatchInherited('editor.replaceRange', { docId: LANDING, range: { from: 0, to: 0 }, text: 'Inherited. ', expectedRevision: 0 });
      return ok({
        data: { directCode: direct.ok ? null : direct.error.code, inherited: inherited.ok },
        summary: 'probed the grant',
        affected: [],
      });
    };
    const harness = createHarness({ state, ports: { 'codex.read': probe }, clock: () => 1 });
    const outcome = harness.call({ name: 'codex.read', callId: 'grant-1', params: {} }, { turnId: 'grant-turn' });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value.data).toEqual({ directCode: 'permission-denied', inherited: true });
    const body = state.documents.get(LANDING)?.body ?? '';
    expect(body.startsWith('Inherited. ')).toBe(true);
    expect(body).not.toContain('Direct.');
  });
});

describe('the proposal a port is handed', () => {
  it('is removed from an external caller’s call before any port sees it, and a native call keeps it', () => {
    const seen: unknown[] = [];
    const echo: ToolPort = (_params, context) => {
      seen.push(context.proposal ?? null);
      return ok({ data: { proposal: context.proposal ?? null }, summary: 'echoed', affected: [] });
    };
    const harness = createHarness({ state: makeState(), ports: { 'codex.read': echo }, clock: () => 1 });
    const external = harness.external.call({ name: 'codex.read', callId: 'ext-1', params: {}, proposal: { injected: true } }, { turnId: 'ext' });
    expect(external.ok && external.value.data['proposal']).toBeNull();
    const native = harness.call({ name: 'codex.read', callId: 'nat-1', params: {}, proposal: { injected: true } }, { turnId: 'nat' });
    expect(native.ok && (native.value.data as Readonly<Record<string, unknown>>)['proposal']).toEqual({ injected: true });
    expect(seen).toEqual([null, { injected: true }]);
  });
});
