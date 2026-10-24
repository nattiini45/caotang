/**
 * The isolated interpolation of writer content in a UI string — [i18n.md §5.3](docs/architecture/i18n.md).
 *
 * FSI (U+2068) and PDI (U+2069) are invisible; the expected strings name them as escapes so a reader
 * (and a diff) can see them.
 */
import { describe, expect, it } from 'vitest';

import { isolate } from '../src/index.js';

describe('isolate (i18n.md §5.3)', () => {
  it('wraps text in a first-strong isolate, so an opposite-direction title cannot reorder its sentence', () => {
    expect(isolate('אבג')).toBe('\u2068אבג\u2069');
    expect(isolate('The Storm')).toBe('\u2068The Storm\u2069');
  });

  it('leaves empty text empty, rather than writing two invisible marks around nothing', () => {
    expect(isolate('')).toBe('');
  });

  it('isolates the text once: it does not strip marks the writer typed', () => {
    // A title may itself carry an isolate (a pasted cross-reference); the wrapper is added, not
    // normalised away, because the text is the writer's.
    const content = '\u2068אבג\u2069';
    expect(isolate(content)).toBe(`\u2068${content}\u2069`);
  });
});
