/**
 * A real `Gateway` over in-memory stores, with a mock profile active and the given scripts answering.
 * It is the gateway the product uses for a mock profile (provider-gateway §8), so usage lands in the
 * same per-turn ledger the harness reads: nothing here is a stand-in for accounting.
 */

import { createGateway, createKeyStore, createManualClock, createMemoryVaultPort, createProfileStore, type Gateway } from '@caotang/gateway';
import type { GatewayHooks } from '../../src/agent/eval.js';
import { createMockProvider, type MockScript } from '@caotang/gateway/mock';

export async function mockGateway(scripts: readonly MockScript[], hooks?: GatewayHooks): Promise<Gateway> {
  const clock = hooks?.clock ?? createManualClock(0);
  const keys = createKeyStore(createMemoryVaultPort());
  // Both traced and untraced reports name the profile, so their fixture identities must match.
  let profileId = 0;
  const profiles = createProfileStore({ keys, randomBytes: (n: number) => new Uint8Array(n).fill(profileId++) });
  await profiles.create({ name: 'Mock', kind: 'mock', isActive: true });
  return createGateway({ profiles, keys, clock, mock: createMockProvider({ scripts: [...scripts] }), ...(hooks === undefined ? {} : { observe: hooks.observe }) });
}
