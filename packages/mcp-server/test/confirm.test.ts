/**
 * The pieces of write-confirm that do not need a round trip: the digest that binds an
 * answer to its arguments, the summary the dialog shows (which must not carry a body),
 * the ledger that answers a replay, and the sealed round state.
 */

import { describe, expect, it } from 'vitest';

import {
  argsDigest,
  codexEntryNameOf,
  CONFIRMATION_SCHEMA,
  confirmationMessage,
  confirmationSummary,
  createConfirmLedger,
  createRoundCodec,
  stableJson,
} from '../src/index.js';
import type { CallToolResult } from '@modelcontextprotocol/server';

describe('argsDigest', () => {
  it('is the same for the same tool and arguments, whatever order the keys came in', () => {
    expect(argsDigest('doc.import', { title: 'A', body: 'b' })).toBe(argsDigest('doc.import', { body: 'b', title: 'A' }));
  });

  it('changes with the tool name and with any argument', () => {
    const base = argsDigest('doc.import', { title: 'A', body: 'b' });
    expect(argsDigest('codex.write', { title: 'A', body: 'b' })).not.toBe(base);
    expect(argsDigest('doc.import', { title: 'A', body: 'c' })).not.toBe(base);
    expect(argsDigest('doc.import', { title: 'A', body: 'b', status: 'draft' })).not.toBe(base);
  });

  it('sorts keys at every depth, so nested objects have one spelling too', () => {
    expect(stableJson({ b: { y: 1, x: [{ q: 1, p: 2 }] }, a: 0 })).toBe('{"a":0,"b":{"x":[{"p":2,"q":1}],"y":1}}');
  });
});

describe('confirmationSummary', () => {
  it('names a document import by its title and word count, and never by its body', () => {
    const body = 'SECRET-LINE-ONE and the rest of the chapter, which the dialog must not show.';
    const summary = confirmationSummary('doc.import', { title: 'The Storm', parent: 'manuscript', body });
    expect(summary).toBe('import "The Storm" (13 words) under "manuscript"');
    expect(summary).not.toContain('SECRET');
  });

  it('names the binder and codex changes by their count, and by what each one touches', () => {
    // An operation with no action is a change the summary cannot name, so it says so in one phrase rather than guessing.
    expect(confirmationSummary('binder.restructure', { ops: [{}, {}, {}] })).toBe('apply 3 binder operations: a binder change, a binder change, a binder change');
    expect(confirmationSummary('binder.restructure', { ops: [{}] })).toBe('apply 1 binder operation: a binder change');
    expect(confirmationSummary('codex.write', { entries: [{}] })).toBe('write 1 codex entry: add an entry');
    expect(confirmationSummary('binder.restructure', { ops: [] })).toBe('apply 0 binder operations');
  });

  it('names a binder move, rename and create by the titles of the nodes, and lists only the first few', () => {
    const titles: Record<string, string> = { n_CHAPTR0001: 'Chapter 1', n_LANDING01: 'The Landing', n_OLDTITLE01: 'Old Title', manuscript: 'Manuscript' };
    const titleOf = (id: string) => titles[id];
    const summary = confirmationSummary(
      'binder.restructure',
      {
        ops: [
          { action: 'create', parent: 'n_CHAPTR0001', type: 'document', title: 'Scene one' },
          { action: 'move', node: 'n_LANDING01', newParent: 'manuscript', index: 0 },
          { action: 'rename', node: 'n_OLDTITLE01', title: 'Prologue' },
          { action: 'rename', node: 'n_UNKNOWN001', title: 'Other' },
        ],
      },
      titleOf,
    );
    expect(summary).toBe(
      'apply 4 binder operations: add a document "Scene one" under "Chapter 1", move "The Landing" under "Manuscript", rename "Old Title" to "Prologue", and 1 more',
    );
  });

  it('names each codex entry by its name and type, and never by its description', () => {
    const body = 'SECRET-DESCRIPTION of the keeper, which the dialog must not show.';
    const summary = confirmationSummary('codex.write', {
      entries: [
        { action: 'create', name: 'Mira', type: 'character', description: body, aliases: ['M.'] },
        { action: 'update', id: 'c_HARBOR0001', name: 'Harbor' },
      ],
    });
    expect(summary).toBe('write 2 codex entries: add "Mira" (character), change "Harbor"');
    expect(summary).not.toContain('SECRET');
    expect(confirmationSummary('codex.import', { entries: [{ name: 'Mira', type: 'character', description: body, attachTo: ['n_1'] }] })).toBe(
      'import 1 codex entry: add "Mira" (character)',
    );
  });

  it('names a codex update by the entry it changes, which the project holds by id, even when the update repeats no name', () => {
    // An update names its entry by id, so the dialog would say "change an entry" unless the project's name for that id is looked up.
    const names: Record<string, string> = { c_HARBOR0001: 'Harbor Master' };
    const entryNameOf = (id: string) => names[id];
    const summary = confirmationSummary(
      'codex.write',
      { entries: [{ action: 'update', id: 'c_HARBOR0001', description: 'SECRET-DESCRIPTION, which the dialog must not show.' }] },
      undefined,
      entryNameOf,
    );
    expect(summary).toBe('write 1 codex entry: change "Harbor Master"');
    expect(summary).not.toContain('SECRET');
    // An id the project does not hold names the entry the update repeats, and says so when it repeats none.
    expect(confirmationSummary('codex.write', { entries: [{ action: 'update', id: 'c_UNKNOWN001', name: 'Mira' }] }, undefined, entryNameOf)).toBe(
      'write 1 codex entry: change "Mira"',
    );
    expect(confirmationSummary('codex.write', { entries: [{ action: 'update', id: 'c_UNKNOWN001' }] }, undefined, entryNameOf)).toBe(
      'write 1 codex entry: change an entry',
    );
  });

  it('looks a codex entry up by its id in the project, and names none for an id the project does not hold', () => {
    const state = { manifest: { codex: [{ id: 'c_HARBOR0001', name: 'Harbor Master' }] } } as unknown as Parameters<typeof codexEntryNameOf>[0];
    expect(codexEntryNameOf(state, 'c_HARBOR0001')).toBe('Harbor Master');
    expect(codexEntryNameOf(state, 'c_UNKNOWN001')).toBeUndefined();
  });

  it('names an export by its selection and its format, and by the recipe it takes', () => {
    expect(confirmationSummary('export.compile', { format: 'epub', selection: { root: 'manuscript' } })).toBe('compile the manuscript to epub');
    expect(confirmationSummary('export.compile', { format: 'md', selection: { root: 'manuscript' }, recipeName: 'Beta read' })).toBe(
      'compile the manuscript to md with the recipe "Beta read"',
    );
    expect(confirmationSummary('export.compile', { format: 'docx', selection: { root: 'Chapter 1', includeSubtrees: false } })).toBe(
      'compile "Chapter 1" alone to docx',
    );
    expect(confirmationSummary('export.compile', { format: 'md', recipeName: 'Beta read' })).toBe('compile the recipe "Beta read" to md');
  });

  it('names the parent of a document import by its title when the project holds it', () => {
    const titleOf = (id: string) => (id === 'n_CHAPTR0001' ? 'Chapter 1' : undefined);
    expect(confirmationSummary('doc.import', { title: 'The Storm', parent: 'n_CHAPTR0001', body: 'two words' }, titleOf)).toBe(
      'import "The Storm" (2 words) under "Chapter 1"',
    );
  });

  it('falls back to the tool name for a tool it does not describe, and clips a long name', () => {
    expect(confirmationSummary('scene.draft', { doc: 'x' })).toBe('run scene.draft');
    expect(confirmationSummary('x'.repeat(200), {})).toMatch(/^run x+…$/);
  });
});

