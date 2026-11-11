import { nodeById } from '@caotang/store';
import { describe, expect, it } from 'vitest';
import { assemble, buildPreview, type AgentTask, type AssembledPrompt, type ContextRef, type LayerId } from '../src/index.js';
import { CH3, FOCUS_ID, IDS, SELECTION_TEXT, buildApp, entry } from './fixtures.js';

const doc = (id: string): ContextRef => ({ kind: 'doc', id });
const codex = (id: string): ContextRef => ({ kind: 'codex', id });
const task: AgentTask = { tool: 'scene.draft', instruction: 'Continue.', focus: FOCUS_ID, mode: 'continue' };
const layer = (prompt: AssembledPrompt, id: LayerId) => prompt.layers.find((item) => item.id === id)!;
const text = (prompt: AssembledPrompt, id: LayerId) => prompt.parts.find((part) => part.layer === id)?.text ?? '';

describe('request-local context choices', () => {
  it('leaves an excluded prior-document synopsis out of both optional structure and story layers', () => {
    const app = buildApp();
    nodeById(app.state, IDS.ch2)!.synopsis = 'PRIVATE EXCLUDED SYNOPSIS';
    const baseline = assemble(task, app);
    expect(text(baseline, 'L3')).toContain('PRIVATE EXCLUDED SYNOPSIS');
    expect(text(baseline, 'L4')).toContain('PRIVATE EXCLUDED SYNOPSIS');
    const prompt = assemble({ ...task, overrides: { exclude: [doc(IDS.ch2)] } }, app);
    for (const id of ['L3', 'L4'] as const) {
      expect(text(prompt, id)).not.toContain('PRIVATE EXCLUDED SYNOPSIS');
      expect(layer(prompt, id).drops).toContainEqual(expect.objectContaining({ ref: doc(IDS.ch2), reason: { kind: 'writer-excluded' } }));
    }
    expect(prompt.messages.map((message) => message.content).join('\n')).not.toContain('PRIVATE EXCLUDED SYNOPSIS');
    expect(text(prompt, 'L5')).toBe(text(baseline, 'L5'));
  });

  it('excludes an always codex entry even when pinned, and removes eligible synopses before fitting', () => {
    const prompt = assemble({ ...task, overrides: { include: [codex('c_Harbor'), doc(IDS.ch1)], exclude: [codex('c_Harbor'), doc(IDS.ch1)] } }, buildApp());
    expect(text(prompt, 'L2')).not.toContain('A fog-bound port town');
    expect(layer(prompt, 'L2').drops).toContainEqual(expect.objectContaining({ ref: codex('c_Harbor'), reason: { kind: 'writer-excluded' } }));
    expect(layer(prompt, 'L4').kept.map((item) => item.ref)).toEqual([doc(IDS.ch2)]);
    expect(layer(prompt, 'L4').drops).toContainEqual(expect.objectContaining({ ref: doc(IDS.ch1), reason: { kind: 'writer-excluded' } }));
    expect(layer(prompt, 'L5').drops).toContainEqual(expect.objectContaining({ ref: doc(IDS.ch1), reason: { kind: 'writer-excluded' } }));
  });

  it('does not turn a document exclusion into a change of tool focus or rewrite selection', () => {
    const from = CH3.indexOf(SELECTION_TEXT);
    const rewrite: AgentTask = { ...task, mode: 'rewrite_selection', selection: { from, to: from + SELECTION_TEXT.length, exact: SELECTION_TEXT } };
    const baseline = assemble(rewrite, buildApp());
    const prompt = assemble({ ...rewrite, overrides: { include: [doc(FOCUS_ID)], exclude: [doc(FOCUS_ID)] } }, buildApp());
    expect(text(prompt, 'L5')).toBe(text(baseline, 'L5'));
    expect(prompt.focus).toEqual(baseline.focus);
    expect(text(prompt, 'L5')).toContain(`Selection to rewrite:\n${SELECTION_TEXT}`);
  });

  it('does not bypass Never, empty descriptions, or mandatory read-deny', () => {
    const app = { ...buildApp(), withheld: new Set([IDS.ch5]) };
    const prompt = assemble({ tool: 'meta', instruction: 'Plan.', overrides: { include: [codex('c_Wolf'), codex('c_Fog_Law'), codex('c_Silver_Gull'), doc(IDS.ch5)] } }, app);
    expect(layer(prompt, 'L2').drops).toContainEqual(expect.objectContaining({ ref: codex('c_Wolf'), reason: { kind: 'never' } }));
    expect(layer(prompt, 'L2').drops).toContainEqual(expect.objectContaining({ ref: codex('c_Fog_Law'), reason: { kind: 'empty-description' } }));
    expect(layer(prompt, 'L1').drops.map((item) => item.ref)).toEqual(expect.arrayContaining([doc(IDS.ch5), codex('c_Silver_Gull')]));
    expect(prompt.messages.map((message) => message.content).join('\n')).not.toContain('PRIVATE:');
    expect(text(prompt, 'L2')).not.toContain('A ferry that is not supposed to exist');
    expect(text(prompt, 'L5')).not.toContain('Aftermath on the quay');
    expect(() => assemble({ ...task, overrides: { include: [doc(FOCUS_ID)] } }, { ...buildApp(), withheld: new Set([FOCUS_ID]) })).toThrow('withheld');
  });

  it('activates planner codex pins as protected entries, with visible layer and total overflow', () => {
    const app = buildApp();
    app.state.manifest.codex = [entry('Pinned', { includePolicy: 'manual', description: 'p'.repeat(6_000) }), entry('Other', { includePolicy: 'detected' })];
    const prompt = assemble({ tool: 'meta', instruction: 'Other', overrides: { include: [codex('c_Pinned')] } }, app, { layerBudgets: { L2: 1 }, contextBudget: 1 });
    expect(text(prompt, 'L2')).toContain('p'.repeat(6_000));
    expect(layer(prompt, 'L2').kept).toEqual([expect.objectContaining({ ref: codex('c_Pinned'), reason: 'pinned by the writer for this request' })]);
    expect(layer(prompt, 'L2').drops.map((drop) => drop.reason.kind)).toEqual(expect.arrayContaining(['reserve-overflow', 'budget']));
    expect(prompt.overBudget).toBe(true);
    expect(buildPreview(prompt).layers.find((item) => item.id === 'L2')?.kept?.[0]?.ref).toEqual(codex('c_Pinned'));
  });

  it('deduplicates document pins, caps them at three and sends bounded labelled excerpts for meta without focus', () => {
    const include = [doc(IDS.ch3), doc(IDS.ch1), doc(IDS.ch2), doc(IDS.ch1), doc(IDS.ch4)];
    const prompt = assemble({ tool: 'meta', instruction: 'Plan.', overrides: { include } }, buildApp());
    expect(layer(prompt, 'L5').included).toBe(true);
    expect(layer(prompt, 'L5').kept.map((item) => item.ref)).toEqual([doc(IDS.ch1), doc(IDS.ch2), doc(IDS.ch3)]);
    expect(layer(prompt, 'L5').drops).toEqual([expect.objectContaining({ ref: doc(IDS.ch4), reason: { kind: 'pin-limit', limit: 3 } })]);
    expect(text(prompt, 'L5')).toContain('Chapter 3 (pinned excerpt)');
    expect(text(prompt, 'L5')).toContain('Synopsis: Elena meets Mara');
    expect(text(prompt, 'L5')).toContain(CH3.slice(0, 1_500));
    expect(text(prompt, 'L5')).not.toContain(CH3.slice(1_500, 1_600));
    expect(prompt.focus).toBeUndefined();
  });

  it('gives excerpts only leftover L5 capacity and drops whole excerpts before changing focus', () => {
    const pinned = { ...task, overrides: { include: [doc(IDS.ch3)] } };
    const config = { layerBudgets: { L3: 0, L4: 0, L5: 900 } };
    const baseline = assemble(task, buildApp(), config);
    const prompt = assemble(pinned, buildApp(), config);
    expect(text(prompt, 'L5')).toBe(text(baseline, 'L5'));
    expect(layer(prompt, 'L5').drops).toContainEqual(expect.objectContaining({ ref: doc(IDS.ch3), reason: expect.objectContaining({ kind: 'budget' }) }));

    const full = assemble(pinned, buildApp());
    const trimmed = assemble(pinned, buildApp(), { contextBudget: full.estimate.promptTokens - 1 });
    expect(layer(full, 'L5').kept.some((item) => item.reason === 'pinned by the writer for this request')).toBe(true);
    expect(layer(trimmed, 'L5').drops).toContainEqual(expect.objectContaining({ ref: doc(IDS.ch3), reason: expect.objectContaining({ kind: 'total-budget' }) }));
    expect(text(trimmed, 'L5')).toBe(text(assemble(task, buildApp()), 'L5'));
    expect(trimmed.focus).toEqual(full.focus);
  });

  it('preserves stable references through kept reports, budget drops and previews with duplicate labels', () => {
    const app = buildApp();
    app.state.manifest.codex = [entry('Same', { id: 'c_a', includePolicy: 'always' }), entry('Same', { id: 'c_b', includePolicy: 'always' })];
    nodeById(app.state, IDS.ch1)!.title = 'Same';
    nodeById(app.state, IDS.ch2)!.title = 'Same';
    const prompt = assemble(task, app);
    const preview = buildPreview(prompt);
    expect(preview.layers.find((item) => item.id === 'L2')?.kept?.map((item) => item.ref)).toEqual([codex('c_a'), codex('c_b')]);
    expect(preview.layers.find((item) => item.id === 'L4')?.kept?.map((item) => item.ref)).toEqual([doc(IDS.ch1), doc(IDS.ch2)]);
    const dropped = buildPreview(assemble(task, app, { layerBudgets: { L3: 0, L4: 0 } })).layers.find((item) => item.id === 'L4');
    expect(dropped?.drops.filter((item) => item.reason.kind === 'budget').map((item) => item.ref)).toEqual([doc(IDS.ch2), doc(IDS.ch1)]);
    app.state.manifest.codex = [entry('Same', { id: 'c_a', aliases: ['Alpha'] }), entry('Same', { id: 'c_b', aliases: ['Bravo'] })];
    const codexDrops = buildPreview(assemble({ ...task, instruction: 'Alpha Bravo' }, app, { layerBudgets: { L2: 0 } })).layers.find((item) => item.id === 'L2');
    expect(codexDrops?.drops.map((item) => item.ref)).toEqual([codex('c_a'), codex('c_b')]);
  });

  it('is independent of override and project insertion order, does not mutate inputs, and leaves no-override bytes unchanged', () => {
    const app = buildApp();
    const original = structuredClone(app);
    const include = [doc(IDS.ch2), codex('c_Silver_Gull'), doc(IDS.ch1), doc(IDS.ch2)];
    const request = { ...task, overrides: { include, exclude: [codex('c_Harbor')] } };
    const copy = structuredClone(request);
    const first = assemble(request, app);
    const second = assemble({ ...request, overrides: { ...request.overrides, include: [...include].reverse() } }, buildApp({ shuffled: true }));
    expect(first).toEqual(second);
    expect(app).toEqual(original);
    expect(request).toEqual(copy);
    expect(assemble({ ...task, overrides: {} }, app).messages).toEqual(assemble(task, app).messages);
  });
});
