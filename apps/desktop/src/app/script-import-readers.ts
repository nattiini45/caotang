/**
 * The readers a script, Ink or Twee import runs — the pieces of `@caotang/screenplay` and `@caotang/dialogue` that only a chosen file
 * needs (screenplay.md §2.2, dialogue-narrative.md §4). They are in this module of their own so the binder's **Import…** menu, which is
 * on screen from the first paint, does not carry the FDX and Twee readers, the Ink planner and the container planner in the first load:
 * `ScriptImport.tsx` imports this file only through `import()`, when a writer has picked a file, and the answers are awaited before
 * anything is read or dispatched. The readers themselves are the packages' own; nothing is copied or wrapped here.
 */

export { importFdx } from '@caotang/screenplay';
export { compileInk, mintImportIds, planInkImport, planTweeImport } from '@caotang/dialogue';
