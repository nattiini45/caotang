import { expect, test } from '@playwright/test';
import type { ProjectHook } from '../../packages/bus/src/index.js';
import { MemoryIndexedDb, openRuntimeStore } from '../../packages/store/src/index.js';
import { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { exportBundle, hookNotice, saveFolder } from '../../apps/desktop/src/app/lifecycle.js';
import { IDS, project } from './fixtures.js';
import { filesIn, memoryFolder } from './memory-folder.js';

const globals = globalThis as unknown as Record<string, unknown>;
let previous: { document: unknown; window: unknown };
test.beforeAll(() => {
  previous = { document: globals['document'], window: globals['window'] };
  globals['document'] = new EventTarget();
  globals['window'] = new EventTarget();
});
test.afterAll(() => Object.assign(globals, previous));

const hook = (event: ProjectHook['event'], id = 'h_0123456789'): ProjectHook => ({
  id, name: `Check ${event}`, event, onBlock: 'block', failClosed: true, enabled: true,
  handler: { kind: 'check', check: { kind: 'pattern', patterns: [{ match: 'Four', message: 'Choose another word.' }] } },
});
async function open(hooks: ProjectHook[]) {
  const state = project();
  state.manifest.agent = { hooks };
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
  return { store, session };
}

test('a user compile blocks without side effects, a one-compile override keeps both hook notes in the compile log, and the next compile blocks again', async () => {
  const { session } = await open([hook('export.before'), hook('export.after', 'h_123456789A')]);
  try {
    await session.exportsReady();
    const count = session.log.entries().length;
    const refused = session.dispatch('export.compile', { format: 'md' });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.details?.['hookBlocked']).toBe(true);
    expect(session.log.entries()).toHaveLength(count);
    const compiled = session.dispatch('export.compile', { format: 'md' }, { compileAnyway: true });
    expect(compiled.ok).toBe(true);
    await session.exportsIdle();
    const log = new TextDecoder().decode(await session.readExport('exports/compile-log.json') ?? new Uint8Array());
    expect(log).toContain('Check export.before');
    expect(log).toContain('Check export.after');
    expect(session.dispatch('export.compile', { format: 'md' }).ok).toBe(false);
    expect(session.dispatch('export.compile', { format: 'not-a-format' }, { compileAnyway: true }).ok).toBe(false);
  } finally { await session.close(); }
});

test('export checks see only the compile selection and hold an approved agent call too', async () => {
  const { session } = await open([hook('export.before')]);
  try {
    await session.exportsReady();
    expect(session.dispatch('export.compileSelection', { format: 'md', includeRootIds: [IDS.sceneB] }).ok).toBe(true);
    const harness = await session.harnessReady();
    const outcome = harness.call({ name: 'export.compile', params: { format: 'md', selection: { root: IDS.sceneA } }, callId: 'blocked' }, { turnId: 'turn', permission: { approvedPlan: true } });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.details?.['askBackCode']).toBe('hook_blocked');
    expect(harness.takeHookRuns('turn').some((run) => run.event === 'export.before')).toBe(true);
  } finally { await session.close(); }
});

test('folder and bundle saves never block and expose the hook warning without changing the manuscript', async () => {
  const { session, store } = await open([hook('project.save')]);
  try {
    const body = session.state.documents.get(IDS.sceneA)?.body;
    expect(hookNotice(session).join(' ')).toContain('one hook');
    const bundle = await exportBundle(store, session);
    expect(bundle.bytes.length).toBeGreaterThan(0);
    expect(bundle.notices.join(' ')).toContain('Choose another word.');
    const { handle, tree } = memoryFolder();
    const saved = await saveFolder(session, handle);
    expect(saved.kind).toBe('saved');
    if (saved.kind === 'saved') expect(saved.warnings?.join(' ')).toContain('Choose another word.');
    expect(filesIn(tree).has('caotang.json')).toBe(true);
    expect(session.state.documents.get(IDS.sceneA)?.body).toBe(body);
  } finally { await session.close(); }
});
