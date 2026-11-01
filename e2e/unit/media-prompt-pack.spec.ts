import { expect, test } from '@playwright/test';

import {
  PACK_TEMPLATES,
  exportPackOf,
  isVideoShotRef,
  packPreviewOf,
  recordProblemOf,
  storyboardSnapshotOf,
} from '../../apps/desktop/src/media/prompt-pack-model.js';
import { addShotNode, addStoryboardFolder } from '../../packages/storyboard/src/index.js';
import { createEmptyManifest, createProjectState, type CodexEntry, type ProjectState } from '../../packages/store/src/index.js';

const NOW = new Date('2026-10-08T09:00:00Z');
const FOLDER = 'n_SBFOLDER01';
const OTHER = 'n_SBOTHER001';

/** A Runway text-to-video prompt, with the fields the template composes. `action` can be made long on purpose. */
function runway(action = 'She turns toward the door', camera = 'Slow dolly-in'): Record<string, unknown> {
  return {
    vendor: 'runway-gen4',
    mode: 't2v',
    prompt: {
      camera,
      subject: 'A woman at a rain-streaked window',
      action,
      context: 'A dim kitchen at night',
      style: 'Warm lamp light',
    },
    durationSec: 5,
    aspectRatio: '16:9',
    references: [],
  };
}

/** A Veo prompt for the same shot: a second vendor's record, which Runway does not read. */
function veo(): Record<string, unknown> {
  return {
    vendor: 'veo-3.1',
    mode: 't2v',
    prompt: { camera: 'Static shot', subject: 'A kettle on a stove', action: 'It starts to boil' },
    durationSec: 4,
    aspectRatio: '16:9',
    references: [],
  };
}

interface ShotSpec {
  readonly id: string;
  readonly title: string;
  readonly stored?: Record<string, unknown>;
}

/** A project with the storyboard folder, its shots in the order given, and one shot in another folder that is never packed. */
function project(shots: readonly ShotSpec[]): ProjectState {
  const state = createProjectState(createEmptyManifest('Film', NOW, { locale: 'en-US' }));
  addStoryboardFolder(state, { parentId: 'manuscript', title: 'Scene 1 — Shots', id: FOLDER, now: NOW });
  addStoryboardFolder(state, { parentId: 'manuscript', title: 'Scene 2 — Shots', id: OTHER, now: NOW });
  for (const shot of shots) addShotNode(state, { parentId: FOLDER, id: shot.id, title: shot.title, stored: shot.stored ?? {}, now: NOW });
  addShotNode(state, { parentId: OTHER, id: 'n_ELSEWHERE1', title: 'Elsewhere', stored: { vendorRefs: [runway()] }, now: NOW });
  return state;
}

test.describe('what the pack reads', () => {
  test('the snapshot holds the shots of the folder alone, and each shot carries its prompt records', () => {
    const state = project([
      { id: 'n_SHOTA00001', title: 'Wide', stored: { vendorRefs: [runway()] } },
      { id: 'n_SHOTB00001', title: 'Close' },
    ]);
    const snapshot = storyboardSnapshotOf(state, FOLDER);
    expect(snapshot.shots.map((shot) => shot.id)).toEqual(['n_SHOTA00001', 'n_SHOTB00001']);
    expect(snapshot.shots[0]?.vendorRefs?.map((ref) => ref.vendor)).toEqual(['runway-gen4']);
  });

  test('a covered line is carried as the text its anchor captured, labelled with its scene', () => {
    const state = project([
      {
        id: 'n_SHOTA00001',
        title: 'Wide',
        stored: {
          dialogue: [
            {
              kind: 'fountain-element',
              docId: 'n_SCENE00001',
              anchor: { from: 0, to: 9, exact: 'ANNA looks', prefix: '', suffix: '', capturedRevision: 1 },
            },
          ],
        },
      },
    ]);
    state.manifest.tree.push({
      id: 'n_SCENE00001',
      parentId: 'manuscript',
      type: 'document',
      title: 'Kitchen',
      order: 99,
      status: null,
      label: null,
      keywords: [],
      synopsis: '',
      notes: '',
    });
    expect(storyboardSnapshotOf(state, FOLDER).shots[0]?.covered).toEqual([{ label: 'Kitchen', text: 'ANNA looks' }]);
  });

  test('a stored record that is not a prompt record is left out of the pack, not guessed at', () => {
    expect(isVideoShotRef(runway())).toBe(true);
    expect(isVideoShotRef({ ...runway(), mode: 'sideways' })).toBe(false);
    expect(isVideoShotRef({ vendor: 'runway-gen4', mode: 't2v', prompt: {} })).toBe(false);
    expect(isVideoShotRef('runway-gen4')).toBe(false);
  });

  test('the target models are the six templates, in the order the engine gives them', () => {
    expect(PACK_TEMPLATES.map((template) => template.id)).toEqual(['runway-gen4', 'veo-3.1', 'kling-2.6', 'sora-2', 'wan-2.6', 'seedance-2.5']);
  });
});

