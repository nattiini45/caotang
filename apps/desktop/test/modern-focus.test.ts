/**
 * Modern's focus mode (components/shell/modern/focus-mode.tsx; modern-interface.md §8.8): what brings the faded ornaments, tab bar, Scene
 * info and agent window back. The pointer near an edge of the window; Tab, F6 or Escape anywhere, or any key outside a text field; never
 * typing in the text.
 */
import { describe, expect, it } from 'vitest';

import { EDGE_PX, nearEdge, revealsOnKey } from '../src/components/shell/modern/focus-mode.js';

describe('focus mode in Modern', () => {
  it('counts a point within EDGE_PX of any edge as near, and the middle of the window as not', () => {
    expect(nearEdge(EDGE_PX - 1, 450, 1440, 900)).toBe(true);
    expect(nearEdge(700, EDGE_PX - 1, 1440, 900)).toBe(true);
    expect(nearEdge(1440 - EDGE_PX + 1, 450, 1440, 900)).toBe(true);
    expect(nearEdge(700, 900 - EDGE_PX + 1, 1440, 900)).toBe(true);
    expect(nearEdge(EDGE_PX, 450, 1440, 900)).toBe(false);
    expect(nearEdge(720, 450, 1440, 900)).toBe(false);
  });

  it('shows the chrome for Tab, F6 and Escape anywhere and any key outside a text field, never for typing in the text', () => {
    for (const key of ['Tab', 'F6', 'Escape']) {
      expect(revealsOnKey(key, true)).toBe(true);
      expect(revealsOnKey(key, false)).toBe(true);
    }
    expect(revealsOnKey('a', false)).toBe(true);
    expect(revealsOnKey('a', true)).toBe(false);
    expect(revealsOnKey('Enter', true)).toBe(false);
    expect(revealsOnKey('Backspace', true)).toBe(false);
  });
});
