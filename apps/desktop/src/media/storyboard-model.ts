/**
 * The storyboard view's model: the cards of one storyboard folder, and the two plans a card can make.
 *
 * Every number here is derived, not stored (storyboard.md §2.2): a card's number is its position among its
 * folder's shots (ordering.ts), so a reorder renumbers for free. A reorder is a `binder.move` the engine plans
 * (`planMoveShot`), and a field edit is a `shot.setMeta` the engine checks before it is built. Neither applies
 * anything. The App's bus applies the command, and the view shows the refusal when it turns one away.
 */

import { defaultTitleOf, isolate } from '@caotang/i18n';
import { t } from '@lingui/core/macro';
import { nodeById, type ProjectState, type TreeNode } from '@caotang/store';

import {
  CAMERA_ANGLES,
  CAMERA_MOVEMENTS,
  DERIVE_FOLDER_SUFFIX,
  SHOT_SIZES,
  TRANSITIONS,
  checkShotMeta,
  cardSpecRowOf,
  displayNumbers,
  isShotNode,
  isStoryboardFolder,
  planMoveShot,
  readShotMeta,
  shotFieldOf,
  shotsIn,
  storedValueOf,
  type ShotCommand,
  type ShotMeta,
  type StoryboardRefusal,
  type StoryboardResult,
} from './engines.js';
import { storyboardDeriveIntent } from '../app/model-prompts.js';
import { mediaKindOf } from './route.js';


/* lingui-set comment="Storyboard board text and refusals. Interpolated values: sceneTitle is a scene title the writer wrote; shotId and folderId are ids; field and the quoted value come from the shot record; count is a number." */
/** One card of the board: what the writer reads off it, and what an edit starts from. */
export interface ShotCard {
  readonly id: string;
  readonly title: string;
  /** 1-based position among the folder's shots: the number the card's chip shows. */
  readonly number: number;
  /** 0-based position, which the reorder buttons step from. */
  readonly index: number;
  /** How many shots the folder holds. */
  readonly count: number;
  /** The asset id of the card's image, when the shot has one. */
  readonly image: string | null;
  readonly imageAlt: string;
  /** The row the card prints, in the shot editor's words: `shotSize · cameraAngle · cameraMovement · durationSec s · lens · transition` (storyboard.md §3.1). */
  readonly spec: string;
  readonly action: string;
  readonly lens: string;
  readonly transition: string;
  /** The node's status, named as the corkboard card names it: the status name, or what is missing, with its colour when it has one. */
  readonly status: { readonly name: string; readonly color: string | null };
  /** The node's label name, through the project vocabulary. `null` when it has none, or the vocabulary does not hold it. */
  readonly label: string | null;
  /** How many script elements the shot covers (`dialogue[]`). */
  readonly coverage: number;
  /** Closed-enum values the load kept although they are not in their list, each as one sentence. */
  readonly unknown: readonly string[];
  /** Everything else the load changed or kept, one line each. */
  readonly notices: readonly string[];
  /** The well-formed metadata, which the editor starts from. */
  readonly meta: ShotMeta;
  /** The stored value exactly as the node holds it, which a `shot.setMeta` guards against. */
  readonly raw: unknown;
}

/** The fields the Inspector-style editor writes. Text for every field; `durationSec` is parsed on save. */
export const EDITABLE_FIELDS = ['shotSize', 'cameraAngle', 'cameraMovement', 'transition', 'lens', 'action', 'durationSec', 'imageAlt'] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

/** A closed list the editor offers as a select. The four lists are the v1 vocabulary (storyboard.md §2.2). */
export const ENUM_OPTIONS: Readonly<Record<'shotSize' | 'cameraAngle' | 'cameraMovement' | 'transition', readonly string[]>> = {
  shotSize: SHOT_SIZES,
  cameraAngle: CAMERA_ANGLES,
  cameraMovement: CAMERA_MOVEMENTS,
  transition: TRANSITIONS,
};

export type ShotDraft = Readonly<Record<EditableField, string>>;

/**
 * The storyboard folder a scene's shots live in, when one exists: the folder `shots.derive` makes for the scene, `<Scene Title> — Shots`
 * beside it (storyboard.md §2.1, §4). `undefined` when the scene has none yet.
 *
 * Derive always makes a new folder, and `storyboard.create` does not refuse a title that is taken, so a second derive would leave two
 * folders with the same name. The scene offers its derive action only while this is `undefined`.
 */
export function shotsFolderOf(state: ProjectState, scene: TreeNode): TreeNode | undefined {
  const title = `${scene.title}${DERIVE_FOLDER_SUFFIX}`;
  return state.manifest.tree.find((node) => node.type === 'folder' && node.parentId === scene.parentId && node.title === title);
}

/** The request a scene's derive action sends the agent: the shots derived from the scene's script (storyboard.md §4). */
export function deriveIntentOf(scene: TreeNode): string {
  return storyboardDeriveIntent(scene.title);
}