test.describe('the panel preview', () => {
  test('a shot with no prompt for the chosen model is a warning, and the pack leaves it out', () => {
    const state = project([
      { id: 'n_SHOTA00001', title: 'Wide', stored: { vendorRefs: [runway()] } },
      { id: 'n_SHOTB00001', title: 'Close', stored: { vendorRefs: [veo()] } },
    ]);
    const preview = packPreviewOf(state, FOLDER, 'runway-gen4');
    expect(preview).not.toBeNull();
    if (preview === null) return;
    expect(preview.rows.map((row) => row.shotId)).toEqual(['n_SHOTA00001']);
    expect(preview.missing).toEqual(['n_SHOTB00001']);
    const empty = preview.issues.find((issue) => issue.code === 'empty-prompt');
    expect(empty).toMatchObject({ severity: 'warning', shotId: 'n_SHOTB00001' });
    expect(preview.canExport).toBe(true);
  });

  test('a stored record that is not a prompt record leaves its shot missing, rather than becoming a guessed prompt', () => {
    const state = project([{ id: 'n_SHOTA00001', title: 'Wide', stored: { vendorRefs: [{ ...runway(), mode: 'sideways' }] } }]);
    const preview = packPreviewOf(state, FOLDER, 'runway-gen4');
    expect(preview?.rows).toEqual([]);
    expect(preview?.missing).toEqual(['n_SHOTA00001']);
  });

  test('each row shows the prompt the template composes, and the fields the vendor receives for it', () => {
    const state = project([{ id: 'n_SHOTA00001', title: 'Wide', stored: { vendorRefs: [runway()] } }]);
    const preview = packPreviewOf(state, FOLDER, 'runway-gen4');
    const row = preview?.rows[0];
    expect(row?.number).toBe(1);
    expect(row?.prompt).toContain('A woman at a rain-streaked window');
    expect(row?.mapped.promptText).toBe(row?.prompt);
    expect(row?.mode).toBe('t2v');
    expect(row?.durationSec).toBe(5);
  });

  test('a prompt over the vendor limit is an error row, and the export of the folder is held', () => {
    const state = project([
      { id: 'n_SHOTA00001', title: 'Wide', stored: { vendorRefs: [runway()] } },
      { id: 'n_SHOTB00001', title: 'Close', stored: { vendorRefs: [runway('x'.repeat(2000))] } },
    ]);
    const preview = packPreviewOf(state, FOLDER, 'runway-gen4');
    expect(preview?.canExport).toBe(false);
    expect(preview?.issues.find((issue) => issue.code === 'over-cap')).toMatchObject({ severity: 'error', shotId: 'n_SHOTB00001' });
    expect(exportPackOf(state, FOLDER, 'runway-gen4', 'json')?.ok).toBe(false);
    expect(exportPackOf(state, FOLDER, 'runway-gen4', 'csv')?.ok).toBe(false);
  });

  test('a folder with no prompt for the model has no rows, and every shot is missing', () => {
    const state = project([{ id: 'n_SHOTA00001', title: 'Wide' }, { id: 'n_SHOTB00001', title: 'Close' }]);
    const preview = packPreviewOf(state, FOLDER, 'runway-gen4');
    expect(preview?.rows).toEqual([]);
    expect(preview?.missing).toEqual(['n_SHOTA00001', 'n_SHOTB00001']);
  });

  test('a template id that names no template has no preview and no export', () => {
    const state = project([{ id: 'n_SHOTA00001', title: 'Wide', stored: { vendorRefs: [runway()] } }]);
    expect(packPreviewOf(state, FOLDER, 'no-such-model')).toBeNull();
    expect(exportPackOf(state, FOLDER, 'no-such-model', 'json')).toBeNull();
  });
});

