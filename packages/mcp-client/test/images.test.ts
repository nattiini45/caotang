/**
 * Image content blocks in an external answer (pictures.md §8.3): the stub the model reads, what never reaches it, the caps that refuse
 * before anything is staged, the bounded lifetime, and the outbound `staged:<id>` argument that reads bytes from the staging area alone.
 */

import type { ApplyContext } from '@caotang/bus';
import { createAssetStaging, type RetryableAssetStaging } from '@caotang/store';
import { describe, expect, it } from 'vitest';

import {
  EXTERNAL_IMAGE_BYTES_CAP,
  EXTERNAL_IMAGE_COUNT_CAP,
  STAGED_IMAGE_LIFETIME_MS,
  applyMcpInvoke,
  createImageStager,
  createLoadedTools,
  createMcpTransport,
  prepareInvoke,
  resolveStagedArguments,
  resultTokens,
  routeImages,
  type ImageStager,
  type ImageStagerOptions,
  type McpClient,
  type McpInvokeNormalized,
  type MockMcpScript,
} from '../src/index.js';
import { STORY_KEY, SHELF_KEY, echoScript, openClient, qualified, storyTools } from './fixtures.js';
import { JPEG_BYTES, GIF_BYTES, SVG_BYTES, base64, imageBlock, paddedTo, png } from './pictures-support.js';

const ORIGIN = { server: 'Story Bible', tool: 'lore_lookup' };
const MIB = 1024 * 1024;

/** A staging area that counts what it was asked to hold, so "refused, and nothing staged" is a count and not a hope. */
function countingStaging(): { staging: RetryableAssetStaging; staged: () => number } {
  const inner = createAssetStaging('p_test');
  let count = 0;
  return {
    staged: () => count,
    staging: {
      ...inner,
      stage(bytes) {
        count += 1;
        return inner.stage(bytes);
      },
    },
  };
}

/** A clock and timers a test runs by hand. */
function manualTime(): Pick<ImageStagerOptions, 'now' | 'timers'> & { advance(ms: number): void } {
  let now = 1_000_000;
  let next = 0;
  const jobs = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    timers: {
      set(run, ms) {
        next += 1;
        jobs.set(next, { at: now + ms, run });
        return next;
      },
      clear(handle) {
        jobs.delete(handle as number);
      },
    },
    advance(ms) {
      now += ms;
      for (const [id, job] of [...jobs]) {
        if (job.at <= now) {
          jobs.delete(id);
          job.run();
        }
      }
    },
  };
}

function stagerOver(staging: RetryableAssetStaging, time = manualTime()): { stager: ImageStager; time: ReturnType<typeof manualTime> } {
  return { stager: createImageStager({ staging, now: time.now, timers: time.timers }), time };
}

