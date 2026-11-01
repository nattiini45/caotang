/**
 * The app's transcription runner (`src/media/picture-transcription.ts`, pictures.md §8.4 step 2): after the loop
 * approved a `pictures.transcribe` plan, it sends the plan's batches to the budgeted model calls and reads the
 * wire replies back. The suite runs in Node with fake gateways, so no provider key and no DOM are involved; the
 * pictures are tiny in-memory PNGs whose headers are all the checks read.
 */
import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

import type { CommandError, Result } from '@caotang/bus';
import type { ChatChunk, ChatRequest, ImagePart } from '@caotang/gateway';
import { sha256Hex, type PictureBytes, type ReadAssetRecord } from '@caotang/pictures';
import { createEmptyManifest, createProjectState, type ProjectState } from '@caotang/store';
import {
  buildTranscriptionPrompt,
  planTranscriptionBatches,
  TRANSCRIPTION_TEMPERATURE,
  TurnStopped,
  type ModelCall,
  type PictureTranscriptionGeneration,
  type PictureTranscriptionPlan,
} from '@caotang/harness';

import * as runner from '../src/media/picture-transcription.js';
import { runPictureTranscription, TRANSCRIPTION_MAX_EDGE, type PictureTranscriptionRunInput } from '../src/media/picture-transcription.js';

const NOW = new Date('2026-10-30T09:00:00.000Z');

/* ------------------------------------------------------------------ *
 * Tiny PNG fixtures (the header and the sniff are all that is read)
 * ------------------------------------------------------------------ */

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A structurally valid PNG whose IHDR names `width` × `height`; the pixel data is never decoded. */
function pngBytes(width: number, height: number, idat?: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 0, 0, 0, 0], 8);
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat ?? deflateSync(new Uint8Array(2 + width).fill(0x40))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Fake model calls: a gateway that records each request and streams a scripted reply
 * ------------------------------------------------------------------ */

type Reply = { readonly text: string; readonly cut?: boolean } | Error;
type Script = (request: ChatRequest, served: number) => Reply;

interface FakeCall {
  readonly call: ModelCall;
  readonly requests: ChatRequest[];
}

