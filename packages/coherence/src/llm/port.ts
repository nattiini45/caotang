/**
 * The model port the LLM stages call through — [coherence.md §5.3](../../../../docs/architecture/coherence.md),
 * [provider-gateway.md §5](../../../../docs/architecture/provider-gateway.md).
 *
 * The engine does not own a provider. The app injects an adapter over the
 * gateway, which is the only thing that knows keys, profiles and endpoints.
 * Keeping those out of this package keeps `coherence.json` free of secrets
 * (project-format §2) and lets every test run against a fake port.
 */

export interface ModelUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export interface ModelRequest {
  readonly system: string;
  readonly turnId?: string;
  readonly sessionId?: string;
  readonly user: string;
  /** A JSON Schema shape the reply must follow. The gateway probes whether the provider enforces it. */
  readonly jsonSchemaHint: Readonly<Record<string, unknown>>;
  readonly maxOutputTokens?: number;
  readonly signal?: AbortSignal;
}

export interface ModelReply {
  readonly content: string;
  readonly usage?: ModelUsage;
}

export interface CoherenceModel {
  /** The model that answered, recorded on each finding's `modelMeta` (§3). */
  readonly model: string;
  complete(request: ModelRequest): Promise<ModelReply>;
}