/**
 * The scene an empty storyboard board offers to derive the shots of, or `undefined` when it offers none (storyboard.md §3.1, §4). The
 * board names no scene, so the scene is found beside it: the folder's parent holds exactly one screenplay scene with no shots folder.
 *
 * Two cases offer nothing. A board that is a scene's shots folder already has its folder, and derive would make a second one, which
 * shotsFolderOf exists to prevent. And when two or more scenes are open, the writer has to choose one, and the scene view does that.
 */
export function derivableSceneOf(state: ProjectState, folder: TreeNode): TreeNode | undefined {
  const scenes = state.manifest.tree.filter((node) => mediaKindOf(node) === 'screenplay');
  if (scenes.some((scene) => shotsFolderOf(state, scene)?.id === folder.id)) return undefined;
  const open = scenes.filter((scene) => scene.parentId === folder.parentId && shotsFolderOf(state, scene) === undefined);
  return open.length === 1 ? open[0] : undefined;
}

/** The empty board's words: its title and the sentence under it. */
export interface EmptyBoardCopy {
  readonly title: string;
  readonly body: string;
}

/**
 * What an empty storyboard board says (storyboard.md §3.1). The spec's title invites a derive and a new frame, so it is the title only
 * where the board can save; a read-only board gets a neutral one. `scene` is the scene the board offers to derive (derivableSceneOf):
 * the derive makes a new `<Scene Title> — Shots` folder and does not fill this board, so the body says where the shots go.
 * `canDerive` is whether the board can send a request to the agent at all; with it and no scene, the body points to the scene view.
 */
export function emptyBoardCopyOf(options: { readonly editable: boolean; readonly canDerive: boolean; readonly scene: TreeNode | undefined }): EmptyBoardCopy {
  if (!options.editable) {
    return {
      title: t`No shots in this storyboard yet`,
      body: t`Shots are made by the storyboard tools, which this build does not register yet. The cards appear here once the folder holds shots.`,
    };
  }
  const sceneTitle = options.scene === undefined ? '' : isolate(options.scene.title);
  const body =
    options.scene !== undefined
      ? t`Add the first shot with the button below. Each card takes an image and the camera fields. Derived shots go in a new folder, “${sceneTitle} — Shots”, not on this board.`
      : options.canDerive
        ? t`Add the first shot with the button below. Each card takes an image and the camera fields. To derive a scene’s shots, open the scene.`
        : t`Add the first shot with the button below. Each card takes an image and the camera fields.`;
  return {
    title: t`No shots — derive from the scene's script, or draw/import a frame.`,
    body,
  };
}

/** The cards of one storyboard folder, in sibling order. A folder with no shots gives an empty list. */
export function shotCardsOf(state: ProjectState, folderId: string): readonly ShotCard[] {
  const shots = shotsIn(state, folderId);
  const numbers = displayNumbers(state, folderId);
  return shots.map((node, index) => {
    const raw = shotFieldOf(node);
    const read = readShotMeta(raw);
    const meta = read.meta;
    // The spec row reads the stored shape, so a value kept as unknown still shows (cardSpecRowOf).
    const visible: Record<string, unknown> = { ...meta, ...read.unknownValues };
    const status = node.status === null ? undefined : state.manifest.vocabulary.statuses.find((term) => term.id === node.status);
    const label = node.label === null ? undefined : state.manifest.vocabulary.labels.find((term) => term.id === node.label);
    return {
      id: node.id,
      title: node.title,
      number: numbers.get(node.id) ?? index + 1,
      index,
      count: shots.length,
      image: meta.image ?? null,
      imageAlt: meta.imageAlt ?? '',
      spec: cardSpecRowOf(visible),
      action: meta.action ?? '',
      lens: meta.lens ?? '',
      transition: meta.transition ?? '',
      status: {
        name: status?.name ?? (node.status === null ? t`No status` : t`Unknown status`),
        color: status?.color ?? null,
      },
      label: label?.name ?? null,
      coverage: meta.dialogue?.length ?? 0,
      unknown: Object.entries(read.unknownValues).map(([field, value]) => {
        const shown = String(value);
        return t`${field} "${shown}" is not in the v1 list`;
      }),
      notices: read.notices,
      meta,
      raw,
    };
  });
}

/** The folder a shot card sits in, when the node is a shot. */
function folderOfShot(state: ProjectState, shotId: string): TreeNode | undefined {
  const node = nodeById(state, shotId);
  if (node === undefined || !isShotNode(node) || node.parentId === null) return undefined;
  return nodeById(state, node.parentId);
}

function refused(code: string, message: string): { readonly ok: false; readonly refusal: StoryboardRefusal } {
  return { ok: false, refusal: { code, message } };
}

/**
 * A reorder to a 0-based position among the folder's shots, which the card's number reads. The engine plans it as a
 * `binder.move`, and it already maps the shot index to the bus's sibling index, so this only bounds the position.
 */
