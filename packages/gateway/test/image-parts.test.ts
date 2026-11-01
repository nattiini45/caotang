/**
 * Image content parts (provider-gateway §3): the wire each route writes for them, what is refused before
 * anything is sent, and how they are counted. The gateway-level paths (the vision gate, the log, the ledger)
 * are in image-gateway.test.ts.
 */

import { describe, expect, it } from 'vitest';

import { anthropicMessagesAdapter } from '../src/adapters/anthropic-messages.js';
import { openaiChatAdapter } from '../src/adapters/openai-chat.js';
import { openaiResponsesAdapter } from '../src/adapters/openai-responses.js';
import type { AdapterContext, ProviderAdapter } from '../src/adapters/types.js';
import {
  EgressDeniedError,
  checkRequestImages,
  contentSummaryOf,
  contentTokens,
  dataUrlOf,
  estimateTokens,
  imageBase64Of,
  imageDimensions,
  imageLimitsFor,
  imageTokens,
  placeholderOf,
  promptTokensOf,
  sniffMime,
  textOf,
  usageFor,
  validateMessageContent,
  validatePart,
  type ChatMessage,
  type ChatRequest,
  type ContentPart,
  type ContentRoute,
  type ImagePart,
} from '../src/index.js';
import { MIB, base64, gifBytes, imagePart, jpegBytes, pngBytes, sha256Of, webpBytes } from './image-fixtures.js';
import { bodyInput } from './helpers.js';

const ctxFor = (model: string): AdapterContext => ({ baseUrl: 'https://api.example/v1', model, quirks: {}, caps: { vision: true } });

const build = (adapter: ProviderAdapter, req: ChatRequest): Record<string, unknown> => adapter.buildBody(bodyInput(req, ctxFor('model-x')));

const PNG = pngBytes(640, 480);
const PICTURE: ContentPart[] = [{ type: 'text', text: 'What is on this page?' }, imagePart(PNG, 'image/png', 'page 1')];
const userWith = (content: ChatMessage['content']): ChatRequest => ({ messages: [{ role: 'user', content }] });

describe('the wire each route writes for an image part', () => {
  it('Chat Completions sends text and an image_url block carrying a data URL', () => {
    const built = build(openaiChatAdapter, userWith(PICTURE));
    expect(built.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is on this page?' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64(PNG)}` } },
        ],
      },
    ]);
  });

  it('Responses sends input_text and an input_image block carrying a data URL', () => {
    const built = build(openaiResponsesAdapter, userWith(PICTURE));
    expect(built.input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'What is on this page?' },
          { type: 'input_image', image_url: `data:image/png;base64,${base64(PNG)}` },
        ],
      },
    ]);
  });

  it('Messages sends a base64 source block, with the media type the part declares', () => {
    const jpeg = jpegBytes(300, 200);
    const built = build(anthropicMessagesAdapter, userWith([{ type: 'text', text: 'Read it.' }, imagePart(PNG), imagePart(jpeg, 'image/jpeg')]));
    expect(built.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Read it.' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64(PNG) } },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64(jpeg) } },
        ],
      },
    ]);
  });

  it('keeps the order of the parts, so an image can sit between two passages of text', () => {
    const parts: ContentPart[] = [{ type: 'text', text: 'Before.' }, imagePart(PNG), { type: 'text', text: 'After.' }];
    const chat = (build(openaiChatAdapter, userWith(parts)).messages as { content: { type: string }[] }[])[0]?.content.map((block) => block.type);
    expect(chat).toEqual(['text', 'image_url', 'text']);
    const responses = (build(openaiResponsesAdapter, userWith(parts)).input as { content: { type: string }[] }[])[0]?.content.map((block) => block.type);
    expect(responses).toEqual(['input_text', 'input_image', 'input_text']);
    const messages = (build(anthropicMessagesAdapter, userWith(parts)).messages as { content: { type: string }[] }[])[0]?.content.map((block) => block.type);
    expect(messages).toEqual(['text', 'image', 'text']);
  });

  it('writes every supported mime as the data URL and media type it names', () => {
    const cases: [ImagePart, string][] = [
      [imagePart(PNG), 'image/png'],
      [imagePart(jpegBytes(10, 10), 'image/jpeg'), 'image/jpeg'],
      [imagePart(gifBytes(10, 10), 'image/gif'), 'image/gif'],
      [imagePart(webpBytes(10, 10), 'image/webp'), 'image/webp'],
    ];
    for (const [part, mime] of cases) {
      expect(dataUrlOf(part).startsWith(`data:${mime};base64,`)).toBe(true);
      expect(JSON.stringify(build(anthropicMessagesAdapter, userWith([part])))).toContain(`"media_type":"${mime}"`);
    }
  });

  it('merges an image message into the neighbouring user turn on the Messages route', () => {
    const built = build(anthropicMessagesAdapter, {
      messages: [
        { role: 'assistant', content: 'Which page?' },
        { role: 'user', content: PICTURE },
        { role: 'user', content: 'The first one.' },
      ],
    });
    const turns = built.messages as { role: string; content: { type: string }[] }[];
    expect(turns.map((turn) => turn.role)).toEqual(['assistant', 'user']);
    expect(turns[1]?.content.map((block) => block.type)).toEqual(['text', 'image', 'text']);
  });
});

