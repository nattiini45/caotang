/**
 * The Ink compiler's load state in the app — dialogue-narrative.md §2.2.
 *
 * The compiler (inkjs, about 240 kB) is a separate download, fetched when a project holds a dialogue container and not before. The
 * compile gate is synchronous and throws until the load has finished (`@caotang/dialogue`, ink-loader.ts), so everything that compiles
 * waits on this: a project opens only after the compiler has loaded, an Ink import, a dialogue export and an agent turn wait for it, and
 * the dialogue view and the Inspector's dialogue section show a loading line, or the failure with Try again, until it is ready.
 */

import { loadInkCompiler } from '@caotang/dialogue';
import type { ProjectState } from '@caotang/store';

export type InkCompilerStatus = 'idle' | 'loading' | 'ready' | 'failed';

/** The binder node type a dialogue container carries (dialogue-narrative.md §2.1). */
const DIALOGUE_NODE_TYPE = 'dialogue';

let status: InkCompilerStatus = 'idle';
let failures = 0;
let inFlight: Promise<void> | undefined;
const listeners = new Set<() => void>();

function set(next: InkCompilerStatus): void {
  if (status === next) return;
  status = next;
  for (const listener of listeners) listener();
}

/** Where the load stands. */
export function inkCompilerStatus(): InkCompilerStatus {
  return status;
}

/** How many loads have failed. Chromium keeps a failed import for the life of the page, so from the second the answer is to reload it. */
export function inkCompilerFailures(): number {
  return failures;
}

/** Calls `listener` when the status changes, for `useSyncExternalStore`. Returns the unsubscribe. */
export function subscribeInkCompiler(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Loads the compiler, once. It never rejects: a failed load sets the status to `failed`, which the views show with Try again, and the
 * next call tries again. Callers that go on to compile check the status, or let the gate throw `InkCompilerNotLoaded`.
 */
export function requestInkCompiler(): Promise<void> {
  if (status === 'ready') return Promise.resolve();
  if (inFlight === undefined) {
    set('loading');
    inFlight = loadInkCompiler().then(
      () => {
        inFlight = undefined;
        set('ready');
      },
      () => {
        inFlight = undefined;
        failures += 1;
        set('failed');
      },
    );
  }
  return inFlight;
}

/** Whether the project holds a dialogue container, archived or not: the compile gate has something to read. */
export function hasDialogue(state: ProjectState): boolean {
  return state.manifest.tree.some((node) => node.type === DIALOGUE_NODE_TYPE);
}

/** Loads the compiler when the project holds a dialogue container. A project without one downloads nothing. */
export function requestInkCompilerFor(state: ProjectState): Promise<void> {
  return status === 'ready' || !hasDialogue(state) ? Promise.resolve() : requestInkCompiler();
}
