/**
 * A hook cannot say it read the text of a write tool the hooks have no account of (hooks.md §5): the call is a warning, "the step was not
 * checked", and a block under failClosed, never a pass. `fixture.write` stands for the next tool someone adds without a `WRITTEN_TEXT` row.
 */

import type { ProjectHook } from '@caotang/bus';
import type * as Metadata from '../src/metadata.js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/metadata.js', async (importOriginal) => {
  const original = await importOriginal<typeof Metadata>();
  const row = { name: 'fixture.write', risk: 'write-confirm' };
  return { ...original, metadataFor: (name: string) => (name === 'fixture.write' ? row : original.metadataFor(name)) };
});

import { createHookRunner, proseOf, type HookSpec } from '../src/index.js';
import { makeState } from './fixtures.js';

const hook = (over: Partial<ProjectHook> = {}): HookSpec => ({
  id: 'h_0000000001',
  name: 'No suddenly',
  event: 'tool.before',
  handler: { kind: 'check', check: { kind: 'pattern', patterns: [{ match: 'suddenly', message: 'Avoid suddenly.' }] } },
  enabled: true,
  ...over,
});
const call = (params: Record<string, unknown>) => ({ event: 'tool.before' as const, tool: 'fixture.write', params, affected: [] });

describe('a write tool the hooks have no account of', () => {
  const state = makeState();

  it('throws from proseOf when the call carries text, and not when it carries none', () => {
    expect(() => proseOf('fixture.write', { body: 'It suddenly glows.' })).toThrow('the hook cannot read the text fixture.write writes');
    expect(() => proseOf('fixture.write', { list: ['  ', ''] })).not.toThrow();
    expect(() => proseOf('fixture.write', { count: 3 })).not.toThrow();
  });

  it('warns that the step was not checked, for a pattern hook and for a words hook', () => {
    for (const check of [hook(), hook({ handler: { kind: 'check', check: { kind: 'words', max: 5 } } })]) {
      const [warned] = createHookRunner([check], { state }).run(call({ summary: 'It suddenly glows.' }));
      expect(warned?.decision).toMatchObject({ action: 'warn', reason: expect.stringContaining('the step was not checked') });
      expect(warned?.failed).toBe('the hook cannot read the text fixture.write writes');
    }
  });

  it('blocks under failClosed', () => {
    const [blocked] = createHookRunner([hook({ failClosed: true })], { state }).run(call({ summary: 'It suddenly glows.' }));
    expect(blocked?.decision.action).toBe('block');
    expect(blocked?.failed).toContain('cannot read the text');
  });

  it('stays quiet for a call with no text', () => {
    const [passed] = createHookRunner([hook({ failClosed: true })], { state }).run(call({}));
    expect(passed?.decision).toEqual({ action: 'allow' });
  });
});
