import { describe, expect, it } from 'vitest';
import { EXCERPT_CHARS, type ExternalToolDescriptor } from '@caotang/mcp-client';

import { loadedToolsMessage, plannerToolDefs } from '../../src/agent/protocol.js';

function external(description: string): ExternalToolDescriptor {
  return {
    qualifiedName: 'mcp__notes__search',
    serverKey: 'notes',
    serverName: 'Notes',
    toolName: 'search',
    description,
    inputSchema: { type: 'object' },
    candidateHash: 'hash',
    pinState: 'pinned',
    enabled: true,
    effectiveRisk: 'read-auto',
  } as unknown as ExternalToolDescriptor;
}

function declared(description: string): string {
  const defs = plannerToolDefs([], [], [external(description)]);
  const def = defs.find((d) => d.name === 'mcp__notes__search');
  if (def === undefined) throw new Error('external tool missing from the declaration');
  return def.description;
}

describe('external tool descriptions reach the model as the spec excerpt (extensibility §4 rule 4)', () => {
  it('keeps a short description whole', () => {
    expect(declared('Search the notes.')).toBe('Search the notes.');
    expect(loadedToolsMessage([], [external('Search the notes.')])).toContain('— Search the notes.');
  });

  it('clips a long description to the excerpt budget, ellipsis included', () => {
    const clipped = declared('x'.repeat(EXCERPT_CHARS * 3));
    expect(clipped.length).toBeLessThanOrEqual(EXCERPT_CHARS);
    expect(clipped.endsWith('…')).toBe(true);
  });

  it('never cuts an astral character in half', () => {
    // Every character is a surrogate pair, so a unit-based cut at the budget would split one.
    const clipped = declared('😀'.repeat(EXCERPT_CHARS));
    expect(clipped.length).toBeLessThanOrEqual(EXCERPT_CHARS);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(clipped)).toBe(false);
    expect(loadedToolsMessage([], [external('😀'.repeat(EXCERPT_CHARS))])).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