describe('the stub the model reads', () => {
  it('replaces an image block with one line that names its type, its size in KB and its staging id', () => {
    const { staging } = countingStaging();
    const { stager } = stagerOver(staging);
    const bytes = paddedTo(png(), 812 * 1024);
    const routed = routeImages([{ type: 'text', text: 'Here it is.' }, imageBlock(bytes)], ORIGIN, stager);
    if (!routed.ok) throw new Error(routed.message);

    expect(routed.content).toHaveLength(2);
    expect(routed.content[0]).toEqual({ type: 'text', text: 'Here it is.' });
    const stub = (routed.content[1] as { type: string; text: string }).text;
    expect(stub).toMatch(/^\[image 1: image\/png, 812 KB, staged as stg_[0-9A-Z]+\]$/);
    expect(stub).toContain(routed.staged[0]?.stagingId);
    expect(routed.staged[0]).toMatchObject({ mime: 'image/png', bytes: 812 * 1024, index: 1 });
  });

  it('numbers the images of one answer from one, in order, and types them by their bytes', () => {
    const { staging } = countingStaging();
    const { stager } = stagerOver(staging);
    const routed = routeImages([imageBlock(png()), { type: 'text', text: 'between' }, imageBlock(JPEG_BYTES, 'image/jpeg')], ORIGIN, stager);
    if (!routed.ok) throw new Error(routed.message);
    expect(routed.content.map((block) => (block as { text: string }).text.slice(0, 26))).toEqual(['[image 1: image/png, 1 KB,', 'between', '[image 2: image/jpeg, 1 KB']);
  });

  it('never carries the base64, in the content, the metadata or the stub', () => {
    const { staging } = countingStaging();
    const { stager } = stagerOver(staging);
    const bytes = paddedTo(png(), 300 * 1024);
    const data = base64(bytes);
    const routed = routeImages([imageBlock(bytes)], ORIGIN, stager);
    if (!routed.ok) throw new Error(routed.message);
    expect(JSON.stringify(routed)).not.toContain(data.slice(0, 64));
    expect(JSON.stringify(routed).length).toBeLessThan(600);
  });

  it('leaves an answer with no image exactly as the server sent it', () => {
    const content = [{ type: 'text', text: 'no pictures' }];
    const routed = routeImages(content, ORIGIN, undefined);
    expect(routed).toEqual({ ok: true, content, staged: [] });
    if (routed.ok) expect(routed.content).toBe(content);
  });

  it('with no staging area, checks the bytes and says they were not staged, rather than showing a picture as text', () => {
    const routed = routeImages([imageBlock(png())], ORIGIN, undefined);
    if (!routed.ok) throw new Error(routed.message);
    expect(routed.staged).toEqual([]);
    expect((routed.content[0] as { text: string }).text).toBe('[image 1: image/png, 1 KB, not staged: this host has nowhere to hold pictures]');
  });
});

describe('an image is not text tokens', () => {
  it('counts an image block as its stub, however large its base64 is', () => {
    const big = imageBlock(paddedTo(png(), 3 * MIB));
    expect(big.data.length).toBeGreaterThan(4_000_000);
    expect(resultTokens([big])).toBeLessThan(40);
    expect(resultTokens([{ type: 'text', text: big.data }])).toBeGreaterThan(1_000_000);
  });

  it('counts every image block of one answer as its own stub, so a many-picture answer is measured whole', () => {
    const big = () => imageBlock(paddedTo(png(), 3 * MIB));
    const one = resultTokens([big()]);
    const four = resultTokens([big(), big(), big(), big()]);
    // Each block adds its own stub; the base64 of none of them is counted.
    expect(four).toBeGreaterThan(one * 3);
    expect(four).toBeLessThan(160);
    // Text and pictures in one answer both count.
    const text = { type: 'text', text: 'x'.repeat(400) } as const;
    expect(resultTokens([text, big()])).toBeGreaterThan(resultTokens([text]));
    expect(resultTokens([text, big()])).toBeLessThan(resultTokens([text]) + 40);
  });
});

describe('the caps refuse before anything is staged', () => {
  it('refuses more than four images, naming the cap', () => {
    const { staging, staged } = countingStaging();
    const { stager } = stagerOver(staging);
    const blocks = Array.from({ length: EXTERNAL_IMAGE_COUNT_CAP + 1 }, () => imageBlock(png()));
    const routed = routeImages(blocks, ORIGIN, stager);
    if (routed.ok) throw new Error('expected a refusal');
    expect(routed).toMatchObject({ code: 'limit-exceeded' });
    expect(routed.message).toContain(`5 images, over the ${EXTERNAL_IMAGE_COUNT_CAP}-image cap`);
    expect(staged()).toBe(0);
  });

  it('refuses more decoded bytes than a picture may be, across the answer, naming the cap, and stages none of it', () => {
    const { staging, staged } = countingStaging();
    const { stager } = stagerOver(staging);
    const blocks = [imageBlock(paddedTo(png(), 9 * MIB)), imageBlock(paddedTo(png(), 9 * MIB))];
    const routed = routeImages(blocks, ORIGIN, stager);
    if (routed.ok) throw new Error('expected a refusal');
    expect(routed.code).toBe('limit-exceeded');
    expect(routed.message).toContain(`over the ${(EXTERNAL_IMAGE_BYTES_CAP / MIB).toFixed(1)} MB cap`);
    expect(routed.message).toContain('no picture was staged');
    expect(staged()).toBe(0);
  });

  it('measures the base64 before it decodes it, so an image far over the cap is not allocated', () => {
    const { staging, staged } = countingStaging();
    const { stager } = stagerOver(staging);
    const routed = routeImages([{ type: 'image', data: 'A'.repeat(40 * MIB), mimeType: 'image/png' }], ORIGIN, stager);
    if (routed.ok) throw new Error('expected a refusal');
    expect(routed.code).toBe('limit-exceeded');
    expect(staged()).toBe(0);
  });

  it('stages none of the answer when a later image is the one that fails', () => {
    const { staging, staged } = countingStaging();
    const { stager } = stagerOver(staging);
    const routed = routeImages([imageBlock(png()), imageBlock(SVG_BYTES, 'image/svg+xml')], ORIGIN, stager);
    if (routed.ok) throw new Error('expected a refusal');
    expect(staged()).toBe(0);
    expect(stager.heldIds()).toEqual([]);
  });
});

