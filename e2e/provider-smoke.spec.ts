import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

import { presetFor } from '../packages/gateway/src/index.js';
import { ProviderService } from '../apps/desktop/src/app/providers.js';
import type { AppDb } from '../apps/desktop/src/app/app-db.js';
import {
  ONLY_PRESETS_VAR,
  SmokeReport,
  applyPresetFilter,
  failureText,
  filteredWithoutKey,
  nothingRanText,
  parsePresetFilter,
  smokeKeys,
  summaryNote,
  type SmokeStage,
} from './provider-smoke-lib.js';

/**
 * The real-key round (providers-browser-cors.md §3). It exists only with `CAOTANG_SMOKE=1`: playwright.config.ts then adds the
 * `smoke` project that runs this file, and no other project matches it. Without the gate this module reads no key and never
 * opens the gitignored `caotang.env`, so a normal `pnpm test:e2e` cannot spend even when a key file is sitting on the machine.
 *
 * For every `CAOTANG_SMOKE_<PRESET>` variable set — in the shell or in `caotang.env` — it runs the provider end to end through
 * the app's own service: the model list, a streamed reply, a native tool call where the capability row claims one, thinking
 * levels where offered, the prompt cache where the row caches, and the request log's key-redaction. It runs locally, or in CI
 * only by the manual dispatch of .github/workflows/provider-smoke.yml, never on a pull request.
 *
 * `CAOTANG_ONLY_PRESETS` (space or comma separated ids) limits the round to those presets. Under GitHub Actions a failure
 * names the preset, the stage and the HTTP status only, and each preset appends its stage table to the job summary.
 * The key is never printed. Failures name the provider and the stage, not the credential.
 */

const inActions = process.env['GITHUB_ACTIONS'] === 'true';
const summaryFile = process.env['GITHUB_STEP_SUMMARY'];

function summarize(markdown: string): void {
  if (summaryFile !== undefined && summaryFile !== '') appendFileSync(summaryFile, markdown + '\n');
}

/**
 * The keys, through the gate: `smokeKeys` returns an empty map and calls nothing below unless `CAOTANG_SMOKE=1`, so the file is
 * never opened by a normal suite. `caotang.env` fills in for variables the shell did not set; the file itself stays out of
 * every output.
 */
const keyed = smokeKeys(process.env, () => {
  const envFile = resolve('caotang.env');
  return existsSync(envFile) ? readFileSync(envFile, 'utf8') : undefined;
});

/** The ids `CAOTANG_ONLY_PRESETS` names, if set. A malformed value throws here, before any test is registered. */
const only = parsePresetFilter(process.env[ONLY_PRESETS_VAR]);

function memoryDb(): AppDb {
  const rows = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return rows.has(key) ? (structuredClone(rows.get(key)) as T) : undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      rows.set(key, structuredClone(value));
    },
    async list<T>(prefix: string) {
      return [...rows.entries()].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => ({ key, value: structuredClone(value) as T }));
    },
    async delete(key: string): Promise<void> {
      rows.delete(key);
    },
    close(): void {},
  };
}

const configured = applyPresetFilter(keyed, only);
const nothingToRun =
  configured.size === 0
    ? `no CAOTANG_SMOKE_* variables set${only === undefined ? '' : ' for the presets asked for'} — the real-key round runs only with CAOTANG_SMOKE=1 and a key`
    : '';

// An empty `configured` map would register no tests at all, which Playwright reports as "No tests
// found"; the sentinel keeps the file a clean skip instead.
if (configured.size === 0) {
  test(nothingToRun, () => {
    summarize(nothingRanText(filteredWithoutKey(keyed, only)));
    test.skip();
  });
}

