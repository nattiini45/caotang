/**
 * The harness every Caotang host builds (agent-harness.md §11): one factory, so the desktop, the SDK and the MCP server cannot drift
 * apart in which ports they wire.
 *
 * - `ports: 'agent'` wires every port the agent loop drives (`createAgentPorts`), the coherence module's dialogue facts and review
 *   context, and the `coherence.review` model the caller gives. The desktop and the SDK use it.
 * - `ports: 'external'` wires only what needs no model, `codex.read`, and leaves the coherence defaults alone. The MCP server uses
 *   it: it holds no provider profile or key, and a model-backed tool would draft with Caotang's model, not the caller's. Given
 *   `externalPorts` it also wires the host-model pairs, whose model is the caller's.
 */

import type { ProjectState } from '@caotang/store';

import { createAgentPorts, codexReadPort } from './agent/ports.js';
import { dialogueFactsOf } from './coherence-facts.js';
import { reviewContextOf } from './coherence-review-context.js';
import { createHarness, type Harness, type HarnessOptions } from './runtime.js';
import type { CoherenceSource } from './tools/coherence.js';

export interface ProductHarnessOptions {
  readonly state: ProjectState;
  readonly registry?: HarnessOptions['registry'];
  /** 'agent' wires every port (desktop, SDK); 'external' wires only what needs no model (MCP server). */
  readonly ports: 'agent' | 'external';
  readonly externalWrites?: boolean;
  readonly mcp?: HarnessOptions['mcp'];
  /** The writer's checks and the review model; the dialogue facts and review context are wired here, for 'agent' only. */
  readonly coherence?: Pick<CoherenceSource, 'checks' | 'model'>;
  readonly skills?: HarnessOptions['skills'];
  readonly presentAssets?: () => ReadonlySet<string>;
  readonly clock?: () => number;
  readonly notify?: HarnessOptions['notify'];
  /** The agent rules, read at each call (agent-harness §4). Absent, there are none. */
  readonly rules?: HarnessOptions['rules'];
  /** The hooks, read at each call (hooks.md). Absent, the project's own `agent.hooks`; `[]` runs none. */
  readonly hooks?: HarnessOptions['hooks'];
  /**
   * Ports an external host adds to the model-free set of `ports: 'external'`: the MCP server's host-model brief/apply pairs
   * (`createBriefPorts`, tools/briefs.ts). Passed in, not built here, so the app, which has none, does not carry their code.
   */
  readonly externalPorts?: HarnessOptions['ports'];
}

export function createProductHarness(options: ProductHarnessOptions): Harness {
  const agent = options.ports === 'agent';
  return createHarness({
    state: options.state,
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ports: agent ? createAgentPorts() : { 'codex.read': codexReadPort, ...options.externalPorts },
    ...(options.externalWrites === undefined ? {} : { externalWrites: options.externalWrites }),
    ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
    ...(options.skills === undefined ? {} : { skills: options.skills }),
    ...(options.presentAssets === undefined ? {} : { presentAssets: options.presentAssets }),
    ...(options.notify === undefined ? {} : { notify: options.notify }),
    ...(options.rules === undefined ? {} : { rules: options.rules }),
    // Every host holds an agent to the hooks its project carries, so the desktop, the SDK and the MCP server cannot drift on which.
    hooks: options.hooks ?? (() => options.state.manifest.agent?.hooks),
    ...(agent
      ? { coherence: { dialogue: dialogueFactsOf, review: reviewContextOf, ...options.coherence } }
      : options.coherence === undefined
        ? {}
        : { coherence: options.coherence }),
  });
}
