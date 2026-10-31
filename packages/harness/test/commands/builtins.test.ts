/**
 * Each built-in slash command, from the typed line to the exact plan (tool and params) or session action it means (agent-harness §2).
 */

import { describe, expect, it } from 'vitest';

import { BUILTIN_COMMANDS, BUILTIN_COMMAND_NAMES, docResolverFor, resolveSlash, usageOf, type SlashContext, type SlashResolution } from '../../src/index.js';
import { LANDING, STORM, FRIEND, makeState } from '../fixtures.js';

const state = makeState();
const recipes = [
  { name: 'Submission', format: 'docx' },
  { name: 'Screenplay', format: 'fountain' },
];
const context: SlashContext = { resolve: docResolverFor(state), recipes };

/** The one step of a plan resolution, or a failure naming what came back. */
function stepOf(resolved: SlashResolution) {
  if (resolved.kind !== 'plan') throw new Error(`expected a plan, got ${JSON.stringify(resolved)}`);
  expect(resolved.plan.steps).toHaveLength(1);
  return resolved.plan.steps[0] as NonNullable<(typeof resolved.plan.steps)[number]>;
}

describe('the closed set', () => {
  it('has a definition for exactly the names the guide lists, in order', () => {
    expect(BUILTIN_COMMANDS.map((command) => command.name)).toEqual([...BUILTIN_COMMAND_NAMES]);
  });

  it('gives every command a usage line that starts with its name', () => {
    for (const command of BUILTIN_COMMANDS) expect(usageOf(command).startsWith(`/${command.name}`)).toBe(true);
    expect(usageOf(BUILTIN_COMMANDS.find((command) => command.name === 'draft')!)).toBe('/draft <doc> [draft|continue] [words] [-- brief]');
  });
});

describe('/plan', () => {
  it('sends the request, not the slash, and forces a plan card', () => {
    expect(resolveSlash('/plan tighten the opening of chapter 2', context)).toEqual({
      kind: 'intent',
      intent: 'tighten the opening of chapter 2',
      command: 'plan',
      forcePlan: true,
    });
  });
});

describe('/draft', () => {
  it('builds a scene.draft step from a title, a mode, a length and a brief', () => {
    const resolved = resolveSlash('/draft "The Storm" continue 800 -- keep the rain', context);
    expect(resolved).toMatchObject({ kind: 'plan', command: 'draft', intent: 'Continue “The Storm” (about 800 words)' });
    expect(stepOf(resolved)).toMatchObject({ tool: 'scene.draft', params: { doc: STORM, mode: 'continue', target_words: 800, instruction: 'keep the rain' } });
  });

  it('names the document by id and leaves out what was not typed', () => {
    const step = stepOf(resolveSlash('/draft "the s"', context));
    expect(step.params).toEqual({ doc: STORM, instruction: 'Draft the scene from its synopsis and notes.' });
  });

  it('refuses a rewrite, which needs a selection, and an option it does not know', () => {
    expect(resolveSlash('/draft "the s" rewrite', context)).toMatchObject({ kind: 'ask', command: 'draft', message: expect.stringContaining('selected') });
    expect(resolveSlash('/draft "the s" louder', context)).toMatchObject({ kind: 'ask', command: 'draft', message: expect.stringContaining('“louder”') });
  });

  it('asks, with the candidates, when a title names several documents', () => {
    const resolved = resolveSlash('/draft The', context);
    expect(resolved).toMatchObject({ kind: 'ask', command: 'draft', candidates: ['The Landing', 'The Storm', 'The Friend'] });
  });

  it('asks when a title names nothing, and says a title with spaces goes in quotes', () => {
    expect(resolveSlash('/draft Arrival continue', context)).toMatchObject({ kind: 'ask', message: expect.stringContaining('quotes') });
    expect(resolveSlash('/draft Arrival', context)).toMatchObject({ kind: 'ask', message: expect.not.stringContaining('quotes') });
  });

  it('cannot name a document a read rule withholds', () => {
    const withheld: SlashContext = { ...context, resolve: docResolverFor(state, new Set([STORM])) };
    const resolved = resolveSlash('/draft "The Storm"', withheld);
    expect(resolved).toMatchObject({ kind: 'ask' });
    expect(JSON.stringify(resolved)).not.toContain(STORM);
    expect(resolveSlash('/draft The', withheld)).toMatchObject({ kind: 'ask', candidates: ['The Landing', 'The Friend'] });
    expect(resolveSlash(`/draft ${STORM}`, withheld)).toMatchObject({ kind: 'ask' });
  });

  it('does not resolve a folder as a document', () => {
    expect(resolveSlash('/draft "Chapter 1"', context)).toMatchObject({ kind: 'ask' });
  });
});

