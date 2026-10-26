/**
 * The three agent-file descriptors (context-assembly.md §2, layer LI): what each accepts and refuses, the gate for an agent, and the
 * digest that makes a stale write a conflict. The applies and their undo are the store's, held in the store's commands-agent-files test.
 */

import { describe, expect, it } from 'vitest';

import {
  COMMAND_REGISTRY,
  MEMORY_BODY_MAX_CHARS,
  MEMORY_MAX_FILES,
  checkPermission,
  hardDenyClass,
  isMemorySlug,
  slugOf,
  textDigest,
  type ValidationAgentFiles,
} from '../src/index.js';
import { makeSnapshot } from './fixtures.js';

type Name = 'project.setInstructions' | 'memory.write' | 'memory.forget';
const validate = (name: Name, params: unknown, snapshot = makeSnapshot()) => COMMAND_REGISTRY[name].descriptor.validate(params, snapshot);

const files = (over: Partial<ValidationAgentFiles> = {}): ValidationAgentFiles => ({
  instructions: { path: 'CAOTANG.md', text: 'British spelling.' },
  memory: [{ slug: 'style-dialogue', title: 'Dialogue tags', body: 'Use said.' }],
  declined: new Map(),
  unreadable: [],
  ...over,
});
const held = makeSnapshot({ agentFiles: files() });

const note = { slug: 'process-endings', type: 'process', title: 'Scene endings', body: 'End on a line of dialogue.' };

describe('the classes', () => {
  it('writes are write-confirm and compensable for an agent, and forget is never and hard-denied', () => {
    for (const name of ['project.setInstructions', 'memory.write'] as const) {
      expect(COMMAND_REGISTRY[name].descriptor.agentRisk, name).toBe('write-confirm');
      expect(COMMAND_REGISTRY[name].descriptor.undo, name).toBe('compensable');
    }
    expect(COMMAND_REGISTRY['memory.forget'].descriptor.agentRisk).toBe('never');
    expect(hardDenyClass('memory.forget')).toBe('deletion');
  });

  it('the gate refuses memory.forget for an agent whatever the plan says, and asks the writer to confirm their own', () => {
    const descriptor = COMMAND_REGISTRY['memory.forget'].descriptor;
    for (const context of [{}, { approvedPlan: true }, { confirmed: true, approvedPlan: true }, { inheritedGrant: 'write-confirm' as const }]) {
      const refused = checkPermission(descriptor, { name: 'memory.forget', issuedBy: 'agent', params: { slug: 'a' } }, context);
      expect(refused, JSON.stringify(context)).toMatchObject({ ok: false, error: { code: 'hard-denied', target: 'memory.forget' } });
    }
    expect(checkPermission(descriptor, { name: 'memory.forget', issuedBy: 'user' })).toMatchObject({ ok: true, value: { requiresUserConfirm: true } });
  });

  it('the gate lets an agent write only inside an approved plan or a confirm card', () => {
    for (const name of ['project.setInstructions', 'memory.write'] as const) {
      const descriptor = COMMAND_REGISTRY[name].descriptor;
      expect(checkPermission(descriptor, { name, issuedBy: 'agent' }), name).toMatchObject({ ok: false, error: { code: 'permission-denied' } });
      expect(checkPermission(descriptor, { name, issuedBy: 'agent' }, { approvedPlan: true }).ok, name).toBe(true);
      expect(checkPermission(descriptor, { name, issuedBy: 'agent' }, { confirmed: true }).ok, name).toBe(true);
    }
  });
});

