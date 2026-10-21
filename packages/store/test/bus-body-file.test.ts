/**
 * The bus's "this document has no body loaded" refusal names the file the
 * loader reads — and the **store** owns that name.
 *
 * The bus cannot import the store (the dependency runs store → bus), so the
 * rule that a dialogue container's body is `docs/<id>.ink`, a screenplay
 * document's is `docs/<id>.fountain` and a prose document's is `docs/<id>.md`
 * is restated in the bus's own descriptors. A hint that named the wrong file
 * would send an agent to repair a file that does not exist, so this pins the
 * two against each other: the bus's hint is compared with the store's own
 * `bodyFile`, which is the path a save writes.
 *
 * The three nodes below are added with `addNode`, so none of them has a body
 * record — which is exactly the state the loader leaves a document in when its
 * file is not text it could read.
 */
import { describe, expect, it } from 'vitest';

import { lookupCommand } from '@caotang/bus';
import { addNode, bodyFile, createEmptyManifest, createProjectState } from '../src/index.js';

const OPENED = new Date('2026-10-01T04:00:00.000Z');

function stateWith(nodes: readonly { id: string; type: 'document' | 'dialogue'; kind?: string; title: string }[]) {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', OPENED));
  for (const node of nodes) {
    addNode(state, {
      parentId: 'manuscript',
      title: node.title,
      type: node.type,
      ...(node.kind === undefined ? {} : { kind: node.kind }),
      id: node.id,
      now: OPENED,
    });
  }
  return state;
}

function hintFor(state: ReturnType<typeof stateWith>, docId: string): string {
  const registration = lookupCommand('doc.write');
  if (!registration.ok) throw new Error('doc.write is not in the registry');
  const validated = registration.value.descriptor.validate({ docId, body: 'A body.' }, state);
  if (validated.ok) throw new Error(`doc.write accepted "${docId}", whose body is not loaded`);
  return validated.error.correctiveHint ?? '';
}

describe("the bus's missing-body refusal names the file the store would write", () => {
  const nodes = [
    { id: 'n_3W8RN2TQ6C', type: 'document' as const, title: 'Prose' },
    { id: 'n_7K2QX9M4A1', type: 'document' as const, kind: 'screenplay', title: 'Screenplay' },
    { id: 'n_4T6HY8P3B2', type: 'dialogue' as const, kind: 'branching', title: 'Branching' },
  ];

  it.each(nodes)('names the $type body file of "$title"', (node) => {
    const state = stateWith([node]);
    const treeNode = state.manifest.tree.find((entry) => entry.id === node.id);
    if (treeNode === undefined) throw new Error(`the fixture did not add "${node.id}"`);
    // The store's own answer: the path a save writes for this kind of body.
    const expected = bodyFile(treeNode);
    expect(hintFor(state, node.id)).toContain(expected);
  });

  it('does not name one body kind’s file for another', () => {
    const state = stateWith(nodes);
    // A dialogue container's body is an Ink file; a hint that named the prose
    // `.md` would send an agent to a file that holds no body.
    expect(hintFor(state, 'n_4T6HY8P3B2')).toContain('docs/n_4T6HY8P3B2.ink');
    expect(hintFor(state, 'n_7K2QX9M4A1')).toContain('docs/n_7K2QX9M4A1.fountain');
    expect(hintFor(state, 'n_3W8RN2TQ6C')).toContain('docs/n_3W8RN2TQ6C.md');
  });
});
