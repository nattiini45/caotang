/**
 * Image parts in the agent's own request path (provider-gateway §3): what a call's spend and its system
 * message do with them, what the card's prompt preview keeps of them, and that a model call carrying one
 * leaves hashes and counts in the ledger and nothing else. No tool produces an image part yet, so these tests
 * hand the harness's seams the messages a producer will.
 */

import { createHash } from 'node:crypto';

import {
  createGateway,
  createKeyStore,
  createManualClock,
  createMemoryVaultPort,
  createProfileStore,
  contentTokens,
  imagePartsOf,
  textOf,
  type ChatMessage,
  type Gateway,
  type ImagePart,
} from '@caotang/gateway';
import { createMockProvider, type MockProvider } from '@caotang/gateway/mock';
import { assemble, buildPreview, type AgentTask, type AssembledPrompt } from '@caotang/context';
import { describe, expect, it } from 'vitest';

import { appendLanguageLine, mergePreviews, withLanguages } from '../../src/index.js';
import { complete, spendOf } from '../../src/agent/drafting.js';
import { makeState } from '../fixtures.js';

function picture(caption?: string): ImagePart {
  const bytes = new Uint8Array(8192);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, 1024);
  new DataView(bytes.buffer).setUint32(20, 1024);
  bytes.set(new TextEncoder().encode('SECRET-PIXELS-DO-NOT-LOG'), 30);
  return { type: 'image', mime: 'image/png', bytes, hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, ...(caption === undefined ? {} : { caption }) };
}

const PART = picture('the harbour chart');
const ENCODED = Buffer.from(PART.bytes).toString('base64');
const MARKER = Buffer.from('SECRET-PIXELS-DO-NOT-LOG').toString('base64');
const LANGUAGES = { ui: 'en', project: 'en' };

const PICTURE_MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'You are drafting prose for Caotang.' },
  { role: 'user', content: [{ type: 'text', text: 'Describe the chart.' }, PART] },
];

async function visionGateway(mock: MockProvider): Promise<Gateway> {
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  await profiles.create({ name: 'Mock', kind: 'mock', isActive: true });
  return createGateway({ profiles, keys, clock: createManualClock(0), mock });
}

const REPLY = 'A chart of the harbour.';
const seesImage = { match: (req: { messages: readonly ChatMessage[] }) => req.messages.some((m) => imagePartsOf(m.content).length > 0), respond: () => ({ content: REPLY }) };

describe('the spend of a call that carries an image', () => {
  it('counts the image by its formula and never its base64 form as text', () => {
    const spend = spendOf(PICTURE_MESSAGES, REPLY);
    expect(spend.promptTokens).toBe(contentTokens(PICTURE_MESSAGES[0]?.content ?? '') + contentTokens(PICTURE_MESSAGES[1]?.content ?? ''));
    // The route-agnostic figure for a 1024 x 1024 picture: the per-pixel rule, 1,399 tokens, plus the text.
    expect(spend.promptTokens).toBeGreaterThan(1399);
    expect(spend.promptTokens).toBeLessThan(1500);
    expect(spend.promptTokens).toBeLessThan(ENCODED.length / 4);
    expect(spend.completionTokens).toBeGreaterThan(0);
  });

  it('counts a string-only call exactly as before', () => {
    const spend = spendOf([{ role: 'user', content: 'abcdefgh' }], 'wxyz');
    expect(spend).toEqual({ promptTokens: 2, completionTokens: 1 });
  });
});

describe('a model call that carries an image', () => {
  it('reaches a vision model, is answered, and leaves only counts in the ledger', async () => {
    const mock = createMockProvider({ capsVision: true, scripts: [seesImage] });
    const gateway = await visionGateway(mock);
    const messages: string[] = [];
    const reply = await complete(
      { gateway, turnId: 'turn-1', onDelta: (delta) => messages.push(delta) },
      PICTURE_MESSAGES,
      'text',
    );
    expect(reply.text).toBe(REPLY);
    expect(imagePartsOf(mock.calls[0]?.messages[1]?.content ?? '')).toHaveLength(1);

    const kept = JSON.stringify(gateway.ledger.snapshot());
    expect(kept).not.toContain(ENCODED);
    expect(kept).not.toContain(MARKER);
    const turn = gateway.ledger.turnTotals('turn-1');
    expect(turn.requests).toBe(1);
    // The image is in the prompt estimate (1,399 tokens), and the base64 is not.
    expect(turn.promptTokens).toBeGreaterThan(1399);
    expect(turn.promptTokens).toBeLessThan(ENCODED.length / 4);
  });

  it('is refused by a model with no vision, and the turn’s ledger stays empty', async () => {
    const mock = createMockProvider({ scripts: [seesImage] });
    const gateway = await visionGateway(mock);
    await expect(complete({ gateway, turnId: 'turn-1' }, PICTURE_MESSAGES, 'text')).rejects.toThrow(/does not accept images/);
    expect(mock.calls).toHaveLength(0);
    expect(gateway.ledger.turnTotals('turn-1')).toEqual({ promptTokens: 0, completionTokens: 0, requests: 0 });
  });
});

