/**
 * The script and dialogue commands: the two imports and the dialogue container's settings
 * ([screenplay.md §2.2](../../../docs/architecture/screenplay.md), [dialogue-narrative.md §2.1 and §4](../../../docs/architecture/dialogue-narrative.md)).
 *
 * - `screenplay.import` maps a whole Fountain or FDX file onto the binder: sections become folders and scenes become
 *   screenplay documents, in one undo group. The store parses the text, because it depends on the screenplay engine.
 * - `dialogue.importInk` creates one dialogue container per container of an Ink plan. The plan is made by the caller
 *   with `planInkImport` (`@caotang/dialogue`), because that package depends on the store and the store cannot depend
 *   back on it. The command takes the planned containers, so the import is still one undoable command.
 * - `dialogue.setMeta` writes a container's settings: its default speaker, engine target, line-id opt-in and locale.
 *
 * Both imports are write-confirm for the agent: they bring in a whole file's worth of nodes, and the writer should see
 * the file before it lands. The settings change is write-auto, as `binder.setMeta` is.
 */

import type { CommandDescriptor, ValidationNode, ValidationSnapshot } from './command.js';
import {
  invalid,
  isContainer,
  isRecord,
  limitExceeded,
  notFound,
  requireDeclaredParams,
  requireNode,
  requireNonBlankString,
  requireString,
} from './params.js';
import { ok, type CommandError, type Result } from './result.js';

/** The formats `screenplay.import` reads. Fountain is the plain-text source; FDX is Final Draft's XML. */
export const SCREENPLAY_IMPORT_FORMATS = ['fountain', 'fdx'] as const;

// The param shapes are type aliases, not interfaces: the bus's params table and the store's tests need each one to be
// assignable to `Record<string, unknown>`, which an interface is not (BinderSaveFilterParams takes the same form).

/** The codex types an import seed may take: the characters and places a script file lists (issue #265). */
export const SCREENPLAY_IMPORT_SEED_TYPES = ['character', 'location'] as const;

/** One codex entry the writer ticked in the import dialog: a name the file lists, its type and an optional description. */
export type ScreenplayImportSeed = {
  readonly name: string;
  readonly type: (typeof SCREENPLAY_IMPORT_SEED_TYPES)[number];
  readonly description?: string;
};

/** `screenplay.import`'s params, as the validator returns them. `parentId` is always resolved to an id. */
export type ScreenplayImportParams = {
  readonly format: (typeof SCREENPLAY_IMPORT_FORMATS)[number];
  /** The file's text: Fountain source, or the FDX XML. */
  readonly text: string;
  /** The folder the import lands in. The manuscript when the caller names none. */
  readonly parentId?: string;
  /**
   * Codex entries to create in the same undo step (issue #265): the cast and location rows the writer ticked. Each
   * attaches to the first imported scene that names it; a name the codex already holds is skipped, never merged.
   */
  readonly codex?: readonly ScreenplayImportSeed[];
};

/** One planned container of an Ink import: its title (the first knot's name) and its Ink body. */
export type InkContainerParams = {
  readonly title: string;
  readonly body: string;
};

/** `dialogue.importInk`'s params: the containers an Ink plan made, in order, and the folder they land in. */
export type DialogueImportInkParams = {
  readonly containers: readonly InkContainerParams[];
  readonly parentId?: string;
};

/** The settings a dialogue container holds (dialogue-narrative.md §2.1). `null` clears one. */
export type DialogueMetaPatch = {
  /** A codex entry id: the default speaker for a line with no `Name:` prefix. */
  readonly speaker?: string | null;
  readonly engineTarget?: (typeof DIALOGUE_ENGINE_TARGETS)[number] | null;
  /** Opt-in: the save path mints `lineId` tags for lines that lack one (dialogue-narrative.md A3). */
  readonly autoLineIds?: boolean;
  /** The locale code of the authored language. */
  readonly locBaseline?: string | null;
};

/** `dialogue.setMeta`'s params: the container and the settings to change. */
export type DialogueSetMetaParams = {
  readonly nodeId: string;
  readonly patch: DialogueMetaPatch;
};

/** A whole script file, in characters. A 110-page script is well under this. */
export const SCREENPLAY_IMPORT_TEXT_MAX = 1_000_000;

/** The codex seeds one `screenplay.import` may create: a large ensemble cast and its places, well past `codex.import`'s 20. */
export const SCREENPLAY_IMPORT_SEEDS_MAX = 500;

/** A seed's name and description, in characters: the codex's own limits (`CODEX_NAME_MAX`, `CODEX_DESCRIPTION_MAX`). */
const SEED_NAME_MAX = 120;
const SEED_DESCRIPTION_MAX = 2000;

