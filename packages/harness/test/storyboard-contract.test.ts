/**
 * The storyboard entries against the harness's own entry types, checked by the compiler.
 *
 * This is the guard the review asked for: the two entries had drifted from the harness's entry shape (a
 * `refine` that returned a bare string, which reaches the model unwrapped, and handler results the harness
 * does not read). The check below fails the typecheck when either side moves.
 *
 * It lives in the harness package, not the storyboard's. The harness imports the storyboard's entries, so a
 * storyboard devDependency on the harness would close a cycle (`pnpm -r typecheck` cannot order it). The
 * storyboard now carries no harness edge, and this file is the one place that checks the two shapes meet.
 */

import type { CommandError } from '@caotang/bus';
import type { CallParams, ParamSpec, ToolMetadata } from '../src/index.js';
import { describe, expect, it } from 'vitest';

import { STORYBOARD_TOOL_ENTRIES } from '@caotang/storyboard';

/** The harness's object spec, read off its own `ParamSpec` union, since the harness index does not export `ObjectSpec`. */
type HarnessObjectSpec = Extract<ParamSpec, { kind: 'object' }>;

/**
 * The shape `packages/harness/src/types.ts` gives a port entry (`EntryBase` with `PortEntry`'s `kind`), less the
 * three things this package cannot know. `name` and `port` are closed sets the harness widens when the tools
 * are wired. `schema` is derived from `params` at registration (types.ts: "never written by hand").
 */
interface HarnessEntryShape {
  readonly meta: Omit<ToolMetadata, 'name' | 'targets'>;
  readonly params: HarnessObjectSpec;
  readonly refine?: (params: CallParams) => CommandError | undefined;
}

// Compile-time: every storyboard entry must be assignable to the harness's entry shape. A drift in meta,
// params or refine fails the typecheck here, not at registration.
const conforming: readonly HarnessEntryShape[] = STORYBOARD_TOOL_ENTRIES;

// Compile-time, the other way: the check has to bite. A refine that returns a bare string is the defect the
// review found, and it must not compile against the harness's refine type. The directive is on the line it guards.
// @ts-expect-error a bare string is not a CommandError, and the harness reports a refine's value as the refusal
const bareRefine: Pick<HarnessEntryShape, 'refine'> = { refine: () => 'nothing to set: pass an image, a spec or an action' };
void bareRefine;

describe('the storyboard entries against the harness entry shape', () => {
  it('checks the two entries the spec names, and no others', () => {
    expect(conforming).toHaveLength(2);
    expect(STORYBOARD_TOOL_ENTRIES.map((entry) => entry.meta.name)).toEqual(['shots.derive', 'shots.annotate']);
  });

  it('returns a CommandError from refine, the value the harness reports as the refusal', () => {
    const annotate = STORYBOARD_TOOL_ENTRIES.find((entry) => entry.meta.name === 'shots.annotate');
    expect(annotate?.refine?.({ shots: ['n_X'] })).toEqual({
      code: 'invalid-params',
      message: 'nothing to set: pass an image, a spec or an action',
      correctiveHint: 'add an image, a spec or an action',
    });
  });
});
