/**
 * Canonical JSON, the pin hash, the pin diff, the effective risk, and the review fingerprint. These
 * are the pieces a rug pull has to get past, so each is tested against golden values as well as
 * against itself: a canonical form that drifted would silently re-review every tool on every server.
 */

import { describe, expect, it } from 'vitest';

import {
  agentRiskOf,
  canonicalJson,
  diffPins,
  effectiveRiskOf,
  hasDelta,
  listingFingerprint,
  pinHash,
  pinStateOf,
  pinsAfterReview,
  sha256Hex,
  subjectHash,
  type EffectiveRisk,
  type ToolPin,
} from '../src/index.js';
import { FIXED_NOW, pinAt } from './support.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('the pin of a tool that declares no output schema', () => {
  const SEARCH = {
    toolName: 'search_pages',
    description: 'Search the wiki.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  };

  // Stored from the rule as it stood before an output schema was pinned. A pin a person already reviewed must verify on the next
  // connect, so these bytes never change: the output schema joins the hash only when a server advertises one.
  it('hashes to the value stored before the output schema was pinned, with and without hints', async () => {
    expect(await pinHash(SEARCH)).toBe('0c14f2c64700b5f7c5f96f303a5336ad2620c71cbf4336c242df4a62e662c7a8');
    expect(await pinHash({ ...SEARCH, annotations: { readOnlyHint: true, openWorldHint: false } })).toBe(
      'a4948fc8a9559b5668bf0530f88519457b54ee05b24008fe3f63e2c2bd3f2f57',
    );
    expect(await subjectHash({ kind: 'tool', toolName: 'ping' })).toBe('ca376ac1ee4a797cc78f137a5bf1d9655458d92f19893b9bd5dec4722f25e17c');
  });

  it('hashes the same whether the output schema is absent or the key is left undefined', async () => {
    expect(await pinHash({ ...SEARCH, outputSchema: undefined })).toBe(await pinHash(SEARCH));
    expect(await subjectHash({ kind: 'tool', toolName: 'ping', outputSchema: undefined })).toBe(await subjectHash({ kind: 'tool', toolName: 'ping' }));
  });

  it('changes when a server starts to declare an output schema, or changes the one it declares', async () => {
    const declared = { type: 'object', properties: { pages: { type: 'array' } }, required: ['pages'] };
    const base = await pinHash(SEARCH);
    const withSchema = await pinHash({ ...SEARCH, outputSchema: declared });
    expect(withSchema).not.toBe(base);
    expect(withSchema).toBe(await sha256Hex(canonicalJson({ ...SEARCH, outputSchema: declared })));
    expect(await pinHash({ ...SEARCH, outputSchema: { ...declared, required: [] } })).not.toBe(withSchema);
    expect(await subjectHash({ kind: 'tool', toolName: 'ping', outputSchema: declared })).not.toBe(await subjectHash({ kind: 'tool', toolName: 'ping' }));
  });

  it('is independent of the order of the output schema’s keys', async () => {
    expect(await pinHash({ ...SEARCH, outputSchema: { type: 'object', required: ['a'] } })).toBe(
      await pinHash({ ...SEARCH, outputSchema: { required: ['a'], type: 'object' } }),
    );
  });
});

describe('canonicalJson', () => {
  it('sorts object keys at every depth and drops no-whitespace output', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 1 }] })).toBe('{"a":[{"c":1,"d":2}],"b":1}');
  });

  it('drops undefined members and keeps array order', () => {
    expect(canonicalJson({ z: undefined, y: [3, 1, 2] })).toBe('{"y":[3,1,2]}');
  });

  it('refuses a value JSON cannot carry', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow('non-finite');
    expect(() => canonicalJson({ f: () => 1 })).toThrow('cannot carry a function');
  });

  it('is the same bytes for two objects that differ only in key order', () => {
    expect(canonicalJson({ a: 1, b: { c: 2, d: 3 } })).toBe(canonicalJson({ b: { d: 3, c: 2 }, a: 1 }));
  });
});

