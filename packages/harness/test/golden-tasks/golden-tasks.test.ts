/**
 * The golden writing tasks (agent-harness §9). Each directory under `golden-tasks/` is one task; each cassette under its
 * `cassettes/` is replayed through the mock gateway, the turn runs through the real loop and bus, and then
 *
 * - the task's checks hold over what the replayed turn wrote,
 * - every request the turn sent matched a recorded one by key (a miss fails with a diff and the command that records again),
 * - every recorded exchange was asked for (a cassette with a leftover is stale),
 * - and no network call was made.
 *
 * The cassettes in this tree are synthetic: a person wrote the model's answers in each task's `script`, and the requests were
 * recorded from the loop as it runs today. They prove the harness and the prompts, and say nothing about any model.
 * `CAOTANG_UPDATE_GOLDEN=1` authors them again; review the diff like a golden.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Gateway } from '@caotang/gateway';

import { CASSETTE_FORMAT, parseCassette, recordScripts, replayScript, scriptedGateway, serializeCassette, type Cassette } from '../../src/agent/cassette.js';
import { evaluate, type Scenario, type ScenarioCategory } from '../../src/agent/eval.js';
import type { GoldenCategory, GoldenTask } from './types.js';

const ROOT = __dirname;
const UPDATE = process.env['CAOTANG_UPDATE_GOLDEN'] === '1';
/** The day the synthetic cassettes were authored. It moves only when a task is authored again on purpose. */
const AUTHORED = '2026-10-26';
const RERECORD = 'CAOTANG_UPDATE_GOLDEN=1 corepack pnpm vitest run packages/harness/test/golden-tasks';

const CATEGORY: Record<GoldenCategory, ScenarioCategory> = {
  draft: 'single-op',
  continue: 'single-op',
  rewrite: 'anchor',
  synopsis: 'single-op',
  structure: 'single-op',
  metadata: 'single-op',
  continuity: 'single-op',
  codex: 'codex',
  screenplay: 'single-op',
  dialogue: 'single-op',
  storyboard: 'single-op',
  refusal: 'verify-recovery',
  economy: 'multi-step',
};

const ids = readdirSync(ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const loaded = new Map<string, GoldenTask>();
for (const id of ids) loaded.set(id, ((await import(`./${id}/task.ts`)) as { task: GoldenTask }).task);

const cassettePath = (id: string, file: string): string => resolve(ROOT, id, 'cassettes', file);
const cassetteFiles = (id: string): string[] => (existsSync(cassettePath(id, '')) ? readdirSync(cassettePath(id, '')).filter((name) => name.endsWith('.jsonl')).sort() : []);

function scenarioOf(task: GoldenTask, gateway: Scenario['gateway'], cassette?: string): Scenario {
  return {
    name: `golden task ${task.id}`,
    category: CATEGORY[task.category],
    intent: task.intent,
    project: task.project,
    gateway,
    ...(task.decisions === undefined ? {} : { decisions: task.decisions }),
    ...(task.preload === undefined ? {} : { preload: task.preload }),
    checks: task.checks,
    ...(cassette === undefined ? {} : { cassette }),
    expect: { ...task.expect, ...task.budgets },
  };
}

/** Authors the synthetic cassette of a task: its script answers, and the exchanges are kept. The authored run must itself pass. */
async function author(task: GoldenTask): Promise<void> {
  const recorded = recordScripts(task.script());
  const gateway = await scriptedGateway(recorded.scripts);
  const result = await evaluate(scenarioOf(task, () => Promise.resolve(gateway)));
  if (result.failures.length > 0) throw new Error(`the synthetic answers of ${task.id} do not pass their own task:\n${result.failures.join('\n')}`);
  const manifest = createHash('sha256').update(readFileSync(resolve(ROOT, '../golden/prompt-manifest.json'), 'utf8'), 'utf8').digest('hex');
  const cassette: Cassette = {
    header: { kind: 'header', format: CASSETTE_FORMAT, task: task.id, preset: 'mock', model: 'synthetic', synthetic: true, recordedAt: AUTHORED, promptManifest: manifest },
    exchanges: recorded.exchanges,
  };
  mkdirSync(cassettePath(task.id, ''), { recursive: true });
  writeFileSync(cassettePath(task.id, 'synthetic.jsonl'), serializeCassette(cassette));
}

const fetchStub = vi.fn(() => {
  throw new Error('a golden task made a network call: it must run on recorded responses alone');
});

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchStub);
  if (UPDATE) for (const task of loaded.values()) await author(task);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

/** The gateway that replays a cassette, and the replay it reads misses from. */
async function replayOf(cassette: Cassette, name: string) {
  const replay = replayScript(cassette, { rerecord: RERECORD, name });
  return { replay, gateway: await scriptedGateway([replay.script]) };
}

