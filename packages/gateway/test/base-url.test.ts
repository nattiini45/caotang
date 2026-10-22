/**
 * Base URL validation and normalisation — provider-gateway.md §2. Every case here is a
 * shape a person can type into the settings form, so each one is a decision the form
 * relies on.
 */

import { describe, expect, it } from 'vitest';
import { isLocalBase, isLoopbackHost, isLoopbackLiteral } from '../src/base-url.js';
import { isLoopbackBase, normalizeBaseUrl, normalizeLocalBaseUrl, ProfileError } from '../src/index.js';

const rejects = (input: string): ProfileError => {
  try {
    normalizeBaseUrl(input);
  } catch (error) {
    if (error instanceof ProfileError) return error;
    throw error;
  }
  throw new Error(`expected ${JSON.stringify(input)} to be rejected`);
};

describe('normalizeBaseUrl — accepted shapes', () => {
  it.each([
    ['https://openrouter.ai/api/v1/', 'https://openrouter.ai/api/v1'],
    ['https://api.openai.com/v1', 'https://api.openai.com/v1'],
    ['  https://api.openai.com/v1//  ', 'https://api.openai.com/v1'],
    ['https://api.openai.com/', 'https://api.openai.com'],
    ['https://api.openai.com', 'https://api.openai.com'],
    ['https://API.OpenAI.com:443/v1', 'https://api.openai.com/v1'],
    // Google's documented OpenAI-compatible base carries a version but does not end in one.
    ['https://generativelanguage.googleapis.com/v1beta/openai/', 'https://generativelanguage.googleapis.com/v1beta/openai'],
  ])('normalises %s to %s', (input, expected) => {
    expect(normalizeBaseUrl(input)).toBe(expected);
  });
});

describe('normalizeBaseUrl — refused shapes', () => {
  it('refuses a full endpoint path, since the gateway appends the endpoint itself', () => {
    const error = rejects('https://api.openai.com/v1/chat/completions');
    expect(error.field).toBe('baseUrl');
    expect(error.message).toMatch(/full endpoint path/);
  });

  it.each(['https://x.io/v1/models', 'https://x.io/v1/completions', 'https://x.io/v1/responses', 'https://x.io/v1/embeddings'])(
    'refuses the endpoint path in %s',
    (input) => {
      expect(() => normalizeBaseUrl(input)).toThrow(ProfileError);
    },
  );

  it('refuses a path that carries no version', () => {
    expect(rejects('https://api.example.com/api').message).toMatch(/pathless or carry a version/);
  });

  it('refuses plain http anywhere, loopback included: the generic kind stays HTTPS-only, and a local server goes through a local preset', () => {
    expect(rejects('http://example.com/v1').message).toMatch(/https/);
    for (const loopback of ['http://localhost:1234/v1', 'http://127.0.0.1:11434/v1/', 'http://[::1]:1234/v1']) {
      expect(() => normalizeBaseUrl(loopback)).toThrow(ProfileError);
      expect(rejects(loopback).message).toMatch(/https/);
    }
  });

  it('refuses plain http to a public host whose name merely starts with 127., since only a 127.x.x.x address is loopback', () => {
    expect(() => normalizeBaseUrl('http://127.evil.example/v1')).toThrow(ProfileError);
    expect(rejects('http://127.evil.example/v1').message).toMatch(/https/);
    expect(() => normalizeBaseUrl('http://127.0.0.1.evil.example/v1')).toThrow(ProfileError);
  });

  it('refuses a query string or fragment, which would break the appended path', () => {
    expect(() => normalizeBaseUrl('https://x.io/v1?api-version=2')).toThrow(ProfileError);
    expect(() => normalizeBaseUrl('https://x.io/v1#frag')).toThrow(ProfileError);
  });

  it('refuses credentials embedded in the URL', () => {
    expect(() => normalizeBaseUrl('https://user:pass@x.io/v1')).toThrow(ProfileError);
  });

  it.each(['ftp://x.io/v1', 'mock://caotang', 'file:///etc/passwd'])('refuses the scheme in %s', (input) => {
    expect(() => normalizeBaseUrl(input)).toThrow(ProfileError);
  });

  it('refuses an empty value and a value that is not a URL', () => {
    expect(() => normalizeBaseUrl('   ')).toThrow(/is empty/);
    expect(() => normalizeBaseUrl('not a url')).toThrow(/not a URL/);
  });
});

describe('isLoopbackBase', () => {
  it('is true only for the user’s own machine', () => {
    expect(isLoopbackBase('http://localhost:1234/v1')).toBe(true);
    expect(isLoopbackBase('http://app.localhost:3000')).toBe(true);
    expect(isLoopbackBase('http://127.0.0.1:11434/v1')).toBe(true);
    expect(isLoopbackBase('https://api.openai.com/v1')).toBe(false);
    expect(isLoopbackBase('not a url')).toBe(false);
  });

  it('is false for a public host whose name starts with 127., so a key saved there must be entered', () => {
    expect(isLoopbackBase('http://127.attacker.test')).toBe(false);
    expect(isLoopbackBase('https://127.attacker.test/v1')).toBe(false);
    expect(isLoopbackBase('http://127.0.0.1.attacker.test:11434/v1')).toBe(false);
  });

  it('is true for every address in 127.0.0.0/8, and the URL parser writes short forms out in full', () => {
    expect(isLoopbackBase('http://127.0.0.2:1234/v1')).toBe(true);
    expect(isLoopbackBase('http://127.255.255.254:1234/v1')).toBe(true);
    expect(isLoopbackBase('http://127.1:1234/v1')).toBe(true);
  });
});

