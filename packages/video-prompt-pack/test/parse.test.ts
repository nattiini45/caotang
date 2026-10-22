/**
 * Reading a model reply back in: a fenced block is unwrapped, and unwrapping stays linear on a long run of blanks.
 */
import { describe, expect, it } from 'vitest';

import { parseDraftReply, parseJsonReply } from '../src/index.js';

/** The pattern the unwrapping used before it was scanned by hand, kept as the oracle for ordinary replies. */
function oldBody(content: string): string {
  const text = content.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(text);
  return fenced === null ? text : (fenced[1] ?? '').trim();
}

describe('parseJsonReply unwraps a fenced block', () => {
  const cases: Record<string, string> = {
    'a json fence': '```json\n{"a":1}\n```',
    'an untagged fence': '```\n{"a":1}\n```',
    'an upper-case tag': '```JSON\n{"a":1}\n```',
    'a fence with CRLF line ends': '```json\r\n{"a":1}\r\n```',
    'a fence with no line breaks': '```{"a":1}```',
    'a fence with blanks around the body': '```json   \n\n  {"a":1}  \n\n  ```',
    'a fence with surrounding blanks': '  \n```json\n{"a":1}\n```\n  ',
    'a body with unicode': '```json\n{"a":"Élodie \u2028 \u00a0 日本語"}\n```',
    'an empty fence': '``````',
    'a fence of only blanks': '```json \n ```',
    'a bare object': '{"a":1}',
    'a lone opening fence': '```json\n{"a":1}',
    'an empty reply': '',
    'a reply of only blanks': ' \n\t ',
  };

  for (const [name, content] of Object.entries(cases)) {
    it(`reads ${name} the way the pattern did`, () => {
      const old = oldBody(content);
      const read = (): unknown => parseJsonReply(content, 'prompt.draft');
      if (old.startsWith('{')) expect(read()).toEqual(JSON.parse(old));
      else expect(read).toThrow();
    });
  }

  it('hands back the object inside a fence', () => {
    expect(parseJsonReply('```json\r\n{"a":1}\r\n```', 'prompt.draft')).toEqual({ a: 1 });
    expect(parseDraftReply('```\n{"subject":" Elena "}\n```').fields).toEqual({ subject: 'Elena' });
  });

  it('keeps a fence inside a string value, since only the outer pair is removed', () => {
    expect(parseJsonReply('```json\n{"a":"```"}\n```', 'prompt.draft')).toEqual({ a: '```' });
  });
});

describe('parseJsonReply stays linear on a long run of blanks', () => {
  it('refuses a fence opened and never closed in well under a second', () => {
    for (const filler of [' ', '\t', '\n', ' \n']) {
      const content = `\`\`\`${filler.repeat(50_000)}x`;
      const start = performance.now();
      expect(() => parseJsonReply(content, 'prompt.draft')).toThrow();
      expect(performance.now() - start).toBeLessThan(250);
    }
  });

  it('reads a fenced body padded with 50k blanks in well under a second', () => {
    const content = `\`\`\`json${' '.repeat(50_000)}{"a":1}${' '.repeat(50_000)}\`\`\``;
    const start = performance.now();
    expect(parseJsonReply(content, 'prompt.draft')).toEqual({ a: 1 });
    expect(performance.now() - start).toBeLessThan(250);
  });
});
