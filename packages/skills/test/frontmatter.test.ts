import { describe, expect, it } from 'vitest';

import { FrontMatterError, readFrontMatter, type FieldValue } from '../src/frontmatter.js';

const doc = (...lines: string[]): string => ['---', ...lines, '---', 'Body.', ''].join('\n');
const scalar = (source: string, key: string): string => {
  const field = readFrontMatter(source).fields.get(key);
  if (field?.kind !== 'scalar') throw new Error(`no scalar “${key}”: ${JSON.stringify(field)}`);
  return field.value;
};
const field = (source: string, key: string): FieldValue | undefined => readFrontMatter(source).fields.get(key);
const refused = (source: string): string => {
  try {
    readFrontMatter(source);
  } catch (cause) {
    expect(cause).toBeInstanceOf(FrontMatterError);
    return (cause as Error).message;
  }
  throw new Error('the front matter was read');
};

describe('the front matter reader: what it reads', () => {
  it('splits the file into its front matter and its body, keeping both byte for byte', () => {
    const source = '---\nname: a\ndescription: b\n---\n\n# Title\n\nBody.\n';
    const read = readFrontMatter(source);
    expect(read.text).toBe('---\nname: a\ndescription: b\n---\n');
    expect(read.body).toBe('\n# Title\n\nBody.\n');
    expect(read.text + read.body).toBe(source);
  });

  it('keeps CRLF line endings and a byte-order mark in the text it hands back', () => {
    const source = '\uFEFF---\r\nname: a\r\ndescription: b c\r\n---\r\nBody\r\n';
    const read = readFrontMatter(source);
    expect(read.text + read.body).toBe(source);
    expect(scalar(source, 'description')).toBe('b c');
  });

  it('reads plain scalars, a trailing comment, and a plain value that carries on over indented lines', () => {
    expect(scalar(doc('description: one two # a comment'), 'description')).toBe('one two');
    expect(scalar(doc('description: first line', '  second line', '  third line', 'name: x'), 'description')).toBe('first line second line third line');
    expect(scalar(doc('description: first', '', '  after a blank'), 'description')).toBe('first\nafter a blank');
    expect(scalar(doc('description: has a # comment after a space'), 'description')).toBe('has a');
    expect(scalar(doc('description: no#comment here'), 'description')).toBe('no#comment here');
  });

  it('reads single- and double-quoted scalars, with their escapes', () => {
    expect(scalar(doc("description: 'it''s: fine'"), 'description')).toBe("it's: fine");
    expect(scalar(doc('description: "a: b \\"c\\" \\u00e9 \\x41 \\t|"'), 'description')).toBe('a: b "c" é A \t|');
    expect(scalar(doc('description: "x" # trailing'), 'description')).toBe('x');
  });

  it('folds a quoted scalar that runs over several lines', () => {
    const source = doc('description: "Use this when the writer asks for', '    a close third person voice,', '', '    past tense."', 'name: x');
    expect(scalar(source, 'description')).toBe('Use this when the writer asks for a close third person voice,\npast tense.');
    expect(scalar(doc("description: 'one", '  two', "  three'"), 'description')).toBe('one two three');
    expect(scalar(doc('description: "joined\\', '   without a space"'), 'description')).toBe('joinedwithout a space');
  });

  it('reads literal and folded block scalars with their chomping', () => {
    expect(scalar(doc('description: |', '  line one', '  line two', 'name: x'), 'description')).toBe('line one\nline two\n');
    expect(scalar(doc('description: |-', '  line one', '  line two', 'name: x'), 'description')).toBe('line one\nline two');
    expect(scalar(doc('description: |+', '  line one', '', 'name: x'), 'description')).toBe('line one\n\n');
    expect(scalar(doc('description: >', '  folded one', '  folded two', '', '  next paragraph', 'name: x'), 'description')).toBe('folded one folded two\nnext paragraph\n');
    expect(scalar(doc('description: >-', '  folded one', '  folded two'), 'description')).toBe('folded one folded two');
    expect(scalar(doc('description: |', '  a', '    b more indented', '  c'), 'description')).toBe('a\n  b more indented\nc\n');
  });

  it('reads a one-level metadata map, a block list and a flow list', () => {
    const source = doc('metadata:', '  short-description: Manage issues', '  version: "1.0"', 'allowed-tools:', '  - Read', '  - Grep', 'tags: [a, "b c", d]');
    expect(field(source, 'metadata')).toEqual({ kind: 'map', entries: { 'short-description': 'Manage issues', version: '1.0' } });
    expect(field(source, 'allowed-tools')).toEqual({ kind: 'list', items: ['Read', 'Grep'] });
    expect(field(source, 'tags')).toEqual({ kind: 'list', items: ['a', 'b c', 'd'] });
    expect(field(doc('allowed-tools:', '- Read', '- Write', 'name: x'), 'allowed-tools')).toEqual({ kind: 'list', items: ['Read', 'Write'] });
    expect(field(doc('m: {a: 1, b: "two"}'), 'm')).toEqual({ kind: 'map', entries: { a: '1', b: 'two' } });
  });

  it('skips a key it does not use, however it is written, and keeps reading after it', () => {
    const source = doc('extra:', '  deep:', '    deeper: 1', '  other: [1, [2]]', 'name: kept');
    expect(field(source, 'extra')).toEqual({ kind: 'other' });
    expect(scalar(source, 'name')).toBe('kept');
  });

  it('treats a key with no value as empty text', () => {
    expect(scalar(doc('description:', 'name: x'), 'description')).toBe('');
  });

  it('records how a scalar was written, so "true" and true can be told apart', () => {
    expect(field(doc('a: true'), 'a')).toEqual({ kind: 'scalar', value: 'true', style: 'plain' });
    expect(field(doc('a: "true"'), 'a')).toEqual({ kind: 'scalar', value: 'true', style: 'quoted' });
  });
});