/** The keys a seed may carry. */
const SEED_KEYS: ReadonlySet<string> = new Set(['name', 'type', 'description']);

/** The Ink containers one `dialogue.importInk` call may create. A story of this size is split across calls. */
export const DIALOGUE_IMPORT_CONTAINERS_MAX = 200;

/** The Ink text of one import, summed over its containers, in characters. */
export const DIALOGUE_IMPORT_TEXT_MAX = 1_000_000;

/** A container's title, in characters: the first knot's name, which the binder shows. */
export const DIALOGUE_TITLE_MAX = 200;

/**
 * The engine targets a container may name (dialogue-narrative.md §2.1). The dialogue package's `ENGINE_TARGETS` is the
 * same list; it cannot be imported here, because the dialogue package depends on the bus. Its parity test pins the two.
 */
export const DIALOGUE_ENGINE_TARGETS = ['ink-json', 'yarn-csv', 'generic-csv'] as const;

/** The keys `dialogue.setMeta`'s patch may carry. The dialogue package's `DialogueContainerMeta` is the same set. */
export const DIALOGUE_META_KEYS = ['speaker', 'engineTarget', 'autoLineIds', 'locBaseline'] as const;

/** The longest locale code a container takes, in characters (a BCP 47 tag in practice is far shorter). */
const LOCALE_MAX = 35;

/** A locale code: a language subtag, then any number of subtags. `en`, `en-GB` and `pt_BR` all pass. */
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8})*$/;

/** The default parent of an import: the manuscript, which every project holds (ui-modules §2.1). */
const DEFAULT_IMPORT_PARENT = 'manuscript';

/**
 * The parent an import lands in. Absent means the manuscript. Otherwise it is a folder that holds children and is not a
 * storyboard, because a storyboard holds only shots (storyboard.md §2.1) and the imported nodes are scenes and folders.
 */
function importParentOf(snapshot: ValidationSnapshot, params: Record<string, unknown>): Result<string, CommandError> {
  if (params['parentId'] === undefined) {
    const manuscript = requireNode(snapshot, { parentId: DEFAULT_IMPORT_PARENT }, 'parentId');
    if (!manuscript.ok) return manuscript;
    return ok(manuscript.value.id);
  }
  const parent = requireNode(snapshot, params, 'parentId');
  if (!parent.ok) return parent;
  const node: ValidationNode = parent.value;
  if (node.id === 'root') {
    return invalid(
      'the project root is not a place for a node: the binder shows only the manuscript and research, so an import made here would never appear',
      'import under "manuscript" or "research", or under a folder inside one of them',
      'parentId',
    );
  }
  if (!isContainer(node)) {
    return invalid(
      `parent "${node.id}" is a ${node.type} and cannot hold children`,
      'import under a folder: only folders hold children',
      'parentId',
    );
  }
  if (node.type === 'folder' && node.kind === 'storyboard') {
    return invalid(
      `"${node.id}" is a storyboard, and a storyboard holds only shots`,
      'import under a folder beside the storyboard, not inside it',
      'parentId',
    );
  }
  return ok(node.id);
}

/** The codex seeds of `screenplay.import`, checked whole: absent is none, and an empty list is the same as none. */
function importSeedsOf(value: unknown): Result<readonly ScreenplayImportSeed[] | undefined, CommandError> {
  if (value === undefined) return ok(undefined);
  if (!Array.isArray(value)) {
    return invalid(`params.codex must be an array, got ${typeof value}`, 'pass the ticked rows, each as { name, type }', 'codex');
  }
  if (value.length > SCREENPLAY_IMPORT_SEEDS_MAX) {
    return limitExceeded(
      `the import names ${value.length} codex entries, limit ${SCREENPLAY_IMPORT_SEEDS_MAX}`,
      'tick fewer rows; the rest can be added in the codex later',
      'codex',
    );
  }
  const seeds: ScreenplayImportSeed[] = [];
  for (const [index, item] of value.entries()) {
    const where = `codex[${index}]`;
    if (!isRecord(item)) return invalid(`params.${where} must be an object`, 'pass each row as { name, type }', where);
    const extra = Object.keys(item).find((key) => !SEED_KEYS.has(key));
    if (extra !== undefined) return invalid(`params.${where} has an unknown key "${extra}"`, 'a row carries only name, type and description', `${where}.${extra}`);
    const name = requireNonBlankString(item, 'name', { maxChars: SEED_NAME_MAX, blankHint: 'give each codex row a name' });
    if (!name.ok) return { ok: false, error: { ...name.error, message: `${where}: ${name.error.message}`, target: `${where}.name` } };
    const type = item['type'];
    if (typeof type !== 'string' || !(SCREENPLAY_IMPORT_SEED_TYPES as readonly string[]).includes(type)) {
      return invalid(`params.${where}.type must be "character" or "location"`, 'a script file lists characters and places', `${where}.type`);
    }
    const description = item['description'];
    if (description !== undefined && (typeof description !== 'string' || [...description].length > SEED_DESCRIPTION_MAX)) {
      return invalid(
        `params.${where}.description must be a string of at most ${SEED_DESCRIPTION_MAX} characters`,
        'shorten the description or leave it out',
        `${where}.description`,
      );
    }
    seeds.push({
      name: name.value.trim(),
      type: type as ScreenplayImportSeed['type'],
      ...(typeof description === 'string' && description.trim() !== '' ? { description: description.trim() } : {}),
    });
  }
  return ok(seeds.length === 0 ? undefined : seeds);
}

