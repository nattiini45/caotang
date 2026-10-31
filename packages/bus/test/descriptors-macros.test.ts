/**
 * The two macro descriptors and the structural reader behind them (extensibility.md §10): what `macro.save` accepts and refuses, with
 * each refusal the spec names. Both commands are `never` for an agent; that is held against the gate in permission.test.ts and, through the
 * store's registry, in the store's exit-gate test.
 */

import { describe, expect, it } from 'vitest';

import {
  COMMAND_REGISTRY,
  MACROS_MAX,
  MACRO_DESCRIPTION_MAX,
  MACRO_NAME_MAX,
  MACRO_SIZE_MAX,
  MACRO_STEPS_MAX,
  isMacroId,
  isMacroSlug,
  macroToolProblem,
  placeholdersOf,
  readMacro,
} from '../src/index.js';
import { makeSnapshot } from './fixtures.js';

const ID = 'm_7K2QX9M4A1';
const OTHER = 'm_ABCDEFGHJK';

const SPEC = {
  kind: 'object',
  description: 'The macro params.',
  properties: {
    chapter: { kind: 'string', description: 'The chapter.' },
    status: { kind: 'enum', description: 'The status.', values: ['draft', 'revised'], default: 'revised' },
    count: { kind: 'integer', description: 'How many.', minimum: 1, maximum: 9 },
    flag: { kind: 'boolean', description: 'A switch.' },
  },
  required: ['chapter'],
};

function macro(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = structuredClone({
    slug: 'revise-chapter',
    name: 'Revise chapter',
    description: 'Marks a chapter revised and notes it.',
    params: SPEC,
    steps: [
      { tool: 'meta.set', params: { node: { $param: 'chapter' }, status: { $param: 'status' } }, expect: 'The chapter is marked revised.' },
      { tool: 'notes.append', params: { node: { $param: 'chapter' }, text: 'Revised.' }, expect: 'A note is added.' },
    ],
  });
  return { ...base, ...overrides };
}

const save = (value: unknown, snapshot = makeSnapshot()) => COMMAND_REGISTRY['macro.save'].descriptor.validate({ macro: value }, snapshot);
const remove = (macroId: unknown, snapshot = makeSnapshot()) => COMMAND_REGISTRY['macro.delete'].descriptor.validate({ macroId }, snapshot);

function steps(count: number): unknown[] {
  return Array.from({ length: count }, (_, i) => ({ tool: 'notes.append', params: { text: `n${i}` }, expect: 'Adds a note.' }));
}

describe('the macro commands are user-only', () => {
  it('is agentRisk never and undone by an inverse, as the spec says', () => {
    for (const name of ['macro.save', 'macro.delete'] as const) {
      expect(COMMAND_REGISTRY[name].descriptor.agentRisk, name).toBe('never');
      expect(COMMAND_REGISTRY[name].descriptor.undo, name).toBe('inverse');
      expect(COMMAND_REGISTRY[name].descriptor.mutates, name).toBe('project');
    }
  });
});

describe('macro.save accepts', () => {
  it('a macro with params and placeholders, returned in its canonical shape', () => {
    const result = save(macro());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value.macro)).toEqual(['slug', 'name', 'description', 'params', 'steps']);
    expect(result.value.macro.steps).toHaveLength(2);
  });

  it('a draft with an id, and a name trimmed', () => {
    const result = save(macro({ id: ID, name: '  Revise chapter  ' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.macro).toMatchObject({ id: ID, name: 'Revise chapter' });
  });

  it('a macro with no params at all', () => {
    const none = { kind: 'object', description: 'No params.', properties: {}, required: [] };
    expect(save(macro({ params: none, steps: steps(1) })).ok).toBe(true);
  });

  it('a placeholder nested inside an array and an object', () => {
    const nested = [{ tool: 'filter.save', params: { criteria: { keywordsAny: [{ $param: 'chapter' }] } }, expect: 'Saves a filter.' }];
    expect(save(macro({ steps: nested })).ok).toBe(true);
  });

  it('exactly the largest steps, name and description', () => {
    const edge = macro({ name: 'n'.repeat(MACRO_NAME_MAX), description: 'd'.repeat(MACRO_DESCRIPTION_MAX), steps: steps(MACRO_STEPS_MAX) });
    expect(save(edge).ok).toBe(true);
  });
});

