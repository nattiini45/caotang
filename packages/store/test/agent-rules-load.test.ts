/**
 * `agent.rules` on load and save — agent-harness §4 (Rules), project-format §2.
 *
 * The convention is the one `filters[]` sets: a rule that cannot be read is dropped with a warning that names it, and the project
 * still opens. A project file carries only deny and ask rules, so an `allow` is dropped too, and a rule that names a node the
 * tree no longer holds is kept and flagged. The key is additive in v1, so no format version moves and a project with no rules
 * writes no key.
 */

import { describe, expect, it } from 'vitest';
import {
  MANIFEST_FILE,
  MemoryArtifactFs,
  addDocument,
  createEmptyManifest,
  createProjectState,
  readProject,
  validateManifest,
  writeProject,
  type Manifest,
  type PermissionRule,
} from '../src/index.js';

const T = new Date('2026-10-22T08:00:00.000Z');

const LOCK: PermissionRule = { effect: 'deny', tool: '*', scope: { subtree: 'manuscript' }, access: 'write', note: 'Locked for my editor' };
const ASK: PermissionRule = { effect: 'ask', tool: 'meta.set' };

function base(): Manifest {
  return createEmptyManifest('The Lighthouse Keeper', T);
}

describe('agent.rules on load', () => {
  it('keeps well-formed rules as they are, with no warning', () => {
    const m = base();
    m.agent = { rules: structuredClone([LOCK, ASK]) };
    const r = validateManifest(m, { docFiles: [] });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(r.manifest?.agent?.rules).toEqual([LOCK, ASK]);
  });

  it('drops a malformed rule with a warning that names it, keeps the rest, and opens the project', () => {
    const m = base();
    (m as unknown as Record<string, unknown>)['agent'] = { rules: [LOCK, { effect: 'deny' }, 'nonsense', { effect: 'ask', tool: 'x', access: 'sideways' }, ASK] };
    const r = validateManifest(m, { docFiles: [] });
    expect(r.ok).toBe(true);
    expect(r.manifest?.agent?.rules).toEqual([LOCK, ASK]);
    expect(r.warnings.map((w) => w.path)).toEqual(['agent.rules[1]', 'agent.rules[2]', 'agent.rules[3]']);
  });

  it('drops an allow rule with a warning, since a project file may not grant the agent power', () => {
    const m = base();
    (m as unknown as Record<string, unknown>)['agent'] = { rules: [{ effect: 'allow', tool: 'scene.draft' }, LOCK] };
    const r = validateManifest(m, { docFiles: [] });
    expect(r.ok).toBe(true);
    expect(r.manifest?.agent?.rules).toEqual([LOCK]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]?.path).toBe('agent.rules[0]');
    expect(r.warnings[0]?.message).toContain('allow');
  });

  it('keeps a rule for a node that is gone, flagged as inert, and never blocks the load', () => {
    const m = base();
    m.agent = { rules: [{ effect: 'deny', tool: '*', scope: { subtree: 'n_GONE000001' } }] };
    const r = validateManifest(m, { docFiles: [] });
    expect(r.ok).toBe(true);
    expect(r.manifest?.agent?.rules).toHaveLength(1);
    expect(r.warnings.map((w) => w.path)).toEqual(['agent.rules[0].scope']);
    expect(r.warnings[0]?.message).toContain('no effect');
  });

  it('drops an agent or rules value of the wrong shape, with a warning', () => {
    const wrongAgent = base();
    (wrongAgent as unknown as Record<string, unknown>)['agent'] = [];
    const a = validateManifest(wrongAgent, { docFiles: [] });
    expect(a.ok).toBe(true);
    expect(a.warnings.map((w) => w.path)).toContain('agent');
    expect(a.manifest).not.toHaveProperty('agent');

    const wrongRules = base();
    (wrongRules as unknown as Record<string, unknown>)['agent'] = { rules: {} };
    const b = validateManifest(wrongRules, { docFiles: [] });
    expect(b.ok).toBe(true);
    expect(b.warnings.map((w) => w.path)).toContain('agent.rules');
    expect(b.manifest?.agent?.rules).toEqual([]);
  });
});

describe('agent.rules on save', () => {
  it('round-trips through save and load, with no format version bump and the key order the spec gives', async () => {
    const fs = new MemoryArtifactFs();
    const state = createProjectState(base());
    addDocument(state, { parentId: 'manuscript', title: 'Act 1', body: 'x', now: T, id: 'n_ACT0000001' });
    state.manifest.agent = { rules: [{ effect: 'deny', tool: '*', scope: { subtree: 'n_ACT0000001' }, access: 'read', note: 'Private' }, { effect: 'deny', tool: 'scene.*', scope: { path: 'Manuscript/Act 1/**' } }, ASK] };
    await writeProject(fs, state, { now: T });

    const written = await fs.read(MANIFEST_FILE);
    const parsed = JSON.parse(written) as { formatVersion: number; agent: { rules: Record<string, unknown>[] } };
    expect(parsed.formatVersion).toBe(createEmptyManifest('x', T).formatVersion);
    expect(Object.keys(parsed.agent.rules[0] as object)).toEqual(['effect', 'tool', 'scope', 'access', 'note']);

    const loaded = await readProject(fs);
    expect(loaded.state.manifest.agent?.rules).toEqual(state.manifest.agent?.rules);
    expect(loaded.notices.filter((n) => n.path.startsWith('agent'))).toEqual([]);
  });

  it('writes no agent key for a project with no rules, and a hand-edited file with none reads as none', async () => {
    const fs = new MemoryArtifactFs();
    const state = createProjectState(base());
    state.manifest.agent = { rules: [] };
    await writeProject(fs, state, { now: T });
    expect(await fs.read(MANIFEST_FILE)).not.toContain('"agent"');
    const loaded = await readProject(fs);
    expect(loaded.state.manifest.agent).toBeUndefined();
  });

  it('does not report the key as unknown on load', async () => {
    const fs = new MemoryArtifactFs();
    const state = createProjectState(base());
    state.manifest.agent = { rules: [ASK] };
    await writeProject(fs, state, { now: T });
    const loaded = await readProject(fs);
    expect(JSON.stringify(loaded.notices)).not.toContain('unknown');
  });
});
