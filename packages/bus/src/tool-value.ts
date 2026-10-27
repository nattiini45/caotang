/**
 * What a successful tool call returns to its caller (agent-harness.md §3). The harness builds it, and the media modules'
 * tools return it too, so it lives in the bus with the other shapes a tool package needs and imports nothing from the
 * harness. `@caotang/harness` re-exports it from `types.ts`.
 */

import type { ActivityEntry } from './activity-log.js';

/** What `data` holds when a caller does not name the tool: any JSON object. A tool's own shape is `ToolResults` (harness `results.ts`). */
export type ToolData = Readonly<Record<string, unknown>>;

export interface ToolValue<D extends ToolData = ToolData> {
  /** JSON-serialisable payload for the model and the activity panel. */
  readonly data: D;
  /** One line: what changed, or what was read. */
  readonly summary: string;
  /** §8's human titles for the nodes this call touched. Empty for a read. */
  readonly affected: readonly ActivityEntry['affected'][number][];
  /** The §5 group the call's effects sit in, when it wrote anything. */
  readonly undoGroupId?: string;
  /** Truncation and normalisation notes, said aloud rather than applied silently. */
  readonly notes?: readonly string[];
}
