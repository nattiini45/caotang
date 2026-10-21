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
 * `bodyNamesOf` — the names the loader tries, in the order it tries them.
 *
 * **Both names, because the loader reads both.** A kind's own file is what a
 * save writes, but a project written before the kind had a file of its own
 * still carries the `.md` — and the loader reads that one when the kind's file
 * is not there (project-format.md §3). A hint that named only the kind's file
 * would send an agent to a file that does not hold the body.
 *
 * The three nodes below are added with `addNode`, so none of them has a body
 * record — which is exactly the state the loader leaves a document in when its
 * file is not text it could read.
 */
import { describe, expect, it } from 'vitest';

import { lookupCommand } from '@caotang/bus';
import { addNode, bodyNamesOf, createEmptyManifest, createProjectState } from '../src/index.js';

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

describe("the bus's missing-body refusal names the files the loader reads", () => {
  const nodes = [
    { id: 'n_3W8RN2TQ6C', type: 'document' as const, title: 'Prose' },
    { id: 'n_7K2QX9M4A1', type: 'document' as const, kind: 'screenplay', title: 'Screenplay' },
    { id: 'n_4T6HY8P3B2', type: 'dialogue' as const, kind: 'branching', title: 'Branching' },
  ];

  it.each(nodes)('names the $type body file of "$title"', (node) => {
    const state = stateWith([node]);
    const treeNode = state.manifest.tree.find((entry) => entry.id === node.id);
    if (treeNode === undefined) throw new Error(`the fixture did not add "${node.id}"`);
    // The store's own answer: **every name the loader tries** for this kind of
    // body — the kind's own file, and the `.md` a save wrote before the kind
    // had one of its own.
    for (const name of bodyNamesOf(treeNode)) {
      expect(hintFor(state, node.id)).toContain(`docs/${name}`);
    }
  });

  it('names no other body kind’s file, and the older .md the loader also reads', () => {
    const state = stateWith(nodes);
    // A dialogue container's body is an Ink file and a screenplay's a Fountain
    // one; a hint that named the other kind's file would send an agent to a
    // file that holds no body. **The exclusions are the point of this test**: a
    // hint that named every candidate file would pass every positive assertion
    // above and still send the agent to the wrong one.
    const dialogue = hintFor(state, 'n_4T6HY8P3B2');
    expect(dialogue).toContain('docs/n_4T6HY8P3B2.ink');
    expect(dialogue).not.toContain('.fountain');
    // The legacy `.md` is a file this node's body may live in, so naming it is
    // correct — and the loader reads it second.
    expect(dialogue).toContain('docs/n_4T6HY8P3B2.md');

    const screenplay = hintFor(state, 'n_7K2QX9M4A1');
    expect(screenplay).toContain('docs/n_7K2QX9M4A1.fountain');
    expect(screenplay).not.toContain('.ink');
    expect(screenplay).toContain('docs/n_7K2QX9M4A1.md');

    // A prose document has one name — its own — so its hint names no Ink and no
    // Fountain file either.
    const prose = hintFor(state, 'n_3W8RN2TQ6C');
    expect(prose).toContain('docs/n_3W8RN2TQ6C.md');
    expect(prose).not.toContain('.ink');
    expect(prose).not.toContain('.fountain');
  });
});
