/**
 * Calls to a model server on this computer — [provider-gateway.md §9](docs/architecture/provider-gateway.md).
 *
 * A browser tells a page almost nothing about why a request to `127.0.0.1` failed: a CORS refusal, a connection
 * refused and Chrome's Local Network Access denial all reject `fetch` with the same opaque `TypeError`. This file
 * holds what can still be told apart, so the transport can name the one setting that fixes the failure.
 */

/** The preset facts a failed local call needs for its message. Attached to a `CallSpec` by the gateway. */
export interface LocalHint {
  /** "Ollama", "LM Studio", "llama-server" */
  readonly product: string;
  /** The preset's one-line CORS fix. */
  readonly corsFix: string;
}

export type LocalFailure = 'cors' | 'refused' | 'denied';

/**
 * What a rejected `fetch` says about itself. A refused connection is named by Node and desktop shells (`ECONNREFUSED`)
 * and by Chrome's own text when it is not hidden; a permission denial by its name or its words. A bare `TypeError`
 * is a browser's opaque network failure: `'opaque'`, to be told apart by asking whether the server answers at all.
 * Anything else (an abort, a bug) is not a local-server failure.
 */
export function classifyLocalFailure(err: unknown): LocalFailure | 'opaque' | undefined {
  if (!(err instanceof Error)) return undefined;
  const cause = (err as { cause?: unknown }).cause;
  const causeText = cause instanceof Error ? `${cause.message} ${(cause as { code?: string }).code ?? ''}` : '';
  // Plain substring scans: this text comes from outside, so no pattern here can backtrack on it.
  const text = `${err.message} ${causeText}`.toLowerCase();
  if (text.includes('econnrefused') || text.includes('err_connection_refused') || text.includes('connection refused')) return 'refused';
  const permission = text.includes('permission') && (text.includes('denied') || text.includes('blocked'));
  if (err.name === 'NotAllowedError' || permission || text.includes('local network access') || text.includes('private network access')) {
    return 'denied';
  }
  return err instanceof TypeError ? 'opaque' : undefined;
}

let addressSpaceSupport: boolean | undefined;

/**
 * Whether this browser's `fetch` takes `targetAddressSpace` (Chrome's Local Network Access). A dictionary member is
 * detected by handing `Request` an init whose getter fires only if the browser reads that member, and it counts
 * only if the browser also accepts the value. Elsewhere the option is simply not sent.
 */
export function supportsTargetAddressSpace(): boolean {
  if (addressSpaceSupport !== undefined) return addressSpaceSupport;
  let read = false;
  let supported = false;
  try {
    if (typeof Request === 'function') {
      const init = {
        get targetAddressSpace(): string {
          read = true;
          return 'loopback';
        },
      };
      new Request('http://127.0.0.1/', init as RequestInit);
      supported = read;
    }
  } catch {
    supported = false;
  }
  addressSpaceSupport = supported;
  return supported;
}

interface PermissionsLike {
  query(descriptor: { name: string }): Promise<{ state: string }>;
}

/** The state of the browser's `loopback-network` permission (`granted`, `denied`, `prompt`), or undefined where it does not exist. */
export async function loopbackPermission(): Promise<string | undefined> {
  try {
    const permissions = (globalThis as { navigator?: { permissions?: PermissionsLike } }).navigator?.permissions;
    return permissions === undefined ? undefined : (await permissions.query({ name: 'loopback-network' })).state;
  } catch {
    return undefined;
  }
}
