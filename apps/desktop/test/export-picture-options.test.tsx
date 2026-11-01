/**
 * The export dialog's picture options (apps/desktop/src/app/export-picture-options.ts): which controls each format shows, what a
 * stored recipe value shows under another format, and the options a save writes (pictures.md §4). No DOM: the model is tested
 * without a renderer.
 */

import { describe, expect, it } from 'vitest';

import {
  defaultPictureMode,
  pictureControlsOf,
  pictureControlsShownFor,
  pictureModeShownFor,
  pictureOptionsOf,
  shownPictureOptionsOf,
  withPictureMode,
} from '../src/app/export-picture-options';

describe('which picture controls a format shows', () => {
  it('offers copy, link and drop with the metadata choice for Markdown', () => {
    expect(pictureControlsOf('md')).toEqual({ modes: ['copy', 'link', 'drop'], keepMetadata: true, keepWebp: false });
  });

  it('offers the placeholder or leaving pictures out for plain text, with nothing to keep', () => {
    expect(pictureControlsOf('txt')).toEqual({ modes: ['placeholder', 'drop'], keepMetadata: false, keepWebp: false });
  });

  it('offers no mode for Word and EPUB, which always place the pictures, and WebP only for EPUB', () => {
    expect(pictureControlsOf('docx')).toEqual({ modes: [], keepMetadata: true, keepWebp: false });
    expect(pictureControlsOf('epub')).toEqual({ modes: [], keepMetadata: true, keepWebp: true });
  });

  it('shows nothing for a format that reads no picture option', () => {
    for (const format of ['fountain', 'pdf', 'ink'] as const) {
      expect(pictureControlsOf(format)).toBeUndefined();
      expect(pictureControlsShownFor(format, 'link')).toBeUndefined();
    }
  });

  it('defaults to copy for Markdown, the placeholder for plain text and none for the rest', () => {
    expect(defaultPictureMode('md')).toBe('copy');
    expect(defaultPictureMode('txt')).toBe('placeholder');
    expect(defaultPictureMode('epub')).toBeUndefined();
  });
});

describe('what a stored mode shows under each format', () => {
  it('shows the stored mode when the format reads it', () => {
    expect(pictureModeShownFor('md', 'link')).toBe('link');
    expect(pictureModeShownFor('txt', 'drop')).toBe('drop');
  });

  it('shows the format default when the recipe stores no mode', () => {
    expect(pictureModeShownFor('md', undefined)).toBe('copy');
    expect(pictureModeShownFor('txt', undefined)).toBe('placeholder');
  });

  it('shows the nearest mode the compile honours when the stored one belongs to the other plain format', () => {
    expect(pictureModeShownFor('md', 'placeholder')).toBe('drop');
    expect(pictureModeShownFor('txt', 'copy')).toBe('placeholder');
    expect(pictureModeShownFor('txt', 'link')).toBe('placeholder');
  });

  it('shows no mode for a format with no choice', () => {
    expect(pictureModeShownFor('docx', 'drop')).toBeUndefined();
    expect(pictureModeShownFor('epub', undefined)).toBeUndefined();
  });
});

describe('which checkboxes show', () => {
  it('shows the metadata checkbox while Markdown copies, and hides it for a link or a drop', () => {
    expect(pictureControlsShownFor('md', undefined)?.keepMetadata).toBe(true);
    expect(pictureControlsShownFor('md', 'copy')?.keepMetadata).toBe(true);
    expect(pictureControlsShownFor('md', 'link')?.keepMetadata).toBe(false);
    expect(pictureControlsShownFor('md', 'drop')?.keepMetadata).toBe(false);
  });

  it('never shows the metadata checkbox for plain text', () => {
    expect(pictureControlsShownFor('txt', undefined)?.keepMetadata).toBe(false);
    expect(pictureControlsShownFor('txt', 'placeholder')?.keepMetadata).toBe(false);
  });

  it('shows the WebP checkbox for EPUB only', () => {
    expect(pictureControlsShownFor('epub', undefined)?.keepWebp).toBe(true);
    for (const format of ['md', 'txt', 'docx'] as const) expect(pictureControlsShownFor(format, undefined)?.keepWebp).toBe(false);
  });

  it('shows the metadata checkbox for Word and EPUB', () => {
    expect(pictureControlsShownFor('docx', undefined)?.keepMetadata).toBe(true);
    expect(pictureControlsShownFor('epub', undefined)?.keepMetadata).toBe(true);
  });

  it('warns about broken links only in link mode', () => {
    expect(pictureControlsShownFor('md', 'link')?.linkNote).toBe(true);
    expect(pictureControlsShownFor('md', 'copy')?.linkNote).toBe(false);
    expect(pictureControlsShownFor('txt', 'link')?.linkNote).toBe(false);
  });
});

describe('the options a save writes', () => {
  it('writes nothing for a recipe with no picture choices', () => {
    expect(pictureOptionsOf(shownPictureOptionsOf(undefined))).toEqual({});
  });

  it('round-trips every stored option, carrying the long edge the dialog has no control for', () => {
    const stored = { pictures: 'link', keepPictureMetadata: true, epubKeepWebp: true, epubImageMaxPx: 1200 } as const;
    expect(pictureOptionsOf(shownPictureOptionsOf(stored))).toEqual(stored);
  });

  it('leaves out a checkbox that is off', () => {
    expect(pictureOptionsOf(shownPictureOptionsOf({ keepPictureMetadata: false, epubKeepWebp: false }))).toEqual({});
  });

  it('keeps the stored value of a control the current format does not show', () => {
    const shown = shownPictureOptionsOf({ pictures: 'link', epubKeepWebp: true });
    expect(pictureControlsShownFor('docx', shown.pictures)?.keepWebp).toBe(false);
    expect(pictureOptionsOf(shown)).toEqual({ pictures: 'link', epubKeepWebp: true });
  });

  it('clears the option when the writer chooses the default mode, and stores any other', () => {
    const linked = withPictureMode(shownPictureOptionsOf(undefined), 'md', 'link');
    expect(pictureOptionsOf(linked)).toEqual({ pictures: 'link' });
    expect(pictureOptionsOf(withPictureMode(linked, 'md', 'copy'))).toEqual({});
    expect(pictureOptionsOf(withPictureMode(shownPictureOptionsOf(undefined), 'txt', 'drop'))).toEqual({ pictures: 'drop' });
    expect(pictureOptionsOf(withPictureMode(shownPictureOptionsOf({ pictures: 'drop' }), 'txt', 'placeholder'))).toEqual({});
  });
});
