
import { describe, expect, it } from 'vitest';

import { projectContextInput, type ProjectedContextInput } from '@caotang/context';

import { assembleProjected, createContextPort, type ContextRequest } from '../../src/index.js';
import { FRIEND, LANDING, STORM, makeState } from '../fixtures.js';

const ROLE = 'ROLE: the drafting system text.';

function workerPort(options: Parameters<typeof createContextPort>[0]) {
  const seen: ProjectedContextInput[] = [];
  const port = createContextPort({
    ...options,
    computeAsync: async (input, role, languages) => {
      seen.push(input);
      return assembleProjected(structuredClone(input), role, languages);
    },
  });
  return { port, seen };
}

const requests: { name: string; request: ContextRequest }[] = [
  { name: 'meta', request: { task: { tool: 'meta', instruction: 'Request: hello' }, role: ROLE } },
  { name: 'scene.draft continue', request: { task: { tool: 'scene.draft', instruction: 'Brief: the lamp fails.', focus: STORM, mode: 'continue' }, role: ROLE } },
  { name: 'scene.draft draft', request: { task: { tool: 'scene.draft', instruction: 'Brief: begin.', focus: FRIEND, mode: 'draft' }, role: ROLE } },
  { name: 'synopsis.fill', request: { task: { tool: 'synopsis.fill', instruction: 'Brief: summarise.', focus: LANDING }, role: ROLE } },
  { name: 'continuity.scan', request: { task: { tool: 'continuity.scan', instruction: 'Scan.', scope: [LANDING, STORM] }, role: ROLE } },
  {
    name: 'with history and languages',
    request: {
      task: { tool: 'scene.draft', instruction: 'Brief: the lamp fails.', focus: STORM, mode: 'continue' },
      role: ROLE,
      turns: [
        { turnId: 't-1', intent: 'Reorder the first act.', restoredAt: 1_700_000_000_000 },
        { turnId: 't-2', intent: 'Tighten the storm.' },
      ],
      languages: { ui: 'de', project: 'fr' },
    },
  },
  {
    name: 'with pins and exclusions',
    request: {
      task: { tool: 'scene.draft', instruction: 'Brief: Elena.', focus: STORM, mode: 'continue', overrides: { include: [{ kind: 'doc', id: LANDING }], exclude: [{ kind: 'doc', id: FRIEND }] } },
      role: ROLE,
    },
  },
];

describe('the worker seam assembles byte-identically to the synchronous port', () => {
  for (const { name, request } of requests) {
    it(`${name}: messages, prompt and preview match`, async () => {
      const { port } = workerPort({ state: makeState() });
      const sync = port.assemble(request);
      const async = await port.assembleAsync?.(request);
      expect(async).toEqual(sync);
    });
  }

  it('a withheld set and a local restore-time formatter match', async () => {
    const state = makeState();
    const { port } = workerPort({
      state,
      withheld: () => new Set([LANDING]),
      config: { formatTime: (ms) => `local-${new Date(ms).toISOString().slice(11, 16)}` },
    });
    const request: ContextRequest = {
      task: { tool: 'scene.draft', instruction: 'Brief: the lamp fails.', focus: STORM, mode: 'continue' },
      role: ROLE,
      turns: [{ turnId: 't-1', intent: 'Earlier.', restoredAt: 1_700_000_000_000 }],
    };
    expect(await port.assembleAsync?.(request)).toEqual(port.assemble(request));
  });

  it('the executor receives a clone-safe projection, not the live state', async () => {
    const state = makeState();
    const { port, seen } = workerPort({ state });
    await port.assembleAsync?.({ task: { tool: 'scene.draft', instruction: 'Brief.', focus: STORM, mode: 'continue' }, role: ROLE });
    const input = seen[0];
    expect(input).toBeDefined();
    expect(input?.app.state).not.toBe(state);
    expect(() => structuredClone(input)).not.toThrow();
  });
});

describe('the async method is additive and optional', () => {
  it('an already-aborted call rejects before reading the project or invoking compute', async () => {
    let read = false;
    let computed = false;
    const port = createContextPort({
      state: () => { read = true; throw new Error('The project was read.'); },
      computeAsync: async () => { computed = true; throw new Error('Compute was called.'); },
    });
    await expect(port.assembleAsync?.({ task: { tool: 'meta', instruction: 'Hello.' }, role: ROLE }, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).toBe(false);
    expect(computed).toBe(false);
  });

  it('a projection failure rejects the promise rather than throwing synchronously', async () => {
    const { port } = workerPort({ state: () => { throw new Error('Project unavailable.'); } });
    await expect(port.assembleAsync?.({ task: { tool: 'meta', instruction: 'Hello.' }, role: ROLE })).rejects.toThrow('Project unavailable.');
  });

  it('a port without a compute executor has no assembleAsync', () => {
    const port = createContextPort({ state: makeState() });
    expect(port.assembleAsync).toBeUndefined();
  });

  it('a port with a compute executor offers assembleAsync and keeps assemble', async () => {
    const { port } = workerPort({ state: makeState() });
    expect(typeof port.assembleAsync).toBe('function');
    const request: ContextRequest = { task: { tool: 'meta', instruction: 'Request: hello' }, role: ROLE };
    expect(port.assemble(request)).toEqual(await port.assembleAsync?.(request));
  });

  it('a rejecting executor rejects the async call; it never falls back to synchronous work', async () => {
    const port = createContextPort({
      state: makeState(),
      computeAsync: async () => {
        throw new Error('worker unavailable');
      },
    });
    await expect(port.assembleAsync?.({ task: { tool: 'meta', instruction: 'Request: hello' }, role: ROLE })).rejects.toThrow('worker unavailable');
  });

  it('the projection reads the live state at each call', async () => {
    let current = makeState();
    const { port } = workerPort({ state: () => current });
    const request: ContextRequest = { task: { tool: 'meta', instruction: 'Request: hello' }, role: ROLE };
    const before = await port.assembleAsync?.(request);
    current = makeState();
    current.manifest.project.name = 'A renamed project';
    const after = await port.assembleAsync?.(request);
    expect(before?.messages[1]?.content).not.toContain('A renamed project');
    expect(after?.messages[1]?.content).toContain('A renamed project');
  });
});

describe('assembleProjected is the worker-side computation', () => {
  it('runs the same assembly over a projected input with the restore-time lookup rebuilt', () => {
    const state = makeState();
    const request: ContextRequest = {
      task: { tool: 'scene.draft', instruction: 'Brief: the lamp fails.', focus: STORM, mode: 'continue' },
      role: ROLE,
      turns: [{ turnId: 't-1', intent: 'Earlier.', restoredAt: 1_700_000_000_000 }],
      languages: { ui: 'de', project: 'fr' },
    };
    const app = { state, turns: request.turns };
    const config = { formatTime: (ms: number) => `at-${new Date(ms).toISOString().slice(11, 16)}` };
    const projected = projectContextInput(request.task, app, config);
    const call = assembleProjected(structuredClone(projected), request.role, request.languages);
    const sync = createContextPort({ state, config }).assemble(request);
    expect(call).toEqual(sync);
  });
});
