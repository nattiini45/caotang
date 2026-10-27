/**
 * The output schemas the server advertises (extensibility.md §7, outward table): every listed tool carries an `outputSchema`, the
 * envelope around its row's result schema, and a real result round-trips through the SDK's own client against it. The SDK server does not
 * check a result against its Standard Schema's JSON (the schema here passes every value through, because production does not re-validate
 * a native result), so the client's check, which runs on every call after `tools/list`, is the one that holds.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromJsonSchema } from '@modelcontextprotocol/client';
import type { Client } from '@modelcontextprotocol/client';
import { err, ok } from '@caotang/bus';

import { advertisedInput, advertisedOutput, resultEnvelope, toCallResult, notWritten } from '../src/tools.js';
import { acceptConfirm, CHAPTER_ONE, connectClient, declineConfirm, LANDING, startFixture, type Fixture } from './support.js';

type Json = Record<string, unknown>;

const RESULT: Json = {
  type: 'object',
  properties: { count: { type: 'integer' } },
  required: ['count'],
  additionalProperties: false,
};

/** The envelope's verdict on a value, by the SDK's own checker. */
async function verdict(value: unknown, result: Json = RESULT) {
  return fromJsonSchema(resultEnvelope(result) as Json)['~standard'].validate(value);
}

describe('the envelope around a result schema', () => {
  const success = (data: unknown) => ({ summary: 'counted', data, affected: [{ nodeId: 'n_A', title: 'A' }] });

  it('accepts what toCallResult emits for a success, with or without an undo group and notes', async () => {
    const plain = toCallResult(ok({ data: { count: 2 }, summary: 'counted', affected: [] }));
    expect(await verdict(plain.structuredContent)).not.toHaveProperty('issues');
    const full = toCallResult(ok({ data: { count: 2 }, summary: 'counted', affected: [{ nodeId: 'n_A', title: 'A' }], undoGroupId: 'g_1', notes: ['cut'] }));
    expect(await verdict(full.structuredContent)).not.toHaveProperty('issues');
  });

  it('accepts the answer to a confirmation that was declined, cancelled or not given', async () => {
    expect(await verdict(notWritten('doc.import', 'declined').structuredContent)).not.toHaveProperty('issues');
  });

  it('refuses a success whose data drops a declared field, adds an undeclared one, or has the wrong type', async () => {
    expect(await verdict(success({}))).toHaveProperty('issues');
    expect(await verdict(success({ count: 2, extra: true }))).toHaveProperty('issues');
    expect(await verdict(success({ count: 'two' }))).toHaveProperty('issues');
    expect(await verdict({ summary: 'counted', data: { count: 2 } })).toHaveProperty('issues');
  });

  it('leaves a refusal out: it sets isError and carries { error }, which an output schema is not checked against', async () => {
    const refused = toCallResult(err({ code: 'not-found', message: 'no such node', correctiveHint: 'list the tree' }));
    expect(refused.isError).toBe(true);
    expect(await verdict(refused.structuredContent)).toHaveProperty('issues');
  });

  it('is an object at its root, as the 2025-06-18 revision requires, and advertises the same JSON as input and output', () => {
    const advertised = advertisedOutput(RESULT)['~standard'].jsonSchema;
    expect((advertised.output({ target: 'draft-2020-12' }) as Json)['type']).toBe('object');
    expect(advertised.input({ target: 'draft-2020-12' })).toEqual(advertised.output({ target: 'draft-2020-12' }));
    expect(advertisedInput(RESULT)['~standard'].jsonSchema.input({ target: 'draft-2020-12' })).toEqual(RESULT);
  });
});

describe('a listed tool', () => {
  let fixture: Fixture;
  let client: Client;

  beforeAll(async () => {
    fixture = await startFixture({ label: 'output-schema', allowWrites: true, seed: true });
    client = await connectClient(fixture.url, fixture.token, acceptConfirm);
  });

  afterAll(async () => {
    await client?.close();
    await fixture?.close();
  });

  it('advertises an outputSchema, the envelope around the result schema of its row', async () => {
    const { tools } = await client.listTools();
    const listing = fixture.session.harness.tools();
    expect(tools.length).toBeGreaterThan(10);
    for (const tool of tools) {
      const row = listing.find((item) => item.name === tool.name);
      expect(tool.outputSchema, tool.name).toEqual(resultEnvelope(row?.resultSchema as Json));
    }
  });

  it('round-trips a real result of a read, a write and a refused write through the client’s own check', async () => {
    // listTools above cached the output validators; the SDK client checks every non-error structuredContent against them.
    await client.listTools();
    const overview = await client.callTool({ name: 'project.overview', arguments: {} });
    expect(overview.isError).not.toBe(true);
    const tree = await client.callTool({ name: 'binder.read_tree', arguments: { root: 'manuscript', depth: 3, include: 'synopsis' } });
    expect(tree.isError).not.toBe(true);
    const read = await client.callTool({ name: 'doc.read', arguments: { doc: LANDING, response_format: 'concise' } });
    expect(read.isError).not.toBe(true);
    const notes = await client.callTool({ name: 'notes.read', arguments: { doc: LANDING } });
    expect(notes.isError).not.toBe(true);
    const meta = await client.callTool({ name: 'meta.set', arguments: { targets: [LANDING], status: 'draft' } });
    expect(meta.isError).not.toBe(true);
    const refused = await client.callTool({ name: 'project.overview', arguments: { nonsense: true } });
    expect(refused.isError).toBe(true);
  });

  it('round-trips the answer to a confirmation that was declined, which is not the success envelope', async () => {
    const declining = await startFixture({ label: 'output-schema-declined', allowWrites: true, seed: true });
    const asker = await connectClient(declining.url, declining.token, declineConfirm);
    try {
      await asker.listTools();
      const result = await asker.callTool({ name: 'doc.import', arguments: { parent: CHAPTER_ONE, title: 'Never', body: 'Never written.' } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ status: 'declined', written: false, tool: 'doc.import' });
    } finally {
      await asker.close();
      await declining.close();
    }
  });
});