describe('project.setInstructions', () => {
  it('accepts a text, and an empty one, which leaves the file empty', () => {
    expect(validate('project.setInstructions', { text: 'No semicolons in dialogue.' }, held)).toMatchObject({ ok: true, value: { text: 'No semicolons in dialogue.' } });
    expect(validate('project.setInstructions', { text: '' }, held).ok).toBe(true);
    expect(validate('project.setInstructions', { text: 'First rules.' }).ok).toBe(true);
  });

  it('refuses a text that is already the file, a non-string, an extra key and a text over 50,000 characters', () => {
    expect(validate('project.setInstructions', { text: 'British spelling.' }, held)).toMatchObject({ ok: false, error: { target: 'text' } });
    expect(validate('project.setInstructions', { text: 5 }, held)).toMatchObject({ ok: false, error: { code: 'invalid-params' } });
    expect(validate('project.setInstructions', { text: 'x', slug: 'a' }, held)).toMatchObject({ ok: false, error: { target: 'slug' } });
    expect(validate('project.setInstructions', { text: 'x'.repeat(50_001) }, held)).toMatchObject({ ok: false, error: { code: 'limit-exceeded', target: 'text' } });
  });

  it('treats an AGENTS.md text as not yet the file: the first write creates CAOTANG.md', () => {
    const fallback = makeSnapshot({ agentFiles: files({ instructions: { path: 'AGENTS.md', text: 'From AGENTS.md.' } }) });
    expect(validate('project.setInstructions', { text: 'From AGENTS.md.' }, fallback).ok).toBe(true);
  });

  it('is a revision conflict when the file is no longer the text the caller read', () => {
    expect(validate('project.setInstructions', { text: 'New.', expectedDigest: textDigest('British spelling.') }, held).ok).toBe(true);
    expect(validate('project.setInstructions', { text: 'New.', expectedDigest: textDigest('Older rules.') }, held)).toMatchObject({
      ok: false,
      error: { code: 'revision-conflict', correctiveHint: expect.stringContaining('read CAOTANG.md again') },
    });
    expect(validate('project.setInstructions', { text: 'New.', expectedDigest: '' }, held)).toMatchObject({ ok: false, error: { target: 'expectedDigest' } });
  });

  it('leaves a CAOTANG.md that is not UTF-8 alone', () => {
    const snapshot = makeSnapshot({ agentFiles: files({ instructions: undefined, unreadable: ['CAOTANG.md'] }) });
    expect(validate('project.setInstructions', { text: 'x' }, snapshot)).toMatchObject({ ok: false, error: { correctiveHint: expect.stringContaining('UTF-8') } });
  });
});

describe('memory.write', () => {
  it('accepts a new note and an update, and gives back the title trimmed', () => {
    expect(validate('memory.write', { ...note, title: '  Scene endings  ' }, held)).toMatchObject({ ok: true, value: { title: 'Scene endings' } });
    expect(validate('memory.write', { slug: 'style-dialogue', type: 'style', title: 'Dialogue tags', body: 'Use said, always.' }, held).ok).toBe(true);
  });

  it('refuses a bad slug, type, title and body, naming the key', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...note, slug: 'Bad Slug' }, 'slug'],
      [{ ...note, slug: '' }, 'slug'],
      [{ ...note, type: 'lore' }, 'type'],
      [{ ...note, title: '   ' }, 'title'],
      [{ ...note, title: 'two\nlines' }, 'title'],
      [{ ...note, title: 'x'.repeat(121) }, 'title'],
      [{ ...note, body: '  ' }, 'body'],
      [{ ...note, body: 'x'.repeat(MEMORY_BODY_MAX_CHARS + 1) }, 'body'],
    ];
    for (const [params, target] of cases) {
      expect(validate('memory.write', params, held), JSON.stringify(params).slice(0, 60)).toMatchObject({ ok: false, error: { target } });
    }
    expect(validate('memory.write', { ...note, body: 'x'.repeat(MEMORY_BODY_MAX_CHARS) }, held).ok).toBe(true);
  });

  it('refuses a title that is a codex entry’s name or alias, and names codex.write', () => {
    const snapshot = makeSnapshot({
      codex: [{ id: 'c_ELENA00001', name: 'Elena Voss', aliases: ['The Cartographer', 'El'] }],
      agentFiles: files(),
    });
    for (const title of ['Elena Voss', 'elena voss', ' ELENA VOSS ', 'The Cartographer', 'el']) {
      const result = validate('memory.write', { ...note, title }, snapshot);
      expect(result, title).toMatchObject({ ok: false, error: { code: 'invalid-params', target: 'title', correctiveHint: expect.stringContaining('codex.write') } });
    }
    expect(validate('memory.write', { ...note, title: 'Elena’s dialogue habits' }, snapshot).ok).toBe(true);
  });

  it('does not print the entry’s name when the title matched only an alias', () => {
    const snapshot = makeSnapshot({
      codex: [{ id: 'c_ELENA00001', name: 'Elena Voss', aliases: ['The Cartographer'] }],
      agentFiles: files(),
    });
    const result = validate('memory.write', { ...note, title: 'The Cartographer' }, snapshot);
    if (result.ok) throw new Error('expected a refusal');
    expect(`${result.error.message} ${result.error.correctiveHint ?? ''}`).not.toContain('Elena');
  });

  it('refuses a second note with a title another note has, naming that note', () => {
    expect(validate('memory.write', { ...note, title: 'dialogue TAGS' }, held)).toMatchObject({ ok: false, error: { target: 'title', message: expect.stringContaining('style-dialogue') } });
  });

  it('refuses a slug that names a note the load could not read or a file that is not UTF-8', () => {
    const declined = makeSnapshot({ agentFiles: files({ declined: new Map([['memory/process-endings.md', 'plain']]) }) });
    expect(validate('memory.write', note, declined)).toMatchObject({ ok: false, error: { target: 'slug' } });
    const unreadable = makeSnapshot({ agentFiles: files({ unreadable: ['memory/process-endings.md'] }) });
    expect(validate('memory.write', note, unreadable)).toMatchObject({ ok: false, error: { target: 'slug' } });
  });

  it('holds a project to 200 notes', () => {
    const memory = Array.from({ length: MEMORY_MAX_FILES }, (_, i) => ({ slug: `n-${i}`, title: `Note ${i}`, body: 'x' }));
    const full = makeSnapshot({ agentFiles: files({ memory }) });
    expect(validate('memory.write', note, full)).toMatchObject({ ok: false, error: { code: 'limit-exceeded' } });
    expect(validate('memory.write', { slug: 'n-3', type: 'style', title: 'Note 3', body: 'changed' }, full).ok).toBe(true);
  });

  it('checks the digest against the body of the note, and wants a note to change when one is given', () => {
    const update = { slug: 'style-dialogue', type: 'style', title: 'Dialogue tags', body: 'New.' };
    expect(validate('memory.write', { ...update, expectedDigest: textDigest('Use said.') }, held).ok).toBe(true);
    expect(validate('memory.write', { ...update, expectedDigest: textDigest('Stale.') }, held)).toMatchObject({ ok: false, error: { code: 'revision-conflict' } });
    expect(validate('memory.write', { ...note, expectedDigest: textDigest('x') }, held)).toMatchObject({ ok: false, error: { code: 'not-found', target: 'expectedDigest' } });
  });

  it('takes no origin, date or turn from its params: the apply owns them', () => {
    for (const key of ['origin', 'modified', 'sourceTurn']) {
      expect(validate('memory.write', { ...note, [key]: 'x' }, held), key).toMatchObject({ ok: false, error: { target: key } });
    }
  });
});

