/**
 * The provider set-up the SDK needs and the app keeps in IndexedDB: one profile, its key sealed in an in-memory vault, and a gateway
 * that sends every task role through it. The key is read once, here, and lives nowhere else: not on a profile view, not in a file, not
 * in a log (provider-gateway §4, `redact.ts`). The caller's key goes from the caller's machine to the profile's own origin, through the
 * gateway's egress pin, and to nothing else.
 */

import {
  createGateway,
  createKeyStore,
  createMemoryVaultPort,
  createProfileStore,
  type Gateway,
  type NewProfile,
  type ProfileView,
  type TaskRole,
  type ThinkingLevel,
} from '@caotang/gateway';
import { appMockProvider } from '@caotang/gateway/mock';

export interface ProviderConfig {
  /** A preset id and its fields, as the Settings form takes them. Never the key. */
  readonly profile: Omit<NewProfile, 'apiKey' | 'isActive' | 'kind'>;
  /** Read once, sealed into an in-memory key store, never written to disk or to a log. A thunk is called once, at open. */
  readonly apiKey?: string | (() => string | undefined);
  /** The model every request is sent with. Absent, the profile's default model. */
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
  /** The task role the agent's requests run under (provider-gateway §6). Default 'chat'. */
  readonly role?: TaskRole;
}

export interface NodeProviders {
  readonly gateway: Gateway;
  readonly profile: ProfileView;
  readonly role: TaskRole;
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
}

export interface NodeProvidersOptions {
  readonly provider: ProviderConfig | 'mock';
  readonly fetch?: typeof fetch;
}

/** The profile name the deterministic demo provider runs under. */
const MOCK_PROFILE_NAME = 'Demo (no key, no network)';

export async function createNodeProviders(options: NodeProvidersOptions): Promise<NodeProviders> {
  const { provider } = options;
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });

  const config = provider === 'mock' ? undefined : provider;
  const apiKey = config === undefined ? undefined : typeof config.apiKey === 'function' ? config.apiKey() : config.apiKey;
  const profile =
    config === undefined
      ? await profiles.create({ name: MOCK_PROFILE_NAME, kind: 'mock', isActive: true })
      : await profiles.create({
          ...config.profile,
          kind: 'endpoint',
          isActive: true,
          ...(apiKey === undefined || apiKey === '' ? {} : { apiKey }),
        });
  const role = config?.role ?? 'chat';
  const model = config?.model;
  const thinking = config?.thinking;

  const gateway = createGateway({
    profiles,
    keys,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(config === undefined ? { mock: appMockProvider() } : {}),
    // Every role runs on the one profile: the caller named a single provider, so there is nothing to route.
    roles: {
      resolve: () => ({ profileId: profile.id, ...(model === undefined ? {} : { model }), ...(thinking === undefined ? {} : { thinking }) }),
      allowed: () => [profile.id],
    },
  });
  return { gateway, profile, role, ...(model === undefined ? {} : { model }), ...(thinking === undefined ? {} : { thinking }) };
}