describe('a string content is byte-identical to what it always was', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: 'Hello.' },
  ];

  it('Chat Completions', () => {
    const built = build(openaiChatAdapter, { messages });
    expect(JSON.stringify(built.messages)).toBe('[{"role":"system","content":"Be terse."},{"role":"user","content":"Hello."}]');
  });

  it('Responses', () => {
    const built = build(openaiResponsesAdapter, { messages });
    expect(built.instructions).toBe('Be terse.');
    expect(JSON.stringify(built.input)).toBe('[{"role":"user","content":[{"type":"input_text","text":"Hello."}]}]');
  });

  it('Messages', () => {
    const built = build(anthropicMessagesAdapter, { messages });
    expect(built.system).toBe('Be terse.');
    expect(JSON.stringify(built.messages)).toBe('[{"role":"user","content":"Hello."}]');
  });

  it('a text-only part array sends the same text on the routes that join it', () => {
    const parts: ContentPart[] = [{ type: 'text', text: 'One.' }, { type: 'text', text: 'Two.' }];
    expect(build(openaiChatAdapter, userWith(parts)).messages).toEqual([{ role: 'user', content: 'One.\n\nTwo.' }]);
    expect(build(openaiResponsesAdapter, userWith(parts)).input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'One.\n\nTwo.' }] }]);
  });
});

describe('the placeholder is the only form an image takes outside the wire', () => {
  const part = imagePart(pngBytes(10, 10, 2048), 'image/png', 'the map');

  it('names the position, type, size and a hash prefix, and the caption when there is one', () => {
    expect(placeholderOf(part, 2)).toBe(`[image 2: image/png, 2 KB, sha256:${sha256Of(part.bytes).slice(0, 8)}…, “the map”]`);
    expect(placeholderOf(imagePart(PNG), 1)).toBe(`[image 1: image/png, 64 B, sha256:${sha256Of(PNG).slice(0, 8)}…]`);
  });

  it('textOf joins text and numbers the images from one', () => {
    const text = textOf([{ type: 'text', text: 'See:' }, part, imagePart(PNG), { type: 'text', text: 'Done.' }]);
    expect(text).toBe(`See:\n\n${placeholderOf(part, 1)}\n\n${placeholderOf(imagePart(PNG), 2)}\n\nDone.`);
    expect(text).not.toContain(base64(part.bytes));
    expect(textOf('plain')).toBe('plain');
  });

  it('contentSummaryOf keeps text characters, the count, and hash, size, mime and caption per image', () => {
    const summary = contentSummaryOf([{ content: 'abcd' }, { content: [{ type: 'text', text: 'ef' }, part] }]);
    expect(summary).toEqual({
      chars: 6,
      imageCount: 1,
      images: [{ hash: part.hash, size: part.size, mime: 'image/png', caption: 'the map' }],
    });
    expect(JSON.stringify(summary)).not.toContain('bytes');
    expect(contentSummaryOf([{ content: 'only text' }])).toEqual({ chars: 9, imageCount: 0, images: [] });
  });

  it('imageBase64Of lists the base64 of each image, for the call’s redaction list', () => {
    expect(imageBase64Of([{ content: 'x' }, { content: [part, imagePart(PNG)] }])).toEqual([base64(part.bytes), base64(PNG)]);
  });
});

