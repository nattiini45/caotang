import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ImportPreviewSource } from '../src/import-preview/model.js';
import { closeImportPreview, currentImportPreview, openImportPreview } from '../src/import-preview/requests.js';

const source = {} as ImportPreviewSource;

afterEach(() => closeImportPreview());

describe('UI-12 import preview request ownership', () => {
  it('notifies a replaced request once without closing its replacement', () => {
    const oldClose = vi.fn();
    const newClose = vi.fn();
    openImportPreview({ source, onClose: oldClose });
    openImportPreview({ source, onClose: newClose });
    expect(oldClose.mock.calls).toEqual([[false]]);
    expect(newClose).not.toHaveBeenCalled();
    closeImportPreview(true);
    closeImportPreview();
    expect(oldClose.mock.calls).toEqual([[false]]);
    expect(newClose.mock.calls).toEqual([[true]]);
  });

  it('keeps a request opened from a replacement callback', () => {
    const lastClose = vi.fn();
    const middleClose = vi.fn();
    openImportPreview({ source, onClose: () => openImportPreview({ source, onClose: lastClose }) });
    openImportPreview({ source, onClose: middleClose });
    expect(middleClose.mock.calls).toEqual([[false]]);
    expect(currentImportPreview()?.onClose).toBe(lastClose);
    closeImportPreview();
    expect(lastClose.mock.calls).toEqual([[false]]);
  });

  it('ignores a stale owner closing after replacement, even if both use the same source', () => {
    const oldClose = vi.fn();
    const newClose = vi.fn();
    openImportPreview({ source, onClose: oldClose });
    const old = currentImportPreview()!;
    openImportPreview({ source, onClose: newClose });
    const newer = currentImportPreview();
    closeImportPreview(true, old.id);
    expect(currentImportPreview()).toBe(newer);
    expect(oldClose.mock.calls).toEqual([[false]]);
    expect(newClose).not.toHaveBeenCalled();
    closeImportPreview(false, newer!.id);
    expect(newClose.mock.calls).toEqual([[false]]);
  });
});
