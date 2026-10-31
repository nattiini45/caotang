/**
 * The import's limits (pictures.md §6.1, §6.4). `PICTURE_MAX_BYTES` is the old `COVER_MAX_BYTES`, unchanged at 16 MB, and now
 * the one cap every picture import keeps.
 */

/** The largest file an import takes. Above it the import refuses, with the reason. */
export const PICTURE_MAX_BYTES = 16 * 1024 * 1024;

/** The most pixels a picture may have. Above it the import refuses, with the reason. */
export const PICTURE_MAX_PIXELS = 50_000_000;

/** A photo above either of these is large: the batch asks, once, whether to keep originals or store working copies (D6). */
export const LARGE_PHOTO_PIXELS = 24_000_000;
export const LARGE_PHOTO_BYTES = 8 * 1024 * 1024;

/** The long edge of a working copy, in pixels. */
export const WORKING_COPY_EDGE = 4096;