describe('the language line on a system message that carries parts', () => {
  it('appends to the last text part and leaves image parts as they were', () => {
    const system: ChatMessage['content'] = [{ type: 'text', text: 'Role.' }, PART, { type: 'text', text: 'Tail.' }];
    const out = appendLanguageLine(system, LANGUAGES);
    expect(Array.isArray(out)).toBe(true);
    const parts = out as readonly { type: string; text?: string }[];
    expect(parts.map((p) => p.type)).toEqual(['text', 'image', 'text']);
    expect(parts[2]?.text?.startsWith('Tail.\n\n')).toBe(true);
    expect(parts[1]).toBe(PART);
  });

  it('adds a text part of its own when the system message ends on an image', () => {
    const out = appendLanguageLine([{ type: 'text', text: 'Role.' }, PART], LANGUAGES) as readonly { type: string; text?: string }[];
    expect(out.map((p) => p.type)).toEqual(['text', 'image', 'text']);
    expect(out[2]?.text?.startsWith('Write messages to the writer')).toBe(true);
  });

  it('measures the estimate of the prompt it sends, by formula for the image', () => {
    const prompt = assemble({ tool: 'meta', instruction: 'Request: hello' } satisfies AgentTask, { state: makeState() });
    const [, ...rest] = prompt.messages;
    const imaged: AssembledPrompt = { ...prompt, messages: [{ role: 'system', content: [{ type: 'text', text: 'Role.' }, PART] }, ...rest] };
    const out = withLanguages(imaged, LANGUAGES);
    expect(out.estimate.promptTokens).toBeGreaterThan(1399);
    expect(out.estimate.promptTokens).toBeLessThan(ENCODED.length / 4);
    expect(out.layers.find((layer) => layer.id === 'L0')?.tokens).toBe(contentTokens(out.messages[0]?.content ?? ''));
  });
});

describe('what the card’s prompt preview keeps', () => {
  const task: AgentTask = { tool: 'meta', instruction: 'Request: hello' };

  function previewWith(part: ImagePart) {
    const prompt = assemble(task, { state: makeState() });
    const [, ...rest] = prompt.messages;
    return buildPreview(withLanguages({ ...prompt, messages: [{ role: 'system', content: [{ type: 'text', text: 'Role.' }, part] }, ...rest] }, LANGUAGES));
  }

  it('holds the placeholder and the record of an image, not its bytes', () => {
    const preview = previewWith(PART);
    const stored = JSON.stringify(preview);
    expect(stored).not.toContain(ENCODED);
    expect(stored).not.toContain(MARKER);
    expect(stored).not.toContain('"bytes"');
    expect(preview.images).toEqual([{ hash: PART.hash, size: 8192, mime: 'image/png', caption: 'the harbour chart' }]);
    expect(textOf(preview.payload[0]?.content ?? '')).toContain(`[image 1: image/png, 8 KB, sha256:${PART.hash.slice(0, 8)}…, “the harbour chart”]`);
  });

  it('merges several previews into one that still holds no bytes, and every image’s record', () => {
    const other = picture('the tide table');
    const merged = mergePreviews([previewWith(PART), previewWith(other)]);
    expect(merged?.images.map((image) => image.caption)).toEqual(['the harbour chart', 'the tide table']);
    const stored = JSON.stringify(merged);
    expect(stored).not.toContain(ENCODED);
    expect(stored).not.toContain(Buffer.from(other.bytes).toString('base64'));
    expect(stored).not.toContain(MARKER);
  });
});
