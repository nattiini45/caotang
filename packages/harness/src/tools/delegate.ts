/**
 * `agent.delegate` — the planner hands a self-contained piece of reading to a built-in helper agent
 * ([agent-harness.md §2](../../../../docs/architecture/agent-harness.md), "Delegate").
 *
 * The row is a read whose work the agent loop does: the loop reserves the helper's model calls, runs it (`agent/subagent.ts`) and
 * answers with the helper's result. The port in the registry is only the answer a caller outside a turn gets, so a host that
 * lists the row without a loop (the outward MCP server never does) cannot run a helper by accident.
 */

import { failure, invalidParams } from '../errors.js';
import { param, type ObjectSpec } from '../schema.js';
import type { ToolPort } from '../types.js';

/** The built-in agents. A closed set, like the tool registry: this build has no user-defined agents. */
export const SUBAGENT_NAMES = ['reader', 'general'] as const;
export type SubagentName = (typeof SUBAGENT_NAMES)[number];

/** The most documents a delegate's scope names, as `continuity.scan`'s scope is bounded. */
export const DELEGATE_MAX_SCOPE = 20;

/** What each agent is for, in one line each: the planner reads these in `agent.delegate`'s description, and the specs carry the same text. */
export const SUBAGENT_BLURBS: Readonly<Record<SubagentName, string>> = {
  reader: 'reads the scope and the project and returns notes; it cannot propose a change',
  general: 'reads like the reader and may also propose changes as steps, which only run if you put them in your own plan and the writer approves it',
};

export const delegateParams: ObjectSpec = param.object(
  'The agent to hand the work to, and what to tell it.',
  {
    agent: param.choice('Which built-in agent: reader (read-only research) or general (reads, and may propose steps).', SUBAGENT_NAMES),
    brief: param.string('Everything the agent needs, in plain words: it sees nothing of this conversation but the brief and the scope.', { nonBlank: true, maxLength: 4000 }),
    scope: param.list(
      `Documents the agent starts from: titles or ids, at most ${DELEGATE_MAX_SCOPE}. Omit it and the agent finds what it needs with its read tools.`,
      param.string('One document: a title, or an id.', { nonBlank: true }),
      { maxItems: DELEGATE_MAX_SCOPE },
    ),
  },
  ['agent', 'brief'],
);

export interface DelegateParams {
  readonly agent: SubagentName;
  readonly brief: string;
  readonly scope?: readonly string[];
}

/**
 * The registry's port for the row. A delegated agent runs inside an agent turn, where the loop answers the call before it gets here,
 * so a call that reaches the port came from a caller with no loop around it.
 */
export const delegatePort: ToolPort = () =>
  failure(
    invalidParams(
      '"agent.delegate" runs inside an agent turn, and this call is not in one, so no agent was started. Nothing was run.',
      'ask the agent in the app to hand the work over, or read the documents with doc.read yourself',
      'name',
    ),
  );
