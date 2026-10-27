/**
 * Hooks in the harness (hooks.md): the literal whole-word matching, the runner's order and failure rules, and the three places the
 * harness asks the hooks (the plan's preflight, the call as it runs, and the result as it returns).
 *
 * A hook narrows what the gate lets through and never widens it. The tests that hold that are the ones where a hook says nothing and
 * a call is still refused by the gate, and where a hook blocks and the project is as it was.
 */

import { COMMAND_REGISTRY, createIdempotencyCache, createViewState, execute, type CommandError, type ProjectHook } from '@caotang/bus';
import { loadInkCompiler } from '@caotang/dialogue';
import { createMcpClient, createMockWireFactory } from '@caotang/mcp-client';
import { addDocument, getBody } from '@caotang/store';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  HOOK_SLOW_MS,
  countWholeWord,
  createBriefLedger,
  createBriefPorts,
  createHookRunner,
  createProductHarness,
  foldText,
  hookLabel,
  hookWarnings,
  proseOf,
  TOOL_METADATA,
  TOOL_NAMES,
  type HookInput,
  type HookRun,
  type HookSpec,
} from '../src/index.js';
import { WRITTEN_TEXT } from '../src/hooks.js';
import { CHAPTER_ONE, ENTRY, ENTRY_TWO, LANDING, OPENED, STORM, clock, makeHarness, makeState, refusalOf, run, snapshotOf, valueOf } from './fixtures.js';

let ids = 0;
const nextId = (): string => `h_${String(++ids).padStart(10, '0')}`;

/** A pattern hook: it looks for `words` in what a call would write. */
function pattern(words: readonly string[], over: Partial<ProjectHook> = {}): HookSpec {
  return {
    id: nextId(),
    name: 'No filler',
    event: 'tool.before',
    handler: { kind: 'check', check: { kind: 'pattern', patterns: words.map((match) => ({ match, message: `Avoid ${match}.` })) } },
    enabled: true,
    ...over,
  };
}

function check(check: Extract<ProjectHook['handler'], { kind: 'check' }>['check'], over: Partial<ProjectHook> = {}): HookSpec {
  return { id: nextId(), name: 'A check', event: 'tool.before', handler: { kind: 'check', check }, enabled: true, ...over };
}

const input = (over: Partial<HookInput> = {}): HookInput => ({ event: 'tool.before', tool: 'notes.append', params: { doc: 'The Landing', text: 'plain' }, affected: [], ...over });

