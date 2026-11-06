/**
 * Every registered tool name survives the gateway's wire-safe renaming (issue #486): the native-tools routes allow only
 * `^[a-zA-Z0-9_-]{1,64}$`, and the registry names are dotted, so each one must map to a legal wire name and back.
 */

import { describe, expect, it } from 'vitest';

import { WIRE_TOOL_NAME, toolNameCodec } from '@caotang/gateway';

import { TOOL_NAMES } from '../src/index.js';
import { plannerToolDefs } from '../src/agent/protocol.js';
import { makeHarness } from './fixtures.js';

describe('registered tool names on the native-tools wire', () => {
  const harness = makeHarness();
  const declared = plannerToolDefs(harness.tools(), [], [], true).map((tool) => tool.name);
  const names = [...new Set([...TOOL_NAMES, ...declared])];

  it('declares the registry', () => {
    expect(names.length).toBeGreaterThanOrEqual(TOOL_NAMES.length);
    expect(names.some((name) => name.includes('.'))).toBe(true);
  });

  it('maps every name to a legal, distinct wire name that maps back to it', () => {
    const codec = toolNameCodec(names);
    const wires = names.map((name) => codec.toWire(name));
    for (const wire of wires) expect(wire).toMatch(WIRE_TOOL_NAME);
    expect(new Set(wires).size).toBe(names.length);
    for (const name of names) expect(codec.fromWire(codec.toWire(name))).toBe(name);
  });
});
