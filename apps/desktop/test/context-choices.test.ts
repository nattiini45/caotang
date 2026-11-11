import { REQUEST_PIN_REASON, type ContextOverrides, type ContextRef, type PreviewLayer } from '@caotang/harness';
import { describe, expect, it } from 'vitest';

import { chooseContext, contextChoices, copyContext, droppedContextPins } from '../src/app/context-choices.js';
import { sampleProjectState } from '../src/app/demo-sample.js';

const doc = (id: string): ContextRef => ({ kind: 'doc', id });
const codex = (id: string): ContextRef => ({ kind: 'codex', id });

describe('request-local context choices', () => {
  it('uses an explicitly kept pin, not a required focus, to distinguish a synopsis drop from a dropped excerpt', () => {
    const ref = doc('prior');
    const synopsis = { ref, label: 'Prior scene', text: 'Synopsis cut', reason: { kind: 'budget' as const, layer: 'L4' as const, budget: 0, rank: 1 } };
    const pin = { ref, label: 'Prior scene', reason: REQUEST_PIN_REASON, tokens: 10 };
    const layers: PreviewLayer[] = [
      { id: 'L4', name: 'Story', included: false, tokens: 0, drops: [synopsis], notes: [] },
      { id: 'L5', name: 'Focus', included: true, tokens: 10, kept: [pin], drops: [], notes: [] },
    ];
    const before = structuredClone(layers);
    expect(droppedContextPins(layers, [ref])).toEqual([]);
    const excerpt = { ...synopsis, text: 'Pinned excerpt cut', reason: { ...synopsis.reason, layer: 'L5' as const } };
    const requiredFocus = layers.map((layer) => layer.id !== 'L5' ? layer : { ...layer, kept: [{ ...pin, reason: 'required focus' }], drops: [excerpt] });
    expect(droppedContextPins(requiredFocus, [ref])).toEqual([excerpt]);
    expect(layers).toEqual(before);
  });

  it('copies only IDs and kinds into independent snapshots without changing the source', () => {
    const source = {
      include: [{ kind: 'doc' as const, id: 'scene', label: 'A display label', excerpt: 'Unsent text' }],
      exclude: [{ kind: 'codex' as const, id: 'lore', label: 'Another label' }],
    };
    const before = structuredClone(source);
    const copied = copyContext(source)!;
    expect(copied).toEqual({ include: [doc('scene')], exclude: [codex('lore')] });
    expect(copied.include).not.toBe(source.include);
    expect(copied.include![0]).not.toBe(source.include[0]);
    expect(copied.exclude![0]).not.toBe(source.exclude[0]);
    expect(source).toEqual(before);
    expect(copyContext(undefined)).toBeUndefined();
    expect(copyContext({})).toEqual({});
  });

  it('deduplicates repeated pins and caps distinct documents without counting codex pins', () => {
    let choices: ContextOverrides = {};
    for (const id of ['one', 'two', 'three', 'two', 'four']) choices = chooseContext(choices, doc(id), 'pin');
    expect(choices.include).toEqual([doc('one'), doc('three'), doc('two')]);
    choices = chooseContext(choices, codex('one'), 'pin');
    expect(choices.include).toEqual([doc('one'), doc('three'), doc('two'), codex('one')]);
    const before = structuredClone(choices);
    const excluded = chooseContext(choices, doc('one'), 'exclude');
    const repinned = chooseContext(excluded, doc('four'), 'pin');
    expect(repinned.include).toEqual([doc('three'), doc('two'), codex('one'), doc('four')]);
    expect(repinned.exclude).toEqual([doc('one')]);
    expect(choices).toEqual(before);
  });

  it('deduplicates exclusions and removes the old exclusion when pinning that item', () => {
    const once = chooseContext({ include: [doc('scene')] }, doc('scene'), 'exclude');
    const twice = chooseContext(once, doc('scene'), 'exclude');
    expect(twice).toEqual({ include: [], exclude: [doc('scene')] });
    expect(chooseContext(twice, doc('scene'), 'pin')).toEqual({ include: [doc('scene')], exclude: [] });
  });

  it('clears an exclusion without turning it into a pin or changing other choices', () => {
    const source = { include: [doc('kept')], exclude: [doc('omitted'), codex('other')] };
    const before = structuredClone(source);
    expect(chooseContext(source, doc('omitted'), 'remove')).toEqual({ include: [doc('kept')], exclude: [codex('other')] });
    expect(source).toEqual(before);
  });

  it('hides read-denied documents, Never entries and entries attached only to denied documents', () => {
    const state = sampleProjectState();
    const documents = state.manifest.tree.filter((node) => node.type === 'document');
    const hidden = documents[0]!.id;
    const visible = documents[1]!.id;
    const entry = state.manifest.codex![0]!;
    state.manifest.codex = [
      { ...entry, id: 'never', includePolicy: 'never', attachments: [visible] },
      { ...entry, id: 'denied', includePolicy: 'always', attachments: [hidden] },
      { ...entry, id: 'shared', attachments: [hidden, visible] },
      { ...entry, id: 'unattached', attachments: [] },
    ];
    const before = structuredClone(state.manifest);
    const choices = contextChoices(state, new Set([hidden]));
    expect(choices.filter((choice) => choice.kind === 'doc').map((choice) => choice.id).sort())
      .toEqual(documents.filter((node) => node.id !== hidden).map((node) => node.id).sort());
    expect(choices.filter((choice) => choice.kind === 'codex').map((choice) => choice.id).sort())
      .toEqual(['shared', 'unattached']);
    expect(state.manifest).toEqual(before);
  });
});
