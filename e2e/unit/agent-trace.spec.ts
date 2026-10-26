import { expect, test } from '@playwright/test';

import { MemoryIndexedDb, openRuntimeStore } from '../../packages/store/src/index.js';
import { DEMO_INTENTS } from '../../packages/gateway/src/mock/index.js';
import { TRACE_REVIEWS, parseTrace, type TraceRecord } from '../../packages/harness/src/index.js';

import { AgentController } from '../../apps/desktop/src/app/agent.js';
import { APP_KEYS, openAppDb } from '../../apps/desktop/src/app/app-db.js';
import { activeCoherenceModel } from '../../apps/desktop/src/app/coherence-review.js';
import { sampleProjectState } from '../../apps/desktop/src/app/demo.js';
import { exportBundle } from '../../apps/desktop/src/app/lifecycle.js';
import { ProviderService } from '../../apps/desktop/src/app/providers.js';
import { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { normalizeSettings } from '../../apps/desktop/src/app/settings.js';
import { SettingsStore } from '../../apps/desktop/src/app/services.js';
import { TabTrace, traceFileName } from '../../apps/desktop/src/app/trace-store.js';
import { turnTimeline } from '../../apps/desktop/src/app/trace-model.js';
import { zipEntries } from '../zip-entries.js';

/**
 * The agent trace in the app (agent-harness §5.2), headless on the demo provider: a turn is recorded, the setting that turns it off
 * gathers nothing, the reviews outside a turn are grouped, and nothing about it reaches the app database or a project bundle.
 */

const globals = globalThis as unknown as Record<string, unknown>;
let previous: { document: unknown; window: unknown } | null = null;

test.beforeAll(() => {
  previous = { document: globals['document'], window: globals['window'] };
  globals['document'] = new EventTarget();
  globals['window'] = new EventTarget();
});

test.afterAll(() => {
  if (previous === null) return;
  globals['document'] = previous.document;
  globals['window'] = previous.window;
});

async function open(db: Awaited<ReturnType<typeof openAppDb>> | null = null) {
  const { service } = await ProviderService.open({ db, vault: null });
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
  return { providers: service, session, store, controller: new AgentController(session, service) };
}

const kindsOf = (records: readonly TraceRecord[]): string[] => records.map((record) => record.kind);

test('a turn on the demo provider is traced from its start to its report, every model call a request and a response', async () => {
  const { providers, session, controller } = await open();
  providers.trace.keep(true);

  const report = await controller.submit(DEMO_INTENTS.continuity);

  const records = providers.trace.store.records(report?.turnId);
  expect(kindsOf(records)[0]).toBe('turn.start');
  expect(kindsOf(records).at(-1)).toBe('turn.end');
  const requests = records.filter((record) => record.kind === 'model.request');
  expect(requests.length).toBe(report?.modelCalls);
  expect(records.filter((record) => record.kind === 'model.response').length).toBe(requests.length);
  expect(records.some((record) => record.kind === 'tool.result')).toBe(true);
  expect((records.at(-1) as { report: unknown }).report).toEqual(report);

  // The model calls and the turn's own records are stamped by one clock, so the waterfall's rows lie in order.
  const times = records.filter((record) => record.kind !== 'message').map((record) => record.at);
  expect(times).toEqual([...times].sort((a, b) => a - b));

  const timeline = turnTimeline(providers.trace.store, report?.turnId ?? '');
  expect(timeline.calls).toBe(requests.length);
  expect(timeline.rows.some((row) => row.kind === 'tool')).toBe(true);
  expect(timeline.intent).toBe(DEMO_INTENTS.continuity);

  const parsed = parseTrace(providers.trace.export({ turnId: report?.turnId }));
  expect(parsed.ok).toBe(true);
  await session.close();
});

test('with the setting off, no observer is attached and no sink is given, and the store stays empty', async () => {
  const attached: Array<unknown> = [];
  const trace = new TabTrace({ setObserver: (observe) => attached.push(observe) });
  trace.keep(true);
  trace.store.write({ kind: 'turn.start', at: 0, turnId: 't.turn-1', intent: 'x' });
  expect(typeof attached[0]).toBe('function');
  expect(trace.sink()).toBe(trace.store);

  trace.keep(false);
  expect(attached[1]).toBeUndefined();
  expect(trace.sink()).toBeUndefined();
  expect(trace.store.turns()).toEqual([]);

  const { providers, session, controller } = await open();
  providers.trace.keep(true);
  providers.trace.keep(false);
  await controller.submit(DEMO_INTENTS.continuity);
  expect(providers.trace.store.turns()).toEqual([]);
  expect(providers.trace.store.bytes).toBe(0);
  await session.close();
});

test('the setting is a boolean in the existing settings record: on unless turned off', () => {
  expect(normalizeSettings({}).agent.keepTraces).toBe(true);
  expect(normalizeSettings({ agent: { keepTraces: false } }).agent.keepTraces).toBe(false);
  expect(normalizeSettings({ agent: { keepTraces: 'no' } }).agent.keepTraces).toBe(true);
});

test('a review made outside a turn lands in the reviews group, beside the turns', async () => {
  const { providers, session, controller } = await open();
  providers.trace.keep(true);
  await controller.submit(DEMO_INTENTS.continuity);

  // The Findings tab and the agent's review step run the same model, built here from the active profile. The demo answers
  // only its three requests, so this one fails, and the failure is in the trace as much as an answer would be.
  const model = activeCoherenceModel(providers);
  expect(model).toBeDefined();
  await model?.complete({ system: 'You review a manuscript.', user: 'Review this scene.', jsonSchemaHint: {} }).catch(() => undefined);

  const groups = providers.trace.store.turns().map((turn) => turn.turnId);
  expect(groups.at(-1)).toBe(TRACE_REVIEWS);
  expect(groups.length).toBe(2);
  const reviews = providers.trace.store.records(TRACE_REVIEWS);
  expect(kindsOf(reviews)).toEqual(['model.request', 'model.response']);
  expect((reviews[0] as { turnId?: string }).turnId).toBeUndefined();
  expect(reviews[1]).toMatchObject({ 'gen_ai.response.finish_reasons': ['error'], error: { kind: expect.any(String) } });
  expect(turnTimeline(providers.trace.store, TRACE_REVIEWS).reviews).toBe(true);
  await session.close();
});

test('nothing about the trace reaches the app database or a project bundle', async () => {
  const db = await openAppDb(new MemoryIndexedDb());
  const { providers, session, store, controller } = await open(db);
  const settings = new SettingsStore(db, normalizeSettings({}));
  await settings.persist();
  providers.trace.keep(true);
  const report = await controller.submit(DEMO_INTENTS.continuity);
  await providers.persist();
  const traced = providers.trace.export({ turnId: report?.turnId });
  expect(traced).toContain(DEMO_INTENTS.continuity);

  // The database holds the keys it always held, and none of their records holds a prompt.
  const rows = await db.list<unknown>('');
  expect(rows.map((row) => row.key).sort()).toEqual(Object.values(APP_KEYS).filter((key) => rows.some((row) => row.key === key)).sort());
  expect(rows.every((row) => Object.values(APP_KEYS).includes(row.key as (typeof APP_KEYS)[keyof typeof APP_KEYS]))).toBe(true);
  expect(JSON.stringify(rows)).not.toContain(DEMO_INTENTS.continuity);

  // The bundle names the project's own files, and none is a trace.
  const bundle = await exportBundle(store, session);
  const entries = zipEntries(bundle.bytes);
  expect([...entries.keys()].some((name) => /trace/i.test(name))).toBe(false);
  for (const [, bytes] of entries) expect(new TextDecoder().decode(bytes)).not.toContain('caotang.trace/1');
  await session.close();
});

test('an export is named for the project and the turn', () => {
  expect(traceFileName('The Lighthouse Keeper', 'abc.turn-3')).toBe('The-Lighthouse-Keeper-trace-abc.turn-3.jsonl');
  expect(traceFileName('', undefined)).toBe('project-trace-all.jsonl');
});
