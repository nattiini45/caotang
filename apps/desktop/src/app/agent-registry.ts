/**
 * Which agent controller each open project's session has. It is its own module so a panel outside the agent panel (the findings tab)
 * can ask for the controller without importing the controller, which is a separate download (see `Workspace`).
 */

import type { AgentController } from './agent.js';
import type { ProjectSession } from './session.js';

const controllers = new WeakMap<ProjectSession, AgentController>();
const waiting = new WeakMap<ProjectSession, ((controller: AgentController) => void)[]>();

/** The agent controller of an open project, or `undefined` when its panel has not been made or has not loaded yet. */
export function agentFor(session: ProjectSession): AgentController | undefined {
  return controllers.get(session);
}

/** Makes `controller` the one `agentFor` finds for `session`. The controller calls this when its panel attaches it. */
export function registerAgent(session: ProjectSession, controller: AgentController): void {
  controllers.set(session, controller);
  const queued = waiting.get(session);
  if (queued === undefined) return;
  waiting.delete(session);
  for (const resume of queued) resume(controller);
}

/** The session's controller, as soon as it is registered: a request made while the controller is still downloading waits here instead of being lost. */
export function whenAgent(session: ProjectSession): Promise<AgentController> {
  const known = controllers.get(session);
  if (known !== undefined) return Promise.resolve(known);
  return new Promise((resolve) => {
    const queued = waiting.get(session) ?? [];
    queued.push(resolve);
    waiting.set(session, queued);
  });
}
