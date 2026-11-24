/**
 * The address a key may be stored for — desktop.md §The keychain.
 *
 * A key is kept for a bare origin and for nothing else: no credentials, no path, no query, no fragment. A stored key is sent
 * over https, except for a server on this computer, which the native port already reaches over plain http: an MCP server run
 * on loopback is where a bearer token most often lives, and refusing its address would leave that token unusable. The loopback
 * predicate is the port's own (`native-egress.ts`), so this accepts exactly the plain-http addresses the port will send to.
 */

import { isLoopbackLiteral } from '../loopback.js';

/** The origin `raw` names, or undefined when it is not an address a key may belong to. */
export function keyOrigin(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined;
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && isLoopbackLiteral(url.hostname)) return url.origin;
  return undefined;
}
