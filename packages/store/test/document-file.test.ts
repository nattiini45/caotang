/**
 * Document-file codec — [project-format.md §3](docs/architecture/project-format.md).
 *
 * §3 has three load-bearing claims: front matter holds node-local facts only
 * (no `parentId`, no `order`), the body never carries a title heading, and the
 * body is the irreplaceable content. Plus the writer's own promise: stable key
 * order and a folded `>-` synopsis so diffs stay minimal.
 */

import { describe, expect, it } from 'vitest';
import {
  formatFrontMatter,
  parseDocumentFile,
  parseFrontMatter,
  parseFrontMatterFields,
  serializeDocumentFile,
  type DocumentFrontMatter,
} from '../src/index.js';

const fm = (over: Partial<DocumentFrontMatter> = {}): DocumentFrontMatter => ({
  id: 'n_3W8RN2TQ6C',
  title: 'The Landing',
  status: 'draft',
  label: 'act-1',
  keywords: ['sea', 'grief'],
  synopsis: 'Elena returns to the island after nine years.',
  ...over,
});

describe('front matter', () => {
  it('writes the spec §3 shape, in a stable key order', () => {
    expect(formatFrontMatter(fm())).toBe(
      [
        '---',
        'id: n_3W8RN2TQ6C',
        'title: The Landing',
        'status: draft',
        'label: act-1',
        'keywords: [sea, grief]',
        'synopsis: >-',
        '  Elena returns to the island after nine years.',
        '---',
        '',
      ].join('\n'),
    );
  });

  it('never writes structure into front matter — that would force a rewrite per drag', () => {
    const text = formatFrontMatter(fm());
    expect(text).not.toContain('parentId');
    expect(text).not.toContain('order');
  });

  it('round-trips every field', () => {
    const original = fm();
    expect(parseFrontMatter(formatFrontMatter(original))).toEqual(
      original,
    );
  });

  it('quotes a title that a plain scalar could not carry', () => {
    const tricky = fm({ title: 'Chapter 1: The Landing', synopsis: '# not a heading' });
    const text = formatFrontMatter(tricky);
    expect(text).toContain('title: "Chapter 1: The Landing"');
    // Inside a block scalar `#` is literal, so the synopsis needs no quoting.
    expect(text).toContain('synopsis: >-\n  # not a heading');
    expect(parseFrontMatter(text)).toEqual(tricky);
  });

  it('quotes a string that YAML would otherwise re-read as a number or bool', () => {
    const tricky = fm({ title: '1984', synopsis: '' });
    const text = formatFrontMatter(tricky);
    expect(text).toContain('title: "1984"');
    expect(text).toContain("synopsis: ''");
    expect(parseFrontMatter(text)).toEqual(tricky);
  });

  it('uses a literal block for a multi-line synopsis, because folded would eat the breaks', () => {
    const multi = fm({ synopsis: 'Line one.\nLine two.' });
    const text = formatFrontMatter(multi);
    expect(text).toContain('synopsis: |-');
    expect(parseFrontMatter(text)).toEqual(multi);
  });

  it('round-trips an empty synopsis, null status and null label', () => {
    const bare = fm({ status: null, label: null, keywords: [], synopsis: '' });
    const text = formatFrontMatter(bare);
    expect(text).toContain('status: null');
    expect(text).toContain('label: null');
    expect(text).toContain('keywords: []');
    expect(parseFrontMatter(text)).toEqual(bare);
  });

  it('reads what a real YAML writer would produce, not just what we emit', () => {
    const fromElsewhere = [
      'id: n_3W8RN2TQ6C',
      "title: 'The Landing'",
      'status: null',
      'label: null',
      'keywords: [sea, "grief, and salt"]',
      'synopsis: |',
      '  Line one.',
      '  Line two.',
    ].join('\n');
    expect(parseFrontMatter(fromElsewhere)).toEqual({
      id: 'n_3W8RN2TQ6C',
      title: 'The Landing',
      status: null,
      label: null,
      keywords: ['sea', 'grief, and salt'],
      synopsis: 'Line one.\nLine two.\n',
    });
  });

  it('tolerates CRLF and comments in a hand-edited file', () => {
    const fromElsewhere = [
      '---',
      '# written on Windows',
      'id: n_3W8RN2TQ6C',
      'title: The Landing',
      'status: draft',
      'label: null',
      'keywords: [sea]',
      'synopsis: Late.',
      '---',
    ].join('\r\n');
    expect(parseFrontMatter(fromElsewhere).title).toBe('The Landing');
  });

  it('refuses a block with no id rather than inventing one', () => {
    expect(() => parseFrontMatter('title: Nameless')).toThrow(/no `id`/);
  });
});

