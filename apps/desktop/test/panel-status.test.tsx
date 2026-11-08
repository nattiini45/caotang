import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Icon } from '../src/components/shell/modern/icons.js';
import { EmptyState } from '../src/components/shared.js';
import { ChunkLoadError, LazyBoundary } from '../src/components/lazy-view.js';
import { activateCatalogue, activateEnglish } from '../src/i18n/runtime.js';

beforeEach(activateEnglish);
afterEach(activateEnglish);

function markup(node: ReactNode): string {
  return renderToStaticMarkup(<I18nProvider i18n={i18n}>{node}</I18nProvider>);
}

describe('panel status glyphs', () => {
  it('keeps control icons decorative and names status glyphs without relying on CSS', () => {
    const decorative = markup(<Icon name="binder" />);
    expect(decorative).toContain('aria-hidden="true"');
    expect(decorative).not.toContain('role="img"');
    const status = markup(<Icon name="error" label="Save failed" />);
    expect(status).toContain('role="img" aria-label="Save failed"');
    expect(status).not.toContain('aria-hidden');
    expect(status).toContain('viewBox="0 0 24 24"');
    expect(status).toContain('stroke-width="1.8"');
    expect(status).toContain('fill="none" stroke="currentColor"');
    expect(status).toContain('focusable="false"');
  });

  it('keeps the empty state heading, explanation and action beside its glyph', () => {
    const html = markup(<EmptyState title="Research is empty" glyph={<Icon name="codex" label="Empty research" />} actions={<button>New research note</button>}>Start with one note.</EmptyState>);
    expect(html).toContain('data-panel-state="empty"');
    expect(html).toContain('aria-label="Empty research"');
    expect(html).toContain('<h2>Research is empty</h2>');
    expect(html).toContain('Start with one note.');
    expect(html).toContain('<button>New research note</button>');
  });

  it('names a failed load and preserves both recovery actions in German', async () => {
    await activateCatalogue('de');
    const boundary = new LazyBoundary({ label: 'Ablauf' });
    boundary.state = { error: new ChunkLoadError('offline'), tries: 0 };
    const html = markup(boundary.render());
    expect(html).toContain('role="alert" data-panel-state="error"');
    expect(html).not.toContain('data-panel-state="empty"');
    expect(html).toContain('aria-label="Fehler"');
    expect(html).toContain('Erneut versuchen');
    expect(html).toContain('Neu laden');
    expect(html).not.toContain('aria-label="Error"');
  });
});