describe('the bytes decide the type', () => {
  it('refuses a block whose declared type is not what its bytes are, naming both and never the data', () => {
    const { staging, staged } = countingStaging();
    const { stager } = stagerOver(staging);
    const block = imageBlock(png(), 'image/jpeg');
    const routed = routeImages([block], ORIGIN, stager);
    if (routed.ok) throw new Error('expected a refusal');
    expect(routed.code).toBe('postcondition');
    expect(routed.message).toContain('"image/jpeg" whose bytes are image/png');
    expect(routed.message).not.toContain(block.data);
    expect(staged()).toBe(0);
  });

  it('accepts a declared type with parameters or different case when the bytes agree', () => {
    const { staging } = countingStaging();
    const { stager } = stagerOver(staging);
    expect(routeImages([imageBlock(png(), 'Image/PNG; charset=binary')], ORIGIN, stager).ok).toBe(true);
  });

  it.each([
    ['an SVG, which can carry script', SVG_BYTES, 'image/svg+xml'],
    ['a GIF', GIF_BYTES, 'image/gif'],
    ['bytes that are not a picture', new TextEncoder().encode('plain text'), 'image/png'],
  ])('refuses %s', (_label, bytes, declared) => {
    const { staging, staged } = countingStaging();
    const { stager } = stagerOver(staging);
    const routed = routeImages([imageBlock(bytes, declared)], ORIGIN, stager);
    if (routed.ok) throw new Error('expected a refusal');
    expect(routed.code).toBe('postcondition');
    expect(staged()).toBe(0);
  });

  it('refuses a block that is not base64, or has no data or no type, without echoing it', () => {
    const { staging } = countingStaging();
    const { stager } = stagerOver(staging);
    for (const block of [
      { type: 'image', data: 'not base64 !!', mimeType: 'image/png' },
      { type: 'image', mimeType: 'image/png' },
      { type: 'image', data: base64(png()) },
    ]) {
      const routed = routeImages([block], ORIGIN, stager);
      if (routed.ok) throw new Error('expected a refusal');
      expect(routed.code).toBe('postcondition');
      expect(routed.message).not.toContain('not base64 !!');
    }
  });

  it('refuses the answer, and holds nothing, when the staging area itself fails', () => {
    const inner = createAssetStaging('p_test');
    let calls = 0;
    const staging: RetryableAssetStaging = {
      ...inner,
      stage(bytes) {
        calls += 1;
        if (calls === 2) throw new Error('disk gone');
        return inner.stage(bytes);
      },
    };
    const { stager } = stagerOver(staging);
    const routed = routeImages([imageBlock(png(1)), imageBlock(png(2))], ORIGIN, stager);
    if (routed.ok) throw new Error('expected a refusal');
    expect(routed.message).not.toContain('disk gone');
    expect(stager.heldIds()).toEqual([]);
  });
});

