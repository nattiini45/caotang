/**
 * The registry-to-MCP mapping, checked against [extensibility.md §7](../../../docs/architecture/extensibility.md)
 * over every tool, plus the two rows the registry does not populate (`never` and
 * the protocol) tested on synthetic input so their refusal is still proven.
 */

import { describe, expect, it } from 'vitest';

import { TOOL_METADATA, annotationsFor, mcpExposure, type ExposureInput } from '../src/index.js';

describe('the §7 table, row by row', () => {
  it('maps read to readOnlyHint true and destructiveHint false, with no idempotency claim', () => {
    expect(annotationsFor('read', 'doc.read')).toEqual({ readOnlyHint: true, destructiveHint: false });
  });

  it('maps write-auto to readOnlyHint false, and idempotentHint only where idempotent by design', () => {
    expect(annotationsFor('write-auto', 'meta.set')).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(annotationsFor('write-auto', 'notes.append')).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
  });

  it('maps write-confirm to idempotentHint false', () => {
    expect(annotationsFor('write-confirm', 'codex.write')).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
  });

  it('does not expose the hard-deny class or the protocol', () => {
    expect(annotationsFor('never', 'project.deleteNode')).toBeUndefined();
    expect(annotationsFor('meta', 'agent.plan')).toBeUndefined();
  });
});

describe('every tool, through the mapping', () => {
  for (const meta of TOOL_METADATA) {
    it(`maps ${meta.name}`, () => {
      const exposure = mcpExposure(meta);
      if (meta.name === 'agent.plan') {
        expect(exposure).toEqual({ exposed: false, reason: 'protocol' });
        return;
      }
      expect(exposure.exposed).toBe(true);
      if (!exposure.exposed) return;
      const { annotations, description } = exposure;
      expect(annotations.destructiveHint).toBe(false);
      if (meta.risk === 'read') {
        expect(annotations.readOnlyHint).toBe(true);
      } else {
        expect(annotations.readOnlyHint).toBe(false);
      }
      // The two facts with no annotation travel in the text, always and where true.
      expect(description).toContain(`Returns at most ${meta.response_token_cap} tokens.`);
      if (meta.undoable) expect(description).toContain("Undo via Caotang's turn checkpoints.");
      else expect(description).not.toContain("Undo via Caotang's turn checkpoints.");
    });
  }

  it('makes idempotentHint true for meta.set alone among the exposed tools', () => {
    const idempotent = TOOL_METADATA.filter((meta) => meta.name !== 'agent.plan')
      .map((meta) => mcpExposure(meta))
      .filter((exposure) => exposure.exposed && exposure.annotations.idempotentHint === true)
      .map((exposure) => (exposure.exposed ? exposure.description : ''));
    expect(idempotent).toHaveLength(1);
    expect(idempotent[0]).toContain('Idempotent');
  });

  it('prefixes a write-confirm tool’s description with the confirmation sentence when the text lacks it', () => {
    const exposure = mcpExposure({
      name: 'export.compile',
      risk: 'write-confirm',
      undoable: true,
      response_token_cap: 500,
      description: 'Compile something to a file.',
    });
    expect(exposure.exposed).toBe(true);
    if (!exposure.exposed) return;
    expect(exposure.description.startsWith('Requires user confirmation.')).toBe(true);
  });

  it('starts every exposed write-confirm description with the confirmation sentence, and says it once', () => {
    // Position, not a count: a count passes a description that carries the sentence somewhere else.
    const confirms = TOOL_METADATA.filter((meta) => meta.risk === 'write-confirm');
    expect(confirms.length).toBeGreaterThan(0);
    for (const meta of confirms) {
      const exposure = mcpExposure(meta);
      if (!exposure.exposed) throw new Error(`${meta.name} should be exposed`);
      expect(exposure.description.startsWith('Requires user confirmation.'), meta.name).toBe(true);
      expect(exposure.description.split('Requires user confirmation.').length - 1, meta.name).toBe(1);
    }
  });

  it('moves a confirmation sentence the metadata text carries in its middle to the front, and keeps the rest of the text', () => {
    const exposure = mcpExposure({
      name: 'codex.write',
      risk: 'write-confirm',
      undoable: true,
      response_token_cap: 4000,
      description: 'Create entries. Requires user confirmation. Attach them to nodes.',
    });
    if (!exposure.exposed) throw new Error('codex.write should be exposed');
    expect(exposure.description).toBe(
      "Requires user confirmation. Create entries. Attach them to nodes. Returns at most 4000 tokens. Undo via Caotang's turn checkpoints.",
    );
  });

  it('states the automatic-application sentence on every exposed write-auto tool, and what an external caller has in its place', () => {
    const autos = TOOL_METADATA.filter((meta) => meta.risk === 'write-auto');
    // coherence.setFindingStatus is a write-auto tool restricted to `fixed` (coherence.md §7 tool 17).
    // Its description carries the same automatic-application sentence the other write-auto tools do.
    // shots.annotate is the storyboard module's write-auto tool (storyboard.md §4). synopsis.set, filter.save and goal.save are
    // the allowlisted bus primitives that apply at once (agent-harness §3).
    expect(autos.map((meta) => meta.name).sort()).toEqual(['coherence.setFindingStatus', 'filter.save', 'goal.save', 'meta.set', 'notes.append', 'shots.annotate', 'synopsis.set']);
    for (const meta of autos) {
      const exposure = mcpExposure(meta);
      if (!exposure.exposed) throw new Error(`${meta.name} should be exposed`);
      expect(exposure.description, meta.name).toContain('Applies automatically within an approved turn.');
      expect(exposure.description, meta.name).toContain(
        'An external caller has no approved turn: the write runs only where the user has turned on external writes for this project.',
      );
    }
  });

  it('tells an external caller that doc.import keeps the body verbatim and asks for confirmation', () => {
    const exposure = mcpExposure(TOOL_METADATA.find((meta) => meta.name === 'doc.import')!);
    if (!exposure.exposed) throw new Error('doc.import should be exposed');
    expect(exposure.description).toContain('The body is stored exactly as given and read back to prove it.');
    expect(exposure.description).toContain('Requires user confirmation.');
    // The body may hold newlines, so the description carries no warning about them.
    expect(exposure.description).not.toContain('newline');
  });
});

describe('the rows the registry does not populate', () => {
  it('refuses to expose a hard-deny class, naming the reason', () => {
    const input: ExposureInput = {
      name: 'project.deleteNode',
      risk: 'never',
      undoable: true,
      response_token_cap: 100,
      description: 'Delete a node.',
    };
    expect(mcpExposure(input)).toEqual({ exposed: false, reason: 'hard-deny' });
  });

  it('refuses to expose the protocol row, naming the reason', () => {
    expect(mcpExposure({ name: 'agent.plan', risk: 'meta', undoable: false, response_token_cap: 1, description: 'x' })).toEqual({
      exposed: false,
      reason: 'protocol',
    });
  });
});
