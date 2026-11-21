/**
 * What this page may offer about project folders. The picker is refused in a frame whose origin is not its top document's,
 * which is the hosted studio's composition, so the capability has to answer for the frame as well as for the browser.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { folderAccessSupported } from '../src/app/fs-access.js';

/** A window with a picker, whose parent answers (or throws) the way a same-origin or a cross-origin one does. */
function page(parent: 'same' | 'other' | null) {
  const window = {
    showDirectoryPicker: () => Promise.resolve(),
    top: undefined as unknown,
  };
  if (parent === null) window.top = window;
  else {
    const top = parent === 'same' ? { document: {} } : {};
    if (parent === 'other') Object.defineProperty(top, 'document', { get: () => { throw new Error('SecurityError'); } });
    window.top = top;
  }
  return window;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('opening a project folder', () => {
  it('is offered at the top of a page that has a picker', () => {
    vi.stubGlobal('window', page(null));
    expect(folderAccessSupported()).toBe(true);
  });

  it('is offered in a frame whose parent is the same origin', () => {
    vi.stubGlobal('window', page('same'));
    expect(folderAccessSupported()).toBe(true);
  });

  it('is not offered in a frame on another origin, where the picker throws', () => {
    // The hosted studio: a second origin in a frame. Chromium refuses `showDirectoryPicker` there, so the page must not offer
    // a button that can only fail.
    vi.stubGlobal('window', page('other'));
    expect(folderAccessSupported()).toBe(false);
  });

  it('is not offered by a browser without a picker', () => {
    const window = page(null) as { showDirectoryPicker?: unknown };
    delete window.showDirectoryPicker;
    vi.stubGlobal('window', window);
    expect(folderAccessSupported()).toBe(false);
  });

  it('is not offered where there is no window at all', () => {
    expect(typeof window).toBe('undefined');
    expect(folderAccessSupported()).toBe(false);
  });
});
