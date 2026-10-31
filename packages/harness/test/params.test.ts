/**
 * The closed-set validator, and the schema it is derived with. Each rule the
 * validator enforces has a case that fails without it.
 */

import { describe, expect, it } from 'vitest';

import { checkParams, param, toJsonSchema, type ParamSpec } from '../src/index.js';

const SPEC = param.object(
  'A test object.',
  {
    name: param.string('A name.', { nonBlank: true, maxLength: 5, overflowHint: 'a name is at most five characters — pick a shorter one' }),
    count: param.integer('A count.', { minimum: 1, maximum: 3, default: 2 }),
    flag: param.boolean('A flag.'),
    kind: param.choice('A kind.', ['alpha', 'beta']),
    tags: param.list('Tags.', param.string('One tag.', { nonBlank: true }), { minItems: 1, maxItems: 2, unique: true }),
    range: param.object('A range.', { from: param.integer('From.', { minimum: 0 }), to: param.integer('To.', { minimum: 0 }) }, ['from', 'to']),
    fields: param.either('Fields, or all.', [
      param.list('Some fields.', param.choice('One field.', ['a', 'b']), { minItems: 1 }),
      param.choice('Every field.', ['all'], { default: 'all' }),
    ]),
    op: param.tagged('An operation.', 'action', {
      create: param.object('Create.', { title: param.string('Title.', { nonBlank: true }) }, ['title']),
      move: param.object('Move.', { index: param.integer('Index.', { minimum: 0 }) }, ['index']),
    }),
    anything: param.freeObject('Any object.'),
  },
  ['name'],
);