describe('sha256Hex and pinHash', () => {
  it('matches the published SHA-256 test vector for "abc"', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes the canonical JSON of name, description and schema', async () => {
    const tool = { toolName: 'search_lore', description: 'Find lore', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } };
    expect(await pinHash(tool)).toBe(await sha256Hex(canonicalJson(tool)));
  });

  it('changes when the description changes by one character', async () => {
    const base = { toolName: 't', inputSchema: { type: 'object' } };
    expect(await pinHash({ ...base, description: 'Find lore.' })).not.toBe(await pinHash({ ...base, description: 'Find lore' }));
  });

  it('changes when a read-only hint flips, because the hint decides whether a trusted tool runs unasked', async () => {
    const base = { toolName: 't', description: 'Write a note.', inputSchema: { type: 'object' } };
    const unhinted = await pinHash(base);
    expect(await pinHash({ ...base, annotations: { readOnlyHint: true } })).not.toBe(unhinted);
    expect(await pinHash({ ...base, annotations: { readOnlyHint: true } })).not.toBe(await pinHash({ ...base, annotations: { readOnlyHint: false } }));
  });

  it('hashes a tool with no hints exactly as the base pin rule says, and ignores anything but the four hint keys', async () => {
    const plain = { toolName: 't', description: 'd', inputSchema: { type: 'object' } };
    expect(await pinHash(plain)).toBe(await sha256Hex(canonicalJson({ toolName: 't', description: 'd', inputSchema: { type: 'object' } })));
    expect(await pinHash({ ...plain, annotations: {} })).toBe(await pinHash(plain));
    expect(await pinHash({ ...plain, annotations: { title: 'Ignored' } as never })).toBe(await pinHash(plain));
  });

  it('changes when the schema changes, and not when only key order does', async () => {
    const description = 'd';
    const one = await pinHash({ toolName: 't', description, inputSchema: { type: 'object', properties: { a: { type: 'string' } } } });
    const two = await pinHash({ toolName: 't', description, inputSchema: { properties: { a: { type: 'string' } }, type: 'object' } });
    const three = await pinHash({ toolName: 't', description, inputSchema: { type: 'object', properties: { a: { type: 'number' } } } });
    expect(two).toBe(one);
    expect(three).not.toBe(one);
  });
});

describe('diffPins (§3.4 step 2)', () => {
  const pins: Record<string, ToolPin> = {
    mcp__s_AAAAAAAAAA__a: pinAt(HASH_A),
    mcp__s_AAAAAAAAAA__b: pinAt(HASH_B),
  };

  it('reports nothing when every listed tool matches its pin', () => {
    const delta = diffPins(pins, [
      { qualifiedName: 'mcp__s_AAAAAAAAAA__a', hash: HASH_A },
      { qualifiedName: 'mcp__s_AAAAAAAAAA__b', hash: HASH_B },
    ]);
    expect(hasDelta(delta)).toBe(false);
    expect(delta.firstConnect).toBe(false);
  });

  it('classifies a changed hash, an added tool and a removed tool', () => {
    const delta = diffPins(pins, [
      { qualifiedName: 'mcp__s_AAAAAAAAAA__a', hash: HASH_B },
      { qualifiedName: 'mcp__s_AAAAAAAAAA__c', hash: HASH_A },
    ]);
    expect(delta.changed).toEqual(['mcp__s_AAAAAAAAAA__a']);
    expect(delta.added).toEqual(['mcp__s_AAAAAAAAAA__c']);
    expect(delta.removed).toEqual(['mcp__s_AAAAAAAAAA__b']);
    expect(hasDelta(delta)).toBe(true);
  });

  it('marks a first connect when nothing is pinned yet', () => {
    const delta = diffPins({}, [{ qualifiedName: 'mcp__s_AAAAAAAAAA__a', hash: HASH_A }]);
    expect(delta.firstConnect).toBe(true);
    expect(delta.added).toEqual(['mcp__s_AAAAAAAAAA__a']);
  });

  it('gives a pin state for each tool, with never-reviewed as new', () => {
    expect(pinStateOf(pins, 'mcp__s_AAAAAAAAAA__a', HASH_A)).toBe('verified');
    expect(pinStateOf(pins, 'mcp__s_AAAAAAAAAA__a', HASH_B)).toBe('changed');
    expect(pinStateOf(pins, 'mcp__s_AAAAAAAAAA__z', HASH_A)).toBe('new');
    expect(pinStateOf(pins, 'constructor', HASH_A)).toBe('new');
  });
});