describe('what is refused as a malformed part', () => {
  const problem = (part: unknown, role: ChatMessage['role'] = 'user'): string | undefined => validatePart(part as ContentPart, role);

  it('refuses a part of an unknown type, naming the type', () => {
    expect(problem({ type: 'audio', bytes: PNG })).toBe('unknown content part type "audio"');
    expect(problem({ text: 'no type' })).toBe('unknown content part type undefined');
  });

  it('refuses a part that is not an object', () => {
    expect(problem(null)).toBe('a content part must be an object');
    expect(problem('text')).toBe('a content part must be an object');
  });

  it('refuses a text part without a string', () => {
    expect(problem({ type: 'text', text: 7 })).toBe('a text part needs a string text');
  });

  it('refuses an image part with no bytes, empty bytes, or a base64 string where bytes belong', () => {
    const good = imagePart(PNG);
    const wanted = 'an image part needs non-empty Uint8Array bytes';
    expect(problem({ ...good, bytes: undefined })).toBe(wanted);
    expect(problem({ ...good, bytes: new Uint8Array(0) })).toBe(wanted);
    expect(problem({ ...good, bytes: base64(PNG) })).toBe(wanted);
    expect(problem({ type: 'image', mime: 'image/png', data: '!!!not-base64!!!' })).toBe(wanted);
  });

  it('never quotes a malformed value’s content in the refusal', () => {
    const echoed = problem({ type: 'image', mime: 'image/png', data: 'SECRET-BASE64-PAYLOAD' });
    expect(echoed).not.toContain('SECRET-BASE64-PAYLOAD');
  });

  it('refuses a mime outside the four supported ones', () => {
    expect(problem({ ...imagePart(PNG), mime: 'image/bmp' })).toMatch(/^image mime "image\/bmp" is not one of image\/png, image\/jpeg, image\/gif, image\/webp$/);
    expect(problem({ ...imagePart(PNG), mime: undefined })).toMatch(/^image mime undefined is not one of/);
  });

  it('refuses a size or hash that does not describe the bytes', () => {
    expect(problem({ ...imagePart(PNG), size: 5 })).toBe(`image size 5 does not match its ${PNG.length} bytes`);
    expect(problem({ ...imagePart(PNG), hash: 'abc' })).toBe('image hash must be 64 lowercase hex characters (sha-256 of the bytes)');
    expect(problem({ ...imagePart(PNG), hash: sha256Of(PNG).toUpperCase() })).toBe('image hash must be 64 lowercase hex characters (sha-256 of the bytes)');
  });

  it('refuses a caption that is not a string', () => {
    expect(problem({ ...imagePart(PNG), caption: 4 })).toBe('image caption must be a string');
  });

  it('refuses bytes whose signature is not a supported image', () => {
    const text = new TextEncoder().encode('this is not an image at all, not even close');
    expect(problem(imagePart(text))).toBe('image bytes do not start with a supported image signature (declared image/png)');
  });

  it('refuses a declared mime that does not match the bytes', () => {
    expect(problem(imagePart(PNG, 'image/jpeg'))).toBe('image bytes are image/png, not the declared image/jpeg');
    expect(problem(imagePart(jpegBytes(10, 10), 'image/webp'))).toBe('image bytes are image/jpeg, not the declared image/webp');
  });

  it('accepts a well-formed image of each type on a user message', () => {
    for (const part of [imagePart(PNG), imagePart(jpegBytes(9, 9), 'image/jpeg'), imagePart(gifBytes(9, 9), 'image/gif'), imagePart(webpBytes(9, 9), 'image/webp')]) {
      expect(problem(part)).toBeUndefined();
    }
  });

  it('refuses an image part on any message that is not the user’s', () => {
    for (const role of ['assistant', 'system', 'tool'] as const) {
      expect(problem(imagePart(PNG), role)).toBe(`image parts are only sent on user messages, not ${role}`);
    }
    expect(validatePart({ type: 'text', text: 'fine' }, 'assistant')).toBeUndefined();
  });

  it('validates a whole message, and refuses content that is neither a string nor an array', () => {
    expect(validateMessageContent({ role: 'user', content: PICTURE }, 'openai-chat')).toBeUndefined();
    expect(validateMessageContent({ role: 'user', content: 'plain' }, 'openai-chat')).toBeUndefined();
    expect(validateMessageContent({ role: 'user', content: [{ type: 'text', text: 'ok' }, { type: 'video' } as unknown as ContentPart] }, undefined)).toBe(
      'unknown content part type "video"',
    );
    expect(validateMessageContent({ role: 'user', content: 7 as unknown as string }, 'openai-chat')).toBe('message content must be a string or an array of parts');
    expect(validateMessageContent({ role: 'user', content: undefined as unknown as string }, 'openai-chat')).toBe('message content must be a string or an array of parts');
  });

  it.each([
    ['openai-chat', openaiChatAdapter],
    ['openai-responses', openaiResponsesAdapter],
    ['anthropic-messages', anthropicMessagesAdapter],
  ] as const)('the %s adapter refuses to build a body around a malformed part', (_route, adapter) => {
    const bad = { ...imagePart(PNG), mime: 'image/jpeg' } as ImagePart;
    expect(() => build(adapter, userWith([bad]))).toThrow(EgressDeniedError);
    expect(() => build(adapter, { messages: [{ role: 'assistant', content: [imagePart(PNG)] }] })).toThrow(/only sent on user messages/);
    let thrown: unknown;
    try {
      build(adapter, userWith([{ type: 'image', mime: 'image/png', data: base64(PNG) } as unknown as ContentPart]));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EgressDeniedError);
    expect((thrown as Error).message).not.toContain(base64(PNG));
  });
});

