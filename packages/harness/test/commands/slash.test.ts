/**
 * The pure half of slash commands (agent-harness §2): `parseSlash`, `expandTemplate` and `resolveSlash`. No model, no session, no DOM.
 */

import { describe, expect, it } from 'vitest';

import { docResolverFor, expandTemplate, isCommandName, matchCommands, menuQuery, parseSlash, resolveSlash, type SlashContext } from '../../src/index.js';
import { LANDING, makeState } from '../fixtures.js';

const state = makeState();
const context: SlashContext = { resolve: docResolverFor(state), recipes: [] };

describe('parseSlash', () => {
  it('reads the command name and the words after it', () => {
    expect(parseSlash('/draft The Landing continue 800')).toMatchObject({
      name: 'draft',
      raw: 'The Landing continue 800',
      positional: ['The', 'Landing', 'continue', '800'],
    });
  });

  it('keeps a quoted word whole, with straight, curly and escaped quotes', () => {
    expect(parseSlash('/draft "Chapter 3 / Arrival" continue 800')?.positional).toEqual(['Chapter 3 / Arrival', 'continue', '800']);
    expect(parseSlash("/draft 'The Storm' x")?.positional).toEqual(['The Storm', 'x']);
    expect(parseSlash('/draft “The Storm” x')?.positional).toEqual(['The Storm', 'x']);
    expect(parseSlash('/x "say \\"hi\\" now" z')?.positional).toEqual(['say "hi" now', 'z']);
  });

  it('treats a quote inside a word as text and an unterminated quote as running to the end', () => {
    expect(parseSlash("/x don't stop")?.positional).toEqual(["don't", 'stop']);
    expect(parseSlash('/x "never closed here')?.positional).toEqual(['never closed here']);
  });

  it('collects key=value words as named arguments and keeps them positional', () => {
    const parsed = parseSlash('/x chapter=3 "tone=dark" plain');
    expect(parsed?.named).toEqual({ chapter: '3' });
    expect(parsed?.positional).toEqual(['chapter=3', 'tone=dark', 'plain']);
  });

  it('splits the brief off at a bare --', () => {
    const parsed = parseSlash('/draft Storm continue 800 -- keep the rain, and the "lamp"');
    expect(parsed?.head).toEqual(['Storm', 'continue', '800']);
    expect(parsed?.brief).toBe('keep the rain, and the "lamp"');
    expect(parseSlash('/draft Storm --')?.brief).toBeUndefined();
    expect(parseSlash('/draft "--" x')?.head).toEqual(['--', 'x']);
  });

  it('is case-insensitive about the name and reads a bare name', () => {
    expect(parseSlash('/DRAFT')).toMatchObject({ name: 'draft', raw: '', positional: [] });
  });

  it('does not read text that is not a command line', () => {
    expect(parseSlash('draft it')).toBeUndefined();
    expect(parseSlash('//draft')).toBeUndefined();
    expect(parseSlash('／draft')).toBeUndefined();
    expect(parseSlash('/usr/bin/tool is broken')).toBeUndefined();
    expect(parseSlash('')).toBeUndefined();
  });
});

describe('expandTemplate', () => {
  const parsed = parseSlash('/t "Chapter 3" fast mood=dark');
  if (parsed === undefined) throw new Error('fixture');

  it('fills $ARGUMENTS, $1..$9 and named arguments', () => {
    const out = expandTemplate('All: $ARGUMENTS | first: $1 | second: $2 | mood: $mood', parsed);
    expect(out).toEqual({ ok: true, value: 'All: "Chapter 3" fast mood=dark | first: Chapter 3 | second: fast | mood: dark' });
  });

  it('writes $$ as a dollar sign and does not expand what a value holds', () => {
    const tricky = parseSlash('/t "$1 and $$"');
    if (tricky === undefined) throw new Error('fixture');
    expect(expandTemplate('Cost $$5: $1', tricky)).toEqual({ ok: true, value: 'Cost $5: $1 and $$' });
  });

  it('fills $SELECTION and $DOC from the placeholders', () => {
    expect(expandTemplate('Rewrite $SELECTION in $DOC', parsed, { SELECTION: 'the lamp', DOC: 'The Storm' })).toEqual({ ok: true, value: 'Rewrite the lamp in The Storm' });
  });

  it('names the placeholder that has nothing to fill it, and never sends it empty', () => {
    expect(expandTemplate('Use $4', parsed)).toEqual({ ok: false, error: { missing: '$4' } });
    expect(expandTemplate('In $DOC', parsed)).toEqual({ ok: false, error: { missing: '$DOC' } });
    expect(expandTemplate('x', parsed, {}, ['tone'])).toEqual({ ok: false, error: { missing: '$tone' } });
    expect(expandTemplate('x $tone', parsed, {}, ['mood'])).toEqual({ ok: true, value: 'x $tone' });
  });

  it('leaves a $word that is none of these as written', () => {
    expect(expandTemplate('cost $HOME or 5$ or $', parsed)).toEqual({ ok: true, value: 'cost $HOME or 5$ or $' });
  });
});

