/**
 * Vitest's setup file: loads the Ink compiler before any test file runs, as a Node host does at start. `compileInk` is synchronous and
 * throws `InkCompilerNotLoaded` until it has loaded (packages/dialogue/src/ink-loader.ts), so a test that compiles Ink needs it already.
 */
import { loadInkCompiler } from '../packages/dialogue/src/ink-loader.js';
import { activateEnglish } from '../apps/desktop/src/i18n/runtime.js';

await loadInkCompiler();
// The app activates its English catalogue before its first render. Tests that call a converted model
// or macro directly get the same starting locale, so a missing translation falls back to the message
// itself rather than throwing "without setting a locale".
activateEnglish();