describe('the per-route image limits', () => {
  /** One image of exactly `size` bytes, reused across parts: the limits read sizes, and one buffer keeps the test small. */
  const sized = (size: number): ImagePart => imagePart(pngBytes(100, 100, size));

  it('states a row for each route, and the most conservative one for a route-agnostic call', () => {
    expect(imageLimitsFor('openai-chat')).toEqual({ maxImages: 20, maxImageBytes: 20 * MIB, maxTotalBytes: 64 * MIB });
    expect(imageLimitsFor('openai-responses')).toEqual(imageLimitsFor('openai-chat'));
    expect(imageLimitsFor('anthropic-messages')).toEqual({ maxImages: 20, maxImageBytes: 5 * MIB, maxTotalBytes: 32 * MIB });
    expect(imageLimitsFor(undefined)).toEqual(imageLimitsFor('anthropic-messages'));
  });

  it('allows an image of exactly the per-image cap and refuses one byte more, each route by its own cap', () => {
    const atCap = sized(5 * MIB);
    const over = sized(5 * MIB + 1);
    expect(validateMessageContent({ role: 'user', content: [atCap] }, 'anthropic-messages')).toBeUndefined();
    expect(validateMessageContent({ role: 'user', content: [over] }, 'anthropic-messages')).toMatch(
      /^an image of 5242881 bytes is over this route's per-image cap of 5242880 bytes \(image\/png, sha256:[0-9a-f]{8}…\)$/,
    );
    expect(validateMessageContent({ role: 'user', content: [over] }, 'openai-chat')).toBeUndefined();
    expect(validateMessageContent({ role: 'user', content: [over] }, 'openai-responses')).toBeUndefined();
    expect(validateMessageContent({ role: 'user', content: [over] }, undefined)).toMatch(/per-image cap of 5242880 bytes/);
    expect(validateMessageContent({ role: 'user', content: [sized(20 * MIB + 1)] }, 'openai-chat')).toMatch(/per-image cap of 20971520 bytes/);
  });

  it('refuses a message with more images than the route allows', () => {
    const tiny = imagePart(PNG);
    const twenty = Array.from({ length: 20 }, () => tiny);
    expect(validateMessageContent({ role: 'user', content: twenty }, 'openai-chat')).toBeUndefined();
    expect(validateMessageContent({ role: 'user', content: [...twenty, tiny] }, 'openai-chat')).toBe("a message carries 21 images, over this route's cap of 20");
  });

  it('refuses a message whose images together pass the route’s total', () => {
    const five = sized(5 * MIB);
    expect(validateMessageContent({ role: 'user', content: Array.from({ length: 6 }, () => five) }, 'anthropic-messages')).toBeUndefined();
    expect(validateMessageContent({ role: 'user', content: Array.from({ length: 7 }, () => five) }, 'anthropic-messages')).toBe(
      `a message's images total ${7 * 5 * MIB} bytes, over this route's cap of ${32 * MIB} bytes`,
    );
  });

  it('counts across messages: the request-level image count and total are refused, each with a remedy', () => {
    const tiny = imagePart(PNG);
    const eleven = (): ChatMessage => ({ role: 'user', content: Array.from({ length: 11 }, () => tiny) });
    expect(checkRequestImages([eleven(), eleven()], { vision: true }, 'openai-chat', 'm')).toBe(
      "Refused a request with 22 images, over this route's cap of 20. Send fewer images per request.",
    );

    const five = sized(5 * MIB);
    const pair = (): ChatMessage => ({ role: 'user', content: [five, five] });
    expect(checkRequestImages([pair(), pair(), pair(), pair()], { vision: true }, 'anthropic-messages', 'm')).toBe(
      `Refused a request whose images total ${8 * 5 * MIB} bytes, over this route's cap of ${32 * MIB} bytes. Send smaller images (the app downscales to a 1568-pixel long edge).`,
    );
    expect(checkRequestImages([pair(), pair()], { vision: true }, 'anthropic-messages', 'm')).toBeUndefined();
  });

  it('reports a malformed part ahead of any limit, without the part’s content', () => {
    const refused = checkRequestImages([{ role: 'user', content: [{ ...imagePart(PNG), mime: 'image/gif' }] }], { vision: true }, 'openai-chat', 'm');
    expect(refused).toBe('Refused a request over a malformed content part: image bytes are image/png, not the declared image/gif.');
  });
});