describe('/synopses', () => {
  it('builds a synopsis.fill step over the documents named, once each', () => {
    const resolved = resolveSlash('/synopses "The Landing" "The Storm" "the l" notes', context);
    expect(resolved).toMatchObject({ kind: 'plan', command: 'synopses', intent: 'Fill the synopses of “The Landing”, “The Storm”' });
    expect(stepOf(resolved)).toMatchObject({ tool: 'synopsis.fill', params: { docs: [LANDING, STORM], source: 'notes' } });
  });

  it('leaves source out when it was not typed', () => {
    expect(stepOf(resolveSlash('/synopses "the f"', context)).params).toEqual({ docs: [FRIEND] });
  });

  it('asks before any model call when one of the titles is ambiguous', () => {
    expect(resolveSlash('/synopses "The L" The', context)).toMatchObject({ kind: 'ask', candidates: ['The Landing', 'The Storm', 'The Friend'] });
  });
});

describe('/scan and /review', () => {
  it('scans the manuscript, one document, or what changed', () => {
    expect(stepOf(resolveSlash('/scan', context))).toMatchObject({ tool: 'coherence.scan', params: { scope: { mode: 'full' } } });
    expect(stepOf(resolveSlash('/scan changed', context)).params).toEqual({ scope: { mode: 'changed' } });
    expect(stepOf(resolveSlash('/scan "the s"', context)).params).toEqual({ scope: { mode: 'doc', docIds: [STORM] } });
  });

  it('reviews what changed unless told otherwise, and the cost stays on the card', () => {
    expect(stepOf(resolveSlash('/review', context))).toMatchObject({ tool: 'coherence.review', params: { scope: { mode: 'changed' } } });
    expect(stepOf(resolveSlash('/review full', context)).params).toEqual({ scope: { mode: 'full' } });
    expect(stepOf(resolveSlash('/review "The Friend"', context)).params).toEqual({ scope: { mode: 'doc', docIds: [FRIEND] } });
  });

  it('takes one document at a time', () => {
    expect(resolveSlash('/scan "the s" "the f"', context)).toMatchObject({ kind: 'ask', command: 'scan' });
  });
});

describe('/compile', () => {
  it('compiles the manuscript in a format', () => {
    const resolved = resolveSlash('/compile docx', context);
    expect(resolved).toMatchObject({ kind: 'plan', command: 'compile', intent: 'Compile the manuscript as docx' });
    expect(stepOf(resolved)).toMatchObject({ tool: 'export.compile', params: { format: 'docx', selection: { root: 'manuscript' } } });
  });

  it('compiles a part in a format', () => {
    expect(stepOf(resolveSlash('/compile md "Chapter 2"', context)).params).toEqual({ format: 'md', selection: { root: 'n_CHAPTR0002' } });
  });

  it('names a saved recipe, which supplies the format and, alone, the nodes', () => {
    expect(stepOf(resolveSlash('/compile submission', context)).params).toEqual({ format: 'docx', recipeName: 'Submission' });
    expect(stepOf(resolveSlash('/compile Screenplay "Chapter 1"', context)).params).toEqual({
      format: 'fountain',
      recipeName: 'Screenplay',
      selection: { root: 'n_CHAPTR0001' },
    });
  });

  it('asks, naming the recipes and formats, for a word that is neither', () => {
    const resolved = resolveSlash('/compile glossy', context);
    expect(resolved).toMatchObject({ kind: 'ask', command: 'compile' });
    expect(resolved.kind === 'ask' ? resolved.message : '').toContain('“Submission”');
  });
});

describe('the session actions', () => {
  it('maps /restore, /context and /help to an action with no plan', () => {
    expect(resolveSlash('/restore', context)).toEqual({ kind: 'session', action: 'restore', command: 'restore' });
    expect(resolveSlash('/restore last', context)).toEqual({ kind: 'session', action: 'restore', command: 'restore', arg: 'last' });
    expect(resolveSlash('/restore 2', context)).toMatchObject({ arg: '2' });
    expect(resolveSlash('/context', context)).toEqual({ kind: 'session', action: 'context', command: 'context' });
    expect(resolveSlash('/help', context)).toEqual({ kind: 'session', action: 'help', command: 'help' });
    expect(resolveSlash('/help /draft', context)).toMatchObject({ action: 'help', arg: 'draft' });
  });
});
