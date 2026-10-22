/**
 * Vitest's setup file: loads the Ink compiler before any test file runs, as a Node host does at start. `compileInk` is synchronous and
 * throws `InkCompilerNotLoaded` until it has loaded (packages/dialogue/src/ink-loader.ts), so a test that compiles Ink needs it already.
 */
import { loadInkCompiler } from '../packages/dialogue/src/ink-loader.js';

await loadInkCompiler();
