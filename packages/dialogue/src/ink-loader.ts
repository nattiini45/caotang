/**
 * The Ink compiler's loader — [dialogue-narrative.md §2.2](../../../docs/architecture/dialogue-narrative.md).
 *
 * `inkjs/full` carries the compiler and is about 240 kB, so the app does not download it until a project has a dialogue container. The
 * compile gate stays synchronous: a host awaits `loadInkCompiler()` once (the app when such a project opens, a Node entry before it
 * serves anything, the test setup), and `compileInk` reads the module this holds. Before that it throws {@link InkCompilerNotLoaded},
 * so a gate that cannot run never answers "valid" or "no findings".
 */

const importInk = () => import('inkjs/full');

type InkModule = Awaited<ReturnType<typeof importInk>>;

/** `compileInk` ran before `loadInkCompiler()` resolved. A host bug or a failed load, never a verdict on the writer's Ink. */
export class InkCompilerNotLoaded extends Error {
  constructor() {
    super('The Ink compiler is not loaded yet, so the Ink cannot be checked. Call loadInkCompiler() first.');
    this.name = 'InkCompilerNotLoaded';
  }
}

let loaded: InkModule | undefined;
let pending: Promise<void> | undefined;

/**
 * Loads the compiler once. Every caller gets the same promise; a load that failed is forgotten, so the next call tries again
 * (the app's Try again).
 */
export function loadInkCompiler(): Promise<void> {
  pending ??= importInk().then(
    (module) => {
      loaded = module;
    },
    (error: unknown) => {
      pending = undefined;
      throw error;
    },
  );
  return pending;
}

/** Whether `compileInk` can run now. */
export function inkCompilerLoaded(): boolean {
  return loaded !== undefined;
}

/** The loaded compiler module, or {@link InkCompilerNotLoaded}. */
export function inkCompiler(): InkModule {
  if (loaded === undefined) throw new InkCompilerNotLoaded();
  return loaded;
}