describe('memory.forget', () => {
  it('accepts a note the project holds, and one the load could not read', () => {
    expect(validate('memory.forget', { slug: 'style-dialogue' }, held).ok).toBe(true);
    const declined = makeSnapshot({ agentFiles: files({ declined: new Map([['memory/hand-note.md', 'plain']]) }) });
    expect(validate('memory.forget', { slug: 'hand-note' }, declined).ok).toBe(true);
  });

  it('refuses a note the project does not hold, and a bad slug', () => {
    expect(validate('memory.forget', { slug: 'nope' }, held)).toMatchObject({ ok: false, error: { code: 'not-found', target: 'slug' } });
    expect(validate('memory.forget', { slug: '../x' }, held)).toMatchObject({ ok: false, error: { code: 'invalid-params', target: 'slug' } });
    expect(validate('memory.forget', { slug: 'style-dialogue' })).toMatchObject({ ok: false, error: { code: 'not-found' } });
  });
});

describe('the rules the store shares', () => {
  it('names slugs by a scan, and derives one from a title', () => {
    expect(['a', 'a-b-1', 'x'.repeat(64)].every(isMemorySlug)).toBe(true);
    expect(['', 'A', 'a--b', '-a', 'a-', 'a b', 'a_b', 'x'.repeat(65)].some(isMemorySlug)).toBe(false);
    expect(slugOf('  Dialogue: No semicolons!  ')).toBe('dialogue-no-semicolons');
    expect(slugOf('!!!')).toBe('');
    expect(isMemorySlug(slugOf('Naïve “quotes” and 2 numbers'))).toBe(true);
  });

  it('gives a digest that is stable, short, and different for different text', () => {
    expect(textDigest('a')).toBe(textDigest('a'));
    expect(textDigest('a')).not.toBe(textDigest('b'));
    expect(textDigest('')).toMatch(/^[0-9a-f]{14}$/u);
  });
});