describe('the staged bytes have a bounded life', () => {
  it('holds them for ten minutes, then drops them from the staging area and forgets where they came from', () => {
    expect(STAGED_IMAGE_LIFETIME_MS).toBe(10 * 60 * 1000);
    const { staging } = countingStaging();
    const { stager, time } = stagerOver(staging);
    const [first] = stager.stage([{ bytes: png(), mime: 'image/png' }], ORIGIN);
    const id = first?.stagingId ?? '';
    expect(first?.expiresAt).toBe(1_000_000 + STAGED_IMAGE_LIFETIME_MS);
    expect(stager.provenanceOf(id)).toEqual({ kind: 'mcp', server: 'Story Bible', tool: 'lore_lookup' });
    expect(stager.read(id)).toBeDefined();

    time.advance(STAGED_IMAGE_LIFETIME_MS - 1);
    expect(stager.heldIds()).toEqual([id]);
    time.advance(1);
    expect(stager.heldIds()).toEqual([]);
    expect(stager.provenanceOf(id)).toBeUndefined();
    expect(staging.take(id)).toBeUndefined();
  });

  it('drops expired bytes at the next read even when no timer has run', () => {
    const { staging } = countingStaging();
    let now = 0;
    const stager = createImageStager({ staging, now: () => now, timers: { set: () => 0, clear: () => undefined } });
    const [first] = stager.stage([{ bytes: png(), mime: 'image/png' }], ORIGIN);
    now = STAGED_IMAGE_LIFETIME_MS;
    expect(stager.provenanceOf(first?.stagingId ?? '')).toBeUndefined();
    expect(staging.take(first?.stagingId ?? '')).toBeUndefined();
  });

  it('lets go of named ids when the writer declines, and of everything when the project closes', () => {
    const { staging } = countingStaging();
    const { stager } = stagerOver(staging);
    const staged = stager.stage([{ bytes: png(1), mime: 'image/png' }, { bytes: png(2), mime: 'image/png' }], ORIGIN);
    const [a, b] = staged.map((image) => image.stagingId) as [string, string];
    stager.discard([a]);
    expect(stager.heldIds()).toEqual([b]);
    expect(staging.take(a)).toBeUndefined();

    stager.releaseAll();
    expect(stager.heldIds()).toEqual([]);
    expect(staging.take(b)).toBeUndefined();
  });

  it('does not touch what another part of the app staged', () => {
    const { staging } = countingStaging();
    const { stager } = stagerOver(staging);
    const dropped = staging.stage(png());
    stager.stage([{ bytes: png(), mime: 'image/png' }], ORIGIN);
    stager.releaseAll();
    expect(staging.take(dropped)).toBeDefined();
  });

  it('leaves a read that is mid-import alone, reading it as not held', () => {
    const { staging } = countingStaging();
    const { stager } = stagerOver(staging);
    const [first] = stager.stage([{ bytes: png(), mime: 'image/png' }], ORIGIN);
    const reservation = staging.reserve([first?.stagingId ?? '']);
    expect(stager.read(first?.stagingId ?? '')).toBeUndefined();
    staging.release(reservation.id);
    expect(stager.read(first?.stagingId ?? '')).toBeDefined();
  });
});

