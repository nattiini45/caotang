/**
 * A preview is kept: a staged draft's card carries it into a background task's stored record. So an image
 * in the assembled prompt reaches the preview as its placeholder and its hash, size and type, never its bytes
 * (provider-gateway §3), while a prompt with no image is the payload it always was.
 */
import { createHash } from 'node:crypto';

import { textOf, type ChatMessage, type ImagePart } from '@caotang/gateway';
import { describe, expect, it } from 'vitest';

import { assemble, buildPreview, toChatMessages, type AgentTask, type AssembledPrompt } from '../src/index.js';
import { FOCUS_ID, buildApp } from './fixtures.js';

const TASK: AgentTask = {
  tool: 'scene.draft',
  instruction: 'Write the next scene.',
  mode: 'continue',
  focus: FOCUS_ID,
  params: { doc: FOCUS_ID, mode: 'continue' },
};

function picture(): ImagePart {
  const bytes = new Uint8Array(4096);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, 640);
  new DataView(bytes.buffer).setUint32(20, 480);
  bytes.set(new TextEncoder().encode('SECRET-PIXELS-DO-NOT-LOG'), 30);
  return { type: 'image', mime: 'image/png', bytes, hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, caption: 'the chart' };
}

/** The assembly of an ordinary task, with its user message widened to carry an image after the text. */
function withPicture(part: ImagePart): AssembledPrompt {
  const assembled = assemble(TASK, buildApp());
  const [system, user, ...rest] = assembled.messages;
  const widened: ChatMessage = { role: 'user', content: [{ type: 'text', text: textOf(user?.content ?? '') }, part] };
  return { ...assembled, messages: [system as ChatMessage, widened, ...rest] };
}

describe('a preview over a prompt with an image', () => {
  const part = picture();
  const encoded = Buffer.from(part.bytes).toString('base64');
  const assembled = withPicture(part);
  const preview = buildPreview(assembled);

  it('carries the image as its placeholder, in the position it was sent', () => {
    const user = preview.payload[1];
    expect(Array.isArray(user?.content)).toBe(true);
    const parts = user?.content as readonly { type: string; text?: string }[];
    expect(parts.map((p) => p.type)).toEqual(['text', 'text']);
    expect(parts[1]?.text).toBe(`[image 1: image/png, 4 KB, sha256:${part.hash.slice(0, 8)}…, “the chart”]`);
  });

  it('records each image as its hash, size, type and caption', () => {
    expect(preview.images).toEqual([{ hash: part.hash, size: 4096, mime: 'image/png', caption: 'the chart' }]);
  });

  it('holds no byte of the image anywhere a stored copy would carry', () => {
    const stored = JSON.stringify(preview);
    expect(stored).not.toContain(encoded);
    expect(stored).not.toContain('SECRET-PIXELS');
    expect(stored).not.toContain('"bytes"');
    expect(stored).not.toContain('data:image');
    // A copy that went through storage and back reads the same.
    expect(JSON.parse(stored)).toEqual(JSON.parse(JSON.stringify(buildPreview(assembled))));
  });

  it('shows the same text the model is sent, with the placeholder for the picture', () => {
    const sentText = (assembled.messages as readonly ChatMessage[]).map((m) => textOf(m.content));
    expect(preview.payload.map((m) => textOf(m.content))).toEqual(sentText);
  });

  it('leaves the messages that carry no image exactly as they are sent', () => {
    expect(preview.payload[0]).toEqual(toChatMessages(assembled)[0]);
    expect(JSON.stringify(preview.payload[0])).toBe(JSON.stringify(assembled.messages[0]));
  });

  it('does not change what is sent: the assembly still holds the image bytes', () => {
    const sentUser = toChatMessages(assembled)[1]?.content as readonly { type: string }[];
    expect(sentUser.map((p) => p.type)).toEqual(['text', 'image']);
  });
});

describe('a preview over a prompt with no image', () => {
  it('is the payload it always was: the very messages, string for string', () => {
    const assembled = assemble(TASK, buildApp());
    const preview = buildPreview(assembled);
    expect(JSON.stringify(preview.payload)).toBe(JSON.stringify(toChatMessages(assembled)));
    expect(preview.images).toEqual([]);
  });
});