describe('document file', () => {
  it('puts exactly one blank line between the fence and the body', () => {
    expect(serializeDocumentFile(fm(), 'The ferry was late, as always.')).toBe(
      `${formatFrontMatter(fm())}\nThe ferry was late, as always.\n`,
    );
  });

  it('round-trips the body byte-for-byte, scene separator and all', () => {
    const body = 'The ferry was late, as always.\n\n***\n\nLater, the light.';
    const file = serializeDocumentFile(fm(), body);
    expect(parseDocumentFile(file).body).toBe(body);
  });

  it('preserves a body with no trailing newline, which is what the editor holds', () => {
    const body = 'no trailing newline';
    expect(parseDocumentFile(serializeDocumentFile(fm(), body)).body).toBe(body);
  });

  it('preserves a deliberately leading blank line (it consumes exactly one)', () => {
    const body = '\nstarts with a blank line';
    expect(parseDocumentFile(serializeDocumentFile(fm(), body)).body).toBe(body);
  });

  // The trailing-newline half of the contract. The writer used to add no
  // terminator to a body that already ended in '\n', and the reader always
  // strips one, so 'abc\n' came back as 'abc' — a verbatim import lost a line
  // on every save. The terminator is now always written, and the reader strips
  // exactly the one the writer put there.
  it.each([
    ['one trailing newline', 'The ferry was late.\n'],
    ['two trailing newlines', 'The ferry was late.\n\n'],
    ['only a newline', '\n'],
    ['only two newlines', '\n\n'],
    ['a trailing CRLF', 'The ferry was late.\r\n'],
    ['a bare trailing CR', 'The ferry was late.\r'],
  ])('round-trips a body ending in %s byte-for-byte', (_label, body) => {
    expect(parseDocumentFile(serializeDocumentFile(fm(), body)).body).toBe(body);
  });

  it('round-trips trailing-newline bodies under a CRLF fence, byte-for-byte', () => {
    for (const body of ['abc\n', 'abc\r\n', 'abc\r', '\n', '\r\n', '\r\nleading CRLF']) {
      const file = serializeDocumentFile(fm(), body, { newline: '\r\n' });
      expect(parseDocumentFile(file).body).toBe(body);
    }
  });

  it('reads a hand-authored CRLF file with its one terminator stripped', () => {
    const raw = ['---', 'id: n_3W8RN2TQ6C', 'title: The Landing', '---', '', 'The ferry was late.', ''].join('\r\n');
    expect(parseDocumentFile(raw).body).toBe('The ferry was late.');
  });

  it('preserves non-ASCII and curly quotes untouched', () => {
    const body = 'naïve façade — “curly” — 日本語';
    expect(parseDocumentFile(serializeDocumentFile(fm(), body)).body).toBe(body);
  });

  it('does not normalise CRLF bodies: the store is not the MD dialect owner', () => {
    const body = 'windows line one\r\nwindows line two';
    expect(parseDocumentFile(serializeDocumentFile(fm(), body)).body).toBe(body);
  });

  it('handles an empty body without inventing a blank line', () => {
    const file = serializeDocumentFile(fm(), '');
    expect(file.endsWith('---\n')).toBe(true);
    expect(parseDocumentFile(file).body).toBe('');
  });

  it('reads a CRLF file back with the same body', () => {
    const body = 'line one\r\nline two';
    const file = serializeDocumentFile(fm(), body, { newline: '\r\n' });
    expect(file).toContain('\r\n');
    expect(parseDocumentFile(file).body).toBe(body);
  });

  it('refuses a file that is not a Caotang document', () => {
    expect(() => parseDocumentFile('# just markdown\n')).toThrow(/front matter fence/);
    expect(() => parseDocumentFile('---\nid: n_3W8RN2TQ6C\n')).toThrow(/closing/);
  });
});

describe('folded block scalars', () => {
  // Pinned when a no-op `\n(?!\n)` -> `\n` replacement was dropped from the
  // folding step: the output must be exactly what the join and the trailing
  // space strip produce.
  const fold = (yaml: string): string | null | undefined =>
    parseFrontMatterFields(yaml).get('synopsis')?.scalar;

  it('joins consecutive lines with a space', () => {
    expect(fold('synopsis: >-\n  one\n  two\n  three\n')).toBe('one two three');
  });

  it('turns a blank line into a single newline', () => {
    expect(fold('synopsis: >-\n  one\n  two\n\n  three\n')).toBe('one two\nthree');
  });

  it('keeps consecutive blank lines as consecutive newlines', () => {
    expect(fold('synopsis: >-\n  one\n\n\n  two\n')).toBe('one\n\ntwo');
  });

  it('strips spaces before a newline and honours clip chomping', () => {
    expect(fold('synopsis: >\n  one   \n\n  two\n')).toBe('one\ntwo\n');
  });

  it('decodes CRLF and unicode the same way', () => {
    expect(fold('synopsis: >-\r\n  café\r\n  über\r\n')).toBe('café über');
  });

  it('handles an empty block', () => {
    expect(fold('synopsis: >-\n')).toBe('');
  });
});
