/**
 * What the wire reports, kept free of the MCP SDK — [extensibility.md §3.3](../../../docs/architecture/extensibility.md).
 *
 * `wire.ts` imports the SDK, and the SDK is loaded on first connect (`lazy-wire.ts`), so nothing the
 * rest of the package needs at start-up may live there. The error class, the CORS probe and the
 * constants do, and they are here so that `WireError` is one class however it is reached:
 * `wire.ts` re-exports these, and every `instanceof WireError` in the client sees the same one.
 */

import type { FetchLike } from '@modelcontextprotocol/client';

/**
 * The newest protocol revision, which the client asks for first (§12 D17). A server that speaks it is connected on the
 * stateless path. A server that speaks only an older revision is connected through the SDK's legacy handshake.
 */
export const MODERN_REVISION = '2026-07-28';

/** What the server sees us as. */
export const CLIENT_NAME = 'caotang';
export const CLIENT_VERSION = '0.1.0';

/** How long the probe that tells CORS from a dead host may take. */
const PROBE_MS = 5_000;

/**
 * `revision`: the server speaks none of the revisions Caotang offers (2026-07-28, or a 2024 or 2025 revision),
 * so there is no common one to connect on. It is named apart from a generic protocol error, because the
 * person's fix is the server's version, not the URL.
 */
export type WireErrorKind = 'network' | 'cors' | 'timeout' | 'abort' | 'auth' | 'http' | 'protocol' | 'result' | 'revision';

/** A classified transport failure. The client turns the kind into the person's sentence. */
export class WireError extends Error {
  readonly kind: WireErrorKind;
  readonly status: number | undefined;
  /** For a `revision` failure: the revision the server's `initialize` answer named, when the SDK's message carries it. */
  readonly answeredRevision: string | undefined;
  /** For a `revision` failure: the revisions the server listed as supported, when its refusal carried the list. */
  readonly supportedRevisions: readonly string[];

  constructor(kind: WireErrorKind, message: string, status?: number, named: { readonly answered?: string; readonly supported?: readonly string[] } = {}) {
    super(message);
    this.name = 'WireError';
    this.kind = kind;
    this.status = status;
    this.answeredRevision = named.answered;
    this.supportedRevisions = named.supported ?? [];
  }
}

/**
 * The wire's code could not be fetched (a stale tab after a deploy, or no connection). It is a `network` failure, so the
 * server is told as unreachable and the tools stay as they were, and it is a class of its own so the settings card can
 * say the connector did not load rather than blame the server's URL.
 */
export class WireLoadError extends WireError {
  constructor(cause: unknown) {
    super('network', `the MCP connector could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'WireLoadError';
  }
}

/**
 * The CORS probe: the same URL, asked for with a no-cors GET. A browser answers an opaque
 * response when the host is up, even when it would refuse the real request, and it rejects
 * when the host is down. Only the difference between the two matters here.
 */
export function corsProbe(fetchImpl: FetchLike): (url: string) => Promise<boolean> {
  return async (url) => {
    try {
      await fetchImpl(url, { method: 'GET', mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(PROBE_MS) });
      return true;
    } catch {
      return false;
    }
  };
}
