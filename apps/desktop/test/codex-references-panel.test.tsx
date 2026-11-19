/**
 * The reference list's unreadable records (#750's note F1): a record whose id reads but whose body does not would otherwise be stuck in
 * the project with no control to clear it, counting against the cap, so it keeps a row of its own — named, removable, never editable —
 * while a record with no id at all keeps only the note that it is held.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { CODEX_REFERENCE_MAX } from '@caotang/bus';

import { CodexReferences } from '../src/components/CodexReferences.js';
import { activateEnglish } from '../src/i18n/runtime.js';

beforeEach(() => activateEnglish());

function markup(node: ReactNode): string {
  return renderToStaticMarkup(<I18nProvider i18n={i18n}>{node}</I18nProvider>);
}

const noEdit = (): boolean => true;

describe('an unreadable saved reference', () => {
  it('keeps a row named by its stored title, removable and never editable', () => {
    const html = markup(
      <CodexReferences
        records={[{ id: 'ref_0000000001', title: 'Tide Tables', date: '2026-02-30' }]}
        onEdit={noEdit}
      />,
    );
    expect(html).toContain('Tide Tables');
    expect(html).toContain('A field in this reference could not be read. Remove it and add it again.');
    expect(html).toContain('aria-label="Remove reference Tide Tables"');
    expect(html).not.toContain('Edit reference');
    expect(html).not.toContain('Some saved references could not be shown');
  });

  it('names a record whose title does not read as an untitled one', () => {
    const html = markup(
      <CodexReferences records={[{ id: 'ref_0000000002', title: 7 }]} onEdit={noEdit} />,
    );
    expect(html).toContain('Untitled reference');
    expect(html).toContain('aria-label="Remove reference Untitled reference"');
  });

  it('still refuses a record with no readable id a control, and says it is held', () => {
    const html = markup(
      <CodexReferences records={[{ title: 'Tide Tables', date: '2026-02-30' }]} onEdit={noEdit} />,
    );
    expect(html).toContain('Some saved references could not be shown. They are kept in the project.');
    expect(html).not.toContain('Remove reference');
  });

  it('counts an unreadable record against the cap, and a removable row clears it', () => {
    const readable = Array.from({ length: CODEX_REFERENCE_MAX - 1 }, (_, index) => ({
      id: `ref_${String(index).padStart(10, '0')}`,
      title: `Reference ${String(index)}`,
    }));
    const full = markup(
      <CodexReferences records={[...readable, { id: 'ref_0000000099', title: 'Tide Tables', publisher: 7 }]} onEdit={noEdit} />,
    );
    expect(full).toContain('Remove a reference before adding another.');
    expect(full).toContain('aria-label="Remove reference Tide Tables"');

    const room = markup(<CodexReferences records={readable} onEdit={noEdit} />);
    expect(room).not.toContain('Remove a reference before adding another.');
  });
});
