/**
 * Bidi isolation for writer text shown in the interface ([i18n.md §5.3](docs/architecture/i18n.md)).
 *
 * Writer content — titles, names, file names, finding evidence — is never translated and may read in
 * the opposite direction from the UI. In JSX it goes through {@link UserText}, which renders a `<bdi>`
 * with the project's `lang` and `dir="auto"`; in attributes, notices and plain strings it goes through
 * {@link isolatedText}, which wraps it in FSI…PDI (U+2068…U+2069). The browser then lays out the run in
 * its own direction without reordering the sentence around it.
 *
 * This is not a translation helper: it never calls Lingui and never changes the text.
 */
import { isolate } from '@caotang/i18n';
import type { ReactNode } from 'react';

export interface UserTextProps {
  /** The writer's text, exactly as stored. */
  readonly value: string;
  /** The project's language, when the surface knows it. */
  readonly lang?: string;
}

/** Writer text inside a JSX message or label: isolated, with the content language when it is known. */
export function UserText({ value, lang }: UserTextProps): ReactNode {
  return (
    <bdi lang={lang} dir="auto">
      {value}
    </bdi>
  );
}

/** Writer text interpolated into an attribute or a plain string, where a `<bdi>` cannot go. */
export function isolatedText(value: string): string {
  return isolate(value);
}
