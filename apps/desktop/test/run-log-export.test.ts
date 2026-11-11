import { newRunRecord, type RunEvent } from '@caotang/harness';
import { MemoryArtifactFs } from '@caotang/store';
import { describe, expect, it, vi } from 'vitest';

import { exportRunLog, writeRunLogMirror } from '../src/app/run-log-export.js';

const run = newRunRecord('run_01TEST', { projectId: 'project_1', intent: 'Revise the storm.', now: 100, profileId: 'profile_1', model: 'mock' });
const events: readonly RunEvent[] = [
  { t: 'turn.start', seq: 0, at: 100, v: 3, turnId: 'turn_1', intent: run.intent, wire: 'plan', native: false },
  { t: 'messages', seq: 1, at: 101, turnId: 'turn_1', appended: [{ role: 'assistant', content: 'The rain falls.\nA new paragraph.' }] },
  { t: 'step.intent', seq: 2, at: 102, turnId: 'turn_1', callId: 'call_1', index: 0, tool: 'scene.revise', expect: { doc_1: 1 }, structure: 'digest' },
  { t: 'step.applied', seq: 3, at: 103, turnId: 'turn_1', callId: 'call_1', index: 0, tool: 'scene.revise', summary: 'Revised the storm.', after: { doc_1: 2 } },
  { t: 'spend', seq: 4, at: 104, turnId: 'turn_1', spend: { modelCalls: 1, promptTokens: 200, completionTokens: 50, estimatedTokens: 0, costUsd: 0.002, steps: 1, activeMs: 90 }, reservedCalls: 0 },
  { t: 'turn.end', seq: 5, at: 105, turnId: 'turn_1', status: 'applied', summary: 'The storm is revised.' },
];

describe('run log export', () => {
  it('writes exactly one whitelisted metadata row and every event in order', () => {
    const exported = exportRunLog({ ...run, status: 'finished' }, events);
    const rows = exported.jsonl.trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(rows).toEqual([{ t: 'run.metadata', ...run, status: 'finished' }, ...events]);
    expect(exported.jsonl.endsWith('\n')).toBe(true);
    expect(rows[2].appended[0].content).toBe('The rain falls.\nA new paragraph.');
  });

  it('excludes baseline snapshots and provider configuration, even on an extended record', () => {
    const extended = { ...run, baseline: { docs: { doc_1: 'PRIVATE MANUSCRIPT' } }, baselineSnapshot: 'PRIVATE SNAPSHOT', profile: { apiKey: 'PRIVATE KEY' }, headers: { authorization: 'PRIVATE HEADER' }, futureField: 'PRIVATE UNKNOWN' };
    const exported = exportRunLog(extended, events);
    for (const output of Object.values(exported)) {
      expect(output).not.toContain('PRIVATE');
      expect(output).not.toContain('baseline');
      expect(output).not.toContain('apiKey');
      expect(output).not.toContain('authorization');
    }
    expect(JSON.parse(exported.jsonl.split('\n')[0]!).profileId).toBe('profile_1');
  });

  it('redacts secrets in metadata and nested event text and strips credential fields', () => {
    const secret = 'sk-privatecredential123';
    const event: RunEvent = {
      t: 'card.pending', seq: 0, at: 100, turnId: 'turn_1', kind: 'plan',
      steps: [{ tool: 'scene.revise', params: { brief: `Use ${secret}`, headers: { 'x-api-key': 'opaque-key' }, apiKey: 'opaque-secret', providerProfile: { baseUrl: 'PRIVATE PROFILE' } }, expect: 'The storm is revised.' }],
      proposals: [{ text: `Bearer abcdef123456 ${secret}`, baseline: 'PRIVATE BASELINE', token: 'opaque-token', nested: { client_secret: 'opaque-client-secret' } }], revisions: [null], done: [],
    };
    const exported = exportRunLog({ ...run, intent: `Revise ${secret}` }, [event]);
    for (const output of Object.values(exported)) {
      for (const value of [secret, 'abcdef123456', 'opaque-key', 'opaque-secret', 'opaque-token', 'opaque-client-secret', 'PRIVATE', 'headers', 'apiKey', 'providerProfile', 'baseline']) expect(output).not.toContain(value);
      expect(output).toContain('[redacted]');
    }
  });

  it('summarizes intent, outcome, steps and the latest cumulative spend', () => {
    const earlier: RunEvent = { t: 'spend', seq: -1, at: 99, turnId: 'turn_1', spend: { modelCalls: 0, promptTokens: 0, completionTokens: 0, estimatedTokens: 0, steps: 0, activeMs: 0 }, reservedCalls: 1 };
    const { markdown } = exportRunLog(run, [earlier, ...events]);
    for (const text of ['## Intent', run.intent, '## Outcome', 'The storm is revised.', '## Steps', 'Step 1: scene.revise — applied: Revised the storm.', '## Spend', 'Model calls: 1; reserved calls: 0.', 'Prompt tokens: 200', 'completion tokens: 50', 'USD 0.002', '## Events', '"t":"messages"']) expect(markdown).toContain(text);
    expect(markdown).not.toContain('scene.revise — intent');
  });

  it('keeps failure details and represents an unfinished run without inventing spend', () => {
    const failed: RunEvent = { t: 'step.failed', seq: 3, at: 103, turnId: 'turn_1', callId: 'call_1', index: 0, tool: 'scene.revise', error: 'Document changed.' };
    const { markdown } = exportRunLog({ ...run, cannotResume: true, status: 'interrupted' }, [events[2]!, failed]);
    expect(markdown).toContain('interrupted');
    expect(markdown).toContain('This run cannot be resumed.');
    expect(markdown).toContain('scene.revise — failed: Document changed.');
    expect(markdown).toContain('No spend recorded.');
    const empty = exportRunLog(run, []);
    expect(empty.jsonl.trimEnd().split('\n')).toHaveLength(1);
    expect(empty.markdown).toContain('No steps recorded.');
    expect(empty.markdown).toContain('No events recorded.');
  });

  it('keeps all event families and uses a fence that event text cannot close', () => {
    const other: readonly RunEvent[] = [
      { t: 'skills.loading', seq: 0, at: 100, turnId: 'turn_1' },
      { t: 'skills.loaded', seq: 1, at: 101, turnId: 'turn_1', skills: [] },
      { t: 'card.pending', seq: 2, at: 102, turnId: 'turn_1', kind: 'plan', steps: [], proposals: [], revisions: [], done: [] },
      { t: 'card.decided', seq: 3, at: 103, turnId: 'turn_1', decision: 'approved' },
      { t: 'rule.approved', seq: 4, at: 104, turnId: 'turn_1', callId: 'call_1', tool: 'scene.revise', rule: { source: 'app', effect: 'allow', tool: 'scene.revise', note: 'Writer approved this tool.' } },
    ];
    const quoted: RunEvent = { t: 'messages', seq: 5, at: 105, turnId: 'turn_1', appended: [{ role: 'user', content: '```\nKeep this text.' }] };
    const exported = exportRunLog(run, [...other, quoted]);
    expect(exported.jsonl.trimEnd().split('\n').slice(1).map((line) => JSON.parse(line))).toEqual([...other, quoted]);
    expect(exported.markdown).toContain('````jsonl');
    expect(exported.markdown.trimEnd().endsWith('````')).toBe(true);
  });

  it('does not export unknown event fields or change its input objects', () => {
    const extended = { ...events[0]!, baseline: 'PRIVATE BASELINE', headers: { authorization: 'PRIVATE HEADER' }, provider: { config: 'PRIVATE CONFIG' }, unknown: 'PRIVATE UNKNOWN' };
    const before = JSON.stringify({ run, extended });
    const exported = exportRunLog(run, [extended]);
    expect(exported.jsonl).not.toContain('PRIVATE');
    expect(exported.markdown).not.toContain('PRIVATE');
    expect(JSON.stringify({ run, extended })).toBe(before);
  });
});