describe('the vision gate', () => {
  const messages: ChatMessage[] = [{ role: 'user', content: PICTURE }];

  it('refuses a request with an image when the capability row has no vision, naming the model and the remedy', () => {
    const refused = checkRequestImages(messages, {}, 'openai-chat', 'text-only-1');
    expect(refused).toBe(
      'Refused a request with 1 image: “text-only-1” does not accept images (its capability row has no vision). Choose a vision-capable model in Settings, or send the pictures as text — a caption or a transcription.',
    );
    expect(checkRequestImages(messages, { vision: false, tools: true }, 'anthropic-messages', 'm')).toMatch(/does not accept images/);
    expect(checkRequestImages([{ role: 'user', content: [imagePart(PNG), imagePart(PNG)] }], {}, undefined, 'm')).toMatch(/^Refused a request with 2 images:/);
  });

  it('lets an image through when the row says vision', () => {
    for (const route of ['openai-chat', 'openai-responses', 'anthropic-messages'] as const) {
      expect(checkRequestImages(messages, { vision: true }, route, 'vision-1')).toBeUndefined();
    }
  });

  it('never gates a request with no image, with or without vision', () => {
    const text: ChatMessage[] = [{ role: 'user', content: 'plain' }, { role: 'user', content: [{ type: 'text', text: 'parts, no image' }] }];
    expect(checkRequestImages(text, {}, 'openai-chat', 'm')).toBeUndefined();
    expect(checkRequestImages([], {}, undefined, 'm')).toBeUndefined();
  });

  it('puts neither the bytes nor their base64 form in a refusal', () => {
    const refused = checkRequestImages(messages, {}, 'openai-chat', 'm') ?? '';
    expect(refused).not.toContain(base64(PNG));
    expect(refused).not.toContain('data:image');
  });
});

describe('header reading', () => {
  it('reads the magic number of each supported format, and nothing else', () => {
    expect(sniffMime(PNG)).toBe('image/png');
    expect(sniffMime(jpegBytes(5, 5))).toBe('image/jpeg');
    expect(sniffMime(gifBytes(5, 5))).toBe('image/gif');
    expect(sniffMime(webpBytes(5, 5))).toBe('image/webp');
    expect(sniffMime(new Uint8Array([0x42, 0x4d, 0, 0, 0, 0, 0, 0]))).toBeUndefined();
    expect(sniffMime(new Uint8Array(0))).toBeUndefined();
  });

  it('reads the dimensions of each format from its header', () => {
    expect(imageDimensions(pngBytes(1568, 1000), 'image/png')).toEqual({ width: 1568, height: 1000 });
    expect(imageDimensions(jpegBytes(300, 200), 'image/jpeg')).toEqual({ width: 300, height: 200 });
    expect(imageDimensions(gifBytes(321, 123), 'image/gif')).toEqual({ width: 321, height: 123 });
    expect(imageDimensions(webpBytes(4000, 3000), 'image/webp')).toEqual({ width: 4000, height: 3000 });
  });

  it('says nothing when the header does not parse', () => {
    expect(imageDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]), 'image/jpeg')).toBeUndefined();
    expect(imageDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png')).toBeUndefined();
  });
});