function fakeCall(script: Script, options: { model?: string; profileId?: string; signal?: AbortSignal } = {}): FakeCall {
  const requests: ChatRequest[] = [];
  const call: ModelCall = {
    turnId: 't_transcription',
    ...(options.profileId === undefined ? {} : { profileId: options.profileId }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    gateway: {
      complete(request: ChatRequest): AsyncIterable<ChatChunk> {
        const served = requests.length;
        requests.push(request);
        const outcome = script(request, served);
        async function* stream(): AsyncGenerator<ChatChunk> {
          if (outcome instanceof Error) throw outcome;
          yield { delta: outcome.text };
          yield { finishReason: outcome.cut === true ? 'length' : 'stop' };
        }
        return stream();
      },
    },
  };
  return { call, requests };
}

/** The wire format the prompt demands: one `<<<page id>>>` … `<<<end id>>>` section per page. */
const wireOf = (sections: readonly { assetId: string; text: string }[]): string =>
  `${sections.map((section) => `<<<page ${section.assetId}>>>\n${section.text}\n<<<end ${section.assetId}>>>`).join('\n')}\n`;

/** The page ids a request carries, in image order (each image part is captioned with its asset id). */
const idsOf = (request: ChatRequest): string[] => {
  const content = request.messages[0]?.content;
  if (typeof content === 'string') return [];
  return content.filter((part) => part.type === 'image').map((part) => (part as ImagePart).caption ?? '');
};

/** The standard good reply: one section per page the request carries, with a known text. */
const okScript = (prefix = ''): Script => (request) => ({
  text: wireOf(idsOf(request).map((id) => ({ assetId: id, text: `${prefix}text of ${id}` }))),
});

/* ------------------------------------------------------------------ *
 * Project fixtures: a state with asset records and an in-memory assets store
 * ------------------------------------------------------------------ */

interface World {
  readonly state: ProjectState;
  readonly files: Map<string, Uint8Array>;
}

function world(): World {
  return { state: createProjectState(createEmptyManifest('The Lighthouse Keeper', NOW)), files: new Map<string, Uint8Array>() };
}

let seq = 0;

function addPage(w: World, over: { width?: number; height?: number; bytes?: Uint8Array; omitFile?: boolean } = {}): string {
  seq += 1;
  const id = `a_${String(seq).padStart(10, '0')}`;
  const width = over.width ?? 800;
  const height = over.height ?? 600;
  const bytes = over.bytes ?? pngBytes(width, height);
  const file = `${id}.png`;
  if (!over.omitFile) w.files.set(`assets/${file}`, bytes);
  w.state.manifest.assets = [
    ...(w.state.manifest.assets ?? []),
    {
      id,
      file,
      mime: 'image/png',
      sha256: '0'.repeat(64),
      bytes: bytes.length,
      width,
      height,
      caption: `page ${id}`,
      createdAt: NOW.toISOString(),
    } as unknown as ReadAssetRecord,
  ];
  return id;
}

function makePlan(w: World, ids: readonly string[], over: Partial<PictureTranscriptionPlan> = {}): PictureTranscriptionPlan {
  const records = w.state.manifest.assets ?? [];
  const pages = ids.map((id) => {
    const record = records.find((candidate) => candidate.id === id);
    if (record === undefined) throw new Error(`no record for ${id}`);
    return {
      assetId: id,
      file: record.file,
      ...(record.caption === undefined ? {} : { caption: record.caption }),
      ...(record.width === undefined ? {} : { width: record.width }),
      ...(record.height === undefined ? {} : { height: record.height }),
      bytes: record.bytes,
      expect: null,
    };
  });
  const batches = planTranscriptionBatches(ids);
  return {
    kind: 'pictures.transcribe',
    into: 'new-document',
    language: 'en',
    vocabulary: ['Elena', 'Kestrel'],
    pages,
    batches,
    estimate: { requests: batches.length, maxRequests: pages.length, promptTokens: 0, outputTokens: 0 },
    warnings: [],
    ...over,
  };
}

function runInput(w: World, plan: PictureTranscriptionPlan, call: ModelCall, over: Partial<PictureTranscriptionRunInput> = {}): PictureTranscriptionRunInput {
  return {
    plan,
    model: call,
    state: w.state,
    assets: { readBytes: async (path: string) => w.files.get(path) ?? null },
    ...over,
  };
}

const valueOf = (result: Result<PictureTranscriptionGeneration, CommandError>): PictureTranscriptionGeneration => {
  if (!result.ok) throw new Error(`expected success, got refusal: ${result.error.code}: ${result.error.message}`);
  return result.value;
};

const refusalOf = (result: Result<PictureTranscriptionGeneration, CommandError>): CommandError => {
  if (result.ok) throw new Error('expected a refusal, got success');
  return result.error;
};

const imagePartsOf = (request: ChatRequest): ImagePart[] => {
  const content = request.messages[0]?.content;
  if (typeof content === 'string') return [];
  return content.filter((part): part is ImagePart => part.type === 'image');
};

/* ------------------------------------------------------------------ *
 * The runner
 * ------------------------------------------------------------------ */

describe('runPictureTranscription', () => {
  it('sends one user message per batch — the prompt text, then the batch’s images in order — at temperature 0', async () => {
    const w = world();
    const ids = [addPage(w), addPage(w), addPage(w)];
    const plan = makePlan(w, ids);
    const { call, requests } = fakeCall(okScript(), { model: 'vision-one', profileId: 'p1' });

    const generation = valueOf(await runPictureTranscription(runInput(w, plan, call)));

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.temperature).toBe(0);
    expect(request.temperature).toBe(TRANSCRIPTION_TEMPERATURE);
    expect(request.model).toBe('vision-one');
    expect(request.profileId).toBe('p1');
    expect(request.messages).toHaveLength(1);
    const message = request.messages[0]!;
    expect(message.role).toBe('user');
    const content = message.content;
    if (typeof content === 'string') throw new Error('expected content parts');
    const [text, ...images] = content;
    expect(text).toEqual({ type: 'text', text: buildTranscriptionPrompt({ pages: ids, language: 'en', vocabulary: ['Elena', 'Kestrel'] }) });
    expect(images.map((part) => part.type)).toEqual(['image', 'image', 'image']);
    for (const [index, part] of images.entries()) {
      if (part.type !== 'image') throw new Error('expected an image part');
      const id = ids[index]!;
      const bytes = w.files.get(`assets/${id}.png`)!;
      expect(part.mime).toBe('image/png');
      expect(part.size).toBe(bytes.length);
      expect(part.hash).toBe(await sha256Hex(bytes));
      expect(part.caption).toBe(id);
    }

    expect(generation.pages.map((page) => [page.assetId, page.text])).toEqual(ids.map((id) => [id, `text of ${id}`]));
    expect(generation.model).toBe('vision-one');
    // The result carries texts only — no image bytes.
    const json = JSON.stringify(generation);
    for (const id of ids) {
      expect(json).not.toContain(Buffer.from(w.files.get(`assets/${id}.png`)!).toString('base64'));
    }
  });

  it('labels the generation “default” when the call names no model', async () => {
    const w = world();
    const ids = [addPage(w)];
    const plan = makePlan(w, ids);
    const { call } = fakeCall(okScript());
    const generation = valueOf(await runPictureTranscription(runInput(w, plan, call)));
    expect(generation.model).toBe('default');
  });

  it('runs the plan’s 7-page schedule as two requests — 6 pages, then 1 — keeping page order and exact texts', async () => {
    const w = world();
    const ids = Array.from({ length: 7 }, () => addPage(w));
    const plan = makePlan(w, ids);
    expect(plan.batches.map((batch) => batch.pages.length)).toEqual([6, 1]);
    const { call, requests } = fakeCall(okScript());

    const generation = valueOf(await runPictureTranscription(runInput(w, plan, call)));

    expect(requests).toHaveLength(2);
    expect(idsOf(requests[0]!)).toEqual(ids.slice(0, 6));
    expect(idsOf(requests[1]!)).toEqual(ids.slice(6));
    expect(generation.pages.map((page) => page.assetId)).toEqual(ids);
    expect(generation.pages.map((page) => page.text)).toEqual(ids.map((id) => `text of ${id}`));
  });

  it('retries a malformed batch page by page and keeps the exact parsed texts, line breaks included', async () => {
    const w = world();
    const ids = [addPage(w), addPage(w), addPage(w)];
    const plan = makePlan(w, ids);
    const { call, requests } = fakeCall((request, served) => {
      if (served === 0) return { text: 'I cannot answer in that format.' };
      return { text: wireOf(idsOf(request).map((id) => ({ assetId: id, text: `exact ${id}\nsecond line` }))) };
    });

    const generation = valueOf(await runPictureTranscription(runInput(w, plan, call)));

    expect(requests).toHaveLength(4);
    expect(idsOf(requests[0]!)).toEqual(ids);
    expect(idsOf(requests[1]!)).toEqual([ids[0]!]);
    expect(idsOf(requests[2]!)).toEqual([ids[1]!]);
    expect(idsOf(requests[3]!)).toEqual([ids[2]!]);
    expect(generation.pages.map((page) => page.text)).toEqual(ids.map((id) => `exact ${id}\nsecond line`));
  });

  it('retries page by page when the provider throws on the batch', async () => {
    const w = world();
    const ids = [addPage(w), addPage(w)];
    const plan = makePlan(w, ids);
    const { call, requests } = fakeCall((request, served) => {
      if (served === 0) return new Error('provider exploded');
      return okScript()(request, served);
    });

    const generation = valueOf(await runPictureTranscription(runInput(w, plan, call)));

    expect(requests).toHaveLength(3);
    expect(generation.pages.map((page) => [page.assetId, page.text])).toEqual(ids.map((id) => [id, `text of ${id}`]));
  });

  it('treats a cut reply as malformed and falls back page by page', async () => {
    const w = world();
    const ids = [addPage(w), addPage(w)];
    const plan = makePlan(w, ids);
    const { call, requests } = fakeCall((request, served) => {
      if (served === 0) return { text: wireOf([{ assetId: ids[0]!, text: 'partial' }]), cut: true };
      return okScript()(request, served);
    });

    const generation = valueOf(await runPictureTranscription(runInput(w, plan, call)));

    expect(requests).toHaveLength(3);
    expect(requests[0]!.messages).toHaveLength(1);
    expect(generation.pages.map((page) => page.text)).toEqual(ids.map((id) => `text of ${id}`));
  });

  it('refuses the whole generation when a page still fails on its own request — no partial draft, nothing sent on', async () => {
    const w = world();
    const ids = [addPage(w), addPage(w)];
    const plan = makePlan(w, ids);
    const { call, requests } = fakeCall((_request, served) => {
      if (served === 0) return { text: 'garbage, not the wire format' };
      if (served === 1) return new Error('provider exploded');
      return { text: wireOf([{ assetId: 'a_never0000', text: 'unused' }]) };
    });

    const result = await runPictureTranscription(runInput(w, plan, call));

    const error = refusalOf(result);
    expect(error.code).toBe('internal');
    expect(error.message).toContain(ids[0]!);
    expect(error.target).toBe(ids[0]!);
    expect(error.correctiveHint).toBeTruthy();
    // The batch and the first page’s own request; the second page is never sent.
    expect(requests).toHaveLength(2);
    expect(idsOf(requests[1]!)).toEqual([ids[0]!]);
  });

  it('runs the second read on its own pinned route and fills secondText, keeping the first read as text', async () => {
    const w = world();
    const ids = Array.from({ length: 7 }, () => addPage(w));
    const plan = makePlan(w, ids, { secondRead: { profileId: 'p2', model: 'vision-two' } });
    const primary = fakeCall(okScript(''), { model: 'vision-one', profileId: 'p1' });
    const second = fakeCall(okScript('second '), { model: 'vision-two', profileId: 'p2' });

    const generation = valueOf(await runPictureTranscription(runInput(w, plan, primary.call, { secondModel: second.call })));

    expect(primary.requests).toHaveLength(2);
    expect(second.requests).toHaveLength(2);
    for (const request of primary.requests) {
      expect(request.profileId).toBe('p1');
      expect(request.model).toBe('vision-one');
    }
    for (const request of second.requests) {
      expect(request.profileId).toBe('p2');
      expect(request.model).toBe('vision-two');
    }
    expect(idsOf(second.requests[0]!)).toEqual(ids.slice(0, 6));
    expect(generation.model).toBe('vision-one');
    expect(generation.pages.map((page) => [page.text, page.secondText])).toEqual(ids.map((id) => [`text of ${id}`, `second text of ${id}`]));
  });

  it('refuses when the plan names a second read but no second model call was supplied', async () => {
    const w = world();
    const ids = [addPage(w)];
    const plan = makePlan(w, ids, { secondRead: { profileId: 'p2' } });
    const { call, requests } = fakeCall(okScript(), { model: 'vision-one', profileId: 'p1' });

    const error = refusalOf(await runPictureTranscription(runInput(w, plan, call)));

    expect(error.code).toBe('invalid-params');
    expect(error.target).toBe('secondRead');
    expect(error.correctiveHint).toBeTruthy();
    expect(requests).toHaveLength(0);
  });

  it('refuses a missing asset file with a corrective hint before any request is sent', async () => {
    const w = world();
    const present = addPage(w);
    const missing = addPage(w, { omitFile: true });
    const plan = makePlan(w, [present, missing]);
    const { call, requests } = fakeCall(okScript());

    const error = refusalOf(await runPictureTranscription(runInput(w, plan, call)));

    expect(error.code).toBe('not-found');
    expect(error.message).toContain(missing);
    expect(error.message).toContain(`assets/${missing}.png`);
    expect(error.correctiveHint).toBeTruthy();
    expect(requests).toHaveLength(0);
  });

  it('refuses a damaged file whose sniffed type does not match the record, before any request', async () => {
    const w = world();
    const good = addPage(w);
    const id = addPage(w);
    // The record says PNG, the bytes are a JPEG signature.
    w.files.set(`assets/${id}.png`, Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]));
    w.state.manifest.assets = (w.state.manifest.assets ?? []).map((record) =>
      record.id === id ? { ...record, bytes: 12 } : record,
    );
    const plan = makePlan(w, [good, id]);
    const { call, requests } = fakeCall(okScript());

    const error = refusalOf(await runPictureTranscription(runInput(w, plan, call)));

    expect(error.code).toBe('io-error');
    expect(error.message).toContain(id);
    expect(error.message).toContain('image/jpeg');
    expect(error.correctiveHint).toBeTruthy();
    expect(requests).toHaveLength(0);
  });

  it('refuses unreadable bytes as damaged, keeping the bytes out of the error', async () => {
    const w = world();
    const id = addPage(w);
    const garbage = new TextEncoder().encode('this is not a picture at all');
    w.files.set(`assets/${id}.png`, garbage);
    w.state.manifest.assets = (w.state.manifest.assets ?? []).map((record) => (record.id === id ? { ...record, bytes: garbage.length } : record));
    const plan = makePlan(w, [id]);
    const { call, requests } = fakeCall(okScript());

    const error = refusalOf(await runPictureTranscription(runInput(w, plan, call)));

    expect(error.code).toBe('io-error');
    expect(error.message).toContain(id);
    expect(error.correctiveHint).toBeTruthy();
    expect(requests).toHaveLength(0);
    expect(JSON.stringify(error)).not.toContain(Buffer.from(garbage).toString('base64'));
  });

  it('resizes a page over the max edge transiently and never modifies the stored bytes', async () => {
    const w = world();
    const id = addPage(w, { width: 4000, height: 3000 });
    const stored = w.files.get(`assets/${id}.png`)!;
    const resizedBytes = pngBytes(1176, 882);
    const resize = vi.fn(async (_picture: PictureBytes, _longEdge: number) => ({ bytes: resizedBytes, mime: 'image/png' as const, width: 1176, height: 882 }));
    const plan = makePlan(w, [id]);
    const { call, requests } = fakeCall(okScript());

    const generation = valueOf(await runPictureTranscription(runInput(w, plan, call, { resize })));

    expect(resize).toHaveBeenCalledTimes(1);
    const [picture, longEdge] = resize.mock.calls[0] as unknown as [PictureBytes, number];
    expect(longEdge).toBe(TRANSCRIPTION_MAX_EDGE);
    expect(longEdge).toBe(1568);
    expect(picture).toMatchObject({ mime: 'image/png', width: 4000, height: 3000 });
    expect(picture.bytes).toEqual(stored);
    const images = imagePartsOf(requests[0]!);
    expect(images).toHaveLength(1);
    expect(images[0]!.size).toBe(resizedBytes.length);
    expect(images[0]!.hash).toBe(await sha256Hex(resizedBytes));
    expect(images[0]!.caption).toBe(id);
    // The stored file is untouched.
    expect(w.files.get(`assets/${id}.png`)).toEqual(stored);
    expect(generation.pages[0]!.text).toBe(`text of ${id}`);
  });

  it('sends the stored bytes unchanged when no resize port is supplied and the file is within the limits', async () => {
    const w = world();
    const id = addPage(w, { width: 800, height: 600 });
    const stored = w.files.get(`assets/${id}.png`)!;
    const plan = makePlan(w, [id]);
    const { call, requests } = fakeCall(okScript());

    const generation = valueOf(await runPictureTranscription(runInput(w, plan, call)));

    const images = imagePartsOf(requests[0]!);
    expect(images[0]!.size).toBe(stored.length);
    expect(images[0]!.hash).toBe(await sha256Hex(stored));
    expect(generation.pages).toHaveLength(1);
  });

  it('prechecks the conservative route byte limits and refuses an oversized stored file instead of sending it', async () => {
    const w = world();
    // A ~6 MiB PNG (over the conservative 5 MiB per-image cap) whose header still reads 100 × 100.
    const big = pngBytes(100, 100, new Uint8Array(6 * 1024 * 1024).fill(0x41));
    const id = addPage(w, { width: 100, height: 100, bytes: big });
    const plan = makePlan(w, [id]);
    const { call, requests } = fakeCall(okScript());

    const error = refusalOf(await runPictureTranscription(runInput(w, plan, call)));

    expect(error.code).toBe('limit-exceeded');
    expect(error.message).toContain(id);
    expect(error.message).toContain('bytes');
    expect(error.correctiveHint).toBeTruthy();
    expect(requests).toHaveLength(0);
  });

  it('propagates cancellation as a rejection and returns no result', async () => {
    const w = world();
    const ids = [addPage(w)];
    const plan = makePlan(w, ids);
    const controller = new AbortController();
    controller.abort();
    const { call, requests } = fakeCall(okScript(), { signal: controller.signal });

    await expect(runPictureTranscription(runInput(w, plan, call))).rejects.toBeInstanceOf(TurnStopped);
    expect(requests).toHaveLength(0);
  });

  it('exposes no command-dispatch surface — only the runner and its constants', () => {
    const names = Object.keys(runner);
    expect(names).toContain('runPictureTranscription');
    expect(names).toContain('TRANSCRIPTION_MAX_EDGE');
    expect(names.every((name) => !/dispatch|bus|command/i.test(name))).toBe(true);
    expect(typeof runner.runPictureTranscription).toBe('function');
  });
});