describe('resolveSlash', () => {
  it('sends text that is not a command as it was typed', () => {
    expect(resolveSlash('tighten the opening', context)).toEqual({ kind: 'intent', intent: 'tighten the opening' });
  });

  it('sends // as a literal leading slash', () => {
    expect(resolveSlash('//draft is not a command here', context)).toEqual({ kind: 'intent', intent: '/draft is not a command here' });
  });

  it('sends a line that names no command as a request, with a note', () => {
    const resolved = resolveSlash('/foo bar', context);
    expect(resolved).toMatchObject({ kind: 'intent', intent: '/foo bar' });
    expect(resolved.kind === 'intent' ? resolved.note : '').toContain('No command /foo; sent as a request');
  });

  it('sends a path as a plain request with no note', () => {
    expect(resolveSlash('/usr/bin/tool is broken', context)).toEqual({ kind: 'intent', intent: '/usr/bin/tool is broken' });
  });

  it('answers a bare slash with the help', () => {
    expect(resolveSlash('/', context)).toMatchObject({ kind: 'session', action: 'help' });
  });

  it('asks for a required argument instead of sending it empty', () => {
    expect(resolveSlash('/draft', context)).toMatchObject({ kind: 'ask', command: 'draft', missing: { name: 'doc', required: true } });
    expect(resolveSlash('/plan', context)).toMatchObject({ kind: 'ask', command: 'plan', missing: { name: 'request' } });
    expect(resolveSlash('/synopses', context)).toMatchObject({ kind: 'ask', command: 'synopses' });
    expect(resolveSlash('/compile', context)).toMatchObject({ kind: 'ask', command: 'compile' });
  });

  it('is pure: the same line and project give the same answer', () => {
    expect(resolveSlash(`/draft ${LANDING} continue 300`, context)).toEqual(resolveSlash(`/draft ${LANDING} continue 300`, context));
  });
});

describe('the menu', () => {
  it('opens for a command name being typed and for nothing else', () => {
    expect(menuQuery('/')).toBe('');
    expect(menuQuery('/dr')).toBe('dr');
    expect(menuQuery('/Dr')).toBe('dr');
    expect(menuQuery('/draft ')).toBeUndefined();
    expect(menuQuery('//')).toBeUndefined();
    expect(menuQuery('／dr')).toBeUndefined();
    expect(menuQuery('dr')).toBeUndefined();
    expect(menuQuery('/a/b')).toBeUndefined();
  });

  it('lists the commands that start with what was typed, in the closed set’s order', () => {
    expect(matchCommands('').map((command) => command.name)).toEqual(['help', 'plan', 'draft', 'synopses', 'scan', 'review', 'compile', 'restore', 'context']);
    expect(matchCommands('s').map((command) => command.name)).toEqual(['synopses', 'scan']);
    expect(matchCommands('zz')).toEqual([]);
  });

  it('names a command in the form the log may carry', () => {
    expect(isCommandName('draft')).toBe(true);
    expect(isCommandName('Draft')).toBe(false);
    expect(isCommandName('a b')).toBe(false);
    expect(isCommandName('')).toBe(false);
    expect(isCommandName('x'.repeat(40))).toBe(false);
  });
});
