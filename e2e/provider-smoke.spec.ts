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
  type SmokeStage,
} from './provider-smoke-lib.js';

/**
 * The real-key round (providers-browser-cors.md §3). For every `CAOTANG_SMOKE_<PRESET>` variable set — in the shell or in
 * the gitignored `caotang.env` — this runs the provider end to end through the app's own service: the model list, a
 * streamed reply, a native tool call where the capability row claims one, thinking levels where offered, and the
 * request log's key-redaction. Without any of these variables the suite skips. It runs locally, or in CI only by the manual
 * dispatch of .github/workflows/provider-smoke.yml, never on a pull request.
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
    close(): void {},
  };
}

const keyed = smokeKeys();
const configured = applyPresetFilter(keyed, only);
const nothingToRun = configured.size === 0 ? `no CAOTANG_SMOKE_* variables set${only === undefined ? '' : ' for the presets asked for'} — the real-key round is manual` : '';

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
    test(`${presetId}: list, stream, tools where claimed, thinking where offered, no key in the log`, async () => {
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
            expect(reasoning.join('').length, 'thinking: low returns a readable summary').toBeGreaterThan(0);
          });
        } else report.notClaimed('thinking');

        // 5. The request log carries the calls — and never the key.
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
