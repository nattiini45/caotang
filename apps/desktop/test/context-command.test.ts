import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryIndexedDb, openRuntimeStore } from '@caotang/store';
import type { RequestContextPreview } from '@caotang/harness';
import { AgentController } from '../src/app/agent.js';
import { sampleProjectState } from '../src/app/demo-sample.js';
import { ProviderService } from '../src/app/providers.js';
import { ProjectSession } from '../src/app/session.js';

const sessions: { session: ProjectSession; controller: AgentController }[] = [];

beforeEach(() => {
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('window', new EventTarget());
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { session, controller } of sessions.splice(0)) {
    controller.detach();
    await session.close();
  }
  vi.unstubAllGlobals();
});

async function fixture() {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
  const providers = (await ProviderService.open({ db: null, vault: null })).service;
  await providers.addProfile({ name: 'Mock', kind: 'mock', isActive: true, defaultModel: 'mock/echo-1' });
  const controller = new AgentController(session, providers);
  sessions.push({ session, controller });
  const request = await controller.previewRequest('Consider the sample.');
  if (request === null) throw new Error('The mock profile must support a local preview');
  return { controller, request };
}

function deferred() {
  let resolve!: (value: RequestContextPreview | null) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<RequestContextPreview | null>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it.each(['help', 'dismiss'] as const)('does not replace %s with a late preview success or failure', async (action) => {
  const { controller, request } = await fixture();
  for (const outcome of ['success', 'failure'] as const) {
    const pending = deferred();
    const spy = vi.spyOn(controller, 'previewRequest').mockReturnValueOnce(pending.promise);
    controller.sendLine('/context');
    expect(controller.snapshot().command?.title).toBe('Loading the context preview…');
    if (action === 'help') controller.sendLine('/help');
    else controller.dismissCommandNote();
    const expected = controller.snapshot().command;
    if (outcome === 'success') pending.resolve(request);
    else pending.reject(new Error('Preview failed'));
    await Promise.allSettled([pending.promise]);
    expect(controller.snapshot().command).toEqual(expected);
    spy.mockRestore();
  }
});

it('explains a missing profile and supports retrying without sending a request', async () => {
  const { controller, request } = await fixture();
  const preview = vi.spyOn(controller, 'previewRequest').mockResolvedValueOnce(null).mockResolvedValueOnce(request);
  controller.sendLine('/context');
  await vi.waitFor(() => expect(controller.snapshot().command?.title).toBe('Context preview is unavailable.'));
  expect(controller.snapshot().command?.lines).toContain('Choose a provider in Settings, then run /context again. No request was sent.');
  controller.sendLine('/context');
  await vi.waitFor(() => expect(controller.snapshot().command?.requestContext).toEqual(request));
  expect(preview).toHaveBeenCalledTimes(2);
  expect(controller.turnCount()).toBe(0);
});

it('handles a rejected preview and safely retries after the error', async () => {
  const { controller, request } = await fixture();
  vi.spyOn(controller, 'previewRequest').mockRejectedValueOnce(new Error('Failure')).mockResolvedValueOnce(request);
  controller.sendLine('/context');
  await vi.waitFor(() => expect(controller.snapshot().command?.title).toBe('The context preview could not load.'));
  expect(controller.snapshot().command?.lines).toContain('Run /context again to retry. No request was sent.');
  controller.sendLine('/context');
  await vi.waitFor(() => expect(controller.snapshot().command?.requestContext).toEqual(request));
  expect(controller.turnCount()).toBe(0);
});
