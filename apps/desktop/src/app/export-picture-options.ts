/**
 * The picture options of an export recipe as the export dialog offers them (pictures.md §4): which controls a format reads, what
 * each one shows for the recipe's stored value, and the options a change saves. A format shows only the controls it reads, so a
 * writer is not asked about WebP on a Word file; the stored value of a control a format does not show is kept as it was, so a
 * recipe saved for one format still means the same thing under another.
 */

import type { PictureMode } from '@caotang/bus';
import type { ExportFormat } from '@caotang/exporter';

export type { PictureMode };

/** What a format's picture settings consist of. */
export interface PictureControls {
  /** The modes the format reads, the default first. Empty when the format has no choice to make. */
  readonly modes: readonly PictureMode[];
  /** Whether the format reads the keep-metadata choice. */
  readonly keepMetadata: boolean;
  /** Whether the format reads the keep-WebP choice (the EPUB's, for Apple Books). */
  readonly keepWebp: boolean;
}

/** The picture options a recipe stores. */
export interface PictureOptions {
  readonly pictures?: PictureMode;
  readonly keepPictureMetadata?: boolean;
  readonly epubKeepWebp?: boolean;
  readonly epubImageMaxPx?: number;
}

/** The picture options as the dialog holds them: every option has a shown value, and the long edge is carried unchanged. */
export interface ShownPictureOptions {
  readonly pictures: PictureMode | undefined;
  readonly keepPictureMetadata: boolean;
  readonly epubKeepWebp: boolean;
  /** Set in a saved recipe or by an agent; the dialog has no control for it, and a save must not drop it. */
  readonly epubImageMaxPx: number | undefined;
}

const CONTROLS: Readonly<Partial<Record<ExportFormat, PictureControls>>> = {
  md: { modes: ['copy', 'link', 'drop'], keepMetadata: true, keepWebp: false },
  txt: { modes: ['placeholder', 'drop'], keepMetadata: false, keepWebp: false },
  docx: { modes: [], keepMetadata: true, keepWebp: false },
  epub: { modes: [], keepMetadata: true, keepWebp: true },
};

/** The picture controls the format reads, or `undefined` for a format with no pictures to set. */
export function pictureControlsOf(format: ExportFormat): PictureControls | undefined {
  return CONTROLS[format];
}

/** The mode a format uses when the recipe names none: Markdown copies, plain text writes the placeholder. */
export function defaultPictureMode(format: ExportFormat): PictureMode | undefined {
  return pictureControlsOf(format)?.modes[0];
}

/**
 * The mode a format will run, for a stored value: the stored one when the format reads it, and otherwise the nearest the compile
 * honours (Markdown has no placeholder and leaves the pictures out; plain text has no copy or link and writes the placeholder).
 */
export function pictureModeShownFor(format: ExportFormat, stored: PictureMode | undefined): PictureMode | undefined {
  const modes = pictureControlsOf(format)?.modes ?? [];
  if (modes.length === 0) return undefined;
  if (stored !== undefined && modes.includes(stored)) return stored;
  if (stored === undefined) return modes[0];
  return format === 'md' ? 'drop' : 'placeholder';
}

/** What the dialog shows for one format and one stored mode. */
export interface PictureControlsShown {
  /** The modes to choose from; empty when the format has no choice, and then no mode control is shown. */
  readonly modes: readonly PictureMode[];
  /** The chosen mode, `undefined` when the format has no choice. */
  readonly mode: PictureMode | undefined;
  /** Whether to show the keep-metadata checkbox: only while pictures are written out, which a link or a drop does not do. */
  readonly keepMetadata: boolean;
  /** Whether to show the keep-WebP checkbox. */
  readonly keepWebp: boolean;
  /** Whether to say that the links break when the exported file moves away from the project. */
  readonly linkNote: boolean;
}

/** The picture controls to show for `format` under the recipe's stored mode, or `undefined` when the format has no pictures to set. */
export function pictureControlsShownFor(format: ExportFormat, stored: PictureMode | undefined): PictureControlsShown | undefined {
  const controls = pictureControlsOf(format);
  if (controls === undefined) return undefined;
  const mode = pictureModeShownFor(format, stored);
  return {
    modes: controls.modes,
    mode,
    keepMetadata: controls.keepMetadata && mode !== 'link' && mode !== 'drop',
    keepWebp: controls.keepWebp,
    linkNote: mode === 'link',
  };
}

/** The picture options a recipe stores, as the dialog shows them. An option the recipe does not set shows its default. */
export function shownPictureOptionsOf(options: PictureOptions | undefined): ShownPictureOptions {
  return {
    pictures: options?.pictures,
    keepPictureMetadata: options?.keepPictureMetadata ?? false,
    epubKeepWebp: options?.epubKeepWebp ?? false,
    epubImageMaxPx: options?.epubImageMaxPx,
  };
}

/** The shown options after the writer chooses a mode in `format`. Choosing the format's default clears the option, as no choice. */
export function withPictureMode(shown: ShownPictureOptions, format: ExportFormat, mode: PictureMode): ShownPictureOptions {
  return { ...shown, pictures: mode === defaultPictureMode(format) ? undefined : mode };
}

/**
 * The options a save writes. Defaults are left out, so a recipe saved without a choice stays as it was, and the stored value of a
 * control the current format does not show is carried through.
 */
export function pictureOptionsOf(shown: ShownPictureOptions): PictureOptions {
  return {
    ...(shown.pictures === undefined ? {} : { pictures: shown.pictures }),
    ...(shown.keepPictureMetadata ? { keepPictureMetadata: true } : {}),
    ...(shown.epubKeepWebp ? { epubKeepWebp: true } : {}),
    ...(shown.epubImageMaxPx === undefined ? {} : { epubImageMaxPx: shown.epubImageMaxPx }),
  };
}