describe('macro.save refuses', () => {
  it('a step that names a tool a macro may never name', () => {
    for (const tool of ['agent.plan', 'tool.search', 'mcp__notion__search', 'macro.revise-chapter', 'macro.']) {
      const result = save(macro({ steps: [{ tool, params: {}, expect: 'x' }] }));
      expect(result, tool).toMatchObject({ ok: false, error: { code: 'invalid-params', target: 'macro.steps[0].tool' } });
      expect(macroToolProblem(tool), tool).toBeDefined();
    }
    expect(macroToolProblem('meta.set')).toBeUndefined();
  });

  it('a tool name built from a placeholder, since the tool is a plain string', () => {
    expect(save(macro({ steps: [{ tool: { $param: 'chapter' }, params: {}, expect: 'x' }] }))).toMatchObject({ ok: false, error: { target: 'macro.steps[0].tool' } });
  });

  it('more than thirty steps, as a limit, and no steps at all', () => {
    expect(save(macro({ steps: steps(MACRO_STEPS_MAX + 1) }))).toMatchObject({ ok: false, error: { code: 'limit-exceeded' } });
    expect(save(macro({ steps: [] }))).toMatchObject({ ok: false, error: { code: 'invalid-params', target: 'macro.steps' } });
    expect(save(macro({ steps: 'none' }))).toMatchObject({ ok: false });
  });

  it('a placeholder the macro does not declare', () => {
    const result = save(macro({ steps: [{ tool: 'meta.set', params: { node: { $param: 'ghost' } }, expect: 'x' }] }));
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-params' } });
    if (!result.ok) expect(result.error.message).toContain('"ghost"');
  });

  it('a placeholder of the wrong shape: extra keys, a non-string name, or one standing for the whole params', () => {
    for (const bad of [{ $param: 'chapter', extra: 1 }, { $param: 5 }, { $param: null }]) {
      expect(save(macro({ steps: [{ tool: 'meta.set', params: { node: bad }, expect: 'x' }] })), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
    expect(save(macro({ steps: [{ tool: 'meta.set', params: { $param: 'chapter' }, expect: 'x' }] }))).toMatchObject({ ok: false, error: { target: 'macro.steps[0].params' } });
  });

  it('a step with an unknown key, no expect, or params that are not an object', () => {
    expect(save(macro({ steps: [{ tool: 'meta.set', params: {}, expect: 'x', script: 'boom' }] }))).toMatchObject({ ok: false });
    expect(save(macro({ steps: [{ tool: 'meta.set', params: {} }] }))).toMatchObject({ ok: false, error: { target: 'macro.steps[0].expect' } });
    expect(save(macro({ steps: [{ tool: 'meta.set', params: 'x', expect: 'x' }] }))).toMatchObject({ ok: false, error: { target: 'macro.steps[0].params' } });
  });

  it('a script field, since script macros are not in this build', () => {
    const result = save(macro({ script: 'return plan' }));
    expect(result).toMatchObject({ ok: false, error: { target: 'macro.script' } });
    if (!result.ok) expect(result.error.correctiveHint).toContain('not supported');
  });

  it('a prototype key anywhere: a step, a spec, a nested value, the macro itself', () => {
    const proto = JSON.parse('{"__proto__": {"polluted": true}}') as unknown;
    expect(save(macro({ steps: [{ tool: 'meta.set', params: proto, expect: 'x' }] }))).toMatchObject({ ok: false });
    expect(save(macro({ steps: [{ tool: 'meta.set', params: { a: { constructor: 1 } }, expect: 'x' }] }))).toMatchObject({ ok: false });
    expect(save(macro({ steps: [{ tool: 'meta.set', params: { prototype: 1 }, expect: 'x' }] }))).toMatchObject({ ok: false });
    const properties = JSON.parse('{"__proto__": {"kind": "string", "description": "x"}}') as unknown;
    expect(save(macro({ params: { ...SPEC, properties } }))).toMatchObject({ ok: false });
    const top = JSON.parse(JSON.stringify(macro()).replace('"slug"', '"__proto__":{"x":1},"slug"')) as unknown;
    expect(save(top)).toMatchObject({ ok: false });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
  });

  it('a value JSON cannot hold, and a step that nests too deep', () => {
    expect(save(macro({ steps: [{ tool: 'meta.set', params: { n: Number.NaN }, expect: 'x' }] }))).toMatchObject({ ok: false });
    expect(save(macro({ steps: [{ tool: 'meta.set', params: { n: Infinity }, expect: 'x' }] }))).toMatchObject({ ok: false });
    expect(save(macro({ steps: [{ tool: 'meta.set', params: { f: () => 1 }, expect: 'x' }] }))).toMatchObject({ ok: false });
    expect(save(macro({ steps: [{ tool: 'meta.set', params: { u: undefined }, expect: 'x' }] }))).toMatchObject({ ok: false });
    let deep: unknown = 'leaf';
    for (let i = 0; i < 20; i += 1) deep = { a: deep };
    expect(save(macro({ steps: [{ tool: 'meta.set', params: deep, expect: 'x' }] }))).toMatchObject({ ok: false });
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(save({ ...macro(), steps: [{ tool: 'meta.set', params: cyclic, expect: 'x' }] })).toMatchObject({ ok: false });
  });

  it('an oversize payload, by values and by size', () => {
    const wide = { tool: 'meta.set', params: { list: Array.from({ length: 2500 }, (_, i) => i) }, expect: 'x' };
    expect(save(macro({ steps: [wide] }))).toMatchObject({ ok: false, error: { code: 'limit-exceeded' } });
    const long = [{ tool: 'meta.set', params: { text: 'x'.repeat(MACRO_SIZE_MAX) }, expect: 'x' }];
    expect(save(macro({ steps: long }))).toMatchObject({ ok: false, error: { code: 'limit-exceeded' } });
  });

  it('a slug, name, description or id of the wrong kind', () => {
    for (const slug of ['', 'Revise', 'a b', 'a/b', 'x'.repeat(41), 5, null, '../x']) {
      expect(save(macro({ slug })), String(slug)).toMatchObject({ ok: false, error: { target: 'macro.slug' } });
    }
    for (const name of ['', '   ', 'n'.repeat(MACRO_NAME_MAX + 1), 7]) {
      expect(save(macro({ name })), String(name)).toMatchObject({ ok: false, error: { target: 'macro.name' } });
    }
    expect(save(macro({ description: 'd'.repeat(MACRO_DESCRIPTION_MAX + 1) }))).toMatchObject({ ok: false, error: { target: 'macro.description' } });
    expect(save(macro({ description: 5 }))).toMatchObject({ ok: false });
    expect(save(macro({ id: 'g_7K2QX9M4A1' }))).toMatchObject({ ok: false, error: { target: 'macro.id' } });
    expect(save(macro({ id: 'm_short' }))).toMatchObject({ ok: false });
  });

  it('a param spec that is not a small closed one', () => {
    const spec = (properties: unknown, required: unknown = []) => ({ kind: 'object', description: 'p', properties, required });
    const bad: unknown[] = [
      spec({ x: { kind: 'array', description: 'd', items: { kind: 'string', description: 'd' } } }),
      spec({ x: { kind: 'object', description: 'd', properties: {}, required: [] } }),
      spec({ x: { kind: 'string', description: 'd', extra: true } }),
      spec({ x: { kind: 'string' } }),
      spec({ x: { kind: 'enum', description: 'd', values: [] } }),
      spec({ x: { kind: 'enum', description: 'd', values: ['a', 'a'] } }),
      spec({ x: { kind: 'enum', description: 'd', values: ['a'], default: 'b' } }),
      spec({ x: { kind: 'integer', description: 'd', minimum: 5, maximum: 1 } }),
      spec({ 'bad name': { kind: 'string', description: 'd' } }),
      spec({ x: { kind: 'string', description: 'd' } }, ['y']),
      spec({ x: { kind: 'string', description: 'd' } }, ['x', 'x']),
      { ...spec({}), kind: 'string' },
      { ...spec({}), extra: 1 },
      'params',
    ];
    for (const params of bad) expect(save(macro({ params, steps: steps(1) })), JSON.stringify(params)).toMatchObject({ ok: false });
    const many = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`p${i}`, { kind: 'boolean', description: 'd' }]));
    expect(save(macro({ params: spec(many), steps: steps(1) }))).toMatchObject({ ok: false, error: { code: 'limit-exceeded' } });
  });

  it('params that are not a macro, or a key that is not declared', () => {
    expect(COMMAND_REGISTRY['macro.save'].descriptor.validate({ macro: macro(), extra: 1 }, makeSnapshot())).toMatchObject({ ok: false });
    expect(COMMAND_REGISTRY['macro.save'].descriptor.validate({}, makeSnapshot())).toMatchObject({ ok: false });
    expect(save('macro')).toMatchObject({ ok: false });
    expect(save(null)).toMatchObject({ ok: false });
    expect(save([macro()])).toMatchObject({ ok: false });
  });

  it('a slug another macro holds, but not the same macro saved again', () => {
    const snapshot = makeSnapshot({ macros: [{ id: OTHER, slug: 'revise-chapter' }] });
    expect(save(macro(), snapshot)).toMatchObject({ ok: false, error: { target: 'macro.slug' } });
    expect(save(macro({ id: OTHER }), snapshot).ok).toBe(true);
    expect(save(macro({ id: ID }), snapshot)).toMatchObject({ ok: false });
  });

  it('a new macro past the limit, though an existing one may still be changed', () => {
    const held = Array.from({ length: MACROS_MAX }, (_, i) => ({ id: `m_${String(i).padStart(10, '0')}`, slug: `m-${i}` }));
    const snapshot = makeSnapshot({ macros: held });
    expect(save(macro(), snapshot)).toMatchObject({ ok: false, error: { code: 'limit-exceeded' } });
    expect(save(macro({ id: held[3]?.id, slug: 'm-3' }), snapshot).ok).toBe(true);
  });
});

