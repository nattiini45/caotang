/**
 * The preset contract — what the registry holds for one provider.
 *
 * A preset is data: the default route, the default base URL, a capability row per
 * documented model, the quirks the adapter honours, and the fields a save form needs
 * beyond name/key/model (region, workspace). Nothing here invents capability: a field
 * the provider's documentation does not state is absent, and absent means "not
 * supported" to every reader.
 */

import type { AdapterId, QuirkFlags } from '../adapters/types.js';
import type { TransportTimeouts } from '../retry.js';
import type { ModelCaps } from '../types.js';

/** One model entry in a preset's capability table. */
export interface ModelRow {
  /** The model id, or a glob ending in `*` (`claude-*`). `'*'` alone is the preset's default row. */
  readonly pattern: string;
  /** A display name, when the id is not what a person calls it. */
  readonly name?: string;
  /** What the model takes on this route. Absent fields mean "not supported". */
  readonly caps: ModelCaps;
  /** The documented context window in tokens, when the provider publishes one. */
  readonly contextWindow?: number;
  /** The provider's documented output cap, when published. Informational: the profile's cap is what is sent. */
  readonly maxOutputTokens?: number;
  /** USD per 1,000 tokens (the profile's unit), when the provider publishes a price. */
  readonly pricePer1k?: { readonly prompt: number; readonly completion: number };
}

/** An extra field a preset needs beyond name/key/model — a region picker, a workspace id. */
export interface PresetField {
  /** The record key (`workspaceId`, `region`). */
  readonly key: string;
  /** The form label. */
  readonly label: string;
  /** A save cannot proceed without it. */
  readonly required?: boolean;
  /** The allowed values; absent means free text. */
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  /** The value used when the form leaves it empty. */
  readonly defaultValue?: string;
}

/**
 * Whether a browser page can reach the provider directly. `local` is a server on this computer: whether the browser may
 * call it is the person's setting on that server, which `PresetDef.local.corsFix` names.
 */
export type CorsStatus = 'ok' | 'blocked' | 'unknown' | 'local';

/** What a preset for a model server on this computer adds. Its presence is what makes a preset local. */
export interface LocalServer {
  /** The product's name in messages: "Ollama", "LM Studio", "llama-server". */
  readonly product: string;
  /** The one-line fix shown when the browser's CORS check fails: the exact setting on that server. */
  readonly corsFix: string;
  /** A short setup note for the settings form: start the server, load a model, raise the context window. */
  readonly setup: string;
}

export interface PresetDef {
  readonly id: string;
  /** The picker name, e.g. "Anthropic (Claude)". */
  readonly name: string;
  /** The default route's adapter; `quirks.modelRoutes` may override it per model. */
  readonly adapter: AdapterId;
  /** The default base URL. A preset with `baseUrlFor` carries the templated form here. */
  readonly baseUrl: string;
  /** The model id a new profile starts with. */
  readonly defaultModel: string;
  /** The per-model capability table, exact ids and globs. */
  readonly models: readonly ModelRow[];
  /** The flags the adapter honours on this route. */
  readonly quirks: QuirkFlags;
  /** Documented keyless inference (OpenCode's free models) or a hand-rolled endpoint. `/models` may still keyless-answer elsewhere — that is `keylessModels`, never keyless calls. */
  readonly keyOptional?: boolean;
  /** The model list answers without a key. Listing only — says nothing about inference. */
  readonly keylessModels?: boolean;
  /** The route documents no `/models` endpoint (Cohere's compatibility layer): the table is the catalogue. */
  readonly noModelsRoute?: boolean;
  /** Browser reachability. `unknown` where the documentation is silent. */
  readonly cors: CorsStatus;
  /** The words a UI shows next to `cors`, when the status needs them. */
  readonly corsNote?: string;
  /** Extra profile fields beyond name/key/model (Alibaba workspace, Tencent region). */
  readonly fields?: readonly PresetField[];
  /** Builds the base URL from the extra fields, when `baseUrl` is a template. */
  readonly baseUrlFor?: (fields: Readonly<Record<string, string>>) => string;
  /** The provider's API documentation. */
  readonly docsUrl?: string;
  /**
   * A server on this computer. Its base URL follows the loopback rule (`normalizeLocalBaseUrl`: `http` to a literal
   * loopback address is allowed), the picker groups it under "On this computer", and a failed call names `corsFix`.
   */
  readonly local?: LocalServer;
  /** Per-preset deadline overrides: a local server loads its model from disk before it answers. The gateway's own settings still win. */
  readonly timeouts?: Partial<TransportTimeouts>;
}
