import type { ModelChoice, PresetDef } from '@caotang/gateway';
import type { ProbeFailure } from './provider-probe.js';

/** What a person has given when adding a provider: the key, and only for a custom endpoint or a local server where it is. */
export interface SetupInput {
  readonly preset: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fields?: Readonly<Record<string, string>>;
  readonly customHeaders?: Readonly<Record<string, string>>;
}

/** Why a setup stopped before any model could be offered. Nothing was saved in any of these cases. */
export type SetupFailure =
  | { readonly kind: 'invalid'; readonly message: string; readonly field?: string }
  | { readonly kind: 'probe'; readonly failure: ProbeFailure }
  | { readonly kind: 'empty' };

export class SetupError extends Error {
  constructor(readonly failure: SetupFailure) {
    super(failure.kind === 'invalid' ? failure.message : failure.kind);
    this.name = 'SetupError';
  }
}

/** A key that passed its check and the models it can write with. The profile exists but is hidden until a model is chosen. */
export interface SetupDiscovery {
  readonly draftId: string;
  readonly name: string;
  readonly preset: PresetDef;
  readonly models: readonly ModelChoice[];
  /** `table` when the provider documents no model list and Caotang's own table is the catalogue. */
  readonly source: 'live' | 'table';
}
