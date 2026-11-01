import { expect, test } from '@playwright/test';
import { withoutIsolates } from '../support.js';

import { consistencyLinesOf, packPreviewOf } from '../../apps/desktop/src/media/prompt-pack-model.js';
import {
  clearPromptCommand,
  fieldIdOf,
  fieldKeyOf,
  hasUnsavedText,
  promptDraftOf,
  promptEditCommand,
  recordOf,
  recordOfDraft,
  storedKeyOf,
  syncVendorDraft,
  vendorDraftOf,
  type PromptDraft,
  type VendorDraftState,
} from '../../apps/desktop/src/media/prompt-edit-model.js';
import type { AssetRecord, VideoShotRef } from '../../apps/desktop/src/media/engines.js';
import { addShotNode, addStoryboardFolder } from '../../packages/storyboard/src/index.js';
import { createEmptyManifest, createProjectState, nodeById, type ProjectState } from '../../packages/store/src/index.js';

const NOW = new Date('2026-10-09T09:00:00Z');
const FOLDER = 'n_SBFOLDER01';
const SHOT = 'n_SHOTA00001';
const ELENA = 'c_ELENA00001';
const PORTRAIT = 'a_ABCDEF2345';
const RUNWAY = 'runway-gen4';
const KLING = 'kling-2.6';

/** A complete draft for Runway, as the editor holds one after the writer has filled it in. */
function runwayDraft(overrides: Partial<PromptDraft> = {}): PromptDraft {
  return {
    ...promptDraftOf(undefined),
    mode: 't2v',
    camera: 'Slow dolly-in',
    subject: 'Elena',
    action: 'walks down the quay',
    durationSec: '5',
    aspectRatio: '16:9',
    ...overrides,
  };
}

function storyboard(): ProjectState {
  const state = createProjectState(createEmptyManifest('Film', NOW, { locale: 'en-US' }));
  addStoryboardFolder(state, { parentId: 'manuscript', title: 'Scene 1 — Shots', id: FOLDER, now: NOW });
  addShotNode(state, {
    parentId: FOLDER,
    id: SHOT,
    title: 'Wide',
    stored: { action: 'Elena walks down the quay toward the ferry.', durationSec: 5 },
    now: NOW,
  });
  return state;
}

function vendorRefsOf(state: ProjectState): VideoShotRef[] {
  return (nodeById(state, SHOT)?.shot?.vendorRefs ?? []) as VideoShotRef[];
}

test.describe('the editor’s text and the record it writes', () => {
  test('a shot with no record opens on the defaults: text to video, nothing set, no reference, no take', () => {
    const draft = promptDraftOf(undefined);
    expect(draft).toMatchObject({ mode: 't2v', camera: '', durationSec: '', references: [], keepTake: false, promptExtend: false });
  });

  test('a complete draft becomes the record the engine reads, under the vendor it is for', () => {
    const parsed = recordOfDraft(RUNWAY, runwayDraft({ seed: '42', negativePrompt: 'no rain' }));
    if (!parsed.ok) throw new Error(parsed.refusal.message);
    expect(parsed.value).toMatchObject({
      vendor: RUNWAY,
      mode: 't2v',
      prompt: { camera: 'Slow dolly-in', subject: 'Elena', action: 'walks down the quay' },
      durationSec: 5,
      aspectRatio: '16:9',
      seed: 42,
      negativePrompt: 'no rain',
      references: [],
    });
  });

  test('a value that is not a number, or a mode and ratio off the list, is refused with the field it names', () => {
    expect(recordOfDraft(RUNWAY, runwayDraft({ seed: 'forty-two' }))).toMatchObject({ ok: false, refusal: { field: 'seed' } });
    expect(recordOfDraft(RUNWAY, runwayDraft({ mode: 'i2v-ish' }))).toMatchObject({ ok: false, refusal: { field: 'mode' } });
    expect(recordOfDraft(RUNWAY, runwayDraft({ aspectRatio: '2:1' }))).toMatchObject({ ok: false, refusal: { field: 'aspectRatio' } });
    expect(recordOfDraft(RUNWAY, runwayDraft({ durationSec: 'soon' }))).toMatchObject({ ok: false, refusal: { field: 'durationSec' } });
  });

  test('a reference with no target is refused rather than dropped, and a take must carry a seed and key: value settings', () => {
    expect(recordOfDraft(RUNWAY, runwayDraft({ references: [{ type: 'image', target: '' }] }))).toMatchObject({
      ok: false,
      refusal: { field: 'references' },
    });
    expect(recordOfDraft(RUNWAY, runwayDraft({ keepTake: true, takeSeed: '' }))).toMatchObject({ ok: false, refusal: { field: 'bestTake.seed' } });
    expect(recordOfDraft(RUNWAY, runwayDraft({ keepTake: true, takeSeed: '7', takeParams: 'steps forty' }))).toMatchObject({
      ok: false,
      refusal: { field: 'bestTake.seed' },
    });
    const kept = recordOfDraft(RUNWAY, runwayDraft({ keepTake: true, takeSeed: '7', takeModel: 'gen4', takeParams: 'steps: 30\nstyle: film' }));
    if (!kept.ok) throw new Error(kept.refusal.message);
    expect(kept.value.bestTake).toEqual({ seed: 7, model: 'gen4', vendorParams: { steps: 30, style: 'film' } });
  });

  test('reading a record back and writing it again gives the same record', () => {
    const first = recordOfDraft(RUNWAY, runwayDraft({ seed: '9', references: [{ type: 'character', target: `entry:${ELENA}` }] }));
    if (!first.ok) throw new Error(first.refusal.message);
    const again = recordOfDraft(RUNWAY, promptDraftOf(first.value));
    if (!again.ok) throw new Error(again.refusal.message);
    expect(again.value).toEqual(first.value);
  });
});