describe('isLoopbackHost', () => {
  it('needs four octets, each at most 255, after 127', () => {
    expect(isLoopbackHost('127.300.0.1')).toBe(false);
    expect(isLoopbackHost('127.0.0')).toBe(false);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('128.0.0.1')).toBe(false);
  });
});

const localRejects = (input: string): ProfileError => {
  try {
    normalizeLocalBaseUrl(input);
  } catch (error) {
    if (error instanceof ProfileError) return error;
    throw error;
  }
  throw new Error(`expected ${JSON.stringify(input)} to be rejected`);
};

describe('normalizeLocalBaseUrl — a local model server, on this computer only', () => {
  it.each([
    ['http://127.0.0.1:11434/v1', 'http://127.0.0.1:11434/v1'],
    ['http://localhost:1234/v1/', 'http://localhost:1234/v1'],
    ['http://[::1]:8080/v1', 'http://[::1]:8080/v1'],
    ['  HTTP://LocalHost:8080/v1  ', 'http://localhost:8080/v1'],
    ['http://127.0.0.2:8080', 'http://127.0.0.2:8080'],
    ['http://127.255.255.254:1234/v1', 'http://127.255.255.254:1234/v1'],
    // The URL parser writes a short form out in full, so what is stored is the literal address.
    ['http://127.1:1234/v1', 'http://127.0.0.1:1234/v1'],
    ['https://127.0.0.1:8443/v1', 'https://127.0.0.1:8443/v1'],
  ])('accepts %s as %s', (input, expected) => {
    expect(normalizeLocalBaseUrl(input)).toBe(expected);
  });

  it.each([
    ['a LAN address', 'http://192.168.1.20:11434/v1'],
    ['a 10.x address', 'http://10.0.0.5:1234/v1'],
    ['a .local name', 'http://box.local:11434/v1'],
    ['a .localhost name, which is a name and not a literal', 'http://app.localhost:11434/v1'],
    ['a look-alike with a 127. prefix', 'http://127.evil.example/v1'],
    ['a look-alike with a full dotted quad prefix', 'http://127.0.0.1.evil.example:11434/v1'],
    ['a public host over https', 'https://api.openai.com/v1'],
    ['an unspecified address', 'http://0.0.0.0:11434/v1'],
    ['a trailing-dot name', 'http://localhost.:11434/v1'],
    ['an IPv4-mapped IPv6 address', 'http://[::ffff:7f00:1]:11434/v1'],
  ])('refuses %s and says why', (_name, input) => {
    const error = localRejects(input);
    expect(error.field).toBe('baseUrl');
    expect(error.message).toMatch(/this computer/);
    expect(error.message).toMatch(/never sent unencrypted over a network/);
  });

  it('refuses an octet out of range, which the URL parser itself rejects', () => {
    expect(() => normalizeLocalBaseUrl('http://127.0.0.256:11434/v1')).toThrow(ProfileError);
  });

  it('refuses credentials in the URL, including a loopback-looking userinfo in front of another host', () => {
    expect(localRejects('http://127.0.0.1@evil.example/v1').message).toMatch(/username or password/);
    expect(localRejects('http://user:pass@127.0.0.1:11434/v1').message).toMatch(/username or password/);
  });

  it.each(['ftp://127.0.0.1/v1', 'mock://caotang', 'file:///etc/passwd', 'ws://127.0.0.1:1234/v1'])('refuses the scheme in %s', (input) => {
    expect(localRejects(input).message).toMatch(/http:[/][/] or https:[/][/]/);
  });

  it('keeps the shape rules of the https normaliser: no query, no endpoint path, a version or nothing', () => {
    expect(localRejects('http://127.0.0.1:11434/v1?x=1').message).toMatch(/query string/);
    expect(localRejects('http://127.0.0.1:11434/v1/chat/completions').message).toMatch(/full endpoint path/);
    expect(localRejects('http://127.0.0.1:11434/api').message).toMatch(/pathless or carry a version/);
    expect(() => normalizeLocalBaseUrl('   ')).toThrow(/is empty/);
    expect(() => normalizeLocalBaseUrl('not a url')).toThrow(/not a URL/);
  });

  it('names a local example, not the hosted one', () => {
    expect(localRejects('not a url').message).toContain('http://127.0.0.1:11434/v1');
    expect(rejects('not a url').message).toContain('https://api.openai.com/v1');
  });

  it('leaves the https normaliser as it was: loopback http still fails there', () => {
    expect(() => normalizeBaseUrl('http://127.0.0.1:11434/v1')).toThrow(/https/);
  });
});

describe('isLoopbackLiteral and isLocalBase — literals only', () => {
  it('accepts localhost, 127.0.0.0/8 and [::1], and no name under .localhost', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.10.20.30', '[::1]']) expect(isLoopbackLiteral(host), host).toBe(true);
    for (const host of ['app.localhost', '127.evil.example', '127.0.0.256', '::1', '0.0.0.0', 'localhost.']) {
      expect(isLoopbackLiteral(host), host).toBe(false);
    }
    // The shared predicate the MCP client uses still takes the names.
    expect(isLoopbackHost('app.localhost')).toBe(true);
  });

  it('reads a base by its parsed host', () => {
    expect(isLocalBase('http://127.0.0.1:11434/v1')).toBe(true);
    expect(isLocalBase('http://app.localhost:11434/v1')).toBe(false);
    expect(isLocalBase('https://api.openai.com/v1')).toBe(false);
    expect(isLocalBase('not a url')).toBe(false);
  });
});
