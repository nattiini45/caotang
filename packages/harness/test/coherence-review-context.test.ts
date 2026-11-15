import { describe, expect, it } from 'vitest';
import { withheldState } from '@caotang/context';
import type { ProjectState } from '@caotang/store';
import { reviewContextOf } from '../src/coherence-review-context.js';
import { ENTRY, FRIEND, LANDING, STORM, makeState } from './fixtures.js';

function entryOf(state: ProjectState, id: string) {
  const entry = (state.manifest.codex ?? []).find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`no entry ${id}`);
  return entry;
}

function forbidDescription(state: ProjectState, id: string): void {
  Object.defineProperty(entryOf(state, id), 'description', {
    configurable: true,
    get() { throw new Error(`description of ${id} was read`); },
  });
}

function forbidBody(state: ProjectState, id: string): void {
  const record = state.documents.get(id);
  if (record === undefined) throw new Error(`no doc ${id}`);
  Object.defineProperty(record, 'body', {
    configurable: true,
    get() { throw new Error(`body of ${id} was read`); },
  });
}

function keys(blocks: readonly { key: string }[]): string[] {
  return blocks.map((block) => block.key);
}

describe('reviewContextOf effective inputs', () => {
  it('never reads a never entry description, even when it is pinned', () => {
    const state = makeState();
    entryOf(state, ENTRY).includePolicy = 'never';
    forbidDescription(state, ENTRY);
    const context = reviewContextOf(state, { include: [{ kind: 'codex', id: ENTRY }] });
    expect(keys(context.codex!(STORM))).not.toContain('Elena');
  });

  it('leaves a request-excluded entry out before reading its description', () => {
    const state = makeState();
    entryOf(state, ENTRY).includePolicy = 'always';
    forbidDescription(state, ENTRY);
    const context = reviewContextOf(state, { exclude: [{ kind: 'codex', id: ENTRY }] });
    expect(keys(context.codex!(STORM))).not.toContain('Elena');
  });

  it('a pin promotes an unattached manual entry, but an exclude wins over the pin', () => {
    const state = makeState();
    entryOf(state, ENTRY).includePolicy = 'manual';
    const pinned = reviewContextOf(state, { include: [{ kind: 'codex', id: ENTRY }] });
    expect(keys(pinned.codex!(STORM))).toContain('Elena');
    const excluded = reviewContextOf(state, { include: [{ kind: 'codex', id: ENTRY }], exclude: [{ kind: 'codex', id: ENTRY }] });
    expect(keys(excluded.codex!(STORM))).not.toContain('Elena');
  });

  it('leaves a request-excluded document out of the story so far before reading its body', () => {
    const state = makeState();
    forbidBody(state, STORM);
    const context = reviewContextOf(state, { exclude: [{ kind: 'doc', id: STORM }] });
    expect(keys(context.storySoFar!(FRIEND))).not.toContain('The Storm');
  });

  it('does not read a withheld document body', () => {
    const state = makeState();
    forbidBody(state, STORM);
    const view = withheldState(state, new Set([STORM]));
    const context = reviewContextOf(view);
    expect(keys(context.storySoFar!(FRIEND))).not.toContain('The Storm');
  });

  it('reads the story so far in manuscript order for the scope document', () => {
    const state = makeState();
    const context = reviewContextOf(state);
    expect(keys(context.storySoFar!(FRIEND))).toEqual(['The Landing', 'The Storm']);
    expect(keys(context.storySoFar!(LANDING))).toEqual([]);
  });
});