describe('the confirmation form', () => {
  it('asks for exactly one required boolean, named confirmed', () => {
    expect(Object.keys(CONFIRMATION_SCHEMA.properties)).toEqual(['confirmed']);
    expect(CONFIRMATION_SCHEMA.properties.confirmed.type).toBe('boolean');
    expect(CONFIRMATION_SCHEMA.required).toEqual(['confirmed']);
  });
});

describe('confirmationMessage', () => {
  it('names the change and that nothing changes unless accepted, and the wait only when the connection has one', () => {
    const plain = confirmationMessage('import "A"');
    expect(plain).toBe('Caotang needs your confirmation to import "A". Nothing changes unless you accept.');
    const waits = confirmationMessage('import "A"', 60);
    expect(waits).toContain(plain);
    expect(waits).toContain('This question waits 60 seconds; after that the call fails, nothing changes');
  });
});

describe('createConfirmLedger', () => {
  const answer: CallToolResult = { content: [{ type: 'text', text: 'done' }] };

  it('answers a remembered nonce until it expires, and then forgets it', async () => {
    const ledger = createConfirmLedger();
    ledger.remember('nonce-1', Promise.resolve(answer), 1_000, 0);
    expect(await ledger.recall('nonce-1', 500)).toBe(answer);
    expect(ledger.recall('nonce-1', 1_000)).toBeUndefined();
    expect(ledger.recall('never-seen', 0)).toBeUndefined();
  });

  it('gives a replay that arrives before the answer is ready the same answer, rather than an empty slot', async () => {
    const ledger = createConfirmLedger();
    let settle: (result: CallToolResult) => void = () => undefined;
    ledger.remember('nonce-2', new Promise<CallToolResult>((resolve) => (settle = resolve)), 1_000, 0);
    const replay = ledger.recall('nonce-2', 10);
    expect(replay).toBeDefined();
    settle(answer);
    expect(await replay).toBe(answer);
  });
});

describe('createRoundCodec', () => {
  it('seals a round, opens it back to the same payload, and refuses it once altered', async () => {
    const codec = createRoundCodec();
    const payload = { v: 1 as const, tool: 'doc.import', digest: 'd', turnId: 't', callId: 'c', nonce: 'n' };
    const sealed = await codec.mint(payload);
    const context = {} as Parameters<typeof codec.verify>[1];
    expect(await codec.verify(sealed, context)).toEqual(payload);

    const [head, body = '', mac = ''] = sealed.split('.');
    const forged = `${head}.${body.slice(0, -2)}${body.endsWith('A') ? 'B' : 'A'}.${mac}`;
    await expect(codec.verify(forged, context)).rejects.toThrow();
    await expect(codec.verify('v1.garbage', context)).rejects.toThrow();
  });

  it('opens a state sealed with the same key and refuses one sealed under another, as a restart would', async () => {
    const key = Buffer.alloc(32, 7);
    const payload = { v: 1 as const, tool: 'doc.import', digest: 'd', turnId: 't', callId: 'c', nonce: 'n' };
    const context = {} as Parameters<ReturnType<typeof createRoundCodec>['verify']>[1];
    const sealed = await createRoundCodec(key).mint(payload);
    expect(await createRoundCodec(key).verify(sealed, context)).toEqual(payload);
    await expect(createRoundCodec(Buffer.alloc(32, 8)).verify(sealed, context)).rejects.toThrow();
    // No key given: random per process, so a second codec is a restarted process and cannot open the first's state.
    await expect(createRoundCodec().verify(sealed, context)).rejects.toThrow();
  });
});
