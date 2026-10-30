/**
 * `@caotang/pictures/prepare` — the import pipeline (`pipeline.ts`, pictures.md §6.4) and the lossless metadata strip it runs
 * (`exif.ts`). Its own entry, so the store loads it with the first import (`import()`) and the app's first load does not carry it.
 * The types are also exported from the package's main entry.
 */

export * from './exif.js';
export * from './pipeline.js';