describe('a pattern is a literal, whole word', () => {
  it('matches a word at either edge and in the middle, in any case, and counts each occurrence', () => {
    expect(countWholeWord('Suddenly, the lamp failed. SUDDENLY it was dark; suddenly.', 'suddenly')).toBe(3);
    expect(countWholeWord('(suddenly)', 'suddenly')).toBe(1);
    expect(countWholeWord('suddenly', 'Suddenly')).toBe(1);
  });

  it('does not match inside a longer word', () => {
    for (const text of ['suddenlyish', 'unsuddenly', 'suddenly_x', 'x1suddenly', 'suddenly2']) expect(countWholeWord(text, 'suddenly'), text).toBe(0);
  });

  it('has no pattern syntax: a regular expression is only its own characters', () => {
    expect(countWholeWord('It was sudden. It was suddenly.', 'sudden(ly)?')).toBe(0);
    expect(countWholeWord('The text sudden(ly)? appears.', 'sudden(ly)?')).toBe(1);
    expect(countWholeWord('axb a.b', 'a.b')).toBe(1);
    expect(countWholeWord('aab', 'a*b')).toBe(0);
    expect(countWholeWord('x^y$z', '^y$')).toBe(1);
  });

  it('reads a phrase as a unit, and a phrase with punctuation at its edges', () => {
    expect(countWholeWord('He said, all of a sudden, nothing.', 'all of a sudden')).toBe(1);
    expect(countWholeWord('He said all of a suddenly.', 'all of a sudden')).toBe(0);
    expect(countWholeWord('Wait... what?', '...')).toBe(1);
  });

  it('treats composed and decomposed forms as one, and folds case on the NFC form', () => {
    const composed = 'café';
    const decomposed = 'café';
    expect(countWholeWord(`Un ${decomposed} noir`, composed)).toBe(1);
    expect(countWholeWord(`Un ${composed} noir`, decomposed)).toBe(1);
    expect(countWholeWord('L’ÉCOLE', 'école')).toBe(1);
    expect(countWholeWord('ÉCOLE', 'école')).toBe(1);
    expect(foldText('É')).toBe('é');
  });

  it('matches by code point in scripts written without spaces, where there is no boundary to look for', () => {
    expect(countWholeWord('他突然说话了，突然。', '突然')).toBe(2);
    expect(countWholeWord('彼は突然来た', '突然')).toBe(1);
    expect(countWholeWord('ฉันกินข้าว', 'กิน')).toBe(1);
    // Latin beside Han is two words.
    expect(countWholeWord('用AI写', 'AI')).toBe(1);
    expect(countWholeWord('用AIs写', 'AI')).toBe(0);
    // An astral Han character is one code point, and half of it is nothing.
    expect(countWholeWord('字\u{20000}字', '\u{20000}')).toBe(1);
    expect(countWholeWord('\u{20000}', '\ude00')).toBe(0);
  });

  it('reads Greek, Cyrillic and Arabic as the words they are', () => {
    expect(countWholeWord('Ξαφνικά έγινε σκοτάδι', 'ΞΑΦΝΙΚΆ')).toBe(1);
    expect(countWholeWord('Вдруг стало темно', 'вдруг')).toBe(1);
    expect(countWholeWord('Вдругой', 'вдруг')).toBe(0);
    expect(countWholeWord('فجأة حدث', 'فجأة')).toBe(1);
  });

  it('finds nothing for an empty text or an empty pattern', () => {
    expect(countWholeWord('', 'x')).toBe(0);
    expect(countWholeWord('x', '')).toBe(0);
  });

  it('stays fast on the worst text for a scan: a long run of near matches', () => {
    const text = `${'suddenl '.repeat(100_000)}suddenly`;
    const started = Date.now();
    expect(countWholeWord(text, 'suddenly')).toBe(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('the prose a call would write', () => {
  it('is the prose params of a native tool, and not its references', () => {
    expect(proseOf('notes.append', { doc: 'suddenly', text: 'Quiet.' })).toBe('Quiet.');
    expect(proseOf('synopsis.set', { doc: 'x', synopsis: 'A keeper returns.' })).toBe('A keeper returns.');
  });

  it('adds the draft the loop staged, and not the prompt behind it', () => {
    expect(proseOf('scene.draft', { doc: 'x', instruction: 'Go on.' }, { text: 'The ferry came in.', context: { prompt: 'suddenly' } })).toBe('The ferry came in.');
    expect(proseOf('synopsis.fill', { docs: ['x'] }, { items: [{ docId: 'n', synopsis: 'One.' }, { docId: 'm', synopsis: 'Two.' }] })).toBe('One.\nTwo.');
    expect(proseOf('dialogue.draft', { doc: 'x' }, { ink: '=== a ===\nHi.' })).toBe('=== a ===\nHi.');
  });

  it('is every string of an external tool\'s arguments', () => {
    expect(proseOf('mcp__s_ABC__write', { page: { title: 'T', blocks: ['a', 'b'] } })).toBe('T\na\nb');
  });

  it('reads the prose a codex write or import puts in an entry, and a document import\'s title', () => {
    const entries = [{ action: 'create', name: 'Lamp', type: 'object', aliases: ['The Lantern'], description: 'It suddenly glows.', attachTo: ['n_BEACH00001'] }];
    expect(proseOf('codex.write', { entries })).toBe('Lamp\nThe Lantern\nIt suddenly glows.');
    expect(proseOf('codex.import', { entries: [{ name: 'Lamp', type: 'object', description: 'Warm.' }] })).toBe('Lamp\nWarm.');
    expect(proseOf('doc.import', { parent: 'Chapter 1', title: 'Suddenly here', body: 'plain' })).toBe('Suddenly here\nplain');
  });

  it('is nothing for a read, which writes nothing', () => {
    expect(proseOf('doc.read', { doc: 'The Landing' })).toBe('');
  });
});

describe('the limits of an external tool\'s arguments', () => {
  const nest = (depth: number, leaf: unknown): Record<string, unknown> => (depth === 0 ? (leaf as Record<string, unknown>) : { next: nest(depth - 1, leaf) });
  const strings = (count: number): string[] => Array.from({ length: count }, () => 'x');

  it('fails past 500 strings and reads exactly 500', () => {
    expect(proseOf('mcp__s_ABC__post', { list: strings(500) }).split('\n')).toHaveLength(500);
    expect(() => proseOf('mcp__s_ABC__post', { list: [...strings(600), 'suddenly'] })).toThrow('the arguments hold over 500 strings');
    expect(() => proseOf('mcp__s_ABC__post', { list: strings(501) })).toThrow('over 500 strings');
  });

  it('fails past 6 levels of nesting for a string or for a list or object with something in it, and reads 6 levels', () => {
    expect(proseOf('mcp__s_ABC__post', nest(5, 'suddenly'))).toBe('suddenly');
    expect(proseOf('mcp__s_ABC__post', nest(6, 'suddenly'))).toBe('suddenly');
    expect(() => proseOf('mcp__s_ABC__post', nest(7, 'suddenly'))).toThrow('nested over 6 levels deep');
    expect(() => proseOf('mcp__s_ABC__post', nest(8, ['suddenly']))).toThrow('nested over 6 levels deep');
    expect(() => proseOf('mcp__s_ABC__post', nest(8, { a: 1 }))).toThrow('nested over 6 levels deep');
  });

  it('does not fail for a number, a flag, a null or an empty list or object nested deeper, which carry no prose', () => {
    for (const leaf of [1, true, null, [], {}]) expect(proseOf('mcp__s_ABC__post', { deep: nest(5, { under: leaf }), note: 'plain' })).toBe('plain');
  });

  describe('through the runner', () => {
    const state = makeState();
    const tool = 'mcp__s_ABC__post';
    const call = (params: Record<string, unknown>): HookInput => ({ event: 'tool.before', tool, params, affected: [] });
    const sudden = (over: Partial<ProjectHook> = {}): HookSpec => pattern(['suddenly'], { matcher: { tools: [tool] }, ...over });
    const tooDeep = call(nest(8, 'suddenly'));
    const tooMany = call({ list: [...strings(600), 'suddenly'] });

    it('blocks under failClosed rather than passing text it did not read, and says why', () => {
      for (const params of [tooDeep, tooMany]) {
        const [blocked] = createHookRunner([sudden({ failClosed: true })], { state }).run(params);
        expect(blocked?.decision.action).toBe('block');
        expect(blocked?.failed).toMatch(/the arguments (are nested over 6 levels deep|hold over 500 strings)/);
      }
    });

    it('warns that the step was not checked without failClosed', () => {
      for (const params of [tooDeep, tooMany]) {
        const [warned] = createHookRunner([sudden()], { state }).run(params);
        expect(warned?.decision).toMatchObject({ action: 'warn', reason: expect.stringContaining('the step was not checked') });
        expect(warned?.failed).toBeDefined();
      }
    });

    it('holds a words hook to the same limits', () => {
      const words = check({ kind: 'words', max: 10 }, { matcher: { tools: [tool] }, failClosed: true });
      const [blocked] = createHookRunner([words], { state }).run(tooDeep);
      expect(blocked?.decision.action).toBe('block');
      expect(blocked?.failed).toContain('6 levels');
    });

    it('still finds the word six levels down', () => {
      const [warned] = createHookRunner([sudden()], { state }).run(call(nest(6, 'suddenly')));
      expect(warned?.decision).toEqual({ action: 'warn', reason: '“suddenly” appears: Avoid suddenly.' });
      expect(warned?.failed).toBeUndefined();
    });
  });
});

describe('the text a native write tool writes', () => {
  const state = makeState();
  const everything = (tool: string, params: Record<string, unknown>, over: Partial<ProjectHook> = {}) =>
    createHookRunner([pattern(['suddenly'], { onBlock: 'block', failClosed: true, ...over })], { state }).run({ event: 'tool.before', tool, params, affected: [] });

  it('lists a row for every write tool, and every free string of its params is read or set aside, so a new tool cannot go unguarded', () => {
    const tools = makeHarness().tools();
    const free = (schema: unknown, at: string, out: string[]): string[] => {
      if (typeof schema !== 'object' || schema === null) return out;
      const node = schema as Record<string, unknown>;
      if (node['type'] === 'string') {
        if (node['enum'] === undefined) out.push(at);
        return out;
      }
      for (const [key, value] of Object.entries((node['properties'] ?? {}) as Record<string, unknown>)) free(value, at === '' ? key : `${at}.${key}`, out);
      if (node['items'] !== undefined) free(node['items'], `${at}[]`, out);
      for (const option of [...((node['oneOf'] as unknown[] | undefined) ?? []), ...((node['anyOf'] as unknown[] | undefined) ?? [])]) free(option, at, out);
      return out;
    };
    const writes = TOOL_METADATA.filter((meta) => meta.risk.startsWith('write'));
    expect(writes.length).toBeGreaterThan(20);
    for (const meta of writes) {
      const row = WRITTEN_TEXT[meta.name];
      expect(row, `${meta.name} has no row in WRITTEN_TEXT`).toBeDefined();
      const schema = tools.find((tool) => tool.name === meta.name)?.schema;
      const strings = [...new Set(free(schema, '', []))];
      const known = new Set([...(row?.read ?? []), ...(row?.skip ?? [])]);
      expect(strings.filter((path) => !known.has(path)), `${meta.name}: free strings neither read nor set aside`).toEqual([]);
      expect([...known].filter((path) => !strings.includes(path)), `${meta.name}: a listed string its params do not have`).toEqual([]);
    }
    expect(Object.keys(WRITTEN_TEXT).filter((name) => !writes.some((meta) => meta.name === name))).toEqual([]);
  });

  const entries = [{ action: 'create', name: 'Lamp', type: 'object', description: 'It suddenly glows.' }];
  const cases: readonly { readonly tool: string; readonly params: Record<string, unknown> }[] = [
    { tool: 'codex.write', params: { entries } },
    { tool: 'codex.write', params: { entries: [{ action: 'create', name: 'Suddenly', type: 'object' }] } },
    { tool: 'codex.write', params: { entries: [{ action: 'update', id: ENTRY, aliases: ['Suddenly'] }] } },
    { tool: 'codex.import', params: { entries: [{ name: 'ferry', attachTo: [LANDING], type: 'object', description: 'It suddenly arrives.' }] } },
    { tool: 'doc.import', params: { parent: 'Chapter 1', title: 'Suddenly here', body: 'plain' } },
  ];

  it('is read for codex.write, codex.import and doc.import, so a hook that names a word holds them', () => {
    for (const { tool, params } of cases) {
      const [blocked] = everything(tool, params);
      expect(blocked?.decision, tool).toEqual({ action: 'block', reason: '“suddenly” appears: Avoid suddenly.' });
      expect(blocked?.failed).toBeUndefined();
    }
    const [clean] = everything('doc.import', { title: 'Here', body: 'plain' });
    expect(clean?.decision).toEqual({ action: 'allow' });
  });

  it('is not read from the references a call names: a title that finds a document is not text the call writes', () => {
    expect(everything('doc.import', { parent: 'Suddenly', title: 'Here', body: 'plain' })[0]?.decision.action).toBe('allow');
    expect(everything('notes.append', { doc: 'Suddenly', text: 'plain' })[0]?.decision.action).toBe('allow');
    expect(everything('meta.set', { targets: ['Suddenly'], status: 'final' })[0]?.decision.action).toBe('allow');
  });

  it('stops the write itself through the harness and leaves the project as it was', () => {
    for (const { tool, params } of cases) {
      const project = makeState();
      const harness = makeHarness({ hooks: [pattern(['suddenly'], { onBlock: 'block', failClosed: true })] }, project);
      const before = snapshotOf(project);
      const error = refusalOf(run(harness, tool, params, { permission: { confirmed: true } }));
      expect(codeOf(error), tool).toBe('hook_blocked');
      expect(snapshotOf(project)).toBe(before);
    }
  });

  it('warns on the call when the hook only warns', () => {
    const project = makeState();
    const harness = makeHarness({ hooks: [pattern(['suddenly'])] }, project);
    const value = valueOf(run(harness, 'codex.write', { entries }, { permission: { confirmed: true }, turnId: 'tw' }));
    expect(value.hookNotes).toEqual([{ hook: 'No filler', text: '“suddenly” appears: Avoid suddenly.' }]);
    expect(harness.takeHookRuns('tw').map((r) => r.decision.action)).toEqual(['warn']);
  });
});

describe('the runner', () => {
  const state = makeState();
  const runner = (hooks: readonly HookSpec[], deps: Partial<Parameters<typeof createHookRunner>[1]> = {}) => createHookRunner(hooks, { state, ...deps });

  it('runs the hooks of the event and the tool, in declaration order, and skips the rest', () => {
    const hooks = [
      pattern(['alpha'], { name: 'first' }),
      pattern(['alpha'], { name: 'other tool', matcher: { tools: ['meta.set'] } }),
      pattern(['alpha'], { name: 'off', enabled: false }),
      pattern(['alpha'], { name: 'after', event: 'tool.after' }),
      pattern(['alpha'], { name: 'user only', matcher: { issuedBy: 'user' } }),
      pattern(['alpha'], { name: 'last', matcher: { tools: ['notes.append'] } }),
    ];
    const runs = runner(hooks).run(input({ params: { doc: 'x', text: 'alpha' } }));
    expect(runs.map((r) => r.name)).toEqual(['first', 'last']);
  });

  it('warns by default and blocks only when the writer said so', () => {
    const text = { doc: 'x', text: 'a very bad word' };
    const [warned] = runner([pattern(['very'])]).run(input({ params: text }));
    expect(warned?.decision).toEqual({ action: 'warn', reason: '“very” appears: Avoid very.' });
    const [blocked] = runner([pattern(['very'], { onBlock: 'block' })]).run(input({ params: text }));
    expect(blocked?.decision).toEqual({ action: 'block', reason: '“very” appears: Avoid very.' });
    const [passed] = runner([pattern(['very'], { onBlock: 'block' })]).run(input({ params: { doc: 'x', text: 'a plain word' } }));
    expect(passed?.decision).toEqual({ action: 'allow' });
  });

  it('stops at the first block: the hooks after it are not asked', () => {
    const runs = runner([pattern(['very'], { name: 'one', onBlock: 'block' }), pattern(['very'], { name: 'two', onBlock: 'block' })]).run(input({ params: { doc: 'x', text: 'very' } }));
    expect(runs.map((r) => r.name)).toEqual(['one']);
    // A warning does not stop the next hook.
    const warns = runner([pattern(['very'], { name: 'one' }), pattern(['very'], { name: 'two' })]).run(input({ params: { doc: 'x', text: 'very' } }));
    expect(warns.map((r) => r.name)).toEqual(['one', 'two']);
  });

  it('turns a failed check at tool.after into a note for the model, and says the step has already run for a hook that blocks', () => {
    const after = input({ event: 'tool.after', params: { doc: 'x', text: 'very' } });
    const [note] = runner([pattern(['very'], { event: 'tool.after' })]).run(after);
    expect(note?.decision).toEqual({ action: 'context', text: '“very” appears: Avoid very.' });
    const [late] = runner([pattern(['very'], { event: 'tool.after', onBlock: 'block' })]).run(after);
    expect(late?.decision).toMatchObject({ action: 'context', text: expect.stringContaining('The step has already run; the writer can undo it.') });
  });

  it('warns that the step was not checked when a check throws, and blocks only under failClosed', () => {
    const broken = check({ kind: 'coherence', checks: ['no.such-check'] }, { name: 'Broken', affected: undefined } as Partial<ProjectHook>);
    const withNode = input({ affected: [LANDING] });
    const [warned] = runner([broken]).run(withNode);
    expect(warned).toMatchObject({ decision: { action: 'warn', reason: expect.stringContaining('the step was not checked') }, failed: expect.stringContaining('no.such-check') });
    const [closed] = runner([{ ...broken, failClosed: true }]).run(withNode);
    expect(closed?.decision.action).toBe('block');
    // After the call there is nothing left to block, so it warns.
    const [late] = runner([{ ...broken, failClosed: true, event: 'tool.after' }]).run({ ...withNode, event: 'tool.after' });
    expect(late?.decision.action).toBe('warn');
  });

  it('records how long a check took, and warns about one that took over two seconds', () => {
    let now = 0;
    const clock = () => {
      now += HOOK_SLOW_MS + 500;
      return now;
    };
    const [slow] = runner([pattern(['never'])], { now: clock }).run(input({ params: { doc: 'x', text: 'fine' } }));
    expect(slow?.ms).toBe(HOOK_SLOW_MS + 500);
    expect(slow?.decision).toMatchObject({ action: 'warn', reason: expect.stringContaining('took 2.5 seconds') });
    let quiet = 0;
    const [fast] = runner([pattern(['never'])], { now: () => (quiet += 3) }).run(input({ params: { doc: 'x', text: 'fine' } }));
    expect(fast).toMatchObject({ ms: 3, decision: { action: 'allow' } });
  });

  it('holds the caps even for a list that did not come through the bus: 20 hooks, 50 patterns, 300 characters', () => {
    const many = Array.from({ length: 25 }, (_, i) => pattern(['zzz'], { name: `hook ${i}` }));
    expect(runner(many).run(input({ params: { doc: 'x', text: 'zzz' } }))).toHaveLength(20);
    const fifty = Array.from({ length: 60 }, (_, i) => `word${i}`);
    const runs = runner([pattern(fifty)]).run(input({ params: { doc: 'x', text: 'word49 word50' } }));
    expect(runs[0]?.decision).toEqual({ action: 'warn', reason: '“word49” appears: Avoid word49.' });
    const long = 'q'.repeat(400);
    const [clipped] = runner([pattern([long])]).run(input({ params: { doc: 'x', text: 'q'.repeat(300) } }));
    expect(clipped?.decision.action).toBe('warn');
  });

  it('reads the hooks at each call, so a change applies to the next one', () => {
    let held: readonly HookSpec[] = [];
    const live = createHookRunner(() => held, { state });
    const call = input({ params: { doc: 'x', text: 'very' } });
    expect(live.run(call)).toEqual([]);
    held = [pattern(['very'])];
    expect(live.run(call)).toHaveLength(1);
  });

  it('is synchronous: preflight and run return their runs, not a promise', () => {
    const result = runner([pattern(['very'])]).preflight({ ...input({ params: { doc: 'x', text: 'very' } }), event: 'tool.before' });
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown as { then?: unknown }).then).toBeUndefined();
  });

  describe('the status check', () => {
    const statusHook = check({ kind: 'status', allowed: ['Draft', 'revised'] }, { onBlock: 'block' });

    it('passes a document whose status is allowed, by id or by the name the vocabulary gives it', () => {
      const s = makeState();
      const r = createHookRunner([statusHook], { state: s });
      expect(r.run(input({ affected: [LANDING] }))[0]?.decision.action).toBe('allow');
    });

    it('blocks a document in another status, naming it, and a folder or a document with none', () => {
      const s = makeState();
      const node = s.manifest.tree.find((n) => n.id === LANDING);
      if (node === undefined) throw new Error('fixture');
      node.status = 'final';
      const r = createHookRunner([statusHook], { state: s });
      expect(r.run(input({ affected: [LANDING] }))[0]?.decision).toEqual({ action: 'block', reason: '“The Landing” is not marked “Draft” or “revised”.' });
      node.status = null;
      expect(r.run(input({ affected: [LANDING] }))[0]?.decision.action).toBe('block');
    });

    it('says nothing about a call that touches no node', () => {
      expect(createHookRunner([statusHook], { state: makeState() }).run(input({ affected: [] }))[0]?.decision.action).toBe('allow');
    });
  });

  describe('the words check', () => {
    it('bounds the text a call would write before it runs', () => {
      const r = runner([check({ kind: 'words', max: 3 }, { onBlock: 'block' })]);
      expect(r.run(input({ params: { doc: 'x', text: 'one two three' } }))[0]?.decision.action).toBe('allow');
      expect(r.run(input({ params: { doc: 'x', text: 'one two three four' } }))[0]?.decision).toEqual({ action: 'block', reason: 'The text is 4 words, over the 3 this hook allows.' });
      expect(r.run(input({ params: { doc: 'x' } }))[0]?.decision.action).toBe('allow');
      const under = runner([check({ kind: 'words', min: 5 })]);
      expect(under.run(input({ params: { doc: 'x', text: 'one two' } }))[0]?.decision).toMatchObject({ action: 'warn', reason: 'The text is 2 words, under the 5 this hook asks for.' });
    });

    it('counts words the way the project does: a Han text is segmented, not one word', () => {
      const r = runner([check({ kind: 'words', max: 2 })]);
      expect(r.run(input({ params: { doc: 'x', text: '他突然说话了然后离开' } }))[0]?.decision.action).toBe('warn');
    });

    it('bounds the documents a call changed once it has run', () => {
      const r = runner([check({ kind: 'words', max: 3 }, { event: 'tool.after' })]);
      const outcome = r.run({ ...input({ event: 'tool.after', affected: [LANDING] }) });
      expect(outcome[0]?.decision).toMatchObject({ action: 'context', text: '“The Landing” is 6 words, over the 3 this hook allows.' });
    });
  });

  describe('the coherence check', () => {
    function collided() {
      const s = makeState();
      const kestrel = s.manifest.codex?.find((entry) => entry.id === ENTRY_TWO);
      if (kestrel === undefined) throw new Error('fixture');
      kestrel.aliases = ['Elena'];
      return s;
    }

    it('reports the findings of the named checks in the documents a call touched, and quotes the project only in the note for the model', () => {
      const s = collided();
      const hook = check({ kind: 'coherence', checks: ['codex.alias-collisions'] }, { event: 'tool.after', name: 'Aliases' });
      const [note] = createHookRunner([hook], { state: s }).run(input({ event: 'tool.after', affected: [LANDING] }));
      expect(note?.decision.action).toBe('context');
      const text = note?.decision.action === 'context' ? note.decision.text : '';
      expect(text).toContain('1 finding from codex.alias-collisions in “The Landing”.');
      expect(text).toMatch(/\n- .*Elena/);
      const [warn] = createHookRunner([{ ...hook, event: 'tool.before' }], { state: s }).run(input({ affected: [LANDING] }));
      expect(warn?.decision).toEqual({ action: 'warn', reason: '1 finding from codex.alias-collisions in “The Landing”.' });
    });

    it.each(['branch.loose-end', 'branch.dead-end', 'dialogue.speaker-unknown', 'medium.speaker-parity'])('treats %s, which a document scan does not run, as a failure of the hook and not a pass', (id) => {
      const hook = check({ kind: 'coherence', checks: [id] }, { onBlock: 'block', failClosed: true });
      const [run] = createHookRunner([hook], { state: makeState() }).run(input({ affected: [LANDING] }));
      expect(run).toMatchObject({ decision: { action: 'block' }, failed: expect.stringContaining('did not run') });
      const [warned] = createHookRunner([{ ...hook, failClosed: false }], { state: makeState() }).run(input({ affected: [LANDING] }));
      expect(warned?.decision.action).toBe('warn');
    });

    it('says nothing for a project with no finding, and leaves the held coherence file alone', () => {
      const s = makeState();
      const before = JSON.stringify(s.coherence ?? null);
      const hook = check({ kind: 'coherence', checks: ['codex.alias-collisions'] }, { event: 'tool.after' });
      expect(createHookRunner([hook], { state: s }).run(input({ event: 'tool.after', affected: [LANDING] }))[0]?.decision.action).toBe('allow');
      expect(JSON.stringify(s.coherence ?? null)).toBe(before);
      const c = collided();
      createHookRunner([hook], { state: c }).run(input({ event: 'tool.after', affected: [LANDING] }));
      expect(c.coherence?.findings ?? []).toEqual([]);
    });

    it('keeps findings below the severity the hook asks for out of its note', () => {
      const s = collided();
      const hook = check({ kind: 'coherence', checks: ['codex.alias-collisions'], severityAtLeast: 'error' }, { event: 'tool.after' });
      expect(createHookRunner([hook], { state: s }).run(input({ event: 'tool.after', affected: [LANDING] }))[0]?.decision.action).toBe('allow');
    });

    it('reads no document a read rule withholds', () => {
      const s = collided();
      const hook = check({ kind: 'coherence', checks: ['codex.alias-collisions'] }, { event: 'tool.after' });
      const r = createHookRunner([hook], { state: s, withheld: () => new Set([LANDING]) });
      expect(r.run(input({ event: 'tool.after', affected: [LANDING] }))[0]?.decision.action).toBe('allow');
    });

    it('does not scan a call that touches more documents than the scan guard allows, and warns that it did not', () => {
      const s = makeState();
      const affected: string[] = [];
      for (let i = 0; i < 25; i += 1) {
        const id = `n_BULK${String(i).padStart(6, '0')}`;
        addDocument(s, { parentId: CHAPTER_ONE, title: `Bulk ${i}`, now: OPENED, id, body: 'x' });
        affected.push(id);
      }
      const [guarded] = createHookRunner([check({ kind: 'coherence', checks: ['codex.alias-collisions'] }, { event: 'tool.after' })], { state: s }).run(input({ event: 'tool.after', affected }));
      expect(guarded?.decision).toMatchObject({ action: 'warn', reason: expect.stringContaining('scan guard') });
    });
  });
});

describe('a hook label', () => {
  it('is one short line with no marker characters', () => {
    expect(hookLabel('No “suddenly”')).toBe('No “suddenly”');
    expect(hookLabel('x'.repeat(100))).toHaveLength(60);
    expect(hookLabel('a\nb')).toBe('a b');
    expect(hookLabel('<<untrusted id="x">>')).not.toMatch(/[<>"]/);
  });
});

/** The refusal's ask-back code, when the call was refused by a hook. */
const codeOf = (error: CommandError): unknown => error.details?.['askBackCode'];

describe('through the harness', () => {
  const sudden = (over: Partial<ProjectHook> = {}): HookSpec => pattern(['suddenly'], { name: 'No suddenly', onBlock: 'block', matcher: { tools: ['notes.append'] }, ...over });
  const append = { doc: 'The Landing', text: 'Suddenly the lamp failed.' };

  it('refuses a call at tool.before when a hook blocks, names the hook, and writes nothing', () => {
    const state = makeState();
    const harness = makeHarness({ hooks: [sudden()] }, state);
    const before = snapshotOf(state);
    const error = refusalOf(run(harness, 'notes.append', append, { turnId: 't1' }));
    expect(error.code).toBe('permission-denied');
    expect(codeOf(error)).toBe('hook_blocked');
    expect(error.message).toContain('The hook “No suddenly” stopped notes.append: “suddenly” appears: Avoid suddenly.');
    expect(error.message).toContain('Nothing was run.');
    expect(error.correctiveHint).toContain('only the writer can change a hook');
    expect(snapshotOf(state)).toBe(before);
    expect(harness.log.length).toBe(0);
    expect(harness.takeHookRuns('t1').map((r) => [r.name, r.event, r.decision.action])).toEqual([['No suddenly', 'tool.before', 'block']]);
    expect(harness.takeHookRuns('t1')).toEqual([]);
  });

  it('lets a call through a warning, and tells the model in a note the model reads as data', () => {
    const state = makeState();
    const harness = makeHarness({ hooks: [sudden({ onBlock: 'warn' })] }, state);
    const value = valueOf(run(harness, 'notes.append', append, { turnId: 't2' }));
    expect(value.undoGroupId).toBeDefined();
    expect(value.hookNotes).toEqual([{ hook: 'No suddenly', text: '“suddenly” appears: Avoid suddenly.' }]);
    expect(state.manifest.tree.find((n) => n.id === LANDING)?.notes).toContain('Suddenly');
    expect(harness.takeHookRuns('t2').map((r) => r.decision.action)).toEqual(['warn']);
  });

  it('adds what a tool.after hook reports to the result, and the call has run', () => {
    const state = makeState();
    const harness = makeHarness({ hooks: [sudden({ event: 'tool.after', onBlock: undefined })] }, state);
    const value = valueOf(run(harness, 'notes.append', append, { turnId: 't3' }));
    expect(value.hookNotes).toEqual([{ hook: 'No suddenly', text: '“suddenly” appears: Avoid suddenly.' }]);
    expect(value.affected.map((node) => node.nodeId)).toEqual([LANDING]);
    expect(harness.takeHookRuns('t3')[0]?.decision.action).toBe('context');
  });

  it('answers a replay of a call from its record, notes included, and does not ask the hooks again', () => {
    const harness = makeHarness({ hooks: [sudden({ event: 'tool.after', onBlock: undefined })] });
    const first = run(harness, 'notes.append', append, { turnId: 't4', callId: 'same' });
    harness.takeHookRuns('t4');
    const second = run(harness, 'notes.append', append, { turnId: 't4', callId: 'same' });
    expect(second).toEqual(first);
    expect(harness.takeHookRuns('t4')).toEqual([]);
  });

  it('keeps a call that no hook speaks about exactly as it was', () => {
    const harness = makeHarness({ hooks: [sudden()] });
    const value = valueOf(run(harness, 'notes.append', { doc: 'The Landing', text: 'The lamp failed.' }));
    expect(value).not.toHaveProperty('hookNotes');
  });

  it('asks the hooks for a call that is not one of the matcher\'s tools only to skip it', () => {
    const state = makeState();
    const harness = makeHarness({ hooks: [sudden()] }, state);
    expect(valueOf(run(harness, 'meta.set', { targets: [LANDING], status: 'final' })).undoGroupId).toBeDefined();
  });

  describe('at the plan\'s preflight', () => {
    const plan = (text: string) => ({ steps: [{ tool: 'notes.append', params: { doc: 'The Landing', text }, expect: 'a note' }] });

    it('shows the block as a refused step, with the hook\'s reason, and runs nothing', () => {
      const state = makeState();
      const harness = makeHarness({ hooks: [sudden()] }, state);
      const before = snapshotOf(state);
      const checked = harness.previewPlan(plan('Suddenly.'), { turnId: 't5' });
      expect(checked.ok).toBe(true);
      if (!checked.ok) return;
      expect(checked.value.ok).toBe(false);
      expect(checked.value.steps[0]).toMatchObject({ status: 'refused', error: { code: 'permission-denied' } });
      expect(codeOf(checked.value.steps[0]?.error as CommandError)).toBe('hook_blocked');
      expect(snapshotOf(state)).toBe(before);
      expect(harness.log.length).toBe(0);
      expect(harness.takeHookRuns('t5').map((r) => r.decision.action)).toEqual(['block']);
    });

    it('keeps a warning on the step, and the step stays ready', () => {
      const harness = makeHarness({ hooks: [sudden({ onBlock: 'warn' })] });
      const checked = harness.previewPlan(plan('Suddenly.'));
      if (!checked.ok) throw new Error('refused');
      expect(checked.value.ok).toBe(true);
      expect(checked.value.steps[0]?.status).toBe('ready');
      expect(checked.value.steps[0]?.hooks?.map((r) => r.decision.action)).toEqual(['warn']);
    });

    it('says nothing of a step the hooks pass', () => {
      const harness = makeHarness({ hooks: [sudden()] });
      const checked = harness.previewPlan(plan('The lamp failed.'));
      if (!checked.ok) throw new Error('refused');
      expect(checked.value.steps[0]).not.toHaveProperty('hooks');
    });

    it('records one report row for the same hook saying the same thing about the same step, however often the card is checked', () => {
      const harness = makeHarness({ hooks: [sudden({ onBlock: 'warn' })] });
      for (let i = 0; i < 4; i += 1) harness.previewPlan(plan('Suddenly.'), { turnId: 't6' });
      expect(harness.takeHookRuns('t6')).toHaveLength(1);
    });

    it('checks the project as it stands when the plan runs: a change between the card and the run is the run-time block', () => {
      const state = makeState();
      const harness = makeHarness({ hooks: [check({ kind: 'status', allowed: ['draft'] }, { name: 'Drafts only', onBlock: 'block', matcher: { tools: ['notes.append'] } })] }, state);
      const card = harness.previewPlan(plan('A note.'), { turnId: 't7' });
      if (!card.ok) throw new Error('refused');
      expect(card.value.ok).toBe(true);
      // The writer marks the scene final while the card is open.
      const node = state.manifest.tree.find((n) => n.id === LANDING);
      if (node === undefined) throw new Error('fixture');
      node.status = 'final';
      const before = snapshotOf(state);
      const outcome = harness.executePlan(plan('A note.'), { turnId: 't7', callId: 'plan-7' });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.value.status).toBe('refused');
      expect(outcome.value).toMatchObject({ preflight: { steps: [{ status: 'refused' }] } });
      expect(snapshotOf(state)).toBe(before);
      expect(harness.log.length).toBe(0);
      expect(harness.takeHookRuns('t7').map((r) => r.decision.action)).toEqual(['block']);
    });

    it('blocks at run time when only the run sees the change: a call made directly, after an earlier clean check', () => {
      const state = makeState();
      const harness = makeHarness({ hooks: [check({ kind: 'status', allowed: ['draft'] }, { name: 'Drafts only', onBlock: 'block', matcher: { tools: ['notes.append'] } })] }, state);
      expect(valueOf(run(harness, 'notes.append', { doc: 'The Landing', text: 'First.' })).undoGroupId).toBeDefined();
      const node = state.manifest.tree.find((n) => n.id === LANDING);
      if (node === undefined) throw new Error('fixture');
      node.status = 'final';
      const error = refusalOf(run(harness, 'notes.append', { doc: 'The Landing', text: 'Second.' }));
      expect(codeOf(error)).toBe('hook_blocked');
      expect(node.notes).not.toContain('Second.');
    });

    it('never awaits, and never reaches a connected server or runs a port', () => {
      const client = createMcpClient({
        settings: { enabled: true, servers: [] },
        wire: createMockWireFactory({}),
        probe: async () => false,
        now: () => '2026-10-08T09:00:00.000Z',
        listTimeoutMs: 1_000,
        callTimeoutMs: 1_000,
      });
      const spies = Object.getOwnPropertyNames(Object.getPrototypeOf(client))
        .filter((name) => name !== 'constructor' && typeof (client as unknown as Record<string, unknown>)[name] === 'function')
        .map((name) => vi.spyOn(client as unknown as Record<string, () => unknown>, name));
      const port = vi.fn(() => ({ ok: true as const, value: { data: {}, summary: '', affected: [] } }));
      const harness = makeHarness({
        hooks: [sudden(), check({ kind: 'coherence', checks: ['codex.alias-collisions'] }, { matcher: { tools: ['notes.append'] } })],
        mcp: { client },
        ports: { 'scene.draft': port },
      });
      for (const spy of spies) spy.mockClear();
      const checked = harness.previewPlan(plan('Suddenly.'));
      const drafted = harness.previewPlan({ steps: [{ tool: 'scene.draft', params: { doc: 'The Landing', instruction: 'Go on.', mode: 'continue' }, expect: 'a draft' }] }, { turnId: 't10', proposals: [{ text: 'Suddenly.', words: 1, revision: 0 }] });
      expect(checked.ok).toBe(true);
      expect(drafted.ok).toBe(true);
      expect((checked as unknown as { then?: unknown }).then).toBeUndefined();
      expect(spies.length).toBeGreaterThan(0);
      expect(spies.flatMap((spy) => spy.mock.calls)).toEqual([]);
      expect(port).not.toHaveBeenCalled();
    });
  });

  describe('a hook never widens the gate', () => {
    it('leaves an unapproved write-confirm call refused by the gate, and does not ask the hooks', () => {
      const source = vi.fn(() => [pattern(['never-here'], { name: 'Quiet' })]);
      const state = makeState();
      const harness = makeHarness({ hooks: source }, state);
      const before = snapshotOf(state);
      source.mockClear();
      const error = refusalOf(run(harness, 'notes.replace', { doc: 'The Landing', notes: 'x' }));
      expect(error.code).toBe('permission-denied');
      expect(error.message).toContain('"notes.replace" is a write-confirm tool');
      expect(codeOf(error)).toBeUndefined();
      expect(source).not.toHaveBeenCalled();
      expect(snapshotOf(state)).toBe(before);
    });

    it('leaves a call a rule denies refused by the rule, and does not ask the hooks', () => {
      const source = vi.fn(() => [] as HookSpec[]);
      const harness = makeHarness({ hooks: source, rules: () => ({ rules: [{ effect: 'deny', tool: 'notes.append', source: 'project' }] }) });
      source.mockClear();
      const error = refusalOf(run(harness, 'notes.append', { doc: 'The Landing', text: 'x' }));
      expect(error.code).toBe('permission-denied');
      expect(error.details?.['rule']).toBeDefined();
      expect(source).not.toHaveBeenCalled();
    });

    it('leaves a hard-denied command hard-denied for an agent, hooks or none', () => {
      const state = makeState();
      const harness = makeHarness({ hooks: [pattern(['x'])] }, state);
      const result = execute(
        { id: 'cmd_0000000001', name: 'project.deleteNode', params: { nodeId: STORM }, issuedBy: 'agent', createdAt: 0, turnId: 't', callId: 'c' },
        { state, view: createViewState(), read: () => state, undo: harness.undo, log: harness.log, idempotency: createIdempotencyCache(), notify: () => {} },
        harness.registry,
      );
      expect(result).toMatchObject({ ok: false, error: { code: 'hard-denied' } });
    });

    it('offers the agent no way to write a hook: neither command is a tool, both are never-class, and a plan that names one is refused in the writer\'s words', () => {
      const harness = makeHarness({ hooks: [] });
      const names = harness.tools().map((tool) => tool.name as string);
      for (const name of ['hook.save', 'hook.delete']) {
        expect(names).not.toContain(name);
        expect(COMMAND_REGISTRY[name as 'hook.save'].descriptor.agentRisk).toBe('never');
        const error = refusalOf(run(harness, name, { hookId: 'h_0000000001' }));
        expect(error.code).toBe('not-found');
        expect(error.message).toContain('hooks are set in Settings › Hooks');
        const planned = harness.previewPlan({ steps: [{ tool: name, params: {}, expect: 'a hook' }] });
        if (!planned.ok) throw new Error('malformed');
        expect(planned.value.steps[0]).toMatchObject({ status: 'refused', error: { message: expect.stringContaining('hooks are set in Settings › Hooks') } });
      }
    });

    it('lets no tool dispatch a hook command: every tool\'s prepared commands avoid them', () => {
      // The registry rows are the only way an agent names a command, and none of them is the hook family.
      const dispatched = new Set<string>();
      const harness = makeHarness({ hooks: [] });
      for (const tool of harness.tools()) for (const word of tool.description.match(/hook\.(save|delete)/g) ?? []) dispatched.add(`${tool.name}:${word}`);
      expect([...dispatched]).toEqual([]);
    });
  });

  it('reaches an agent\'s own turn-scoped caches only through the loop: the hook runs of a turn are dropped with the turn', () => {
    const harness = makeHarness({ hooks: [sudden()] });
    run(harness, 'notes.append', append, { turnId: 't8' });
    harness.endTurn('t8');
    expect(harness.takeHookRuns('t8')).toEqual([]);
  });

  it('holds an external caller to the hooks too', () => {
    const harness = makeHarness({ hooks: [sudden()], externalWrites: true });
    const error = refusalOf(run(harness, 'notes.append', append, { source: 'mcp', turnId: 'ext' }));
    expect(codeOf(error)).toBe('hook_blocked');
  });
});

describe('a hook scoped to a draft tool', () => {
  const TAVERN = 'n_TAVERN0001';
  beforeAll(loadInkCompiler);

  /** An external host, as the MCP server builds it: the brief ports, writes on, and the writer's hooks. */
  function host(hooks: readonly HookSpec[]) {
    const state = makeState();
    addDocument(state, { id: TAVERN, parentId: 'manuscript', title: 'Tavern', type: 'dialogue', body: '', now: OPENED });
    const harness = createProductHarness({
      state,
      ports: 'external',
      externalWrites: true,
      externalPorts: createBriefPorts({ ledger: createBriefLedger({ now: () => clock.now() }) }),
      clock: clock.now,
      hooks,
    });
    const brief = (name: string, params: Record<string, unknown>) => {
      const result = valueOf(harness.external.call({ name, callId: `brief-${ids++}`, params }, { turnId: 'mcp-turn' }));
      return (result.data as { applyWith: Record<string, unknown> }).applyWith;
    };
    return { state, harness, brief };
  }

  it('also holds scene.apply, the row an external host writes prose through', () => {
    const { state, harness, brief } = host([pattern(['suddenly'], { matcher: { tools: ['scene.draft'] }, onBlock: 'block' })]);
    const before = getBody(state, LANDING);
    const applyWith = brief('scene.brief', { doc: LANDING, instruction: 'Carry on.', mode: 'continue' });
    const error = refusalOf(run(harness, 'scene.apply', { ...applyWith, text: 'Suddenly, the lamp failed.' }, { permission: { confirmed: true } }));
    expect(codeOf(error)).toBe('hook_blocked');
    expect(getBody(state, LANDING)).toBe(before);
    expect(valueOf(run(harness, 'scene.apply', { ...applyWith, text: 'The lamp failed.' }, { permission: { confirmed: true } })).summary).toContain('continued');
  });

  it('also holds dialogue.apply', () => {
    const { state, harness, brief } = host([pattern(['suddenly'], { matcher: { tools: ['dialogue.draft'] }, onBlock: 'block' })]);
    const applyWith = brief('dialogue.brief', { doc: TAVERN, instruction: 'A thank-you.' });
    const ink = ['=== reply ===', 'Suddenly, thanks.', '-> END'].join('\n');
    const error = refusalOf(run(harness, 'dialogue.apply', { ...applyWith, ink }, { permission: { confirmed: true } }));
    expect(codeOf(error)).toBe('hook_blocked');
    expect(getBody(state, TAVERN)).toBe('');
  });

  it('does not reach a row whose mirrored tool the matcher leaves out', () => {
    const { harness, brief } = host([pattern(['suddenly'], { matcher: { tools: ['notes.append'] }, onBlock: 'block' })]);
    const applyWith = brief('scene.brief', { doc: LANDING, instruction: 'Carry on.', mode: 'continue' });
    expect(run(harness, 'scene.apply', { ...applyWith, text: 'Suddenly, the lamp failed.' }, { permission: { confirmed: true } }).ok).toBe(true);
  });

  it('holds the row an in-app tool stands for when the matcher names the in-app tool by a glob', () => {
    const { harness, brief } = host([pattern(['suddenly'], { matcher: { tools: ['scene.*'] }, onBlock: 'block' })]);
    const applyWith = brief('scene.brief', { doc: LANDING, instruction: 'Carry on.', mode: 'continue' });
    const error = refusalOf(run(harness, 'scene.apply', { ...applyWith, text: 'Suddenly, the lamp failed.' }, { permission: { confirmed: true } }));
    expect(codeOf(error)).toBe('hook_blocked');
  });
});

describe('a matcher takes globs, as a rule does', () => {
  const state = makeState();
  const runner = (hooks: readonly HookSpec[]) => createHookRunner(hooks, { state });
  const text = { doc: 'x', text: 'It suddenly glows.' };

  it('holds every tool a glob names, and not the others', () => {
    const hook = pattern(['suddenly'], { onBlock: 'block', matcher: { tools: ['notes.*'] } });
    expect(runner([hook]).run(input({ tool: 'notes.append', params: text }))[0]?.decision.action).toBe('block');
    expect(runner([hook]).run(input({ tool: 'synopsis.set', params: { doc: 'x', synopsis: 'It suddenly glows.' } }))).toEqual([]);
    expect(runner([pattern(['suddenly'], { matcher: { tools: ['*.append'] } })]).run(input({ params: text }))).toHaveLength(1);
  });

  it('holds an external tool by a glob over its qualified name', () => {
    const hook = pattern(['suddenly'], { onBlock: 'block', matcher: { tools: ['mcp__slack__*'] } });
    const call = { event: 'tool.before' as const, params: { message: 'It suddenly glows.' }, affected: [] };
    expect(runner([hook]).run({ ...call, tool: 'mcp__slack__post' })[0]?.decision.action).toBe('block');
    expect(runner([hook]).run({ ...call, tool: 'mcp__other__post' })).toEqual([]);
  });

  it('still takes an exact name, and * for every tool', () => {
    expect(runner([pattern(['suddenly'], { matcher: { tools: ['notes.append'] } })]).run(input({ params: text }))).toHaveLength(1);
    expect(runner([pattern(['suddenly'], { matcher: { tools: ['*'] } })]).run(input({ params: text }))).toHaveLength(1);
  });

  it('blocks a call through the harness, as the hook was written, and writes nothing', () => {
    const project = makeState();
    const harness = makeHarness({ hooks: [pattern(['suddenly'], { onBlock: 'block', matcher: { tools: ['notes.*'] } })] }, project);
    const before = snapshotOf(project);
    expect(codeOf(refusalOf(run(harness, 'notes.append', { doc: 'The Landing', text: 'It suddenly glows.' })))).toBe('hook_blocked');
    expect(snapshotOf(project)).toBe(before);
  });
});

describe('a matcher name that matches no tool', () => {
  const state = makeState();
  const typo = (names: readonly string[], over: Partial<ProjectHook> = {}): HookSpec => pattern(['suddenly'], { name: 'No suddenly', matcher: { tools: names }, ...over });

  it('is one warning for each name, and none for a name that can match', () => {
    expect(hookWarnings([typo(['notes.apend'])], TOOL_NAMES)).toEqual(['Hook “No suddenly”: “notes.apend” matches no tool, so it never fires. Check the spelling']);
    expect(hookWarnings([typo(['nots.*'])], TOOL_NAMES)).toHaveLength(1);
    expect(hookWarnings([typo(['notes.append', 'notes.apend'])], TOOL_NAMES)).toHaveLength(1);
    for (const names of [['notes.*'], ['*'], ['mcp__x__*'], ['scene.draft'], ['mcp__slack__post']]) expect(hookWarnings([typo(names)], TOOL_NAMES), names.join()).toEqual([]);
  });

  it('says nothing of a hook that is off or has no matcher', () => {
    expect(hookWarnings([typo(['notes.apend'], { enabled: false }), pattern(['suddenly'])], TOOL_NAMES)).toEqual([]);
  });

  it('warns on a write call, so the hook is not taken for one that found nothing to object to', () => {
    const [warned] = createHookRunner([typo(['notes.apend'])], { state }).run(input({ params: { doc: 'x', text: 'plain' } }));
    expect(warned?.decision).toEqual({ action: 'warn', reason: 'No tool is named “notes.apend”, so this hook never fires. Check the spelling.' });
    // A read, and the event after a call, are not spoken for.
    expect(createHookRunner([typo(['notes.apend'])], { state }).run(input({ tool: 'doc.read', params: { doc: 'x' } }))).toEqual([]);
    expect(createHookRunner([typo(['notes.apend'], { event: 'tool.after' })], { state }).run(input({ event: 'tool.after' }))).toEqual([]);
  });

  it('blocks every write call under block and failClosed, since the writer meant to stop steps and none is stopped', () => {
    const closed = typo(['notes.apend'], { onBlock: 'block', failClosed: true });
    const [blocked] = createHookRunner([closed], { state }).run(input({ params: { doc: 'x', text: 'plain' } }));
    expect(blocked?.decision).toMatchObject({ action: 'block', reason: expect.stringContaining('The hook could not run (no tool is named “notes.apend”)') });
    expect(blocked?.failed).toBe('no tool is named “notes.apend”');
    // Failing closed takes both settings: a hook that only warns, or that is not fail-closed, does not stop the step.
    expect(createHookRunner([typo(['notes.apend'], { onBlock: 'block' })], { state }).run(input())[0]?.decision.action).toBe('warn');
    expect(createHookRunner([typo(['notes.apend'], { failClosed: true })], { state }).run(input())[0]?.decision.action).toBe('warn');
  });

  it('stops the call through the harness and writes nothing', () => {
    const project = makeState();
    const harness = makeHarness({ hooks: [typo(['notes.apend'], { onBlock: 'block', failClosed: true })] }, project);
    const before = snapshotOf(project);
    const error = refusalOf(run(harness, 'notes.append', { doc: 'The Landing', text: 'plain' }));
    expect(codeOf(error)).toBe('hook_blocked');
    expect(snapshotOf(project)).toBe(before);
  });

  it('does not stop a call when a name in the matcher is live', () => {
    const closed = typo(['notes.apend', 'notes.append'], { onBlock: 'block', failClosed: true });
    expect(createHookRunner([closed], { state }).run(input({ params: { doc: 'x', text: 'plain' } }))[0]?.decision).toEqual({ action: 'allow' });
  });
});

describe('what a run is', () => {
  it('names the hook, the event and the tool, and keeps only the runs that spoke', () => {
    const harness = makeHarness({ hooks: [pattern(['suddenly'], { name: 'Quiet one', matcher: { tools: ['notes.append'] } })] });
    run(harness, 'notes.append', { doc: 'The Landing', text: 'Fine.' }, { turnId: 't9' });
    expect(harness.takeHookRuns('t9')).toEqual([]);
    run(harness, 'notes.append', { doc: 'The Landing', text: 'Suddenly.' }, { turnId: 't9' });
    const [spoke] = harness.takeHookRuns('t9') as HookRun[];
    expect(spoke).toMatchObject({ name: 'Quiet one', event: 'tool.before', tool: 'notes.append' });
  });
});