describe('the front matter reader: what it refuses', () => {
  it('needs an opening and a closing line', () => {
    expect(refused('name: a\n')).toMatch(/does not start with/);
    expect(refused('---\nname: a\n')).toMatch(/no closing/);
  });

  it('refuses anchors, aliases and tags, anywhere a value starts', () => {
    expect(refused(doc('a: &x one'))).toMatch(/anchor or an alias/);
    expect(refused(doc('a: *x'))).toMatch(/anchor or an alias/);
    expect(refused(doc('a: !!str one'))).toMatch(/tag/);
    expect(refused(doc('a:', '  - &x one'))).toMatch(/anchor or an alias/);
    expect(refused(doc('a:', '  k: *x'))).toMatch(/anchor or an alias/);
    expect(refused(doc('a: [one, *x]'))).toMatch(/anchor or an alias/);
    expect(refused(doc('<<: *x'))).toMatch(/not a key/);
  });

  it('refuses a second document, a directive, and a document that is a list', () => {
    expect(refused('---\na: b\n--- extra\n---\n')).toMatch(/more than one/);
    expect(refused('---\na: b\n...\n---\n')).toMatch(/more than one/);
    expect(refused(doc('%YAML 1.2'))).toMatch(/directive/);
    expect(refused(doc('- a', '- b'))).toMatch(/list/);
  });

  it('refuses a tab in the indentation, a duplicate key, and an indent under nothing', () => {
    expect(refused(doc('a:', '\tb: c'))).toMatch(/tab/);
    expect(refused(doc('a: 1', 'a: 2'))).toMatch(/appears twice/);
    expect(refused(doc('  a: 1'))).toMatch(/indented under nothing/);
  });

  it('refuses a plain value a YAML parser would also refuse, and says to quote it', () => {
    expect(refused(doc('description: Use when: the writer asks'))).toMatch(/put the whole value in quotes/);
    expect(refused(doc('description: ends with a colon:'))).toMatch(/quotes/);
  });

  it('refuses a quoted value that is not closed, has a bad escape, or has text after it', () => {
    expect(refused(doc('a: "open'))).toMatch(/not closed/);
    expect(refused(doc('a: "bad \\q escape"'))).toMatch(/bad escape/);
    expect(refused(doc('a: "\\ud800"'))).toMatch(/bad escape/);
    expect(refused(doc('a: "done" more'))).toMatch(/after its closing quote/);
    expect(refused(doc('a: [one, two'))).toMatch(/not closed/);
  });

  it('reads a flow list across lines, and a long unclosed one in linear time', () => {
    expect(field(doc('a: [one,', '  "t]wo",', '  three]'), 'a')).toEqual({ kind: 'list', items: ['one', 't]wo', 'three'] });
    const lines = Array.from({ length: 25_000 }, () => '[');
    const started = Date.now();
    expect(refused(doc('z: [', ...lines))).toMatch(/not closed|not written/);
    expect(refused(doc('m: [', ...Array.from({ length: 17_000 }, () => 'a,')))).toMatch(/not closed/);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('refuses a value that starts with a character YAML reserves', () => {
    expect(refused(doc('a: @mention'))).toMatch(/put it in quotes/);
    expect(refused(doc('a: `code`'))).toMatch(/put it in quotes/);
  });
});

describe('the front matter reader: nothing backtracks', () => {
  it('reads long hostile lines in linear time', () => {
    const long = 'x'.repeat(200_000);
    const started = Date.now();
    readFrontMatter(doc(`description: ${long}`));
    refused(doc(`description: ${' '.repeat(100_000)}${':'.repeat(100_000)}`));
    readFrontMatter(doc(`description: "${'\\ '.repeat(50_000)}"`));
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
