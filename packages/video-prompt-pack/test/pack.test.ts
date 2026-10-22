/**
 * The prompt pack exports (video-prompt-pack.md §3, §5): the JSON pack, the Markdown pack and the CSV shot
 * list, rendered from one run, with the fail-closed rule and the best-take re-export.
 */
import { describe, expect, it } from 'vitest';

import {
  preparePack,
  renderPromptPack,
  templateById,
  type PackRun,
  type ShotNode,
  type StoryboardSnapshot,
  type VideoShotRef,
} from '../src/index.js';

import { SHOTS, refFor, storyboard, withRef } from './fixtures.js';

const REF1 = refFor('runway-gen4', {
  prompt: { camera: 'Slow dolly-in', subject: 'Elena', action: 'walks down the quay', context: 'Harbour at dusk', style: 'Film grain' },
  durationSec: 5,
  aspectRatio: '16:9',
});
const REF2 = refFor('runway-gen4', {
  prompt: { subject: 'The ferryman', action: 'points at the harbour', style: 'Grey light' },
  durationSec: 5,
  aspectRatio: '9:16',
  notes: 'hold on the ferryman',
});

/** A storyboard where s1 and s2 both carry a Runway record, ready to export. */
function ready(ref1: VideoShotRef = REF1, ref2: VideoShotRef = REF2): StoryboardSnapshot {
  return storyboard({ shots: [withRef(SHOTS[0] as ShotNode, ref1), withRef(SHOTS[1] as ShotNode, ref2), ...SHOTS.slice(2)] });
}

function text(run: ReturnType<typeof preparePack>, artifact: 'json' | 'markdown' | 'csv'): string {
  const outcome = renderPromptPack(run, artifact);
  if (!outcome.ok) throw new Error(`export refused: ${outcome.issues.map((issue) => issue.message).join('; ')}`);
  return outcome.text;
}

