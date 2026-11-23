/**
 * The network calls the desktop shell makes for the page: the shape the preload exposes and the main process answers, and
 * nothing more. See [desktop.md](../../../docs/architecture/desktop.md#native-provider-and-mcp-calls-405).
 *
 * A request is a plain value — method, URL, headers, text body — and an answer arrives in two parts: its head, which is
 * the reply to `start`, and then its body as chunks on one channel, so a server-sent event reaches the page as it is
 * written rather than after it ends. Nothing here carries a secret the page does not already have; #404 moves provider keys
 * out of the page and has the main process attach them.
 */

/** Why a call did not happen, or why one that started ended early. */
export type EgressError = 'invalid' | 'denied' | 'too-large' | 'unavailable' | 'aborted';

export type EgressReply<T> = { readonly ok: true; readonly value: T } | {
  readonly ok: false;
  readonly error: EgressError;
};

/** One request to make. `id` is minted by the page and echoed on every chunk, so one channel serves many calls. */
export interface EgressRequestSpec {
  readonly id: string;
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** A response before its body: status, reason and headers. */
export interface EgressHead {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface EgressChunk {
  readonly id: string;
  readonly bytes: Uint8Array;
}

/** The end of a body. `error` is present when it did not finish cleanly, and the reply it belongs to already said why. */
export interface EgressEnd {
  readonly id: string;
  readonly error?: Exclude<EgressError, 'invalid' | 'denied'>;
}

export interface NativeEgressBridge {
  /** Replaces the origins that may be reached. Called before a request to an address the page has not used yet. */
  configure(origins: readonly string[]): Promise<EgressReply<null>>;
  start(spec: EgressRequestSpec): Promise<EgressReply<EgressHead>>;
  /** Stops a call that is still streaming. A call that already ended is not an error. */
  abort(id: string): Promise<EgressReply<null>>;
  onChunk(listener: (chunk: EgressChunk) => void): () => void;
  onEnd(listener: (end: EgressEnd) => void): () => void;
}