test.describe('real-key round', () => {
  test.skip(configured.size === 0, nothingToRun);

  for (const [presetId, apiKey] of configured) {
    test(`${presetId}: list, stream, tools where claimed, thinking where offered, the prompt cache where the row caches, no key in the log`, async () => {
      test.setTimeout(120_000);
      const preset = presetFor(presetId);
      test.skip(preset === undefined, `no preset named ${presetId}`);

      const report = new SmokeReport(presetId);
      // Runs one stage and records it. Under GitHub Actions the failure that escapes is the preset, the stage and the HTTP
      // status, not the matcher's or the provider's own text, which could echo part of a key that Actions does not mask.
      const stage = async <T>(name: SmokeStage, run: () => Promise<T>): Promise<T> => {
        report.begin(name);
        try {
          const value = await run();
          report.pass(name);
          return value;
        } catch (error) {
          report.fail(name, error);
          throw inActions ? new Error(failureText(presetId, name, error)) : error;
        }
      };

      try {
        const { service } = await ProviderService.open({ db: memoryDb(), vault: null, fetch });

        // 1. The model list answers with the key (or the preset's table when the route has no listing).
        const saved = await stage('model list', async () => {
          const outcome = await service.addProfile({ name: `smoke ${presetId}`, kind: 'endpoint', preset: presetId, apiKey });
          if (preset!.noModelsRoute !== true) {
            expect(outcome.probeError, 'model list').toBeUndefined();
            expect(outcome.models?.length ?? 0, 'model list is non-empty').toBeGreaterThan(0);
          }
          return outcome;
        });

        // 2. A one-line prompt streams to a finish on the preset's default model.
        const view = saved.view;
        await stage('streamed completion', async () => {
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
        });

        const caps = service.gateway.modelCaps(view.id, view.defaultModel);

        // 3. Native tools where the row claims them.
        if (caps?.tools === true) {
          await stage('native tools', async () => {
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
          });
        } else report.notClaimed('native tools');

        // 4. Thinking levels the row offers are accepted on the wire.
        const levels = (caps?.effortLevels ?? []).filter((l) => l !== 'off');
        // Anthropic also gets adaptive thinking at the lowest level: Claude 5 models reject the old budget shape, so this is the
        // call that proves the body the adapter sends is accepted, and that the summarised thinking comes back readable.
        const adaptive = presetId === 'anthropic' && levels.includes('low');
        if (levels.length > 0 || adaptive) {
          await stage('thinking', async () => {
            for (const level of levels) {
              const reply = await service.gateway.completeOnce({
                profileId: view.id,
                model: view.defaultModel,
                messages: [{ role: 'user', content: 'What is 2+2? One word.' }],
                thinking: level,
              });
              expect(reply.content.length, `thinking level ${level}`).toBeGreaterThan(0);
            }
            if (!adaptive) return;
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
            // The endpoint can accept the call and still summarise nothing (seen on thinking: low), so the summary is
            // informational: when one arrives it must read, and its length is recorded in the row either way.
            const summary = reasoning.join('');
            if (summary.length > 0) expect(summary.trim().length, 'a thinking summary that arrives reads').toBeGreaterThan(0);
            report.observe('thinking', summaryNote(summary.length));
          });
        } else report.notClaimed('thinking');

        // 5. Prompt caching where the row says the route caches (provider-gateway §3): one of the identical calls after the first, with a
        // prefix above the row's minimum reads part of its prompt from the provider's cache, as the usage breakdown reports it.
        if (caps?.cache === 'explicit' || caps?.cache === 'automatic') {
          await stage('prompt cache', async () => {
            const system = `You answer in one word. ${'Caotang keeps a writer\'s manuscript on their own machine. '.repeat(160)}`;
            const ask = async () => {
              let cached: number | undefined;
              for await (const chunk of service.gateway.complete({
                profileId: view.id,
                model: view.defaultModel,
                messages: [
                  { role: 'system', content: system },
                  { role: 'user', content: 'Say ready.' },
                ],
              })) {
                if (chunk.usage !== undefined) cached = chunk.usage.cachedPromptTokens;
              }
              return cached;
            };
            // An implicit cache is best-effort (a write can land on another node), so up to three more identical calls may read it.
            await ask();
            let read = 0;
            for (let attempt = 0; attempt < 3 && read === 0; attempt += 1) read = (await ask()) ?? 0;
            expect(read, 'one of the next three identical calls reads from the cache').toBeGreaterThan(0);
          });
        } else report.notClaimed('prompt cache');

        // 6. The request log carries the calls — and never the key.
        await stage('key redaction', async () => {
          const entries = service.requests.entries();
          expect(entries.length, 'requests were logged').toBeGreaterThan(0);
          expect(JSON.stringify(entries).includes(apiKey), 'the key appears in no log entry').toBe(false);
        });
      } finally {
        summarize(report.markdown());
      }
    });
  }
});
