/**
 * The narrow layout's rules, apart from any renderer so they are tested without one (ui-modules §0.6, §1). Below 960 px the shell has
 * one centre column, the rail is a drawer and the inspector a bottom sheet. Which of the two is open is view state, never project state.
 * What a phone does not do is named here, once, so every surface that says "Open on desktop" says it in the same words.
 */

import type { ExportFormat } from '@caotang/exporter';

import type { MediaKind } from '../media/route.js';

/** The widest viewport that gets the narrow layout. 960 px and above is the desktop shell, unchanged. */
export const NARROW_MAX_WIDTH = 959;
/** The media query styles.css repeats in its `@media` block; the two are kept in step by e2e/unit/narrow-model.spec.ts. */
export const NARROW_QUERY = `(max-width: ${NARROW_MAX_WIDTH}px)`;

/** The panels the narrow layout opens over the centre. At most one is open. */
export type NarrowPanel = 'rail' | 'inspector';

/** What the narrow layout leaves to a desktop, each named in the words the notice uses. */
export type DesktopFeature = 'corkboard' | 'storyboard' | 'dialogue' | 'screenplay-pages' | 'mcp' | 'exports';

export interface DesktopFeatureNote {
  /** The feature in words: the notice's title is "Open on desktop: " and this. */
  readonly name: string;
  /** What the writer can do instead, or what is unchanged. */
  readonly detail: string;
}

export const DESKTOP_FEATURES: Readonly<Record<DesktopFeature, DesktopFeatureNote>> = {
  corkboard: {
    name: 'the corkboard',
    detail: 'The board, where cards are dragged into order, needs a wider window. Your chapters and scenes are unchanged, and the binder still lists them.',
  },
  storyboard: {
    name: 'the storyboard',
    detail: 'The shot board needs a wider window. Your shots are unchanged.',
  },
  dialogue: {
    name: 'the dialogue branch graph',
    detail: 'The branch graph and its Ink text need a wider window. Your dialogue is unchanged.',
  },
  'screenplay-pages': {
    name: 'the screenplay Pages view',
    detail: 'The Script and Source views work here. Pages shows the printed layout, and the screenplay PDF is made on a desktop.',
  },
  mcp: {
    name: 'MCP & tools',
    detail: 'Connecting servers and tools is set up on a desktop. Nothing connected there is changed from here.',
  },
  exports: {
    name: 'the other export formats',
    detail: 'Word, EPUB, Fountain, Final Draft, PDF, Ink, spreadsheets, prompt packs and reports are made on a desktop. Markdown and plain text are here.',
  },
};

/** The formats a narrow window compiles. Every other format says "Open on desktop". */
export const NARROW_EXPORT_FORMATS: readonly ExportFormat[] = ['md', 'txt'];

export function narrowExportAllowed(format: ExportFormat): boolean {
  return NARROW_EXPORT_FORMATS.includes(format);
}

/** The format a narrow dialog starts on for a recipe: the recipe's own when a phone makes it, else Markdown. */
export function narrowExportFormat(format: ExportFormat): ExportFormat {
  return narrowExportAllowed(format) ? format : 'md';
}

/** The desktop-only view a media node would get, or `null` when its view works on a narrow screen. */
export function narrowMediaFeature(kind: MediaKind | null): DesktopFeature | null {
  return kind === 'storyboard' ? 'storyboard' : kind === 'dialogue' ? 'dialogue' : null;
}

/**
 * The panel after a request to toggle `target`. Opening one closes the other, and asking for the open one closes it, so a drawer and a
 * sheet are never open together.
 */
export function togglePanel(current: NarrowPanel | null, target: NarrowPanel): NarrowPanel | null {
  return current === target ? null : target;
}
