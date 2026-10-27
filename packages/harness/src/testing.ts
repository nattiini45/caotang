/**
 * Result checks for tests (agent-harness.md §9, "Result-shape assertions"). Nothing here runs in production: the app, the MCP
 * server and the CLI import `@caotang/harness`, which never imports this file.
 *
 * `withResultChecks` wraps a harness so that every successful `ToolValue.data` it hands back, from `call`, `callAsync` and a plan's
 * steps, is checked against its row's `resultSchema` with the MCP client's 2020-12 checker. A mismatch throws, naming the tool and the
 * JSON path of each violation, so removing a declared field from a tool fails the suite where the tool is called, not later where the
 * missing key is read.
 */

import { describeFailure, validateArguments } from '@caotang/mcp-client';

import type { Harness, ToolListing } from './runtime.js';
import type { PlanOutcome } from './plan.js';

/** The violations of one tool's result, as sentences with JSON paths. Empty when the data matches (or the row declares no result). */
export function resultFailures(tools: readonly Pick<ToolListing, 'name' | 'resultSchema'>[], tool: string, data: unknown): readonly string[] {
  const schema = tools.find((listing) => listing.name === tool)?.resultSchema;
  if (schema === undefined) return [];
  // The wire is JSON: an undefined value is an absent key, and a key a tool leaves undefined must not be read as a present one.
  const verdict = validateArguments(schema, JSON.parse(JSON.stringify(data)));
  if (verdict.ok) return [];
  if ('unsupported' in verdict) return [`the result schema of ${tool} uses ${verdict.unsupported}, which the checker does not follow`];
  return verdict.failures.map((failure) => describeFailure(failure));
}

/** Throws when `data` does not match the result schema of `tool`. */
export function assertResult(tools: readonly Pick<ToolListing, 'name' | 'resultSchema'>[], tool: string, data: unknown): void {
  const failures = resultFailures(tools, tool, data);
  if (failures.length > 0) throw new Error(`${tool} returned a result that does not match its declared schema:\n  ${failures.join('\n  ')}`);
}

function checkOutcome(harness: Harness, tool: string, outcome: { readonly ok: boolean; readonly value?: { readonly data: unknown } }): void {
  if (outcome.ok && outcome.value !== undefined) assertResult(harness.tools(), tool, outcome.value.data);
}

function checkPlan(harness: Harness, outcome: PlanOutcome): void {
  const steps = outcome.status === 'applied' ? outcome.steps : outcome.status === 'failed' || outcome.status === 'stopped' ? outcome.completed : [];
  for (const step of steps) assertResult(harness.tools(), step.tool, step.value.data);
}

/** The same harness, with every successful result checked against its row's declared schema. */
export function withResultChecks<H extends Harness>(harness: H): H {
  return {
    ...harness,
    call: ((call, turn) => {
      const outcome = harness.call(call, turn);
      checkOutcome(harness, call.name, outcome);
      return outcome;
    }) as Harness['call'],
    callAsync: async (call, turn) => {
      const outcome = await harness.callAsync(call, turn);
      checkOutcome(harness, call.name, outcome);
      return outcome;
    },
    external: {
      ...harness.external,
      call: (call, turn) => {
        const outcome = harness.external.call(call, turn);
        checkOutcome(harness, call.name, outcome);
        return outcome;
      },
    },
    executePlan: (plan, turn, options) => {
      const outcome = harness.executePlan(plan, turn, options);
      if (outcome.ok) checkPlan(harness, outcome.value);
      return outcome;
    },
  };
}