export function moveShotCommand(state: ProjectState, shotId: string, toIndex: number): StoryboardResult<ShotCommand> {
  const folder = folderOfShot(state, shotId);
  if (folder === undefined) return refused('not-a-shot', t`no shot "${shotId}" in a storyboard folder`);
  const count = shotsIn(state, folder.id).length;
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= count) {
    return refused('out-of-range', t`A shot moves to a position from 1 to ${count} in its storyboard`);
  }
  return planMoveShot(state, shotId, { folderId: folder.id, index: toIndex });
}

/** The params of a new, empty shot: a `binder.create` of type `shot`, with the folder it goes in as its parent. */
export interface NewShotParams {
  readonly parentId: string;
  readonly type: 'shot';
  readonly title: string;
}

/**
 * A new, empty shot at the end of a storyboard folder. storyboard.md §3.1 makes a new card a `binder.create` with no new
 * command, and the bus takes a `shot` type now, so this plans that create. The bus checks the parent again; this checks
 * only that the folder is a storyboard, so the writer is told in the storyboard's words before anything is dispatched.
 */
export function newShotParams(state: ProjectState, folderId: string, title = defaultTitleOf('shot', state.manifest.project.language)): StoryboardResult<NewShotParams> {
  const folder = nodeById(state, folderId);
  if (folder === undefined || !isStoryboardFolder(folder)) {
    return refused('not-a-storyboard', t`"${folderId}" is not a storyboard folder, and a shot lives in one`);
  }
  return { ok: true, value: { parentId: folder.id, type: 'shot', title } };
}

/** The editor's starting values for a card: the stored value of each field, and `''` for a field the shot leaves unset. */
export function draftOf(card: ShotCard): ShotDraft {
  const unknownOf = (field: string): string => {
    const read = readShotMeta(card.raw);
    const value = read.unknownValues[field];
    return value === undefined ? '' : String(value);
  };
  const enumDraft = (field: 'shotSize' | 'cameraAngle' | 'cameraMovement' | 'transition'): string => card.meta[field] ?? unknownOf(field);
  return {
    shotSize: enumDraft('shotSize'),
    cameraAngle: enumDraft('cameraAngle'),
    cameraMovement: enumDraft('cameraMovement'),
    transition: enumDraft('transition'),
    lens: card.meta.lens ?? '',
    action: card.meta.action ?? '',
    durationSec: card.meta.durationSec === undefined ? '' : String(card.meta.durationSec),
    imageAlt: card.meta.imageAlt ?? '',
  };
}

/**
 * The draft after the card's stored values changed. A field whose stored value changed (an undo, or another writer) takes the stored
 * value, and every other field keeps what the writer typed. A save of another section of the shot (its prompt, its coverage, its image)
 * changes the stored shot without changing any editable field, so the text the writer has not saved here is kept.
 */
export function draftAfterStoredChange(draft: ShotDraft, synced: ShotDraft, stored: ShotDraft): ShotDraft {
  const next: Record<EditableField, string> = { ...draft };
  for (const field of EDITABLE_FIELDS) {
    if (stored[field] !== synced[field]) next[field] = stored[field];
  }
  return next;
}

/**
 * The `shot.setMeta` that writes a draft over a shot's stored value. Only the edited fields are checked, with the
 * engine's own strict check, so a value the load kept as unknown is refused until the writer picks a listed one, and
 * an unknown field the load already dropped is not revived. The guard `expect` is the value the node holds now.
 */
export function shotEditCommand(state: ProjectState, shotId: string, draft: ShotDraft): StoryboardResult<ShotCommand> {
  const node = nodeById(state, shotId);
  if (node === undefined || !isShotNode(node)) return refused('not-a-shot', t`no shot "${shotId}" to edit`);
  const raw = shotFieldOf(node);
  const base: Record<string, unknown> = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};

  for (const field of EDITABLE_FIELDS) {
    if (field === 'durationSec') {
      const text = draft.durationSec.trim();
      if (text === '') {
        delete base.durationSec;
        continue;
      }
      const seconds = Number(text);
      if (!Number.isFinite(seconds) || seconds < 0) return refused('duration-invalid', t`The duration is a number of seconds, at least zero`);
      base.durationSec = seconds;
      continue;
    }
    const text = draft[field];
    if (text === '') delete base[field];
    else base[field] = text;
  }

  // Only the fields this edit writes are checked. A value the load kept as unknown and the writer did not touch is
  // still in `base`, so it is checked too, which is the refusal the writer needs to see.
  const touched = Object.fromEntries(EDITABLE_FIELDS.filter((field) => field in base).map((field) => [field, base[field]]));
  const refusal = checkShotMeta(touched);
  if (refusal !== undefined) return { ok: false, refusal };

  const stored = storedValueOf(readShotMeta(base));
  const empty = stored === null || typeof stored !== 'object' || Object.keys(stored).length === 0;
  return {
    ok: true,
    value: {
      name: 'shot.setMeta',
      params: {
        nodeId: shotId,
        stored: empty ? null : (stored as Readonly<Record<string, unknown>>),
        expect: raw === undefined ? null : raw,
      },
    },
  };
}
