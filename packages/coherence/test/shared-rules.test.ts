/**
 * The rules the coherence module shares with the bus and the store, and the canon ranking and id
 * minting that are its own (coherence.md §3, §5.2.1, §6.3; codex.md §2 provenance).
 *
 * The vocabulary is held twice on purpose: the bus validates with its own copy, because the dependency
 * runs coherence → store → bus. These tests read both copies back, so a timeline mode or a dismissal
 * reason added in one place and not the other fails here rather than in a user's file.
 */

import { describe, expect, it } from 'vitest';

import {
  COHERENCE_NOTE_LIMIT,
  DISMISSAL_REASON_IDS,
  KNOWLEDGE_TEXT_LIMIT as BUS_KNOWLEDGE_TEXT_LIMIT,
  TIMELINE_MODES as BUS_TIMELINE_MODES,
  applySceneMetaPatch as busApplySceneMetaPatch,
} from '@caotang/bus';

import {
  DISMISSAL_REASONS,
  KNOWLEDGE_TEXT_LIMIT,
  NOTE_LIMIT,
  TIMELINE_MODES,
  applySceneMetaPatch,
  canonOfPair,
  canonRank,
  isCoherenceId,
  isWriterCanonOrigin,
  mintCoherenceId,
} from '../src/index.js';

describe('the shared vocabulary matches the coherence model', () => {
  it('holds the timeline modes the model declares (§5.2.1)', () => {
    expect([...BUS_TIMELINE_MODES]).toEqual([...TIMELINE_MODES]);
  });

  it('holds the dismissal reason ids the picker declares (§6.3)', () => {
    expect([...DISMISSAL_REASON_IDS]).toEqual(DISMISSAL_REASONS.map((reason) => reason.id));
  });

  it('holds the note limit the model declares (§7)', () => {
    expect(COHERENCE_NOTE_LIMIT).toBe(NOTE_LIMIT);
  });

  it('holds the knowledge text limit the model declares (§4.4)', () => {
    expect(BUS_KNOWLEDGE_TEXT_LIMIT).toBe(KNOWLEDGE_TEXT_LIMIT);
  });

  it('re-exports the one scene-metadata rule the bus and the store apply, rather than a second copy', () => {
    expect(applySceneMetaPatch).toBe(busApplySceneMetaPatch);
  });
});

describe('canon ranking (codex.md §2 provenance; coherence.md §4.3)', () => {
  it('ranks an import equal to the writer’s own hand-authored entry: imported writing is the writer’s canon', () => {
    expect(canonRank('import')).toBe(canonRank('manual'));
    expect(isWriterCanonOrigin('import')).toBe(true);
    expect(isWriterCanonOrigin('manual')).toBe(true);
  });

  it('ranks an agent inference below both the writer’s entries and an import', () => {
    expect(isWriterCanonOrigin('agent')).toBe(false);
    expect(canonRank('agent')).toBeGreaterThan(canonRank('import'));
  });

  it('picks the canon of a conflicting pair, and none when the two rank the same', () => {
    const manual = { id: 'c_MANUAL0001', origin: 'manual' as const };
    const imported = { id: 'c_IMPORT0001', origin: 'import' as const };
    const inferred = { id: 'c_AGENT00001', origin: 'agent' as const };
    expect(canonOfPair(inferred, manual)).toBe(manual);
    expect(canonOfPair(inferred, imported)).toBe(imported);
    // Two canon entries, or two inferences, decide nothing between them: the caller must say so.
    expect(canonOfPair(manual, imported)).toBeUndefined();
    const second = { id: 'c_AGENT00002', origin: 'agent' as const };
    expect(canonOfPair(inferred, second)).toBeUndefined();
  });
});

describe('coherence ids are minted by the family, under their own prefixes (no prefix swap)', () => {
  it('mints f, r and w ids in the spec shape, distinct against the taken set', () => {
    const taken = new Set<string>();
    for (const prefix of ['f', 'r', 'w'] as const) {
      const id = mintCoherenceId(prefix, taken);
      expect(isCoherenceId(prefix, id)).toBe(true);
      expect(id.startsWith(`${prefix}_`)).toBe(true);
      taken.add(id);
    }
    expect(taken.size).toBe(3);
  });

  it('re-rolls past a collision, and throws rather than return a duplicate when it cannot escape one', () => {
    // A randomness source that always yields the same bytes: every attempt is the same candidate.
    const fixed = () => new Uint8Array(8).fill(7);
    const first = mintCoherenceId('f', new Set(), fixed);
    expect(() => mintCoherenceId('f', new Set([first]), fixed)).toThrow(/could not mint a unique f_ id/);
  });
});