describe('derived run log mirror', () => {
  it('atomically replaces the mirror with cumulative history without duplicating rows', async () => {
    const fs = new MemoryArtifactFs();
    const write = vi.spyOn(fs, 'writeAtomic');
    await writeRunLogMirror(fs, run, events.slice(0, 2));
    await writeRunLogMirror(fs, run, events);
    await writeRunLogMirror(fs, run, events);
    expect(write).toHaveBeenCalledTimes(3);
    expect(await fs.read(`runs/${run.runId}.jsonl`)).toBe(exportRunLog(run, events).jsonl);
    expect(await fs.listFiles('runs')).toEqual([`${run.runId}.jsonl`]);
  });

  it.each(['', '../escape', '/absolute', 'a/b', 'a\\b', 'C:escape', 'run.id', 'run%2fescape', 'run\nother', 'run ', 'CON', 'lpt1', 'a'.repeat(129)])('refuses unsafe id %j before any filesystem operation', async (runId) => {
    const fs = new MemoryArtifactFs();
    const ensure = vi.spyOn(fs, 'ensureDir');
    const write = vi.spyOn(fs, 'writeAtomic');
    await expect(writeRunLogMirror(fs, { ...run, runId }, events)).rejects.toThrow('not safe');
    expect(ensure).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it.each(['ensureDir', 'writeAtomic'] as const)('leaves the primary and prior mirror untouched on %s failure and permits retry', async (method) => {
    const fs = new MemoryArtifactFs();
    await writeRunLogMirror(fs, run, events.slice(0, 2));
    const previous = await fs.read(`runs/${run.runId}.jsonl`);
    const primary = JSON.stringify({ run, events });
    vi.spyOn(fs, method).mockRejectedValueOnce(new Error('Folder unavailable.'));
    await expect(writeRunLogMirror(fs, run, events)).rejects.toThrow('Folder unavailable.');
    expect(await fs.read(`runs/${run.runId}.jsonl`)).toBe(previous);
    expect(JSON.stringify({ run, events })).toBe(primary);
    await writeRunLogMirror(fs, run, events);
    expect(await fs.read(`runs/${run.runId}.jsonl`)).toBe(exportRunLog(run, events).jsonl);
  });
});
