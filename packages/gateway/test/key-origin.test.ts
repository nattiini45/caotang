/**
 * The address a key may be stored for — desktop.md §The keychain. https anywhere, and plain http only on this computer: a local
 * MCP server's own address, which is the one non-https address the native port sends to (native-egress.ts).
 */

import { describe, expect, it } from 'vitest';
import { keyOrigin } from '../src/keys/key-origin.js';

describe('an address a key may belong to', () => {
  it('accepts a bare https origin', () => {
    expect(keyOrigin('https://api.example.com')).toBe('https://api.example.com');
    expect(keyOrigin('https://api.example.com:8443')).toBe('https://api.example.com:8443');
  });

  it('accepts plain http on this computer, which is where a local MCP server runs', () => {
    expect(keyOrigin('http://127.0.0.1:3845')).toBe('http://127.0.0.1:3845');
    expect(keyOrigin('http://127.1.2.3:3333')).toBe('http://127.1.2.3:3333');
    expect(keyOrigin('http://localhost:11434')).toBe('http://localhost:11434');
    expect(keyOrigin('http://[::1]:3845')).toBe('http://[::1]:3845');
  });

  it('refuses plain http for a public host, because the port would never send a token there', () => {
    expect(keyOrigin('http://api.example.com')).toBeUndefined();
    expect(keyOrigin('http://127.evil.example:3845')).toBeUndefined();
    expect(keyOrigin('http://app.localhost:3845')).toBeUndefined();
  });

  it('refuses a base URL, an address with credentials, and another scheme', () => {
    expect(keyOrigin('https://api.example.com/v1')).toBeUndefined();
    expect(keyOrigin('https://user:secret@api.example.com')).toBeUndefined();
    expect(keyOrigin('https://api.example.com/?key=1')).toBeUndefined();
    expect(keyOrigin('https://api.example.com/#fragment')).toBeUndefined();
    expect(keyOrigin('ftp://api.example.com')).toBeUndefined();
    expect(keyOrigin('not an address')).toBeUndefined();
  });
});
