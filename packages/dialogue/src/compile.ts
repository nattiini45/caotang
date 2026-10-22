/**
 * The Ink compile gate — [dialogue-narrative.md §2.2 and §4](../../../docs/architecture/dialogue-narrative.md).
 *
 * inkjs (`inkjs/full`, the build that carries the compiler) is the validator. Caotang adds no
 * bespoke graph checks (§2.3): an Ink body is valid when the reference compiler accepts it,
 * and its warnings are the loose ends the findings inbox shows. Compiling is in-process,
 * zero network, and the same in a browser and in tests. The compiler loads on demand (`ink-loader.ts`):
 * until `loadInkCompiler()` has resolved, `compileInk` throws `InkCompilerNotLoaded`.
 */

import { inkCompiler } from './ink-loader.js';

/**
 * inkjs's `ErrorType` values. The enum itself is not exported at runtime by `inkjs/full`,
 * so the numbers are named here and the tests exercise both levels.
 */
const INK_AUTHOR = 0;
const INK_WARNING = 1;
const INK_ERROR = 2;

export interface InkMessage {
  /** The message as inkjs wrote it, verbatim. */
  readonly text: string;
  /** The body line the message names, when it names one. */
  readonly line: number | null;
}

export interface InkCompileResult {
  /** True when the body compiled with no errors. Warnings do not make it false. */
  readonly ok: boolean;
  /** The compiled story JSON (`.ink.json`) when `ok`, else null. */
  readonly json: string | null;
  readonly errors: readonly InkMessage[];
  readonly warnings: readonly InkMessage[];
}

const LINE_IN_MESSAGE = /line (\d+)/;

function messageOf(text: string): InkMessage {
  const found = LINE_IN_MESSAGE.exec(text);
  return { text, line: found ? Number(found[1]) : null };
}

/**
 * Compiles an Ink body and reports every message. A compile that throws (inkjs throws
 * "Compilation failed" once it has errors, and a file-resolution error for `INCLUDE`)
 * is reported as errors, never rethrown: the caller is a gate, and a gate reports. The one throw is
 * `InkCompilerNotLoaded`: no compiler means no verdict, and a gate with no verdict fails closed.
 */
export function compileInk(body: string): InkCompileResult {
  const { Compiler, CompilerOptions } = inkCompiler();
  const errors: InkMessage[] = [];
  const warnings: InkMessage[] = [];
  const options = new CompilerOptions(null, [], false, (message: string, type: number) => {
    if (type === INK_ERROR) errors.push(messageOf(message));
    else if (type === INK_WARNING) warnings.push(messageOf(message));
    else if (type === INK_AUTHOR) return;
  }, null);
  const compiler = new Compiler(body, options);
  let json: string | null = null;
  try {
    const text = compiler.Compile().ToJson();
    json = typeof text === 'string' ? text : null;
  } catch (error) {
    if (errors.length === 0) errors.push({ text: error instanceof Error ? error.message : String(error), line: null });
  }
  const ok = errors.length === 0 && json !== null;
  return { ok, json: ok ? json : null, errors, warnings };
}