test.describe('writing a shot’s prompt', () => {
  test('a prompt is written into the shot’s vendor records, and another vendor’s record is kept as it was', () => {
    const state = storyboard();
    const first = promptEditCommand(state, SHOT, KLING, runwayDraft({ durationSec: '5', aspectRatio: '16:9' }));
    if (!first.ok) throw new Error(first.refusal.message);
    applyParams(state, first.value.params);

    const second = promptEditCommand(state, SHOT, RUNWAY, runwayDraft({ camera: 'Static' }));
    if (!second.ok) throw new Error(second.refusal.message);
    applyParams(state, second.value.params);
    expect(vendorRefsOf(state).map((record) => record.vendor)).toEqual([KLING, RUNWAY]);

    const replaced = promptEditCommand(state, SHOT, RUNWAY, runwayDraft({ camera: 'Pan left' }));
    if (!replaced.ok) throw new Error(replaced.refusal.message);
    applyParams(state, replaced.value.params);
    expect(vendorRefsOf(state).map((record) => [record.vendor, record.prompt.camera])).toEqual([
      [KLING, 'Slow dolly-in'],
      [RUNWAY, 'Pan left'],
    ]);
  });

  test('the write is guarded by the value the editor read, so a record changed since then is not overwritten', () => {
    const state = storyboard();
    const planned = promptEditCommand(state, SHOT, RUNWAY, runwayDraft());
    if (!planned.ok) throw new Error(planned.refusal.message);
    expect(planned.value.params).toMatchObject({ nodeId: SHOT, expect: { action: 'Elena walks down the quay toward the ferry.', durationSec: 5 } });
  });

  test('a refused draft writes nothing and says why', () => {
    const refused = promptEditCommand(storyboard(), SHOT, RUNWAY, runwayDraft({ seed: 'x' }));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe('prompt-invalid');
  });

  test('clearing a vendor’s prompt takes out that record only, and the last one leaves no vendor list at all', () => {
    const state = storyboard();
    const both = promptEditCommand(state, SHOT, KLING, runwayDraft());
    if (!both.ok) throw new Error(both.refusal.message);
    applyParams(state, both.value.params);
    const other = promptEditCommand(state, SHOT, RUNWAY, runwayDraft());
    if (!other.ok) throw new Error(other.refusal.message);
    applyParams(state, other.value.params);

    const cleared = clearPromptCommand(state, SHOT, KLING);
    if (!cleared.ok) throw new Error(cleared.refusal.message);
    applyParams(state, cleared.value.params);
    expect(vendorRefsOf(state).map((record) => record.vendor)).toEqual([RUNWAY]);

    const last = clearPromptCommand(state, SHOT, RUNWAY);
    if (!last.ok) throw new Error(last.refusal.message);
    applyParams(state, last.value.params);
    expect(nodeById(state, SHOT)?.shot?.vendorRefs).toBeUndefined();
    expect(recordOf(state, SHOT, RUNWAY)).toBeUndefined();
  });
});

test.describe('the checks link to the field they name', () => {
  test('each field a check names maps to the input the editor gives it, and a field the editor does not show maps to nothing', () => {
    expect(fieldKeyOf('prompt')).toBe('prompt.camera');
    expect(fieldKeyOf('audio')).toBe('audio.dialogue');
    expect(fieldKeyOf('bestTake')).toBe('bestTake.seed');
    expect(fieldKeyOf('template')).toBe('vendor');
    expect(fieldKeyOf('durationSec')).toBe('durationSec');
    expect(fieldKeyOf('unknown.field')).toBeUndefined();
    expect(fieldIdOf('prompt.camera')).toBe('prompt-field-prompt-camera');
  });
});

