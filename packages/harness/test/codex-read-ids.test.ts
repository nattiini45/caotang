/**
 * The ids `codex.read` returns are the ids `codex.write` documents for update and remove (#751).
 *
 * An agent could create a reference or a relation but never name an existing one: `codex.write` updates and
 * removes by `ref_`/`rel_` id, and nothing the model could read returned one. The explicit read item carries
 * them now — with the reference's title and the relation's target name — while automatic context still carries
 * neither. The pin is the round trip: the id the read hands back is accepted by the write that documents it.
 */

import { describe, expect, it } from 'vitest';

import { createAgentPorts, type Harness } from '../src/index.js';
import { checkedHarness, ENTRY, ENTRY_TWO, makeState, refusalOf, run, valueOf } from './fixtures.js';

const CONFIRMED = { confirmed: true } as const;
const REFERENCE = 'ref_0000000001';
const RELATION = 'rel_0000000001';

function stateWithLinks(): ReturnType<typeof makeState> {
  const state = makeState();
  const entry = (state.manifest.codex ?? []).find((candidate) => candidate.id === ENTRY);
  if (entry === undefined) throw new Error('missing fixture entry');
  entry.references = [{ id: REFERENCE, title: 'Tide Tables', publisher: 'Gull Press' }];
  entry.relations = [{ id: RELATION, targetId: ENTRY_TWO, label: 'ally' }];
  return state;
}

interface ReadItem {
  readonly id: string;
  readonly name: string;
  readonly references?: readonly { id: string; title: string }[];
  readonly relations?: readonly { id: string; targetId: string; target: string; label?: string }[];
}

function harnessFor(state: ReturnType<typeof makeState>): Harness {
  return checkedHarness({ state, ports: createAgentPorts(), clock: () => 1 });
}

function readItem(state: ReturnType<typeof makeState>, id = ENTRY): ReadItem {
  const outcome = valueOf(run(harnessFor(state), 'codex.read', { id }));
  const [item] = outcome.data['entries'] as ReadItem[];
  if (item === undefined) throw new Error('codex.read returned no entry');
  return item;
}

describe('the ids codex.read returns', () => {
  it('carries each reference’s ref_ id beside its title, and each relation’s rel_ id beside its target name', () => {
    const item = readItem(stateWithLinks());
    expect(item.name).toBe('Elena');
    expect(item.references).toEqual([{ id: REFERENCE, title: 'Tide Tables' }]);
    expect(item.relations).toEqual([{ id: RELATION, targetId: ENTRY_TWO, target: 'Kestrel', label: 'ally' }]);
  });

  it('names a relation’s target by its id when that entry is gone rather than dropping the link', () => {
    const state = stateWithLinks();
    const entry = (state.manifest.codex ?? []).find((candidate) => candidate.id === ENTRY);
    if (entry === undefined) throw new Error('missing fixture entry');
    entry.relations = [{ id: RELATION, targetId: 'c_GONE000000' }];
    expect(readItem(state).relations).toEqual([{ id: RELATION, targetId: 'c_GONE000000', target: 'c_GONE000000' }]);
  });

  it('carries neither field for an entry that has no reference and no link', () => {
    const item = readItem(makeState(), ENTRY_TWO);
    expect(item.references).toBeUndefined();
    expect(item.relations).toBeUndefined();
  });

  it('returns ids the write accepts: an update and a remove by what the read handed back', () => {
    const state = stateWithLinks();
    const item = readItem(state);
    const referenceId = item.references?.[0]?.id;
    const relationId = item.relations?.[0]?.id;
    if (referenceId === undefined || relationId === undefined) throw new Error('read returned no ids');
    const write = harnessFor(state);

    valueOf(run(write, 'codex.write', {
      entries: [{ action: 'update', id: ENTRY, referenceEdits: [{ action: 'update', id: referenceId, publisher: 'Nordufer Verlag' }] }],
    }, { permission: CONFIRMED }));
    const entry = (state.manifest.codex ?? []).find((candidate) => candidate.id === ENTRY);
    expect(entry?.references?.[0]).toMatchObject({ id: referenceId, title: 'Tide Tables', publisher: 'Nordufer Verlag' });

    valueOf(run(write, 'codex.write', {
      entries: [{ action: 'update', id: ENTRY, relationEdits: [{ action: 'remove', id: relationId }] }],
    }, { permission: CONFIRMED }));
    expect(entry?.relations).toBeUndefined();

    const stale = refusalOf(run(write, 'codex.write', {
      entries: [{ action: 'update', id: ENTRY, referenceEdits: [{ action: 'remove', id: 'ref_0000000002' }] }],
    }, { permission: CONFIRMED }));
    expect(JSON.stringify(stale)).toContain('must name one existing reference on this entry');
  });
});