describe('preparePack collects the shots in storyboard order, with their rows', () => {
  it('lists the shots that have a record for the template, and raises no error for a clean set', () => {
    const run = preparePack(ready(), 'runway-gen4');
    expect(run.shots.map((shot) => shot.shotNumber)).toEqual([1, 2]);
    expect(run.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('leaves out a shot with no record when the export is the whole storyboard, and says so as a warning', () => {
    const run = preparePack(ready(), 'runway-gen4');
    expect(run.shots.map((shot) => shot.shotId)).toEqual(['s1', 's2']);
    const left = run.issues.filter((issue) => issue.code === 'empty-prompt');
    expect(left.map((issue) => issue.shotId)).toEqual(['s3', 's4']);
    expect(left.every((issue) => issue.severity === 'warning')).toBe(true);
    expect(renderPromptPack(run, 'json').ok).toBe(true);
  });

  it('refuses the render when the writer named a shot that has no record', () => {
    const run = preparePack(ready(), 'runway-gen4', ['s1', 's3']);
    expect(run.issues.find((issue) => issue.code === 'empty-prompt' && issue.shotId === 's3')).toMatchObject({ severity: 'error' });
    const outcome = renderPromptPack(run, 'json');
    expect(outcome.ok).toBe(false);
    expect('text' in outcome).toBe(false);
  });

  it('refuses an unknown shot id rather than skipping it', () => {
    expect(() => preparePack(ready(), 'runway-gen4', ['nope'])).toThrow(/No storyboard shot has the id nope/);
  });

  it('refuses every render when one shot is over its cap, so nothing reaches a file', () => {
    const over = refFor('runway-gen4', { prompt: { subject: 'x'.repeat(600) }, durationSec: 5 });
    const outcome = renderPromptPack(preparePack(ready(over, REF2), 'runway-gen4'), 'csv');
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.code === 'over-cap' && issue.severity === 'error')).toBe(true);
  });
});

describe('the JSON pack is the canonical artifact', () => {
  it('names the vendor and the template, and lists each shot with its normalized fields and its mapped payload', () => {
    const run = preparePack(ready(), 'runway-gen4');
    const document = JSON.parse(text(run, 'json')) as Record<string, unknown>;
    expect(document).toMatchObject({ vendor: 'Runway Gen-4', templateId: 'runway-gen4' });
    const shots = document.shots as Array<Record<string, unknown>>;
    expect(shots[0]).toMatchObject({
      shotNumber: 1,
      shotId: 's1',
      mode: 't2v',
      durationSec: 5,
      aspectRatio: '16:9',
      promptExtend: false,
      mapped: { promptText: 'Slow dolly-in: Elena walks down the quay. Harbour at dusk. Film grain.', duration: 5, ratio: '16:9' },
    });
  });

  it('records the references as file names with where each came from', () => {
    const run = preparePack(ready(), 'runway-gen4');
    const document = JSON.parse(text(run, 'json')) as { shots: Array<{ references: Array<Record<string, unknown>> }> };
    expect(document.shots[0]?.references).toEqual([
      expect.objectContaining({ type: 'character', source: 'codex', file: 'a_elena.png', label: 'Elena' }),
      expect.objectContaining({ type: 'image', source: 'codex', file: 'a_ferry.png', label: 'Ferry' }),
    ]);
  });

  it('lists the files to attach by hand for a vendor whose references are uploaded', () => {
    const run = preparePack(ready(), 'runway-gen4');
    const document = JSON.parse(text(run, 'json')) as { attach?: Array<Record<string, unknown>> };
    expect(document.attach).toEqual([
      { shotNumber: 1, file: 'a_elena.png', type: 'character', for: 'Elena' },
      { shotNumber: 1, file: 'a_ferry.png', type: 'image', for: 'Ferry' },
      { shotNumber: 2, file: 'a_harbor.jpg', type: 'image', for: 'Harbour' },
    ]);
  });

  it('carries no attach list for a vendor that takes names only', () => {
    const wanRef = refFor('wan-2.6', { prompt: { subject: 'Elena' }, durationSec: 5 });
    const board = storyboard({ shots: [withRef(SHOTS[0] as ShotNode, wanRef), ...SHOTS.slice(1)] });
    const document = JSON.parse(text(preparePack(board, 'wan-2.6'), 'json')) as Record<string, unknown>;
    expect('attach' in document).toBe(false);
  });

  it('is the same bytes on every render of the same run', () => {
    const run = preparePack(ready(), 'runway-gen4');
    expect(text(run, 'json')).toBe(text(run, 'json'));
    expect(text(run, 'json').endsWith('\n')).toBe(true);
  });

  it('forces prompt_extend to false for Wan, and maps Sora’s frame size from the aspect and the resolution', () => {
    const wan = refFor('wan-2.6', { prompt: { subject: 'Elena' }, durationSec: 5, aspectRatio: '16:9', resolution: '720p' });
    const sora = refFor('sora-2', { prompt: { subject: 'Elena' }, durationSec: 8, aspectRatio: '9:16', resolution: '1080p' });
    const wanDoc = JSON.parse(text(preparePack(storyboard({ shots: [withRef(SHOTS[0] as ShotNode, wan), ...SHOTS.slice(1)] }), 'wan-2.6'), 'json')) as {
      shots: Array<{ mapped: Record<string, unknown> }>;
    };
    expect(wanDoc.shots[0]?.mapped.prompt_extend).toBe(false);
    const soraDoc = JSON.parse(text(preparePack(storyboard({ shots: [withRef(SHOTS[0] as ShotNode, sora), ...SHOTS.slice(1)] }), 'sora-2'), 'json')) as {
      shots: Array<{ mapped: Record<string, unknown> }>;
    };
    expect(soraDoc.shots[0]?.mapped.size).toBe('1080x1920');
  });
});

describe('the best take is re-exported in the vendor’s own field block (§3)', () => {
  it('merges the take’s vendor parameters into the payload, and records the take as it was kept', () => {
    const take = refFor('runway-gen4', {
      prompt: REF1.prompt,
      durationSec: 5,
      aspectRatio: '16:9',
      bestTake: { seed: 99, model: 'gen4-turbo', vendorParams: { cfg_scale: 0.5, sampler: 'euler' }, note: 'the one with the fog' },
    });
    const run = preparePack(ready(take, REF2), 'runway-gen4');
    const shot = run.shots[0];
    expect(shot?.mapped).toMatchObject({ cfg_scale: 0.5, sampler: 'euler', seed: 99, model: 'gen4-turbo' });
    const document = JSON.parse(text(run, 'json')) as { shots: Array<{ bestTake?: Record<string, unknown> }> };
    expect(document.shots[0]?.bestTake).toEqual({ seed: 99, model: 'gen4-turbo', vendorParams: { cfg_scale: 0.5, sampler: 'euler' }, note: 'the one with the fog' });
  });

  it('never overwrites a field the payload already sets, and reports the clash as a warning', () => {
    const take = refFor('runway-gen4', {
      prompt: REF1.prompt,
      durationSec: 5,
      bestTake: { seed: 1, model: 'gen4', vendorParams: { promptText: 'a different prompt' } },
    });
    const run = preparePack(ready(take, REF2), 'runway-gen4');
    expect(run.shots[0]?.mapped.promptText).toBe('Slow dolly-in: Elena walks down the quay. Harbour at dusk. Film grain.');
    expect(run.issues).toContainEqual(expect.objectContaining({ code: 'best-take-collision', severity: 'warning', shotId: 's1' }));
    expect(renderPromptPack(run, 'json').ok).toBe(true);
  });

  it('fills an unset seed from the take, so a re-run reproduces it', () => {
    const take = refFor('runway-gen4', { prompt: REF1.prompt, durationSec: 5, bestTake: { seed: 1234, model: 'gen4', vendorParams: {} } });
    expect(preparePack(ready(take, REF2), 'runway-gen4').shots[0]?.mapped.seed).toBe(1234);
  });
});

describe('a best take whose seed is out of range refuses the export, so the seed never reaches a payload', () => {
  it('names the field in an error row, and renders nothing', () => {
    const take = refFor('runway-gen4', { prompt: REF1.prompt, durationSec: 5, aspectRatio: '16:9', bestTake: { seed: 0, model: 'gen4', vendorParams: {} } });
    const outcome = renderPromptPack(preparePack(ready(take, REF2), 'runway-gen4'), 'json');
    expect(outcome.ok).toBe(false);
    expect(outcome.issues).toContainEqual(expect.objectContaining({ code: 'out-of-range', field: 'bestTake.seed', severity: 'error', shotId: 's1' }));
  });
});

describe('the Markdown pack is the reviewable artifact', () => {
  it('gives each shot a card with its spec, its prompt in a quotation, its files and its grammar in comments', () => {
    const markdown = text(preparePack(ready(), 'runway-gen4'), 'markdown');
    expect(markdown.startsWith('# Prompt pack: Runway Gen-4\n')).toBe(true);
    expect(markdown).toContain('## Shot 1');
    expect(markdown).toContain('| Duration | 5 s |');
    expect(markdown).toContain('> Slow dolly-in: Elena walks down the quay. Harbour at dusk. Film grain.');
    expect(markdown).toContain('- `a_elena.png`: character for Elena');
    expect(markdown).toContain('Grammar: Runway Gen-4: [camera movement]: [establishing scene]. [additional details].');
  });

  it('keeps the writer’s note as a comment, out of the prompt', () => {
    const markdown = text(preparePack(ready(), 'runway-gen4'), 'markdown');
    expect(markdown).toContain('<!-- Notes: hold on the ferryman -->');
    expect(markdown).not.toContain('> hold on the ferryman');
  });

  it('closes no comment early, whether the note ends it with --> or with --!>', () => {
    for (const [note, safe] of [
      ['a --> b', 'a --&gt; b'],
      ['a --!> b', 'a --!&gt; b'],
    ] as const) {
      const markdown = text(preparePack(ready(REF1, { ...REF2, notes: note }), 'runway-gen4'), 'markdown');
      expect(markdown).toContain(`<!-- Notes: ${safe} -->`);
    }
  });

  it('escapes a backslash in a table cell before the pipe, so the pipe stays inside the cell', () => {
    const markdown = text(preparePack(ready({ ...REF1, audio: { sfx: 'a\\|b' } }), 'runway-gen4'), 'markdown');
    expect(markdown).toContain('- sfx: a\\\\\\|b');
  });
});

describe('the CSV shot list follows RFC 4180', () => {
  it('writes the spec’s header, one row per shot, CRLF line ends, and the file names joined by semicolons', () => {
    const csv = text(preparePack(ready(), 'runway-gen4'), 'csv');
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('shotNumber,vendor,mode,duration,aspect,prompt,negativePrompt,refs');
    expect(lines[1]).toBe('1,runway-gen4,t2v,5,16:9,Slow dolly-in: Elena walks down the quay. Harbour at dusk. Film grain.,,a_elena.png; a_ferry.png');
    expect(lines[2]).toBe('2,runway-gen4,t2v,5,9:16,The ferryman points at the harbour. Grey light.,,a_harbor.jpg');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('quotes a field with a comma or a quotation mark and doubles its quotation marks', () => {
    const tricky = refFor('runway-gen4', { prompt: { subject: 'Elena', context: 'Harbour, at "dusk"' }, durationSec: 5, aspectRatio: '16:9' });
    const csv = text(preparePack(ready(tricky, REF2), 'runway-gen4'), 'csv');
    // The composed prompt is `Elena. Harbour, at "dusk".`: quoted because of the comma, with its quotes doubled.
    const quotedPrompt = '"Elena. Harbour, at ""dusk"".' + '"';
    expect(csv.split('\r\n')[1]).toBe(`1,runway-gen4,t2v,5,16:9,${quotedPrompt},,a_elena.png; a_ferry.png`);
  });

  it('names the file the artifact is written under, from the template', () => {
    const run = preparePack(ready(), 'runway-gen4');
    expect(renderPromptPack(run, 'csv')).toMatchObject({ ok: true, fileName: 'runway-gen4-shot-list.csv' });
    expect(renderPromptPack(run, 'markdown')).toMatchObject({ ok: true, fileName: 'runway-gen4-prompt-pack.md' });
    expect(renderPromptPack(run, 'json')).toMatchObject({ ok: true, fileName: 'runway-gen4-prompt-pack.json' });
  });

  it('writes a field a spreadsheet would run as a formula as text, with a leading single quote', () => {
    for (const subject of ['=1+1', '+SUM(A1)', '-2+3', '@cmd']) {
      const tricky = refFor('runway-gen4', { prompt: { subject }, durationSec: 5, aspectRatio: '16:9' });
      const line = text(preparePack(ready(tricky, REF2), 'runway-gen4'), 'csv').split('\r\n')[1] ?? '';
      expect(line.split(',')[5]).toBe(`'${subject}.`);
    }
  });

  it('applies the quote before RFC 4180 quoting, so a guarded field with a comma is still quoted', () => {
    const tricky = refFor('runway-gen4', { prompt: { subject: '=1', context: 'at dusk, dry' }, durationSec: 5, aspectRatio: '16:9' });
    const csv = text(preparePack(ready(tricky, REF2), 'runway-gen4'), 'csv');
    expect(csv.split('\r\n')[1]).toBe(`1,runway-gen4,t2v,5,16:9,"'=1. at dusk, dry.",,a_elena.png; a_ferry.png`);
  });

  it('leaves an ordinary field exactly as it was written, with no quote added', () => {
    const csv = text(preparePack(ready(), 'runway-gen4'), 'csv');
    expect(csv.split('\r\n')[1]?.split(',')[5]).toBe('Slow dolly-in: Elena walks down the quay. Harbour at dusk. Film grain.');
  });
});

describe('a provisional template says so in every export (video-prompt-pack.md §9, A3)', () => {
  it('raises one warning row, and the export still renders', () => {
    const outcome = renderPromptPack(preparePack(ready(), 'runway-gen4'), 'json');
    expect(outcome.ok).toBe(true);
    expect(outcome.issues).toContainEqual(expect.objectContaining({ code: 'provisional-template', severity: 'warning', vendor: 'runway-gen4' }));
  });

  it('states the template’s note in the JSON pack and in the Markdown pack', () => {
    const note = templateById('runway-gen4')?.provisional ?? '';
    const run = preparePack(ready(), 'runway-gen4');
    expect((JSON.parse(text(run, 'json')) as { provisional?: string }).provisional).toBe(note);
    expect(text(run, 'markdown')).toContain(`> **Provisional template.** ${note}`);
  });

  it('keeps the row in the CSV export too, where the note has no place', () => {
    const run = preparePack(ready(), 'runway-gen4');
    expect(renderPromptPack(run, 'csv').issues).toContainEqual(expect.objectContaining({ code: 'provisional-template' }));
    expect(text(run, 'csv')).not.toContain('Provisional');
  });

  it('raises no row and states no note for a template that is not provisional', () => {
    const run = preparePack(ready(), 'runway-gen4');
    const settled: PackRun = { ...run, template: { ...run.template, provisional: undefined } };
    expect(renderPromptPack(settled, 'json').issues.some((issue) => issue.code === 'provisional-template')).toBe(false);
    expect('provisional' in (JSON.parse(text(settled, 'json')) as Record<string, unknown>)).toBe(false);
    expect(text(settled, 'markdown')).not.toContain('Provisional template');
  });
});
