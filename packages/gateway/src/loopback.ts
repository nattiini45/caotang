/**
 * The loopback predicate, in one place. The gateway (local model presets) and the MCP client
 * (plain `http://` to a server on this machine) both decide "is this host this computer?" with it,
 * so the two cannot drift. No DNS is consulted: a hostname is judged by its text alone.
 */

/** A dotted-quad IPv4 address in 127.0.0.0/8. The octets are range-checked by `isLoopbackLiteral`. */
const LOOPBACK_IPV4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * An IPv4 address written in IPv6 form, `::ffff:a.b.c.d`, which a parsed URL serialises as `[::ffff:7f00:1]`: the last two
 * groups are the four IPv4 octets, so the first is the second octet.
 */
const IPV4_MAPPED = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/u;

/** Whether an IPv4-mapped IPv6 literal maps a 127.0.0.0/8 address, which reaches this computer exactly as the dotted form does. */
function isMappedLoopback(host: string): boolean {
  const groups = IPV4_MAPPED.exec(host);
  if (groups === null) return false;
  const second = Number.parseInt(groups[1] ?? '', 16);
  return second >= 0x7f00 && second <= 0x7fff;
}

/**
 * True for a literal address of this machine: `localhost`, an address in 127.0.0.0/8, `[::1]`, or an IPv4-mapped form of a
 * 127.0.0.0/8 address such as `[::ffff:127.0.0.1]`, which is the same computer by another spelling. Takes a parsed
 * `URL.hostname` (which lower-cases and normalises `127.1` to `127.0.0.1`). A name that merely starts with `127.`,
 * such as `127.evil.example`, is a public host. A name such as `app.localhost` is a name, not a literal, so it is false.
 */
export function isLoopbackLiteral(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '[::1]' || isMappedLoopback(host)) return true;
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