/** The shape `screenplay.import` takes, with the parent resolved to an id. */
export const screenplayImport: CommandDescriptor<ScreenplayImportParams> = {
  mutates: 'project',
  agentRisk: 'write-confirm',
  undo: 'compensable',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('screenplay.import', params);
    if (!p.ok) return p;
    const format = requireString(p.value, 'format');
    if (!format.ok) return format;
    if (!(SCREENPLAY_IMPORT_FORMATS as readonly string[]).includes(format.value)) {
      return invalid(
        `params.format must be "fountain" or "fdx", got "${format.value}"`,
        'pass "fountain" for a .fountain file and "fdx" for a .fdx file',
        'format',
      );
    }
    const text = requireNonBlankString(p.value, 'text', {
      maxChars: SCREENPLAY_IMPORT_TEXT_MAX,
      blankHint: 'pass the text of the script file: a blank file has no scenes to import',
    });
    if (!text.ok) return text;
    const parent = importParentOf(snapshot, p.value);
    if (!parent.ok) return parent;
    const codex = importSeedsOf(p.value['codex']);
    if (!codex.ok) return codex;
    return ok({
      format: format.value as ScreenplayImportParams['format'],
      text: text.value,
      parentId: parent.value,
      ...(codex.value === undefined ? {} : { codex: codex.value }),
    });
  },
};

/** The shape `dialogue.importInk` takes: the planned containers, each with its title and Ink body. */
export const dialogueImportInk: CommandDescriptor<DialogueImportInkParams> = {
  mutates: 'project',
  agentRisk: 'write-confirm',
  undo: 'compensable',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('dialogue.importInk', params);
    if (!p.ok) return p;
    const parent = importParentOf(snapshot, p.value);
    if (!parent.ok) return parent;
    const list = p.value['containers'];
    if (!Array.isArray(list)) {
      return invalid(
        `params.containers must be an array, got ${list === undefined ? 'nothing' : typeof list}`,
        'pass the containers of an Ink plan, each as { title, body }',
        'containers',
      );
    }
    if (list.length === 0) {
      return invalid(
        'the import holds no containers, so there is nothing to create',
        'plan the Ink file first: a story with no knots makes no containers',
        'containers',
      );
    }
    if (list.length > DIALOGUE_IMPORT_CONTAINERS_MAX) {
      return limitExceeded(
        `the import holds ${list.length} containers, limit ${DIALOGUE_IMPORT_CONTAINERS_MAX}`,
        `import the story in parts of at most ${DIALOGUE_IMPORT_CONTAINERS_MAX} containers`,
        'containers',
      );
    }
    let totalChars = 0;
    const containers: { title: string; body: string }[] = [];
    for (const [i, item] of list.entries()) {
      const at = `containers[${i}]`;
      if (!isRecord(item)) {
        return invalid(`${at} must be an object with a title and a body`, 'each container is { title, body }', at);
      }
      for (const key of Object.keys(item)) {
        if (key !== 'title' && key !== 'body') {
          return invalid(`${at}.${key} is not a container field`, `a container carries only title and body`, `${at}.${key}`);
        }
      }
      const title = item['title'];
      if (typeof title !== 'string' || title.trim() === '') {
        return invalid(`${at}.title must be a non-blank string`, 'name each container after its first knot', `${at}.title`);
      }
      if ([...title].length > DIALOGUE_TITLE_MAX) {
        return limitExceeded(`${at}.title is longer than ${DIALOGUE_TITLE_MAX} characters`, 'shorten the knot name', `${at}.title`);
      }
      const body = item['body'];
      if (typeof body !== 'string' || body.trim() === '') {
        return invalid(`${at}.body must be non-blank Ink text`, 'a container with no Ink has nothing to hold', `${at}.body`);
      }
      totalChars += body.length;
      containers.push({ title, body });
    }
    if (totalChars > DIALOGUE_IMPORT_TEXT_MAX) {
      return limitExceeded(
        `the import's Ink text is ${totalChars} characters, limit ${DIALOGUE_IMPORT_TEXT_MAX}`,
        'import the story in parts',
        'containers',
      );
    }
    return ok({ containers, parentId: parent.value });
  },
};

