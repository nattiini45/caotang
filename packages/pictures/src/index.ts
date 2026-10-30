/**
 * `@caotang/pictures` — the picture registry's pure parts ([pictures.md](../../../docs/architecture/pictures.md)).
 *
 *  - the record (`AssetRecord`) and the load's reading of one (`record.ts`, §2.1);
 *  - where a picture is used, derived and never stored (`usesOf`, `uses.ts`, §2.1);
 *  - the `assets/` file names and the sniff, moved here from `@caotang/storyboard` (`files.ts`, `ids.ts`);
 *  - the import pipeline over bytes and an injected decoder (`pipeline.ts`, §6.4): HEIC, the pixel budget, working copies,
 *    the lossless GPS strip (`exif.ts`) and the SHA-256 dedup key (`hash.ts`); these two load from `@caotang/pictures/prepare`;
 *  - the limits (`limits.ts`, §6.1).
 *
 * Nothing here touches a file system, a DOM or the store: the store applies the commands, and the host decodes.
 */

export * from './ids.js';
export * from './files.js';
export * from './dimensions.js';
export { jpegHasGps, jpegOrientation } from './tiff.js';
export type { StrippedPart, StripResult } from './exif.js';
export * from './hash.js';
export * from './limits.js';
export * from './record.js';
export * from './uses.js';
// The pipeline and the strip are values only in `@caotang/pictures/prepare`, which loads on the first import.
export type { LargePhotoChoice, PictureDecoder, PictureRefusal, PictureRefusalCode, PrepareResult, PreparedPicture } from './pipeline.js';
