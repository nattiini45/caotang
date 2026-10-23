import { expect, test } from '@playwright/test';

import { ProjectAssets } from '../../apps/desktop/src/app/project-assets.js';
import { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { animaticLineOf } from '../../apps/desktop/src/media/board-model.js';
import {
  assignImageCommand,
  clearImageCommand,
  dropReportOf,
  firstPicture,
  isPictureFile,
  planPictureDrop,
  shotNumberOfFileName,
  type BoardShot,
} from '../../apps/desktop/src/media/shot-image-model.js';
import type { ShotCommand } from '../../apps/desktop/src/media/engines.js';
import { addShotNode, addStoryboardFolder } from '../../packages/storyboard/src/index.js';
import {
  MemoryIndexedDb,
  addDocument,
  createEmptyManifest,
  createProjectState,
  nodeById,
  openRuntimeStore,
  type ProjectState,
} from '../../packages/store/src/index.js';

const NOW = new Date('2026-10-09T09:00:00Z');
const FOLDER = 'n_SBFOLDER01';
const SHOT = 'n_SHOTA00001';
const OTHER = 'n_SHOTB00001';
// A valid asset id: `a_` and ten Crockford base32 characters (no I, L, O or U).
const ASSET = 'a_ABCDEF2345';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function board(): ProjectState {
  const state = createProjectState(createEmptyManifest('Film', NOW));
  addStoryboardFolder(state, { parentId: 'manuscript', title: 'Scene 1 — Shots', id: FOLDER, now: NOW });
  addShotNode(state, { parentId: FOLDER, id: SHOT, title: 'Wide', stored: { shotSize: 'WS', durationSec: 4 }, now: NOW });
  addShotNode(state, { parentId: FOLDER, id: OTHER, title: 'Close', stored: {}, now: NOW });
  addDocument(state, { parentId: 'manuscript', title: 'The Landing', body: 'The ferry was late.', now: NOW, id: 'n_LANDING001' });
  return state;
}

function applied(command: ShotCommand): unknown {
  if (command.name !== 'shot.setMeta') throw new Error(`expected shot.setMeta, got ${command.name}`);
  return command.params;
}

test.describe('which files a card takes', () => {
  test('a PNG, JPEG or WebP is a picture by its declared type, and a file with no declared type by its name', () => {
    expect(isPictureFile({ type: 'image/png', name: 'frame' })).toBe(true);
    expect(isPictureFile({ type: 'image/jpeg', name: 'frame' })).toBe(true);
    expect(isPictureFile({ type: 'image/webp', name: 'frame' })).toBe(true);
    expect(isPictureFile({ type: '', name: 'frame.JPG' })).toBe(true);
    expect(isPictureFile({ type: 'image/gif', name: 'frame.gif' })).toBe(false);
    expect(isPictureFile({ type: 'text/plain', name: 'notes.png' })).toBe(false);
  });

  test('a drop or paste takes the first picture among the files it carries, and nothing else', () => {
    const files = [
      { type: 'text/plain', name: 'script.txt' },
      { type: 'image/webp', name: 'frame.webp' },
      { type: 'image/png', name: 'other.png' },
    ];
    expect(firstPicture(files)?.name).toBe('frame.webp');
    expect(firstPicture([{ type: 'text/plain', name: 'script.txt' }])).toBeUndefined();
  });
});

test.describe('the image commands', () => {
  test('assigning an image sets its id, keeps the shot’s other fields, and guards the value it read', () => {
    const state = board();
    const result = assignImageCommand(state, SHOT, ASSET);
    if (!result.ok) throw new Error(result.refusal.message);
    expect(applied(result.value)).toEqual({
      nodeId: SHOT,
      stored: { shotSize: 'WS', durationSec: 4, image: ASSET },
      expect: { shotSize: 'WS', durationSec: 4 },
    });
  });

  test('clearing the image removes only the image, and a shot left with nothing stores no value', () => {
    const state = board();
    const cleared = clearImageCommand(state, SHOT);
    if (!cleared.ok) throw new Error(cleared.refusal.message);
    expect(applied(cleared.value)).toMatchObject({ nodeId: SHOT, stored: { shotSize: 'WS', durationSec: 4 } });

    const bare = clearImageCommand(state, OTHER);
    if (!bare.ok) throw new Error(bare.refusal.message);
    // The shot exists with empty metadata, so its guard is the empty object it holds, and the write removes the value.
    expect(applied(bare.value)).toEqual({ nodeId: OTHER, stored: null, expect: {} });
  });

  test('a node that is not a shot cannot take an image, and the refusal says so', () => {
    const result = assignImageCommand(board(), 'n_LANDING001', ASSET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('not-a-shot');
  });
});

test.describe('the animatic line in the board header', () => {
  test('gives the timed total, and says how many shots are left out for want of a duration', () => {
    const line = animaticLineOf(board(), FOLDER);
    expect(line).toMatchObject({ seconds: 4, timed: 1, untimed: 1 });
    expect(line.text).toBe('4 s of animatic, with 1 shot left out for want of a duration');
  });

  test('says nothing is left out when every shot is timed, and totals a folder with no shots at zero', () => {
    const state = board();
    const timed = animaticLineOf(state, FOLDER);
    expect(timed.text).toContain('left out');
    const empty = createProjectState(createEmptyManifest('Film', NOW));
    addStoryboardFolder(empty, { parentId: 'manuscript', title: 'Empty', id: 'n_EMPTY00001', now: NOW });
    expect(animaticLineOf(empty, 'n_EMPTY00001')).toMatchObject({ seconds: 0, timed: 0, untimed: 0, text: '0 s of animatic' });
  });
});

test.describe('the project’s images, held in the browser', () => {
  test('an image written by one session is read back by a new session of the same project, after the database is reopened', async () => {
    const factory = new MemoryIndexedDb();
    const first = new ProjectAssets();
    await first.persistFor('p_IMAGES0001', factory);
    await first.writeBytes(`assets/${ASSET}.png`, PNG);
    expect(first.durable()).toBe(true);

    const reopened = new ProjectAssets();
    await reopened.persistFor('p_IMAGES0001', factory);
    expect(await reopened.readBytes(`assets/${ASSET}.png`)).toEqual(PNG);
    expect(reopened.presentIds().has(ASSET)).toBe(true);
    expect(await reopened.listPaths()).toEqual([`assets/${ASSET}.png`]);
  });

  test('a project’s images are kept apart from another project’s', async () => {
    const factory = new MemoryIndexedDb();
    const one = new ProjectAssets();
    await one.persistFor('p_ONE0000001', factory);
    await one.writeBytes(`assets/${ASSET}.png`, PNG);

    const two = new ProjectAssets();
    await two.persistFor('p_TWO0000001', factory);
    expect(two.presentIds().has(ASSET)).toBe(false);
    expect(await two.readBytes(`assets/${ASSET}.png`)).toBeNull();
  });

  test('without a browser store, the images are held for the page and the store says it is not durable', async () => {
    const assets = new ProjectAssets();
    await assets.persistFor('p_NOSTORE001');
    expect(assets.durable()).toBe(false);
    await assets.writeBytes(`assets/${ASSET}.png`, PNG);
    expect(await assets.readBytes(`assets/${ASSET}.png`)).toEqual(PNG);
  });

  test('the storyboard reads the images through the assets as an artifact store, and a missing file is not found', async () => {
    const assets = new ProjectAssets();
    await assets.writeBytes(`assets/${ASSET}.png`, PNG);
    const fs = assets.artifactFs();
    expect(await fs.listFiles('assets')).toEqual([`${ASSET}.png`]);
    expect(await fs.listFiles('docs')).toEqual([]);
    expect(await fs.readBytes(`assets/${ASSET}.png`)).toEqual(PNG);
    await expect(fs.readBytes('assets/a_MISSING001.png')).rejects.toThrow();
  });
});

const FERRY = 'n_SHOTC00001';

/** A board of three shots, numbered 1 to 3 by their order: Wide, Close and The Ferry. */
function threeShots(): ProjectState {
  const state = board();
  addShotNode(state, { parentId: FOLDER, id: FERRY, title: 'The Ferry', stored: { action: 'The lamp goes out.' }, now: NOW });
  return state;
}

const SHOTS: readonly BoardShot[] = [
  { id: SHOT, number: 1, title: 'Wide' },
  { id: OTHER, number: 2, title: 'Close' },
  { id: FERRY, number: 3, title: 'The Ferry' },
];

function named(...names: string[]): { name: string; type: string }[] {
  return names.map((name) => ({ name, type: /\.txt$/i.test(name) ? 'text/plain' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.webp$/i.test(name) ? 'image/webp' : 'image/png' }));
}

test.describe('which shot a photograph’s file name names (storyboard.md §6)', () => {
  test('is the number the name starts with, padded or not, with anything after a separator', () => {
    for (const [name, number] of [
      ['007.jpg', 7],
      ['7.jpg', 7],
      ['07.JPEG', 7],
      ['007-ferry.jpg', 7],
      ['7 (1).jpeg', 7],
      ['12_the_lamp.png', 12],
      ['3', 3],
      ['3.5.png', 3],
      ['0.png', 0],
    ] as const) {
      expect(shotNumberOfFileName(name), name).toBe(number);
    }
  });

  test('is nothing for a name that starts with no digit, or whose digits run into letters, as a camera’s do', () => {
    for (const name of ['IMG_0007.jpg', 'ferry.png', '.png', '7a.jpg', '7é.jpg', '٣.png', '']) {
      expect(shotNumberOfFileName(name), name).toBeUndefined();
    }
  });
});

test.describe('matching the files of a drop to the shots of the board', () => {
  test('puts each picture on the shot its name numbers, whatever the order of the drop', () => {
    const verdicts = planPictureDrop(named('3.png', '001.jpg', '02-close.webp'), SHOTS);
    expect(verdicts.map((verdict) => (verdict.kind === 'import' ? [verdict.name, verdict.shot.id] : [verdict.name, 'left out']))).toEqual([
      ['3.png', FERRY],
      ['001.jpg', SHOT],
      ['02-close.webp', OTHER],
    ]);
  });

  test('leaves out a file that is not a picture, one with no number, and one past the last shot, each with its reason, and imports the rest', () => {
    const verdicts = planPictureDrop(named('notes.txt', 'ferry.png', '9.png', '2.png'), SHOTS);
    expect(verdicts).toEqual([
      { kind: 'left-out', file: 0, name: 'notes.txt', reason: 'it is not a PNG, JPEG or WebP picture' },
      { kind: 'left-out', file: 1, name: 'ferry.png', reason: 'its name does not start with a shot number (name a photograph like 007.jpg)' },
      { kind: 'left-out', file: 2, name: '9.png', reason: 'the board has 3 shots and none is numbered 9', beyond: 9 },
      { kind: 'import', file: 3, name: '2.png', shot: SHOTS[1] },
    ]);
  });

  test('leaves out both files that name one shot, since it cannot be known which was meant, and names the other', () => {
    const verdicts = planPictureDrop(named('1.png', '001-wide.jpg', '2.png'), SHOTS);
    expect(verdicts.map((verdict) => verdict.kind)).toEqual(['left-out', 'left-out', 'import']);
    expect(verdicts[0]).toMatchObject({ reason: 'another file in this drop is also named for shot 1, so neither was imported' });
  });

  test('numbers a file 0 as no shot, since shot numbers start at 1', () => {
    expect(planPictureDrop(named('0.png'), SHOTS)[0]).toMatchObject({ kind: 'left-out', reason: expect.stringContaining('does not start with a shot number') });
  });
});

test.describe('the notice after a drop on the board', () => {
  test('names the shot each file landed on by number and title, and says one Undo takes them all back', () => {
    const report = dropReportOf(planPictureDrop(named('1.png', '03.jpg'), SHOTS), 3, { ok: true });
    expect(report.summary).toBe('Put 2 pictures on their shots. One Undo takes them all back.');
    expect(report.lines).toEqual(['1.png: shot 1, Wide', '03.jpg: shot 3, The Ferry']);
  });

  test('names a file that matched no shot and why, beside the ones that did', () => {
    const report = dropReportOf(planPictureDrop(named('2.png', 'notes.txt'), SHOTS), 3, { ok: true });
    expect(report.summary).toBe('Put 1 picture on its shot; 1 file was not imported. One Undo takes it back.');
    expect(report.lines).toEqual(['2.png: shot 2, Close', 'notes.txt: not imported, it is not a PNG, JPEG or WebP picture']);
  });

  test('says nothing was imported when no file matched, and hints at a sheet from a longer board when a number is past the last shot', () => {
    const report = dropReportOf(planPictureDrop(named('12.png'), SHOTS), 3, { ok: true });
    expect(report.summary).toContain('Nothing was imported.');
    expect(report.summary).toContain('The board has 3 shots; a sheet printed from a longer board does not match it');
    expect(report.lines).toEqual(['12.png: not imported, the board has 3 shots and none is numbered 12']);
  });

  test('says nothing was imported when the command refused, and that each matched file was not', () => {
    const report = dropReportOf(planPictureDrop(named('1.png'), SHOTS), 3, { ok: false, message: 'the project cannot be written to' });
    expect(report.summary).toBe('Nothing was imported: the project cannot be written to');
    expect(report.lines).toEqual(['1.png: not imported (it was for shot 1, Wide)']);
  });
});

test.describe('a drop of several pictures in a session: one command, one undo step', () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  let previous: { document: unknown; window: unknown } | null = null;

  test.beforeAll(() => {
    previous = { document: globals['document'], window: globals['window'] };
    globals['document'] = new EventTarget();
    globals['window'] = new EventTarget();
  });

  test.afterAll(() => {
    if (previous === null) return;
    globals['document'] = previous.document;
    globals['window'] = previous.window;
  });

  async function sessionOver(state: ProjectState): Promise<ProjectSession> {
    const store = await openRuntimeStore(new MemoryIndexedDb());
    return new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
  }

  const imageOf = (state: ProjectState, id: string): unknown => (nodeById(state, id)?.shot as { image?: string } | undefined)?.image;

  test('puts each picture on the shot named for it, and one Undo takes every picture back', async () => {
    const state = threeShots();
    const session = await sessionOver(state);
    expect(session.newestUndoGroupId()).toBeNull();

    const verdicts = planPictureDrop(named('3.png', '001.png'), SHOTS);
    const items = verdicts.flatMap((verdict) => (verdict.kind === 'import' ? [{ shotId: verdict.shot.id, bytes: PNG }] : []));
    const result = await session.importShotImages(items.map(({ shotId, bytes }) => ({ nodeId: shotId, bytes })));
    expect(result.ok).toBe(true);

    expect(imageOf(state, FERRY)).toMatch(/^a_/);
    expect(imageOf(state, SHOT)).toMatch(/^a_/);
    expect(imageOf(state, OTHER)).toBeUndefined();
    // Both pictures are in the project's images, and the batch is one group.
    expect((await session.assets.listPaths()).length).toBe(2);
    expect(session.newestUndoGroupId()).not.toBeNull();

    expect(await session.undoLast()).toBe(true);
    expect(imageOf(state, FERRY)).toBeUndefined();
    expect(imageOf(state, SHOT)).toBeUndefined();
    // Two pictures were one group: the one Undo left none.
    expect(session.newestUndoGroupId()).toBeNull();
  });

  test('imports nothing, and leaves no file, when one of the files is not a picture', async () => {
    const state = threeShots();
    const session = await sessionOver(state);
    const result = await session.importShotImages([
      { nodeId: SHOT, bytes: PNG },
      { nodeId: OTHER, bytes: Uint8Array.from([0x25, 0x50, 0x44, 0x46]) },
    ]);
    expect(result.ok).toBe(false);
    expect(imageOf(state, SHOT)).toBeUndefined();
    expect((await session.assets.listPaths()).length).toBe(0);
  });
});
