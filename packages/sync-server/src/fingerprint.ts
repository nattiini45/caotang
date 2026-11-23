/** The immutable upload fingerprint: SHA-256 over project id, object name and payload, binding an idempotency key to one upload. */
export async function payloadFingerprint(projectId: string, name: string, bytes: Uint8Array): Promise<string> {
  const prefix = new TextEncoder().encode(`${projectId}\0${name}\0`);
  const input = new Uint8Array(prefix.byteLength + bytes.byteLength);
  input.set(prefix);
  input.set(bytes, prefix.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}