test.describe('the codex’s visual references reach the pack', () => {
  test('an entry the action names with a visual reference sends it, and the consistency line names the entry and where it was named', () => {
    const state = storyboard();
    state.manifest.codex = [
      {
        id: ELENA,
        name: 'Elena',
        aliases: [],
        type: 'character',
        description: 'A cartographer who maps the harbour.',
        includePolicy: 'detected',
        caseSensitive: false,
        exclude: [],
        attachments: [],
        keywords: [],
        origin: 'manual',
        sources: [],
        visualRefs: [PORTRAIT],
      },
    ];
    const first = promptEditCommand(state, SHOT, RUNWAY, runwayDraft());
    if (!first.ok) throw new Error(first.refusal.message);
    applyParams(state, first.value.params);

    const assets: ReadonlyMap<string, AssetRecord> = new Map([[PORTRAIT, { id: PORTRAIT, fileName: 'elena.png' }]]);
    const preview = packPreviewOf(state, FOLDER, RUNWAY, assets);
    const row = preview?.rows[0];
    expect(row?.consistency?.map(withoutIsolates)).toEqual(['Elena: mentioned in the action, sends 1 reference']);
    expect(row?.references).toEqual(['elena.png']);
  });

  test('a withheld entry names its reason, in the engine’s words', () => {
    expect(
      consistencyLinesOf({
        shotId: SHOT,
        source: 'none',
        supplied: [],
        withheld: [{ entryId: ELENA, name: 'Elena', reason: 'no-visual-reference' }],
      }).map(withoutIsolates),
    ).toEqual(['Elena: not sent, because it has no visual reference image']);
  });
});

test.describe('the text the editor holds for each vendor (Media-1)', () => {
  test('a vendor with no stored prompt starts blank, and typing in it makes its text unsaved', () => {
    const blank = vendorDraftOf(undefined);
    expect(storedKeyOf(undefined)).toBe('null');
    expect(hasUnsavedText(blank)).toBe(false);
    expect(hasUnsavedText({ ...blank, draft: { ...blank.draft, camera: 'Slow dolly-in' } })).toBe(true);
  });

  test('while the stored record is the one the held text came from, the held text stands, whichever vendor is on screen', () => {
    const parsed = recordOfDraft(RUNWAY, runwayDraft());
    if (!parsed.ok) throw new Error(parsed.refusal.message);
    const base = vendorDraftOf(parsed.value);
    const held: VendorDraftState = { ...base, draft: { ...base.draft, camera: 'Pan left' } };
    const synced = syncVendorDraft(held, parsed.value);
    expect(synced.state).toBe(held);
    expect(synced.replaced).toBe(false);
  });

  test('a vendor the editor has not held yet takes its stored record, and nothing is replaced', () => {
    const parsed = recordOfDraft(RUNWAY, runwayDraft());
    if (!parsed.ok) throw new Error(parsed.refusal.message);
    expect(syncVendorDraft(undefined, parsed.value)).toEqual({ state: vendorDraftOf(parsed.value), replaced: false });
  });

  test('a stored record that changed since the text was taken (an undo, or an agent apply) takes its values, and says so only when text was typed', () => {
    const parsed = recordOfDraft(RUNWAY, runwayDraft());
    if (!parsed.ok) throw new Error(parsed.refusal.message);
    const base = vendorDraftOf(parsed.value);

    // The writer had typed, and the record is gone (an undo of its save): the typed text is replaced, and the editor is told.
    const typed: VendorDraftState = { ...base, draft: { ...base.draft, camera: 'Pan left' } };
    const undone = syncVendorDraft(typed, undefined);
    expect(undone.replaced).toBe(true);
    expect(undone.state.draft).toEqual(promptDraftOf(undefined));

    // Nothing was typed: the stored values are shown again, with nothing said, since no text was lost.
    const untouched = syncVendorDraft(base, undefined);
    expect(untouched.replaced).toBe(false);
    expect(untouched.state.draft).toEqual(promptDraftOf(undefined));
  });

  test('the text taken from a stored record has no unsaved text, so a prompt just saved is not shown as unsaved', () => {
    const parsed = recordOfDraft(RUNWAY, runwayDraft({ seed: '9' }));
    if (!parsed.ok) throw new Error(parsed.refusal.message);
    expect(hasUnsavedText(vendorDraftOf(parsed.value))).toBe(false);
  });
});

/** Applies one `shot.setMeta` to the state the way the bus does, so the next edit reads what the previous one wrote. */
function applyParams(state: ProjectState, params: unknown): void {
  const { nodeId, stored, expect: expected } = params as { nodeId: string; stored: Record<string, unknown> | null; expect: unknown };
  const node = nodeById(state, nodeId);
  if (node === undefined) throw new Error(`no node ${nodeId}`);
  if (JSON.stringify(node.shot ?? null) !== JSON.stringify(expected ?? null)) throw new Error('the expectation does not hold');
  if (stored === null) delete node.shot;
  else node.shot = structuredClone(stored);
}