describe('outbound: a tool argument gets staged bytes, never a path or a fetched URL', () => {
  function held() {
    const { staging } = countingStaging();
    const { stager } = stagerOver(staging);
    const bytes = png(0x77);
    const [first] = stager.stage([{ bytes, mime: 'image/png' }], ORIGIN);
    return { stager, bytes, id: first?.stagingId ?? '' };
  }

  it('fills a staged reference with the base64 of the bytes, at any depth, and leaves the rest alone', () => {
    const { stager, bytes, id } = held();
    const args = { note: 'hello', image: `staged:${id}`, nested: { frames: [`staged:${id}`, 3, null] } };
    const filled = resolveStagedArguments(args, stager);
    if (!filled.ok) throw new Error(filled.refusal.message);
    expect(filled.args).toEqual({ note: 'hello', image: base64(bytes), nested: { frames: [base64(bytes), 3, null] } });
    expect(args.image).toBe(`staged:${id}`);
    expect(stager.read(id)).toBeDefined();
  });

  it('refuses an id that is not held, naming nothing but the reference, and sends nothing', () => {
    const { stager } = held();
    const filled = resolveStagedArguments({ image: 'staged:stg_ZZZZZZZZZZ' }, stager);
    if (filled.ok) throw new Error('expected a refusal');
    expect(filled.refusal.code).toBe('not-found');
    expect(filled.refusal.message).toContain('staged:stg_ZZZZZZZZZZ');
  });

  it('refuses a reference when the host has no staging at all', () => {
    expect(resolveStagedArguments({ image: 'staged:stg_ZZZZZZZZZZ' }, undefined).ok).toBe(false);
  });

  it('passes a path, a URL and a sentence that starts with "staged:" to the tool as written, and reads no file and fetches nothing', () => {
    const { stager } = held();
    const args = { a: '/etc/passwd', b: 'C:\\Users\\me\\photo.png', c: 'https://example.test/pic.png', d: 'staged: the second draft', e: 'staged:../../etc/passwd' };
    const filled = resolveStagedArguments(args, stager);
    expect(filled).toEqual({ ok: true, args });
  });

  it('refuses references that together are over the byte cap', () => {
    const { staging } = countingStaging();
    const { stager } = stagerOver(staging);
    const staged = stager.stage([{ bytes: paddedTo(png(1), 9 * MIB), mime: 'image/png' }, { bytes: paddedTo(png(2), 9 * MIB), mime: 'image/png' }], ORIGIN);
    const [a, b] = staged.map((image) => `staged:${image.stagingId}`);
    const filled = resolveStagedArguments({ one: a, two: b }, stager);
    if (filled.ok) throw new Error('expected a refusal');
    expect(filled.refusal.code).toBe('limit-exceeded');
  });
});

