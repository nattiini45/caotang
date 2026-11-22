/**
 * `@caotang/import-highland` — the Highland 2 / Pro `.highland` reader (issue #284). A `.highland` file is a zip of a
 * customised TextBundle; this unzips it through the shared archive reader and routes the script to the Fountain importer,
 * keeping the assets and naming what it cannot bring in. No DOM, so it runs in the import Worker and in Node.
 */

export { readHighland, type HighlandAsset, type HighlandImport, type HighlandResult } from './highland.js';
