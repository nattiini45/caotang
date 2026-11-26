import { importProjectKey, SecretKey } from '../../../packages/crypto/src/index.js';

export function projectKey(bytes: Uint8Array): Promise<CryptoKey> {
  return importProjectKey(new SecretKey('project', bytes));
}