describe('macro.delete', () => {
  it('accepts the id of a macro the project holds', () => {
    expect(remove(ID, makeSnapshot({ macros: [{ id: ID, slug: 'revise-chapter' }] }))).toMatchObject({ ok: true, value: { macroId: ID } });
  });

  it('refuses an id the project does not hold as not-found, and a malformed one as invalid', () => {
    expect(remove(ID)).toMatchObject({ ok: false, error: { code: 'not-found', target: 'macroId' } });
    expect(remove(ID, makeSnapshot({ macros: [{ id: OTHER, slug: 'a' }] }))).toMatchObject({ ok: false, error: { code: 'not-found' } });
    for (const bad of ['', 'g_7K2QX9M4A1', 5, null, undefined]) expect(remove(bad), String(bad)).toMatchObject({ ok: false, error: { code: 'invalid-params' } });
  });
});

describe('the helpers', () => {
  it('knows a macro id, a slug and the placeholders of a value', () => {
    expect(isMacroId(ID)).toBe(true);
    expect(isMacroId('m_7K2QX9M4AI')).toBe(false);
    expect(isMacroSlug('a-1')).toBe(true);
    expect(isMacroSlug('A')).toBe(false);
    expect(placeholdersOf({ a: { $param: 'x' }, b: [{ $param: 'y' }, { $param: 'x' }], c: 1 })).toEqual(['x', 'y']);
  });

  it('reads a stored macro only with its id', () => {
    expect(readMacro(macro(), true)).toMatchObject({ ok: false, error: { target: 'macro.id' } });
    expect(readMacro(macro({ id: ID }), true).ok).toBe(true);
  });
});