describe('the closed-set validator', () => {
  it('accepts a call that matches, and returns only the declared keys', () => {
    const checked = checkParams('test.tool', SPEC, { name: 'ok', count: 1, tags: ['x'], range: { from: 0, to: 4 } });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value).toEqual({ name: 'ok', count: 1, tags: ['x'], range: { from: 0, to: 4 } });
  });

  it('refuses an undeclared top-level key, names it, and lists the accepted set', () => {
    const checked = checkParams('test.tool', SPEC, { name: 'ok', colour: 'red' });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.error.code).toBe('invalid-params');
    expect(checked.error.message).toBe('test.tool takes no param "colour"');
    expect(checked.error.correctiveHint).toContain('accepts only: name, count, flag, kind, tags, range, fields, op, anything');
    expect(checked.error.target).toBe('params.colour');
  });

  it('refuses an undeclared key even when its value is undefined, because the caller named it', () => {
    const checked = checkParams('test.tool', SPEC, { name: 'ok', colour: undefined });
    expect(checked.ok).toBe(false);
  });

  it('treats a declared optional key with an undefined value as absent', () => {
    const checked = checkParams('test.tool', SPEC, { name: 'ok', count: undefined });
    expect(checked.ok).toBe(true);
  });

  it('refuses an unknown key inside a nested object, and names the nested path', () => {
    const checked = checkParams('test.tool', SPEC, { name: 'ok', range: { from: 0, to: 1, step: 2 } });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.error.message).toBe('params.range takes no param "step"');
  });

  it('refuses a missing required key, with the key named', () => {
    const checked = checkParams('test.tool', SPEC, { count: 1 });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.error.message).toBe('params.name is required');
  });

  it('refuses a non-object root', () => {
    const checked = checkParams('test.tool', SPEC, ['name']);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.error.message).toBe('params must be an object, got an array');
  });

  it('refuses a blank string under nonBlank, but not a whitespace-free empty one that nonBlank does not cover', () => {
    const blank = checkParams('test.tool', SPEC, { name: '   ' });
    expect(blank.ok).toBe(false);
    if (blank.ok) return;
    expect(blank.error.message).toBe('params.name must not be blank');
  });

  it('reports a string over its maxLength as a limit, with the spec’s own overflow hint', () => {
    const checked = checkParams('test.tool', SPEC, { name: 'far too long' });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.error.code).toBe('limit-exceeded');
    expect(checked.error.correctiveHint).toBe('a name is at most five characters — pick a shorter one');
  });

  it('counts code points, not UTF-16 units, against maxLength', () => {
    // Five code points, ten UTF-16 units: inside the limit.
    const checked = checkParams('test.tool', SPEC, { name: '𝒜𝒷𝒸𝒹𝒺' });
    expect(checked.ok).toBe(true);
  });

  it('refuses a wrong type with the type named, and an integer that is not whole', () => {
    expect(checkParams('test.tool', SPEC, { name: 3 }).ok).toBe(false);
    const fraction = checkParams('test.tool', SPEC, { name: 'ok', count: 1.5 });
    expect(fraction.ok).toBe(false);
    if (fraction.ok) return;
    expect(fraction.error.message).toBe('params.count must be an integer, got a number');
  });

  it('refuses an integer outside its minimum and maximum', () => {
    expect(checkParams('test.tool', SPEC, { name: 'ok', count: 0 }).ok).toBe(false);
    const high = checkParams('test.tool', SPEC, { name: 'ok', count: 4 });
    expect(high.ok).toBe(false);
    if (high.ok) return;
    expect(high.error.message).toBe('params.count must be ≤ 3, got 4');
  });

  it('refuses an enum value, listing the values that are valid', () => {
    const checked = checkParams('test.tool', SPEC, { name: 'ok', kind: 'gamma' });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.error.message).toBe('params.kind must be one of alpha, beta, got "gamma"');
    expect(checked.error.correctiveHint).toBe('valid kind values: alpha, beta');
  });

  it('reports a list over maxItems as a limit that says to split the call, and a list under minItems as a shape error', () => {
    const over = checkParams('test.tool', SPEC, { name: 'ok', tags: ['a', 'b', 'c'] });
    expect(over.ok).toBe(false);
    if (over.ok) return;
    expect(over.error.code).toBe('limit-exceeded');
    expect(over.error.message).toBe('params.tags has 3 entries, at most 2 allowed');
    expect(over.error.correctiveHint).toContain('split the rest into another call');

    const under = checkParams('test.tool', SPEC, { name: 'ok', tags: [] });
    expect(under.ok).toBe(false);
    if (under.ok) return;
    expect(under.error.code).toBe('invalid-params');
  });

  it('refuses a duplicate entry in a unique list, and names its index', () => {
    const checked = checkParams('test.tool', SPEC, { name: 'ok', tags: ['x', 'x'] });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.error.target).toBe('params.tags[1]');
  });

  it('checks a list item by item, so the refusal names the item that failed', () => {
    const checked = checkParams('test.tool', SPEC, { name: 'ok', tags: ['fine', '  '] });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.error.target).toBe('params.tags[1]');
  });

  it('chooses a union option by JSON type: an array for a list, a string for "all"', () => {
    expect(checkParams('test.tool', SPEC, { name: 'ok', fields: ['a'] }).ok).toBe(true);
    expect(checkParams('test.tool', SPEC, { name: 'ok', fields: 'all' }).ok).toBe(true);
    const wrong = checkParams('test.tool', SPEC, { name: 'ok', fields: 7 });
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.error.message).toContain('params.fields must be');
  });

  it('selects a tagged variant by its tag, and checks that variant’s keys alone', () => {
    expect(checkParams('test.tool', SPEC, { name: 'ok', op: { action: 'create', title: 'T' } }).ok).toBe(true);
    // `index` belongs to move, so under create it is an unknown key.
    const crossed = checkParams('test.tool', SPEC, { name: 'ok', op: { action: 'create', title: 'T', index: 0 } });
    expect(crossed.ok).toBe(false);
    if (crossed.ok) return;
    expect(crossed.error.message).toBe('params.op takes no param "index"');
  });

  it('refuses a tagged value whose tag names no variant, and lists the variants', () => {
    const checked = checkParams('test.tool', SPEC, { name: 'ok', op: { action: 'delete' } });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.error.message).toBe('params.op.action must be one of create, move, got "delete"');
  });

  it('accepts any object under a free-object spec, and refuses a non-object', () => {
    expect(checkParams('test.tool', SPEC, { name: 'ok', anything: { x: 1, y: [2] } }).ok).toBe(true);
    expect(checkParams('test.tool', SPEC, { name: 'ok', anything: 'text' }).ok).toBe(false);
  });

  it('does not fill in a default: a declared default is documentation, and the tool applies it', () => {
    const checked = checkParams('test.tool', SPEC, { name: 'ok' });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect('count' in checked.value).toBe(false);
  });
});