test.describe('the exports', () => {
  test('the JSON pack is the canonical artifact: the model, the shots in storyboard order, and the provisional note', () => {
    const state = project([
      { id: 'n_SHOTA00001', title: 'Wide', stored: { vendorRefs: [runway()] } },
      { id: 'n_SHOTB00001', title: 'Close', stored: { vendorRefs: [runway('She reaches for the light')] } },
    ]);
    const outcome = exportPackOf(state, FOLDER, 'runway-gen4', 'json');
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok !== true) return;
    expect(outcome.fileName).toBe('runway-gen4-prompt-pack.json');
    const pack = JSON.parse(outcome.text) as { templateId: string; provisional?: string; shots: { shotNumber: number; shotId: string }[] };
    expect(pack.templateId).toBe('runway-gen4');
    expect(pack.shots.map((shot) => [shot.shotNumber, shot.shotId])).toEqual([
      [1, 'n_SHOTA00001'],
      [2, 'n_SHOTB00001'],
    ]);
    expect(pack.provisional).toContain('unverified until they are checked against');
  });

  test('the CSV has one row per shot under its header, and a prompt that starts like a formula is guarded with a quote', () => {
    const state = project([{ id: 'n_SHOTA00001', title: 'Wide', stored: { vendorRefs: [runway('She turns toward the door', '=HYPERLINK("x")')] } }]);
    const outcome = exportPackOf(state, FOLDER, 'runway-gen4', 'csv');
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok !== true) return;
    const lines = outcome.text.trimEnd().split('\r\n');
    expect(lines[0]).toBe('shotNumber,vendor,mode,duration,aspect,prompt,negativePrompt,refs');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`"'=HYPERLINK(""x"")`);
  });

  test('the Markdown pack says the template is provisional, before the cards', () => {
    const state = project([{ id: 'n_SHOTA00001', title: 'Wide', stored: { vendorRefs: [runway()] } }]);
    const outcome = exportPackOf(state, FOLDER, 'runway-gen4', 'markdown');
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok !== true) return;
    expect(outcome.fileName).toBe('runway-gen4-prompt-pack.md');
    expect(outcome.text.indexOf('Provisional template')).toBeLessThan(outcome.text.indexOf('## Shot 1'));
  });
});

/** A Runway record with some fields replaced, so a test can hand the pack a value of the wrong type. */
function runwayWith(patch: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    vendor: 'runway-gen4',
    mode: 't2v',
    prompt: { camera: 'Slow dolly-in', subject: 'A woman at a rain-streaked window', action: 'She turns toward the door' },
    durationSec: 5,
    aspectRatio: '16:9',
    references: [],
    ...patch,
  };
}

