/**
 * The redaction the gateway and the harness share (#870): `redact` for a log line, an error detail and every string of a trace
 * event, `redactSecrets` for a header value or a reason phrase, and `createSecretScrubber` for an answer's bytes.
 *
 * One rule for all three: each secret is replaced once, in one pass, longest first — and the text a replacement puts in is never
 * considered a secret itself. A generic profile may carry any key (`checkKey` accepts a single character, and so does the vault),
 * so a one-character secret is the ordinary case: it used to match the `[redacted]` its own replacement wrote, every match
 * allocating a larger buffer, and a streamed answer in the main process never ended.
 *
 * That one-character case is not run as a test of its own, because on the defect it does not fail — it never returns, and a loop
 * that does not yield cannot be timed out. The string cases below reach the same pass through a secret and a replacement that
 * leave a second secret in the text, so they answer in a millisecond; for the answer's bytes, the case that shows the rule is the
 * longer secret that carries a shorter one, which the old pass redacted in the wrong order.
 */

import { describe, expect, it } from 'vitest';

import { createSecretScrubber, redact, redactSecrets } from '../src/index.js';

/** A scrubber's answer to the chunks a provider wrote, as the page would receive it. */
function scrubbed(secrets: readonly string[], parts: readonly string[]): string {
  const seen: string[] = [];
  const scrubber = createSecretScrubber(secrets, (bytes) => seen.push(new TextDecoder().decode(bytes)));
  for (const part of parts) scrubber.write(new TextEncoder().encode(part));
  scrubber.end();
  return seen.join('');
}

describe('redacting a string', () => {
  it('does not treat what it just wrote as a secret', () => {
    // `e` and `red` both sit inside `[redacted]`: the replacement for the first must not become a candidate for the second.
    expect(redact('seek', ['e', 'red'])).toBe('s[redacted][redacted]k');
    expect(redactSecrets('seek', ['e', 'red'])).toBe('s[redacted][redacted]k');
  });

  it('redacts the longest secret where a shorter one starts with it', () => {
    // A key that carries its own prefix as a second entry is still one key, and the whole of it goes.
    expect(redact('Authorization: sk-abcd1234', ['abcd1234', 'sk-abcd1234'])).toBe('Authorization: [redacted]');
    expect(redactSecrets('Authorization: sk-abcd1234', ['abcd1234', 'sk-abcd1234'])).toBe('Authorization: [redacted]');
  });

  it('still redacts a one-character secret at every place it stands', () => {
    expect(redact('banana', ['a'])).toBe('b[redacted]n[redacted]n[redacted]');
    expect(redactSecrets('banana', ['a'])).toBe('b[redacted]n[redacted]n[redacted]');
  });
});

describe('scrubbing an answer', () => {
  it('redacts a secret that contains another secret’s text once, longest first', () => {
    expect(scrubbed(['abcd1234', 'sk-abcd1234'], ['the key sk-abcd1234 was not accepted']))
      .toBe('the key [redacted] was not accepted');
  });

  it('reads only the provider’s own bytes, never the marker it already wrote', () => {
    // The long secret is what makes the scrubber hold bytes back between chunks; the one-character one is what the markers are
    // full of. Held-back bytes must stay raw input, or the next chunk re-reads a marker and redacts it into itself.
    expect(scrubbed(['long-key-11', 'a'], ['xxxxxbanana', 'zzz'])).toBe('xxxxxb[redacted]n[redacted]n[redacted]zzz');
  });
});
