export type AccountState =
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'waiting'; readonly code: string; readonly expires: number }
  | { readonly kind: 'signed-in' }
  | { readonly kind: 'refused'; readonly reason: 'invalid-address' | 'unavailable' | 'expired' | 'unsupported' };

export interface AccountRequest {
  readonly id: string;
  readonly url: string;
  readonly method: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body?: Uint8Array;
}

export interface AccountResponse {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array | null;
}

export interface AccountBridge {
  configuredOrigin(): Promise<string | null>;
  restore(origin: string): Promise<AccountState>;
  begin(origin: string): Promise<AccountState>;
  check(): Promise<AccountState>;
  cancel(): Promise<AccountState>;
  signOut(): Promise<AccountState>;
  request(request: AccountRequest): Promise<AccountResponse>;
  abort(id: string): void;
}
