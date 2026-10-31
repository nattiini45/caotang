/**
 * The media a focused scene reaches ([timeline.md §9.3, §9.4](docs/architecture/timeline.md)): its dialogue, its comic book, the
 * shots under it and the pages under it. Each entry opens the real view of that medium through the same open-a-node route the
 * scene button uses; a declaration whose target is gone is a note that names what is missing, never a button that opens nothing.
 *
 * Nothing here writes to the project.
 */
/* lingui-set comment="The media of one scene on the timeline. Interpolated values: title is writer text, ref is a node id the writer did not choose, list is a comma-separated list of media names." */

import type { ReactNode } from 'react';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { COMIC_GLYPH, DIALOGUE_GLYPH, STORYBOARD_GLYPH, mediaEntriesOf, unattachedStrips, type MediaEntry, type TimelineModel } from '@caotang/timeline';

import { UserText } from '../../i18n/UserText.js';

export interface TimelineMediaProps {
  readonly model: TimelineModel;
  /** The focused scene, or undefined to list the strips that hang under no scene. */
  readonly nodeId: string | undefined;
  readonly language: string | undefined;
  readonly onOpen: (nodeId: string) => void;
}

function kindLabel(kind: MediaEntry['kind']): string {
  switch (kind) {
    case 'dialogue':
      return t`Dialogue`;
    case 'book':
      return t`Comic book`;
    case 'shots':
      return t`Shots`;
    case 'pages':
      return t`Pages`;
  }
}

/**
 * The words for the media glyphs on a chip. The glyph is `aria-hidden` and shape alone never carries a fact, so the chip's
 * accessible name says the same thing in words.
 */
export function mediaNoteOf(glyphs: string | undefined): string {
  if (glyphs === undefined || glyphs === '') return '';
  const names: string[] = [];
  if (glyphs.includes(DIALOGUE_GLYPH)) names.push(t`dialogue`);
  if (glyphs.includes(COMIC_GLYPH)) names.push(t`comic`);
  if (glyphs.includes(STORYBOARD_GLYPH)) names.push(t`shots`);
  if (names.length === 0) return '';
  const list = names.join(', ');
  return t`has ${list}`;
}

function countOf(entry: MediaEntry): string {
  const count = entry.strip?.cells?.length ?? 0;
  if (entry.kind === 'shots') return plural(count, { one: '# shot', other: '# shots' });
  if (entry.kind === 'pages') return plural(count, { one: '# page', other: '# pages' });
  return '';
}

function EntryRow({ entry, language, onOpen }: { entry: MediaEntry; language: string | undefined; onOpen: (nodeId: string) => void }): ReactNode {
  const kind = kindLabel(entry.kind);
  const count = countOf(entry);
  if (entry.open === undefined) {
    const ref = entry.ref;
    return (
      <li className="tl-media-note" data-testid="timeline-media-broken">
        <span aria-hidden="true">{entry.glyph === '' ? '\u26a0' : `${entry.glyph}\u26a0`}</span>{' '}
        {ref === undefined ? (
          <Trans>This scene links to something that is gone.</Trans>
        ) : (
          <Trans>
            This scene links to <code>{ref}</code>, which is gone. Nothing was re-matched by title.
          </Trans>
        )}
      </li>
    );
  }
  const open = entry.open;
  return (
    <li>
      <button type="button" className="button" data-testid="timeline-media-open" data-kind={entry.kind} onClick={() => onOpen(open)}>
        <span aria-hidden="true">{entry.glyph}</span> <span>{kind}</span>
        {entry.title === '' ? null : (
          <>
            {': '}
            <UserText value={entry.title} lang={language} />
          </>
        )}
        {count === '' ? null : ` (${count})`}
      </button>
    </li>
  );
}

export function TimelineMedia({ model, nodeId, language, onOpen }: TimelineMediaProps): ReactNode {
  const entries: MediaEntry[] =
    nodeId === undefined
      ? unattachedStrips(model).map((strip) => ({
          kind: strip.kind === 'shot-strip' ? ('shots' as const) : ('pages' as const),
          medium: strip.medium,
          title: strip.label,
          glyph: strip.mediumGlyph ?? '',
          ...(strip.open !== undefined ? { open: strip.open } : {}),
          strip,
        }))
      : mediaEntriesOf(model, nodeId);
  if (entries.length === 0) return null;
  return (
    <ul className="tl-media" aria-label={nodeId === undefined ? t`Media with no scene` : t`Media of this scene`} data-testid="timeline-media">
      {entries.map((entry, index) => (
        <EntryRow key={`${entry.kind}:${entry.open ?? entry.ref ?? index}`} entry={entry} language={language} onOpen={onOpen} />
      ))}
    </ul>
  );
}
