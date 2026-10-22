/**
 * The loopback predicate, in one place. The gateway (local model presets) and the MCP client
 * (plain `http://` to a server on this machine) both decide "is this host this computer?" with it,
 * so the two cannot drift. No DNS is consulted: a hostname is judged by its text alone.
 */

/** A dotted-quad IPv4 address in 127.0.0.0/8. The octets are range-checked by `isLoopbackLiteral`. */
const LOOPBACK_IPV4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * True for a literal address of this machine: `localhost`, an address in 127.0.0.0/8, or `[::1]`. Takes a parsed
 * `URL.hostname` (which lower-cases and normalises `127.1` to `127.0.0.1`). A name that merely starts with `127.`,
 * such as `127.evil.example`, is a public host. A name such as `app.localhost` is a name, not a literal, so it is false.
 */
export function isLoopbackLiteral(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '[::1]') return true;
  const octets = LOOPBACK_IPV4.exec(host);
  return octets !== null && octets.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * Hosts on the person's own machine: the literals above, and any `*.localhost` name (browsers resolve those to
 * loopback). The MCP client accepts the names; the local model presets accept literals only (`isLoopbackLiteral`).
 */
export function isLoopbackHost(hostname: string): boolean {
  return isLoopbackLiteral(hostname) || hostname.toLowerCase().endsWith('.localhost');
}