describe('what an image is counted as', () => {
  const at = (width: number, height: number): ImagePart => imagePart(pngBytes(width, height));
  const ROUTES: readonly ContentRoute[] = ['openai-chat', 'openai-responses', 'anthropic-messages'];

  it('Messages counts ceil(width × height / 750)', () => {
    expect(imageTokens(at(1024, 1024), 'anthropic-messages')).toBe(Math.ceil((1024 * 1024) / 750));
    expect(imageTokens(at(1568, 1000), 'anthropic-messages')).toBe(Math.ceil(1_568_000 / 750));
    expect(imageTokens(at(10, 10), 'anthropic-messages')).toBe(1);
  });

  it('Chat and Responses count 85 plus 170 for each 512-pixel tile', () => {
    expect(imageTokens(at(1024, 1024), 'openai-chat')).toBe(85 + 170 * 4);
    expect(imageTokens(at(1024, 1024), 'openai-responses')).toBe(85 + 170 * 4);
    expect(imageTokens(at(513, 512), 'openai-chat')).toBe(85 + 170 * 2);
    expect(imageTokens(at(10, 10), 'openai-chat')).toBe(85 + 170);
  });

  it('counts a route-agnostic image at no less than any route would', () => {
    for (const [width, height] of [[1, 1], [10, 10], [100, 100], [512, 512], [513, 513], [1024, 1024], [1568, 1568], [4000, 3000]] as const) {
      const part = at(width, height);
      const estimate = imageTokens(part);
      for (const route of ROUTES) expect(estimate).toBeGreaterThanOrEqual(imageTokens(part, route));
    }
    // A small picture is cheaper per pixel than a tile, so the per-pixel rule alone would have undercounted it.
    expect(imageTokens(at(100, 100))).toBe(85 + 170);
  });

  it('falls back to a size-based figure when the header cannot be read, on any route', () => {
    const unreadable = imagePart(Uint8Array.from([0xff, 0xd8, 0xff, ...new Array<number>(6397).fill(0)]), 'image/jpeg');
    expect(imageDimensions(unreadable.bytes, 'image/jpeg')).toBeUndefined();
    for (const route of [...ROUTES, undefined]) expect(imageTokens(unreadable, route)).toBe(Math.ceil(6400 / 64));
  });

  it('counts a content’s text as text and its images by formula, and never counts the base64 as text', () => {
    const big = imagePart(pngBytes(800, 600, 3 * MIB));
    const content: ContentPart[] = [{ type: 'text', text: 'abcdefgh' }, big];
    const expected = estimateTokens('abcdefgh') + imageTokens(big, 'anthropic-messages');
    expect(contentTokens(content, 'anthropic-messages')).toBe(expected);
    // Base64 read as text would have been about 1M tokens; the formula gives a few hundred.
    expect(contentTokens(content, 'anthropic-messages')).toBeLessThan(1000);
    expect(contentTokens('abcdefgh')).toBe(estimateTokens('abcdefgh'));
  });

  it('a string content counts exactly as it always did', () => {
    const messages: ChatMessage[] = [{ role: 'system', content: 'abcd' }, { role: 'user', content: 'efghi' }];
    expect(usageFor(messages, 'xyz')).toEqual({ promptTokens: estimateTokens('abcdefghi'), completionTokens: estimateTokens('xyz') });
    expect(promptTokensOf(messages)).toBe(estimateTokens('abcdefghi'));
  });

  it('a request’s prompt estimate is its text plus each image’s formula on the route it goes out on', () => {
    const part = at(1024, 1024);
    const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'abcdefgh' }, part] }];
    expect(usageFor(messages, '', 'openai-chat').promptTokens).toBe(estimateTokens('abcdefgh') + 765);
    expect(usageFor(messages, '', 'anthropic-messages').promptTokens).toBe(estimateTokens('abcdefgh') + Math.ceil((1024 * 1024) / 750));
    // The route-agnostic figure is the one a budget reserves: never below either route’s.
    const agnostic = usageFor(messages, '').promptTokens;
    for (const route of ROUTES) expect(agnostic).toBeGreaterThanOrEqual(usageFor(messages, '', route).promptTokens);
    expect(JSON.stringify(usageFor(messages, 'done'))).not.toContain(base64(part.bytes));
  });
});
