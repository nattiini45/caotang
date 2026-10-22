/**
 * `@caotang/storyboard` — storyboard and shot planning (storyboard.md), headless.
 *
 * What is in here:
 *  - the shot node kind, the `storyboard` folder kind and the closed v1 vocabulary (`model`), and the
 *    load and save rules for a shot's metadata (`shot-meta`);
 *  - shot ordering and numbering: sibling order, binder order and the derived numbers (`ordering`);
 *  - the `assets/` folder, through the store's byte port (`assets`) and the dialogue anchors a shot
 *    covers, captured fresh (`anchors`);
 *  - `shots.derive` and `shots.annotate` as planners: each returns the plan to show and the bus commands
 *    to apply, in order (`derive`, `annotate`, `commands`), and `planMoveShot` plans a card's move;
 *  - the shot-list CSV and the contact-sheet page plan (`render-csv`, `render-contact-sheet`), with the
 *    PDF engine behind an injected port;
 *  - the two tools in the harness's entry shape, declared and checked against the harness types, not
 *    registered (`tools`).
 *
 * What is not: the corkboard and Inspector (the app, which renders this module's views), the
 * `script.shot-coverage` check (coherence's registry), the harness registration of the `shots.*` tools
 * (the app supplies their ports), the PDF library (the exporter's `contact-sheet-pdf` format draws the plan with it, without going through `ContactSheetPdfRenderer`), and the animatic MP4 and EDL exports
 * (parked by the spec). The store carries the `kind` and `shot` node fields, so a shot's metadata is saved
 * with the project; the image import is the store's `shot.importImage` (among the store's storyboard commands).
 */

export * from './model.js';
export * from './result.js';
export * from './ids.js';
export * from './anchors.js';
export * from './shot-meta.js';
export * from './nodes.js';
export * from './ordering.js';
export * from './commands.js';
export * from './animatic.js';
export * from './assets.js';
export * from './derive.js';
export * from './annotate.js';
export * from './render-csv.js';
export * from './render-contact-sheet.js';
export * from './tools.js';
export * from './command-port.js';
