/**
 * A relation the section cannot show (#746; the same gap #750's review names for references): a stored record whose id reads but whose
 * target does not would otherwise be hidden and unremovable while it still counts against the 40 an entry may hold, so it keeps a row of
 * its own — removable, never editable — and the Add button counts what the entry really holds.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { CODEX_RELATION_MAX } from '@caotang/bus';
import type { CodexEntry } from '@caotang/store';

import { CodexRelations } from '../src/components/CodexRelations.js';
import { activateEnglish } from '../src/i18n/runtime.js';

beforeEach(() => activateEnglish());

const FENN = 'c_0000000001';
const MARA = 'c_0000000002';

function entry(id: string, name: string, over: Partial<CodexEntry> = {}): CodexEntry {
  return {
    id,
    name,
    aliases: [],
    type: 'character',
    description: `${name} keeps the harbour log.`,
    includePolicy: 'detected',
    caseSensitive: false,
    exclude: [],
    attachments: [],
    keywords: [],
    origin: 'manual',
    sources: [],
    ...over,
  };
}

function markup(node: ReactNode): string {
  return renderToStaticMarkup(<I18nProvider i18n={i18n}>{node}</I18nProvider>);
}

function panel(relations: unknown[]): string {
  const fenn = entry(FENN, 'Fenn', { relations });
  return markup(
    <CodexRelations entry={fenn} entries={[fenn, entry(MARA, 'Mara')]} onEdit={() => true} onOpen={() => undefined} />,
  );
}

/** The opening tag of the button whose label is `Add relation`. */
function addTag(html: string): string {
  const tag = html.slice(html.lastIndexOf('<button', html.indexOf('Add relation')));
  return tag.slice(0, tag.indexOf('>'));
}

describe('a relation the section cannot show', () => {
  it('keeps a row that names itself and offers Remove, never Edit', () => {
    const html = panel([{ id: 'rel_0000000001', targetId: 7 }]);
    expect(html).toContain('A relation that cannot be shown');
    expect(html).toContain('A field in this relation could not be read. Remove it and add it again.');
    expect(html).toContain('aria-label="Remove relation to A relation that cannot be shown"');
    expect(html).not.toContain('Edit relation to');
    expect(html).not.toContain('This entry links to nothing yet.');
  });

  it('counts every stored relation against the cap, unreadable ones included', () => {
    const stored: unknown[] = Array.from({ length: CODEX_RELATION_MAX }, (_, index) => ({
      id: `rel_${String(index).padStart(10, '0')}`,
      targetId: MARA,
    }));
    stored[0] = { id: 'rel_0000000000', targetId: 7 };
    expect(addTag(panel(stored))).toContain('disabled');
    expect(addTag(panel(stored.slice(1)))).not.toContain('disabled');
  });
});