describe('the golden tasks, replayed from their cassettes', () => {
  it('has the tasks the scope names, each with a cassette', () => {
    expect(ids.length).toBeGreaterThanOrEqual(6);
    for (const id of ids) expect(cassetteFiles(id), `${id} has no cassette`).not.toEqual([]);
  });

  for (const id of ids) {
    const task = loaded.get(id) as GoldenTask;
    for (const file of cassetteFiles(id)) {
      it(`${id}: ${file} replays, every request matches its recording, and the checks hold`, async () => {
        const cassette = parseCassette(readFileSync(cassettePath(id, file), 'utf8'));
        expect(cassette.header.task).toBe(id);
        const { replay, gateway } = await replayOf(cassette, `${id}/${file}`);
        const result = await evaluate(scenarioOf(task, () => Promise.resolve(gateway), `${id}/cassettes/${file}`));
        expect(replay.misses, 'a request differs from its recording').toEqual([]);
        expect(result.failures).toEqual([]);
        expect(replay.unused().map((exchange) => exchange.key), 'recorded exchanges the turn never asked for').toEqual([]);
        expect(fetchStub).not.toHaveBeenCalled();
      });
    }
  }

  it('labels every hand-authored cassette synthetic in its header', () => {
    for (const id of ids) {
      for (const file of cassetteFiles(id)) {
        const { header } = parseCassette(readFileSync(cassettePath(id, file), 'utf8'));
        if (header.model === 'synthetic') expect(header.synthetic, `${id}/${file}`).toBe(true);
        if (file.startsWith('synthetic')) expect(header).toMatchObject({ model: 'synthetic', synthetic: true });
      }
    }
  });
});

describe('a prompt change breaks the replay, with a diff that names it', () => {
  it('fails the first task when one word of the planner system prompt changes', async () => {
    const id = ids[0] as string;
    const task = loaded.get(id) as GoldenTask;
    const file = cassetteFiles(id)[0] as string;
    const cassette = parseCassette(readFileSync(cassettePath(id, file), 'utf8'));
    const { replay, gateway } = await replayOf(cassette, `${id}/${file}`);
    // The patch is in process, as if protocol.ts worded one heading of the planner system message differently.
    const patched: Gateway = {
      ...gateway,
      complete: (request, signal) =>
        gateway.complete(
          {
            ...request,
            messages: request.messages.map((message, index) => (index === 0 && message.role === 'system' ? { ...message, content: message.content.replace('Tools:', 'Tooling:') } : message)),
          },
          signal,
        ),
    };
    const result = await evaluate(scenarioOf(task, () => Promise.resolve(patched), `${id}/cassettes/${file}`));
    expect(result.failures.length).toBeGreaterThan(0);
    expect(replay.misses.length).toBeGreaterThan(0);
    const [first] = replay.misses;
    expect(first).toContain('message 1 (system) changed at character');
    expect(first).toContain('Tools:');
    expect(first).toContain('Tooling:');
    expect(first).toContain(RERECORD);
  });
});

describe('a task fails when the recorded model does the job badly', () => {
  /** The task replayed from its cassette with the text answers changed by `change`: the requests are untouched, so every key still matches. */
  async function badly(id: string, change: (text: string) => string) {
    const task = loaded.get(id) as GoldenTask;
    const file = cassetteFiles(id)[0] as string;
    const cassette = parseCassette(readFileSync(cassettePath(id, file), 'utf8'));
    const worse: Cassette = {
      ...cassette,
      exchanges: cassette.exchanges.map((exchange) => (exchange.request.responseFormat === 'text' ? { ...exchange, response: { ...exchange.response, content: change(exchange.response.content) } } : exchange)),
    };
    const { replay, gateway } = await replayOf(worse, id);
    const result = await evaluate(scenarioOf(task, () => Promise.resolve(gateway)));
    expect(replay.misses).toEqual([]);
    return result.failures;
  }

  it('draft-empty-scene: a chat opening in front of the scene is caught', async () => {
    const failures = await badly('draft-empty-scene', (text) => `Here is the scene you asked for:\n\n${text}`);
    expect(failures.some((failure) => failure.startsWith('check noPreamble'))).toBe(true);
  });

  it('rewrite-selection: a replacement that is not shorter is caught', async () => {
    const failures = await badly('rewrite-selection', (text) => `${text} ${text} ${text}`);
    expect(failures.some((failure) => failure.startsWith('check wordCountWithin'))).toBe(true);
  });

  it('codex-never: the withheld entry’s facts coming back in the writing are caught', async () => {
    const failures = await badly('codex-never', (text) => `${text} He had sold the salvage ledger.`);
    expect(failures.some((failure) => failure.startsWith('check absentEverywhere'))).toBe(true);
  });

});