describe('the JSON Schema derived from the same declaration', () => {
  it('closes every object and lists the required keys', () => {
    const schema = toJsonSchema(SPEC);
    expect(schema['additionalProperties']).toBe(false);
    expect(schema['required']).toEqual(['name']);
    const range = (schema['properties'] as Record<string, Record<string, unknown>>)['range'];
    expect(range?.['additionalProperties']).toBe(false);
    expect(range?.['required']).toEqual(['from', 'to']);
  });

  it('states the limits the validator enforces, under the JSON Schema keywords', () => {
    const properties = toJsonSchema(SPEC)['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['name']).toMatchObject({ type: 'string', minLength: 1, maxLength: 5 });
    expect(properties['count']).toMatchObject({ type: 'integer', minimum: 1, maximum: 3, default: 2 });
    expect(properties['tags']).toMatchObject({ type: 'array', minItems: 1, maxItems: 2, uniqueItems: true });
    expect(properties['kind']).toMatchObject({ type: 'string', enum: ['alpha', 'beta'] });
  });

  it('expresses a tagged union as oneOf, with the tag fixed in each variant', () => {
    const op = (toJsonSchema(SPEC)['properties'] as Record<string, Record<string, unknown>>)['op'];
    const variants = op?.['oneOf'] as Record<string, unknown>[];
    expect(variants).toHaveLength(2);
    const create = variants[0] as { properties: Record<string, { enum: string[] }>; required: string[] };
    expect(create.properties['action']?.enum).toEqual(['create']);
    expect(create.required).toContain('action');
  });

  it('expresses a union as anyOf, one option per JSON type', () => {
    const fields = (toJsonSchema(SPEC)['properties'] as Record<string, Record<string, unknown>>)['fields'];
    expect(fields?.['anyOf']).toHaveLength(2);
  });

  it('derives the same key set the validator accepts, for a spec with an optional key', () => {
    const spec: ParamSpec = param.object('Keys.', { a: param.string('A.'), b: param.string('B.') }, ['a']);
    const keys = Object.keys((toJsonSchema(spec)['properties'] as object) ?? {});
    expect(keys).toEqual(['a', 'b']);
    expect(checkParams('keys.tool', spec as Parameters<typeof checkParams>[1], { a: 'x', b: 'y' }).ok).toBe(true);
  });
});

describe('number and nullable', () => {
  const spec = param.object(
    'A result.',
    {
      score: param.number('A score.', { minimum: 0, maximum: 1 }),
      count: param.integer('A count.'),
      session: param.nullable(param.object('A session.', { words: param.integer('Words.') }, ['words'])),
      label: param.nullable(param.choice('A label.', ['a', 'b'])),
      parts: param.nullable(param.list('Parts.', param.string('One part.'))),
      either: param.nullable(param.either('A or B.', [param.string('Text.'), param.boolean('Flag.')])),
    },
    [],
  );

  it('takes a finite number of any kind, within its bounds', () => {
    expect(checkParams('t', spec, { score: 0.25 }).ok).toBe(true);
    expect(checkParams('t', spec, { score: 1.5 }).ok).toBe(false);
    expect(checkParams('t', spec, { score: Number.NaN }).ok).toBe(false);
    expect(checkParams('t', spec, { score: '0.5' }).ok).toBe(false);
    expect(checkParams('t', spec, { count: 0.5 }).ok).toBe(false);
  });

  it('accepts null only where a spec is nullable, at any depth', () => {
    expect(checkParams('t', spec, { session: null, label: null, parts: null, either: null }).ok).toBe(true);
    expect(checkParams('t', spec, { score: null }).ok).toBe(false);
    expect(checkParams('t', spec, { count: null }).ok).toBe(false);
    expect(checkParams('t', spec, { session: { words: null } }).ok).toBe(false);
    expect(checkParams('t', spec, { session: { words: 3 } }).ok).toBe(true);
  });

  it('emits [type, "null"] for a nullable spec, adds null to an enum, and a null branch to a union', () => {
    expect(toJsonSchema(param.nullable(param.string('S.')))).toEqual({ type: ['string', 'null'], description: 'S.' });
    expect(toJsonSchema(param.number('N.', { minimum: 0 }))).toEqual({ type: 'number', description: 'N.', minimum: 0 });
    expect(toJsonSchema(param.nullable(param.choice('C.', ['a', 'b'])))).toEqual({ type: ['string', 'null'], enum: ['a', 'b', null], description: 'C.' });
    expect(toJsonSchema(param.nullable(param.either('U.', [param.string('S.')])))).toEqual({
      description: 'U.',
      anyOf: [{ type: 'string', description: 'S.' }, { type: 'null' }],
    });
    expect(toJsonSchema(param.nullable(param.freeObject('F.')))).toEqual({ type: ['object', 'null'], description: 'F.' });
  });
});