describe('mcp.invoke with pictures', () => {
  function scriptReturning(content: unknown[]): MockMcpScript {
    return { listTools: storyTools(), respond: () => ({ content }) };
  }

  async function prepared(script: MockMcpScript, args: Record<string, unknown> = { name: 'Mara' }) {
    const { client } = await openClient({ scripts: { [STORY_KEY]: script, [SHELF_KEY]: echoScript([]) }, approve: [STORY_KEY] });
    const loaded = createLoadedTools();
    loaded.beginTurn('turn-1');
    loaded.load([qualified(STORY_KEY, 'lore_lookup')]);
    const result = prepareInvoke({ client, loaded }, { serverKey: STORY_KEY, toolName: 'lore_lookup', args });
    if (!result.ok) throw new Error(result.error.message);
    return { client, loaded, params: result.value };
  }

  const run = (client: McpClient, loaded: ReturnType<typeof createLoadedTools>, params: McpInvokeNormalized, images: ImageStager | undefined, cap?: number) => {
    const reports: Parameters<ApplyContext['report']>[0][] = [];
    const outcome = applyMcpInvoke(
      { client, loaded, transport: createMcpTransport(client), ...(images === undefined ? {} : { images }), ...(cap === undefined ? {} : { resultTokenCap: cap }) },
      params,
      { report: (report) => reports.push(report) },
    );
    return { outcome, reports };
  };

  it('returns the stub, the staged ids and no bytes, and the token cap sees a stub and not a picture', async () => {
    const { client, loaded, params } = await prepared(scriptReturning([{ type: 'text', text: 'found' }, imageBlock(paddedTo(png(), 2 * MIB))]));
    const { staging } = countingStaging();
    const { stager } = stagerOver(staging);
    const { outcome, reports } = run(client, loaded, params, stager, 200);
    const result = await outcome;
    if (!result.ok) throw new Error(result.error.message);

    expect(result.value.untrusted).toBe(true);
    expect(result.value.content).toHaveLength(2);
    expect((result.value.content[1] as { text: string }).text).toMatch(/^\[image 1: image\/png, 2048 KB, staged as stg_[0-9A-Z]+\]$/);
    expect(result.value.staged).toHaveLength(1);
    expect(JSON.stringify(result.value)).not.toContain('iVBORw0KGgo');
    expect(reports).toEqual([{ affected: [], summary: 'called Story Bible › lore_lookup (external)' }]);
    expect(stager.provenanceOf(result.value.staged?.[0]?.stagingId ?? '')).toEqual({ kind: 'mcp', server: 'Story Bible', tool: 'lore_lookup' });
  });

  it('refuses a picture answer with the cap named and the picture not staged, and says so in the activity row', async () => {
    const { client, loaded, params } = await prepared(scriptReturning(Array.from({ length: 5 }, () => imageBlock(png()))));
    const { staging, staged } = countingStaging();
    const { stager } = stagerOver(staging);
    const { outcome, reports } = run(client, loaded, params, stager);
    const result = await outcome;
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error).toMatchObject({ code: 'limit-exceeded', target: 'lore_lookup' });
    expect(result.error.message).toContain('4-image cap');
    expect(staged()).toBe(0);
    expect(reports).toEqual([{ affected: [], summary: 'called Story Bible › lore_lookup (external) — a picture in the result was refused, so it was not returned' }]);
  });

  it('drops the pictures it staged when the rest of the answer is then refused over the token cap', async () => {
    const { client, loaded, params } = await prepared(scriptReturning([{ type: 'text', text: 'x'.repeat(4_000) }, imageBlock(png())]));
    const { staging } = countingStaging();
    const { stager } = stagerOver(staging);
    const result = await run(client, loaded, params, stager, 100).outcome;
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.code).toBe('limit-exceeded');
    expect(stager.heldIds()).toEqual([]);
  });

  it('with no staging area wired, still never hands the model a picture', async () => {
    const { client, loaded, params } = await prepared(scriptReturning([imageBlock(png())]));
    const result = await run(client, loaded, params, undefined).outcome;
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.content).toEqual([{ type: 'text', text: '[image 1: image/png, 1 KB, not staged: this host has nowhere to hold pictures]' }]);
    expect(result.value.staged).toBeUndefined();
  });

  it('sends staged bytes to the tool after validation, and the call the writer approved still names the id', async () => {
    const seen: Record<string, unknown>[] = [];
    const script: MockMcpScript = {
      listTools: storyTools().map((tool) => (tool.name === 'lore_lookup' ? { ...tool, inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } : tool)),
      respond: (_tool, args) => {
        seen.push(args);
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    };
    const { staging } = countingStaging();
    const { stager } = stagerOver(staging);
    const [first] = stager.stage([{ bytes: png(0x33), mime: 'image/png' }], ORIGIN);
    const { client, loaded, params } = await prepared(script, { name: `staged:${first?.stagingId}` });
    expect(params.args).toEqual({ name: `staged:${first?.stagingId}` });

    const result = await run(client, loaded, params, stager).outcome;
    expect(result.ok).toBe(true);
    expect(seen).toEqual([{ name: base64(png(0x33)) }]);
  });

  it('does not call the tool when a staged reference is not held', async () => {
    const calls: string[] = [];
    const script: MockMcpScript = { listTools: storyTools(), respond: (tool) => (calls.push(tool), { content: [] }) };
    const { client, loaded, params } = await prepared(script, { name: 'staged:stg_ZZZZZZZZZZ' });
    const { staging } = countingStaging();
    const { stager } = stagerOver(staging);
    const { outcome, reports } = run(client, loaded, params, stager);
    const result = await outcome;
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.code).toBe('not-found');
    expect(result.error.message).toContain('The tool was not called');
    expect(calls).toEqual([]);
    expect(reports).toEqual([{ affected: [], summary: 'refused Story Bible › lore_lookup (external): a staged picture could not be sent' }]);
  });
});