describe('pinsAfterReview', () => {
  it('keeps firstSeen for a tool it already knew and stamps the review time on all of them', () => {
    const previous = { mcp__s_AAAAAAAAAA__a: pinAt(HASH_A, '2026-01-01T00:00:00.000Z') };
    const next = pinsAfterReview(previous, [
      { qualifiedName: 'mcp__s_AAAAAAAAAA__a', hash: HASH_B },
      { qualifiedName: 'mcp__s_AAAAAAAAAA__n', hash: HASH_A },
    ], FIXED_NOW);
    expect(next['mcp__s_AAAAAAAAAA__a']).toEqual({ hash: HASH_B, firstSeen: '2026-01-01T00:00:00.000Z', lastReviewedAt: FIXED_NOW });
    expect(next['mcp__s_AAAAAAAAAA__n']).toEqual({ hash: HASH_A, firstSeen: FIXED_NOW, lastReviewedAt: FIXED_NOW });
  });

  it('keeps the server’s own name for a tool the review lists with one, so a tool removed later is named as the server named it', () => {
    const next = pinsAfterReview({}, [{ qualifiedName: 'mcp__s_AAAAAAAAAA__project_overview_a1b2c3', hash: HASH_A, toolName: 'project.overview' }], FIXED_NOW);
    expect(next['mcp__s_AAAAAAAAAA__project_overview_a1b2c3']).toEqual({
      hash: HASH_A,
      firstSeen: FIXED_NOW,
      lastReviewedAt: FIXED_NOW,
      toolName: 'project.overview',
    });
  });
});

describe('the listing fingerprint binds an approval to what was seen', () => {
  it('does not depend on the order the server listed its tools in', async () => {
    const one = await listingFingerprint([{ qualifiedName: 'x', hash: HASH_A }, { qualifiedName: 'y', hash: HASH_B }], []);
    const two = await listingFingerprint([{ qualifiedName: 'y', hash: HASH_B }, { qualifiedName: 'x', hash: HASH_A }], []);
    expect(two).toBe(one);
  });

  it('changes when a hash changes, and when a removal would be approved', async () => {
    const base = await listingFingerprint([{ qualifiedName: 'x', hash: HASH_A }], []);
    expect(await listingFingerprint([{ qualifiedName: 'x', hash: HASH_B }], [])).not.toBe(base);
    expect(await listingFingerprint([{ qualifiedName: 'x', hash: HASH_A }], ['gone'])).not.toBe(base);
  });
});

describe('effectiveRiskOf (§7 inward, §3.4 demotion, §4 rule 2)', () => {
  const pinVerified = [true, false];
  const pendingReview = [false, true];
  const trustReads = [true, false];
  const readOnlyHint: Array<boolean | undefined> = [true, false, undefined];

  it('is read-auto only when the pin is verified, nothing is pending, trust is granted, and the server says read-only', () => {
    const allCombinations: Array<[boolean, boolean, boolean, boolean | undefined, EffectiveRisk]> = [];
    for (const pin of pinVerified) {
      for (const pending of pendingReview) {
        for (const trust of trustReads) {
          for (const hint of readOnlyHint) {
            const expected: EffectiveRisk = pin && !pending && trust && hint === true ? 'read-auto' : 'write-confirm';
            allCombinations.push([pin, pending, trust, hint, expected]);
          }
        }
      }
    }
    expect(allCombinations).toHaveLength(2 * 2 * 2 * 3);
    for (const [pin, pending, trust, hint, expected] of allCombinations) {
      expect(effectiveRiskOf({ pinVerified: pin, pendingReview: pending, trustReads: trust, readOnlyHint: hint })).toBe(expected);
    }
  });

  it('is never write-auto, whatever the inputs', () => {
    const risks = new Set<EffectiveRisk>();
    for (const pin of pinVerified) for (const pending of pendingReview) for (const trust of trustReads) for (const hint of readOnlyHint) {
      risks.add(effectiveRiskOf({ pinVerified: pin, pendingReview: pending, trustReads: trust, readOnlyHint: hint }));
    }
    expect([...risks].sort()).toEqual(['read-auto', 'write-confirm']);
  });

  it('maps the bus agent risk from the effective risk', () => {
    expect(agentRiskOf('read-auto')).toBe('read');
    expect(agentRiskOf('write-confirm')).toBe('write-confirm');
  });
});
