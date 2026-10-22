import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

import { presetFor } from '../packages/gateway/src/index.js';
import { ProviderService } from '../apps/desktop/src/app/providers.js';
import type { AppDb } from '../apps/desktop/src/app/app-db.js';

/**
 * The real-key round (providers-browser-cors.md §3). For every `CAOTANG_SMOKE_<PRESET>` variable set — in the shell or in
 * the gitignored `caotang.env` — this runs the provider end to end through the app's own service: the model list, a
 * streamed reply, a native tool call where the capability row claims one, thinking levels where offered, and the
 * request log's key-redaction. Without any of these variables the suite skips; nothing here runs in CI.
 *
 * The key is never printed. Failures name the provider and the stage, not the credential.
 */

/** `caotang.env` values fill in for variables the shell did not set; the file itself stays out of every output. */
function smokeKeys(): ReadonlyMap<string, string> {
  const fromFile = new Map<string, string>();
  const envFile = resolve('caotang.env');
  if (existsSync(envFile)) {
    // Strip a BOM and tolerate `export NAME=value` lines — both are everyday Windows/editor artifacts
    // that would otherwise silently drop a variable.
    const text = readFileSync(envFile, 'utf8').replace(/^\uFEFF/, '');
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (match === null) continue;
      const value = match[2]!.replace(/^['"]|['"]$/g, '');
      if (match[1]!.startsWith('CAOTANG_SMOKE_')) fromFile.set(match[1]!, value);
    }
  }
  const keys = new Map<string, string>();
  for (const name of new Set([...fromFile.keys(), ...Object.keys(process.env)])) {
    if (!name.startsWith('CAOTANG_SMOKE_')) continue;
    const value = process.env[name] ?? fromFile.get(name);
    if (value !== undefined && value !== '') keys.set(name.slice('CAOTANG_SMOKE_'.length).toLowerCase().replace(/_/g, '-'), value);
  }
  return keys;
}

function memoryDb(): AppDb {
  const rows = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return rows.has(key) ? (structuredClone(rows.get(key)) as T) : undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      rows.set(key, structuredClone(value));
    },
    close(): void {},
  };
}

const configured = smokeKeys();

// An empty `configured` map would register no tests at all, which Playwright reports as "No tests
// found"; the sentinel keeps the file a clean skip instead.
if (configured.size === 0) {
  test('no CAOTANG_SMOKE_* variables set — the real-key round is manual', () => {
    test.skip();
  });
}

test.describe('real-key round', () => {
  test.skip(configured.size === 0, 'no CAOTANG_SMOKE_* variables set — the real-key round is manual');

  for (const [presetId, apiKey] of configured) {
    test(`${presetId}: list, stream, tools where claimed, thinking where offered, no key in the log`, async () => {
      test.setTimeout(120_000);
      const preset = presetFor(presetId);
      test.skip(preset === undefined, `no preset named ${presetId}`);

      const { service } = await ProviderService.open({ db: memoryDb(), vault: null, fetch });
      const saved = await service.addProfile({ name: `smoke ${presetId}`, kind: 'endpoint', preset: presetId, apiKey });

      // 1. The model list answers with the key (or the preset's table when the route has no listing).
      if (preset!.noModelsRoute !== true) {
        expect(saved.probeError, 'model list').toBeUndefined();
        expect(saved.models?.length ?? 0, 'model list is non-empty').toBeGreaterThan(0);
      }

      // 2. A one-line prompt streams to a finish on the preset's default model.
      const view = saved.view;
      const chunks: string[] = [];
      let finish: string | undefined;
      for await (const chunk of service.gateway.complete({
        profileId: view.id,
        model: view.defaultModel,
        messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      })) {
        if (chunk.delta !== undefined) chunks.push(chunk.delta);
        if (chunk.finishReason !== undefined) finish = chunk.finishReason;
      }
      expect(finish, 'plain completion finishes').toBe('stop');
      expect(chunks.join('').length, 'plain completion wrote text').toBeGreaterThan(0);

      const caps = service.gateway.modelCaps(view.id, view.defaultModel);

      // 3. Native tools where the row claims them.
      if (caps?.tools === true) {
        const reply = await service.gateway.completeOnce({
          profileId: view.id,
          model: view.defaultModel,
          messages: [{ role: 'user', content: 'You must answer by calling the lookup tool with word "anchor". Call it now.' }],
          tools: [
            {
              name: 'lookup',
              description: 'Look up a word in the dictionary.',
              parameters: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] },
            },
          ],
          toolChoice: 'auto',
        });
        expect(reply.toolCalls?.length ?? 0, 'a tool call comes back').toBeGreaterThan(0);
      }

      // 4. Thinking levels the row offers are accepted on the wire.
      for (const level of (caps?.effortLevels ?? []).filter((l) => l !== 'off')) {
        const reply = await service.gateway.completeOnce({
          profileId: view.id,
          model: view.defaultModel,
          messages: [{ role: 'user', content: 'What is 2+2? One word.' }],
          thinking: level,
        });
        expect(reply.content.length, `thinking level ${level}`).toBeGreaterThan(0);
      }

      // 5. Adaptive thinking at the lowest level: Claude 5 models reject the old budget shape, so this is the call that proves the
      // body the adapter sends is accepted, and that the summarised thinking comes back readable. Run by hand, never in CI.
      if (presetId === 'anthropic' && (caps?.effortLevels ?? []).includes('low')) {
        const reasoning: string[] = [];
        let reply = '';
        for await (const chunk of service.gateway.complete({
          profileId: view.id,
          model: view.defaultModel,
          messages: [{ role: 'user', content: 'What is 17 times 23? Answer with the number only.' }],
          thinking: 'low',
        })) {
          if (chunk.delta !== undefined) reply += chunk.delta;
          if (chunk.reasoningDelta !== undefined) reasoning.push(chunk.reasoningDelta);
        }
        expect(reply.length, 'thinking: low answers').toBeGreaterThan(0);
        expect(service.requests.entries().at(-1)?.outcome, 'thinking: low is accepted').toBe('ok');
        expect(reasoning.join('').length, 'thinking: low returns a readable summary').toBeGreaterThan(0);
      }

      // 6. The request log carries the calls — and never the key.
      const entries = service.requests.entries();
      expect(entries.length, 'requests were logged').toBeGreaterThan(0);
      expect(JSON.stringify(entries).includes(apiKey), 'the key appears in no log entry').toBe(false);
    });
  }
});