test.describe('a stored record the pack cannot read', () => {
  test('recordProblemOf names the first field of the wrong type, and passes a record the engine can read', () => {
    expect(recordProblemOf(runway())).toBeNull();
    expect(recordProblemOf(runwayWith({ prompt: { camera: 42 } }))).toBe('prompt.camera is not text');
    expect(recordProblemOf(runwayWith({ prompt: { camera: null } }))).toBe('prompt.camera is not text');
    expect(recordProblemOf(runwayWith({ audio: { dialogue: 7 } }))).toBe('audio.dialogue is not text');
    expect(recordProblemOf(runwayWith({ references: [null] }))).toBe('references item 1 is not an object');
    expect(recordProblemOf(runwayWith({ references: [{ type: 'video' }] }))).toBe(
      'references item 1 has no type from image, character, firstFrame, lastFrame',
    );
    expect(recordProblemOf(runwayWith({ bestTake: { seed: 1, model: 'gen4' } }))).toBe('bestTake.vendorParams is not an object');
    expect(recordProblemOf(runwayWith({ durationSec: '5' }))).toBe('durationSec is not a number');
    expect(recordProblemOf(runwayWith({ negativePrompt: 3 }))).toBe('negativePrompt is not text');
  });

  test('a camera that is a number is left out and reported as a warning, and the preview does not throw', () => {
    const state = project([{ id: 'n_SHOTA00001', title: 'Wide', stored: { vendorRefs: [runwayWith({ prompt: { camera: 42 } })] } }]);
    const preview = packPreviewOf(state, FOLDER, 'runway-gen4');
    expect(preview?.rows).toEqual([]);
    expect(preview?.missing).toEqual(['n_SHOTA00001']);
    expect(preview?.canExport).toBe(true);
    expect(preview?.issues).toContainEqual(expect.objectContaining({ code: 'unreadable-record', severity: 'warning', shotId: 'n_SHOTA00001' }));
    expect(preview?.issues.find((issue) => issue.code === 'unreadable-record')?.message).toContain('prompt.camera is not text');
  });

  test('audio that is a number and a reference that is null are left out and reported, and the export does not throw', () => {
    const state = project([
      { id: 'n_SHOTA00001', title: 'Wide', stored: { vendorRefs: [runwayWith({ audio: { dialogue: 7 } })] } },
      { id: 'n_SHOTB00001', title: 'Close', stored: { vendorRefs: [runwayWith({ references: [null] })] } },
    ]);
    const preview = packPreviewOf(state, FOLDER, 'runway-gen4');
    expect(preview?.rows).toEqual([]);
    expect(preview?.missing).toEqual(['n_SHOTA00001', 'n_SHOTB00001']);
    const messages = (preview?.issues ?? []).map((issue) => issue.message).join('\n');
    expect(messages).toContain('audio.dialogue is not text');
    expect(messages).toContain('references item 1 is not an object');
    expect(() => exportPackOf(state, FOLDER, 'runway-gen4', 'csv')).not.toThrow();
    expect(() => exportPackOf(state, FOLDER, 'runway-gen4', 'markdown')).not.toThrow();
  });

  test('one unreadable record does not take a readable shot of the same pack with it', () => {
    const state = project([
      { id: 'n_SHOTA00001', title: 'Wide', stored: { vendorRefs: [runway()] } },
      { id: 'n_SHOTB00001', title: 'Close', stored: { vendorRefs: [runwayWith({ references: [null] })] } },
    ]);
    const preview = packPreviewOf(state, FOLDER, 'runway-gen4');
    expect(preview?.rows.map((row) => row.shotId)).toEqual(['n_SHOTA00001']);
    expect(preview?.canExport).toBe(true);
    const outcome = exportPackOf(state, FOLDER, 'runway-gen4', 'json');
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok !== true) return;
    const pack = JSON.parse(outcome.text) as { shots: { shotId: string }[] };
    expect(pack.shots.map((shot) => shot.shotId)).toEqual(['n_SHOTA00001']);
  });

  test('a record the engine throws on is set aside on its own shot as an error row, and that row holds the export', () => {
    const state = project([
      { id: 'n_SHOTA00001', title: 'Wide', stored: { vendorRefs: [runway()] } },
      {
        id: 'n_SHOTB00001',
        title: 'Close',
        stored: { vendorRefs: [runwayWith({ references: [{ type: 'character', entryId: 'n_CODEX00001' }] })] },
      },
    ]);
    // A codex entry with no description. Only an override that names it reaches the line that reads the description, so the
    // throw comes from this shot's record and no other.
    state.manifest.codex = [{ id: 'n_CODEX00001', name: 'Ann', type: 'character', description: null, includePolicy: 'always' } as unknown as CodexEntry];
    const preview = packPreviewOf(state, FOLDER, 'runway-gen4');
    expect(preview?.rows.map((row) => row.shotId)).toEqual(['n_SHOTA00001']);
    expect(preview?.missing).toEqual(['n_SHOTB00001']);
    expect(preview?.canExport).toBe(false);
    expect(preview?.issues).toContainEqual(expect.objectContaining({ code: 'unreadable-record', severity: 'error', shotId: 'n_SHOTB00001' }));
    expect(preview?.issues.find((issue) => issue.code === 'unreadable-record' && issue.severity === 'error')?.message).toContain('could not read');
    expect(exportPackOf(state, FOLDER, 'runway-gen4', 'json')?.ok).toBe(false);
  });
});
