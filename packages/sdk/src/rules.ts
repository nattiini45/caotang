/**
 * The folder's agent rules as a headless host reads them (agent-harness.md §4, "Rules"), shared by the two hosts that read a
 * project without the app's Settings screen: the SDK (and `caotang agent`) and the MCP server.
 *
 * The rules themselves are the manifest's `agent.rules`, as the load kept them. What this module adds is the posture the app does
 * not need: the app shows the writer a warning for every rule the load had to drop, so a lost rule is visible there. A headless
 * host has nobody to show it to, so a lost rule is a restriction nobody will hear was lost: the rules are then unreadable, and
 * every call that changes the project is refused until the file is put right. Reads still work. The same holds when the manifest
 * cannot be read again here, or when its `agent` value is not an object at all.
 *
 * A rule that was read fine is held either way, so a host whose rules are unreadable still withholds what the readable rules keep
 * from the agent.
 */

import type { RulesProvider } from '@caotang/harness';
import { MANIFEST_FILE, parseRules, type ProjectState } from '@caotang/store';

import type { NodeArtifactFs } from './node-fs.js';

/**
 * The project's agent rules, read from the folder's manifest once at open. `state` still gives the rules the load kept; the file
 * is read again only to learn whether the load dropped one (the only place a headless host can see that).
 */
export async function projectRules(fs: NodeArtifactFs, state: ProjectState): Promise<RulesProvider> {
  let unreadable = false;
  try {
    const raw: unknown = JSON.parse(await fs.read(MANIFEST_FILE));
    const agent = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['agent'] : undefined;
    if (agent !== undefined) {
      if (typeof agent !== 'object' || agent === null || Array.isArray(agent)) unreadable = true;
      else unreadable = parseRules((agent as Record<string, unknown>)['rules']).lost > 0;
    }
  } catch {
    unreadable = true;
  }
  return () => ({
    rules: (state.manifest.agent?.rules ?? []).map((rule) => ({ ...rule, source: 'project' as const })),
    ...(unreadable ? { unreadable: true } : {}),
  });
}
