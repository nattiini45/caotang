/**
 * The mock the product runs its demo provider on: the three demo intents, a fixed answer for anything else from the planner, and the
 * echo fallback. The app and the SDK's `provider: 'mock'` both build it here, so there is one script list, not a copy per host.
 */

import { DEMO_REFUSAL, demoScripts, plannerScript } from './agent-scripts.js';
import { createMockProvider, type MockProvider } from './mock-provider.js';
import { echo } from './scripts.js';

/**
 * What the demo provider says to anything outside its three demo intents: the same words the gateway's demo refuses a drafting call
 * with, held once in the gateway's mock (`DEMO_REFUSAL`), so a copy change cannot leave the planner's reply and the refusal apart.
 */
export const DEMO_FALLBACK_REPLY = DEMO_REFUSAL;

export function appMockProvider(): MockProvider {
  return createMockProvider({
    scripts: [...demoScripts, plannerScript(() => JSON.stringify({ reply: DEMO_FALLBACK_REPLY })), echo],
  });
}