/** The settings `dialogue.setMeta` may change, with their checks. The codex is read for the speaker. */
export const dialogueSetMeta: CommandDescriptor<DialogueSetMetaParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'compensable',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('dialogue.setMeta', params);
    if (!p.ok) return p;
    const node = requireNode(snapshot, p.value, 'nodeId');
    if (!node.ok) return node;
    if (node.value.type !== 'dialogue') {
      return invalid(
        `"${node.value.id}" is a ${node.value.type}, and only a dialogue container holds these settings`,
        'choose the dialogue container whose settings to change',
        'nodeId',
      );
    }
    const patch = p.value['patch'];
    if (!isRecord(patch)) {
      return invalid(
        `params.patch must be an object, got ${patch === undefined ? 'nothing' : typeof patch}`,
        `pass a patch with any of: ${DIALOGUE_META_KEYS.join(', ')}`,
        'patch',
      );
    }
    for (const key of Object.keys(patch)) {
      if (!(DIALOGUE_META_KEYS as readonly string[]).includes(key)) {
        return invalid(
          `params.patch.${key} is not a dialogue setting`,
          `a patch carries only: ${DIALOGUE_META_KEYS.join(', ')}`,
          `patch.${key}`,
        );
      }
    }
    if (Object.keys(patch).length === 0) {
      return invalid('the patch changes nothing', `name at least one of: ${DIALOGUE_META_KEYS.join(', ')}`, 'patch');
    }
    const typed: {
      speaker?: string | null;
      engineTarget?: (typeof DIALOGUE_ENGINE_TARGETS)[number] | null;
      autoLineIds?: boolean;
      locBaseline?: string | null;
    } = {};
    if (patch['speaker'] !== undefined) {
      const speaker = patch['speaker'];
      if (speaker === null) {
        typed.speaker = null;
      } else if (typeof speaker !== 'string') {
        return invalid('patch.speaker must be a codex entry id, or null to clear it', 'pass the id of a codex character', 'patch.speaker');
      } else {
        const entry = (snapshot.manifest.codex ?? []).find((e) => e.id === speaker);
        if (entry === undefined) {
          return notFound(
            `no codex entry has id "${speaker}"`,
            'name a character in the codex, or clear the speaker with null',
            'patch.speaker',
          );
        }
        typed.speaker = speaker;
      }
    }
    if (patch['engineTarget'] !== undefined) {
      const target = patch['engineTarget'];
      if (target === null) {
        typed.engineTarget = null;
      } else if (typeof target === 'string' && (DIALOGUE_ENGINE_TARGETS as readonly string[]).includes(target)) {
        typed.engineTarget = target as (typeof DIALOGUE_ENGINE_TARGETS)[number];
      } else {
        return invalid(
          `patch.engineTarget must be one of ${DIALOGUE_ENGINE_TARGETS.join(', ')}, or null`,
          'pass the engine the container compiles for, or null for no hint',
          'patch.engineTarget',
        );
      }
    }
    if (patch['autoLineIds'] !== undefined) {
      if (typeof patch['autoLineIds'] !== 'boolean') {
        return invalid('patch.autoLineIds must be true or false', 'pass true to mint line ids on save, or false', 'patch.autoLineIds');
      }
      typed.autoLineIds = patch['autoLineIds'];
    }
    if (patch['locBaseline'] !== undefined) {
      const locale = patch['locBaseline'];
      if (locale === null) {
        typed.locBaseline = null;
      } else if (typeof locale !== 'string' || locale.trim() === '') {
        return invalid('patch.locBaseline must be a locale code, or null to clear it', 'pass a locale such as "en" or "en-GB"', 'patch.locBaseline');
      } else {
        const trimmed = locale.trim();
        if ([...trimmed].length > LOCALE_MAX || !LOCALE_PATTERN.test(trimmed)) {
          return invalid(
            `patch.locBaseline "${trimmed}" is not a locale code`,
            'pass a language code with optional subtags, such as "en" or "en-GB"',
            'patch.locBaseline',
          );
        }
        typed.locBaseline = trimmed;
      }
    }
    return ok({ nodeId: node.value.id, patch: typed });
  },
};
