/**
 * The Tier-2 gateway's port: `tool.search` (extensibility.md §5), the search-then-load meta-tool.
 *
 * The search itself is `@caotang/mcp-client`'s `toolSearch`, which loads the matches for the turn. This file only
 * maps its answer to the registry's shape. The tool is a read, so it is wired whether or not a server is connected:
 * with none, its answer is a result that says so, not an error (extensibility §5).
 */

import { toolSearch, type IndexedTools, type LoadedTools, type NativeIndexRow } from '@caotang/mcp-client';

import type { ToolOutcome, ToolPort, ToolValue } from '../types.js';

/** The index of an app with no MCP client: no servers, so nothing to search, and a note that says why. */
export const NO_SERVERS: IndexedTools = {
  tools: [],
  notes: ['no MCP servers connected — add one in Settings › MCP & tools'],
};

/**
 * The port. `index` is read on each call, so a server connected or disabled since the last search is seen at once, and
 * `native` lists the deferred registry rows that can be called now. `loaded` is the turn's loaded set: a match is added to
 * it, a native one so the planner declares it, an external one so it can be called (mcp.invoke).
 */
export function toolSearchPort(index: () => IndexedTools, native: () => readonly NativeIndexRow[], loaded: LoadedTools): ToolPort {
  return (params): ToolOutcome => {
    const found = toolSearch(params, { index, native, loaded });
    if (!found.ok) return found;
    const value: ToolValue = {
      data: { matches: found.value.data.matches, surfaced: found.value.data.surfaced },
      summary: found.value.summary,
      affected: [],
      ...(found.value.notes.length === 0 ? {} : { notes: found.value.notes }),
    };
    return { ok: true, value };
  };
}
