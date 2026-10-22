import { buf, encodeBase32, utf8 } from './bytes.js';
import { deriveSubkey, type SecretKey } from './keys.js';

async function hmac(project: SecretKey, message: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey('raw', buf(await deriveSubkey(project, 'path')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await globalThis.crypto.subtle.sign('HMAC', key, buf(utf8(message)));
  return encodeBase32(new Uint8Array(mac)).toLowerCase();
}

/** HMAC-SHA-256 of the project-relative path under the path key; 52 lower-case base32 characters. The server never sees the path. */
export function hashPath(project: SecretKey, path: string): Promise<string> {
  return hmac(project, `path\0${path}`);
}
