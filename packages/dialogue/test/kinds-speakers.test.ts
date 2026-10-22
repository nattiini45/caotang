import type { CodexEntry } from '@caotang/store';
import { describe, expect, it } from 'vitest';

import {
  DIALOGUE_KIND,
  DIALOGUE_NODE_TYPES,
  INK_BODY_EXTENSION,
  isBranchingContainer,
  isDialogueNodeType,
  markBranching,
  readDialogueMeta,
  resolveSpeakerId,
  resolveSpeakerName,
  speakersOf,
  validateContainer,
} from '../src/index.js';
import { TAVERN } from './fixtures.js';

const entry = (over: Partial<CodexEntry> & Pick<CodexEntry, 'id' | 'name' | 'type'>): CodexEntry => ({
  aliases: [],
  description: '',
  includePolicy: 'detected',
  caseSensitive: false,
  exclude: [],
  attachments: [],
  keywords: [],
  origin: 'manual',
  sources: [],
  ...over,
});

describe('the container kinds', () => {
  it('names the two Ink-body node types, the branching marker and the body extension', () => {
    expect(DIALOGUE_NODE_TYPES).toEqual(['dialogue', 'beat']);
    expect(DIALOGUE_KIND).toBe('branching');
    expect(INK_BODY_EXTENSION).toBe('.ink');
    expect(isDialogueNodeType('dialogue')).toBe(true);
    expect(isDialogueNodeType('beat')).toBe(true);
    expect(isDialogueNodeType('document')).toBe(false);
    expect(isDialogueNodeType('shot')).toBe(false);
  });
});

describe('readDialogueMeta', () => {
  it('reads the four fields the spec names, and defaults the rest', () => {
    const read = readDialogueMeta({ speaker: ' c_ALICE00001 ', locBaseline: 'en', engineTarget: 'ink-json', autoLineIds: true });
    expect(read.meta).toEqual({ speaker: 'c_ALICE00001', locBaseline: 'en', engineTarget: 'ink-json', autoLineIds: true });
    expect(read.notes).toEqual([]);
    expect(readDialogueMeta(undefined).meta).toEqual({});
  });

  it('drops an unknown engine target and a non-boolean flag, and says so, without failing', () => {
    const read = readDialogueMeta({ engineTarget: 'twine', autoLineIds: 'yes' });
    expect(read.meta).toEqual({});
    expect(read.notes).toEqual([
      'engineTarget "twine" is not a known target and was ignored',
      'autoLineIds must be true or false; it was ignored and defaults to false',
    ]);
  });

  it('refuses a metadata value that is not an object, with a note', () => {
    expect(readDialogueMeta('ink').notes).toEqual(['dialogue metadata is not an object and was ignored']);
  });
});

describe('speaker resolution', () => {
  const entries: CodexEntry[] = [
    entry({ id: 'c_ALICE00001', name: 'Alice', type: 'character', aliases: ['Al'] }),
    entry({ id: 'c_ALBERT0001', name: 'Albert', type: 'character', aliases: ['Al'] }),
    entry({ id: 'c_LANTERN001', name: 'Lantern', type: 'object' }),
    entry({ id: 'c_EXACT00001', name: 'Mab', type: 'character', caseSensitive: true }),
  ];

  it('resolves a cue by name, regardless of case, through the canonical form', () => {
    expect(resolveSpeakerName(entries, 'alice')).toMatchObject({ kind: 'resolved', entry: { id: 'c_ALICE00001' } });
  });

  it('reports a name that two characters share as ambiguous, and lists both', () => {
    const resolved = resolveSpeakerName(entries, 'Al');
    expect(resolved.kind).toBe('ambiguous');
    if (resolved.kind !== 'ambiguous') return;
    expect(resolved.entries.map((e) => e.id)).toEqual(['c_ALICE00001', 'c_ALBERT0001']);
  });

  it('never resolves a non-character entry as a speaker', () => {
    expect(resolveSpeakerName(entries, 'Lantern')).toEqual({ kind: 'unknown' });
  });

  it('matches a case-sensitive entry only by its exact spelling', () => {
    expect(resolveSpeakerName(entries, 'Mab').kind).toBe('resolved');
    expect(resolveSpeakerName(entries, 'MAB').kind).toBe('unknown');
  });

  it('resolves a default speaker by id, of any type', () => {
    expect(resolveSpeakerId(entries, 'c_LANTERN001')?.name).toBe('Lantern');
    expect(resolveSpeakerId(entries, 'c_NOBODY0001')).toBeUndefined();
  });
});

describe('speakersOf', () => {
  const entries: CodexEntry[] = [
    entry({ id: 'c_ALICE00001', name: 'Alice', type: 'character', aliases: ['Al'] }),
    entry({ id: 'c_BOB0000001', name: 'Bob', type: 'character' }),
    entry({ id: 'c_ALBERT0001', name: 'Albert', type: 'character', aliases: ['Bert', 'Alb'] }),
    entry({ id: 'c_ALBERTA001', name: 'Alberta', type: 'character', aliases: ['Alb'] }),
  ];

  it('returns the speakers in body order, once each, resolved to their codex entry', () => {
    const body = ['Bob: Hello.', 'Alice: Hi.', 'Bob: Again.', 'Al: I said hi.'].join('\n');
    expect(speakersOf(body, entries)).toEqual([
      { name: 'Bob', entryId: 'c_BOB0000001' },
      { name: 'Alice', entryId: 'c_ALICE00001' },
    ]);
  });

  it('keeps the typed spelling of a name that matches no character or matches two', () => {
    const body = ['Marisol Vega: Hello.', 'Alb: Which one?', 'Marisol Vega: Again.'].join('\n');
    expect(speakersOf(body, entries)).toEqual([{ name: 'Marisol Vega' }, { name: 'Alb' }]);
  });

  it('reads no speaker from a line without a prefix, from a choice head, or from a comment', () => {
    const body = ['Plain narration.', '// Bob: commented out', '* Bob: a choice head', ''].join('\n');
    expect(speakersOf(body, entries)).toEqual([]);
    expect(speakersOf('', entries)).toEqual([]);
  });
});

describe('the container stats the inspector shows', () => {
  it('counts knots, stitches, choices, the findings in the inbox and the compile errors', () => {
    const report = validateContainer('d1', TAVERN);
    expect(report.stats).toEqual({ knots: 2, stitches: 1, choices: 3, warnings: 0, errors: 0 });
  });
});

describe('the branching marker', () => {
  it('reads the marker a node carries, and reads nothing from a node without it', () => {
    expect(isBranchingContainer({ id: 'd', kind: 'branching' })).toBe(true);
    expect(isBranchingContainer({ id: 'd' })).toBe(false);
    expect(isBranchingContainer({ id: 'd', kind: 'linear' })).toBe(false);
    expect(isBranchingContainer(undefined)).toBe(false);
  });

  it('sets the marker on a copy, and leaves the node it was given as it was', () => {
    const node = { id: 'd', type: 'dialogue' };
    const marked = markBranching(node);
    expect(marked.kind).toBe(DIALOGUE_KIND);
    expect(isBranchingContainer(marked)).toBe(true);
    expect(isBranchingContainer(node)).toBe(false);
    expect(node).toEqual({ id: 'd', type: 'dialogue' });
  });
});
