/**
 * A small project with one of each media kind, shared by the media tests. Each kind is written through the
 * store's and the media packages' own write paths, so the state the tests compile is the shape a real project
 * has in memory.
 *
 * ```
 * manuscript
 *   Script                      (folder)
 *     INT. KITCHEN - DAY        (screenplay scene, with a synopsis)
 *     Notes for MARA            (prose: left out of the screenplay formats)
 *   Tavern                      (folder)
 *     The innkeeper             (dialogue container: Ink, with line ids)
 *   Shots                       (storyboard folder)
 *     Shot one                  (MS, 4 s, covers the kitchen's cue, and has a Runway prompt)
 *     Shot two                  (WS, 6 s, has no prompt yet)
 * research
 *   Ferry timetable             (prose: compiled only when named)
 * ```
 */

import {
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectState,
  type ProjectState,
} from '@caotang/store';
import { addShotNode, addStoryboardFolder } from '@caotang/storyboard';
import type { AssetRecord } from '@caotang/video-prompt-pack';

export const OPENED = new Date('2026-10-02T15:00:00.000Z');

export const PROJECT_NAME = 'The Lighthouse Keeper';

export const MEDIA_IDS = {
  script: 'n_SCRIPT0001',
  kitchen: 'n_KITCHEN001',
  notesForMara: 'n_NOTESMARA1',
  tavern: 'n_TAVERN0001',
  innkeeper: 'n_INNKEEPER1',
  shots: 'n_SHOTS00001',
  shotOne: 'n_SHOTONE001',
  shotTwo: 'n_SHOTTWO001',
  timetable: 'n_TIMETABLE1',
} as const;

/** The stored image of shot one: an asset id, and the file the asset store holds under it. */
export const ASSET_ID = 'a_8K3QZ2M7RD';
export const ASSET_FILE = `${ASSET_ID}.png`;

/** The assets the exporter is handed, by id. A test that wants no assets passes none. */
export const ASSETS: ReadonlyMap<string, AssetRecord> = new Map([[ASSET_ID, { id: ASSET_ID, fileName: ASSET_FILE }]]);

export const SCENE_SYNOPSIS = 'Mara learns the ferry has gone.';

/** One screenplay scene, in Fountain. Its heading is the document's own. */
export const SCENE_BODY = ['INT. KITCHEN - DAY', '', 'MARA', 'Where were you?', '', 'ELI', 'Out on the water.'].join('\n');

/** The dialogue container's Ink, with line ids on every speakable line and choice. */
export const INK_BODY = [
  '=== start ===',
  'The innkeeper looks up. # lineId: l_0000000001',
  "Innkeeper: Ah, a traveller. What'll it be? # lineId: l_0000000002",
  '* [Order an ale # lineId: l_0000000003_c] -> ale',
  '* [Leave quietly # lineId: l_0000000004_c] -> END',
  '=== ale ===',
  'Ale arrives, foaming. # lineId: l_0000000005',
  '-> END',
].join('\n');

/** A valid Ink story whose lines carry no line ids: the table refuses it, and the story compiles. */
export const UNKEYED_INK = ['=== start ===', 'The innkeeper looks up.', '* [Order an ale] -> END'].join('\n');

/** An Ink story that does not compile: a divert to a knot that does not exist. */
export const BROKEN_INK = ['=== start ===', '-> nowhere'].join('\n');

/** Two lines that name the same id: the table refuses it, and the story compiles. */
export const DUPLICATE_ID_INK = [
  '=== start ===',
  'The innkeeper looks up. # lineId: l_0000000001',
  'The innkeeper looks up again. # lineId: l_0000000001',
  '-> END',
].join('\n');

export interface MediaProjectOptions {
  /** The innkeeper container's Ink body. Defaults to {@link INK_BODY}. */
  readonly innkeeper?: string;
}

export function makeMediaProject(options: MediaProjectOptions = {}): ProjectState {
  // The locale is pinned: `createEmptyManifest` would otherwise read the host's,
  // and the dialogue-csv rows below carry the project language (`en` on the row),
  // so a German or French machine would fail every `,en` assertion without this.
  const state = createProjectState(createEmptyManifest(PROJECT_NAME, OPENED, { locale: 'en-US' }));
  state.manifest.project.id = 'p_9XK2M4Q7RZ';

  addFolder(state, { parentId: 'manuscript', title: 'Script', now: OPENED, id: MEDIA_IDS.script });
  const kitchen = addDocument(state, {
    parentId: MEDIA_IDS.script,
    title: 'INT. KITCHEN - DAY',
    body: SCENE_BODY,
    synopsis: SCENE_SYNOPSIS,
    now: OPENED,
    id: MEDIA_IDS.kitchen,
  });
  Object.assign(kitchen, { kind: 'screenplay' });
  addDocument(state, { parentId: MEDIA_IDS.script, title: 'Notes for MARA', body: 'She hates the rain.', now: OPENED, id: MEDIA_IDS.notesForMara });

  addFolder(state, { parentId: 'manuscript', title: 'Tavern', now: OPENED, id: MEDIA_IDS.tavern });
  const innkeeper = addDocument(state, {
    parentId: MEDIA_IDS.tavern,
    title: 'The innkeeper',
    body: options.innkeeper ?? INK_BODY,
    now: OPENED,
    id: MEDIA_IDS.innkeeper,
  });
  Object.assign(innkeeper, { type: 'dialogue', kind: 'branching' });

  const shots = addStoryboardFolder(state, { parentId: 'manuscript', title: 'Shots', now: OPENED, id: MEDIA_IDS.shots });
  addShotNode(state, {
    parentId: shots.id,
    title: 'Shot one',
    id: MEDIA_IDS.shotOne,
    now: OPENED,
    stored: {
      image: ASSET_ID,
      shotSize: 'MS',
      cameraAngle: 'eye',
      cameraMovement: 'static',
      action: 'Mara sets the kettle down.',
      durationSec: 5,
      transition: 'cut',
      dialogue: [
        {
          kind: 'fountain-element',
          docId: MEDIA_IDS.kitchen,
          anchor: { from: 0, to: 4, exact: 'MARA', prefix: '', suffix: '', capturedRevision: 1 },
        },
      ],
      vendorRefs: [
        {
          vendor: 'runway-gen4',
          mode: 't2v',
          prompt: { camera: 'Static medium shot', subject: 'Mara', action: 'sets the kettle down', context: 'A kitchen at dawn', style: 'Warm light' },
          durationSec: 5,
          aspectRatio: '16:9',
          references: [{ type: 'image', assetId: ASSET_ID }],
        },
      ],
    },
  });
  addShotNode(state, {
    parentId: shots.id,
    title: 'Shot two',
    id: MEDIA_IDS.shotTwo,
    now: OPENED,
    stored: { shotSize: 'WS', action: 'The harbour, empty.', durationSec: 6 },
  });

  addFolder(state, { parentId: 'research', title: 'Ferry', now: OPENED, id: 'n_FERRY00001' });
  addDocument(state, { parentId: 'n_FERRY00001', title: 'Ferry timetable', body: 'Ferry at nine.', now: OPENED, id: MEDIA_IDS.timetable });

  return state;
}
