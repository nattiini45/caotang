/**
 * Project export: the descriptors of the project block, the saved export recipes, the vocabulary and the cover
 * import. Their applies are the store's (`packages/store/src/commands-project.ts`), and they are reached through the
 * same registry as the rest of the closed set (`registry.ts`).
 *
 * The rules a validator enforces are quoted from the spec that states them: epub-metadata.md for the project block
 * (the language tag, the ISBN check digit and its ONIX form), exporter.md §2 for the recipe shape and project-format.md
 * §2 for the vocabulary. Validation is pure and total (command-bus §2): the snapshot is read, never written.
 */

import { err, ok, type CommandError, type Result } from './result.js';
import type {
  CommandDescriptor,
  ProjectImportAssetParams,
  ProjectRenameParams,
  ProjectSetMetadataParams,
  RecipeDeleteParams,
  RecipeOptionsParams,
  RecipeSaveParams,
  ValidationSnapshot,
  VocabularyKind,
  VocabularyRemoveParams,
  VocabularyUpsertParams,
} from './command.js';
import {
  invalid,
  isRecord,
  notFound,
  requireDeclaredParams,
  requireNonBlankString,
  requireStringArray,
  showValue,
} from './params.js';
import { EXPORT_FORMATS } from './descriptors.js';
import { recipeNameMissing } from './recipe-names.js';

/** The longest project title a writer may give. The title is shown on the title page and in the EPUB `dc:title`. */
export const PROJECT_TITLE_MAX = 200;
/** A vocabulary term's name. Long enough for a sentence-cased label, short enough for a menu. */
export const VOCABULARY_NAME_MAX = 40;
/** A saved recipe's name, which is also the stem of the file a recipe compiles to. */
export const RECIPE_NAME_MAX = 80;
/** An author's name on the title page. */
export const AUTHOR_MAX = 200;
/**
 * The largest character limit a recipe may set for the dialogue table (dialogue-narrative.md §4). A subtitle line runs to tens of
 * characters, so the cap only refuses a value that is a typo for another one; the exporter accepts any whole number above zero.
 */
export const CHAR_LIMIT_MAX = 10_000;

/** BCP-47 as far as a writer needs it: a primary subtag and any number of subtags after it (`en`, `en-GB`, `zh-Hant-TW`). */
const LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
/** The shape of an asset id (storyboard.md §2.2: `a_` and ten Crockford base32 characters). */
export const ASSET_ID_PATTERN = /^a_[0-9A-HJKMNP-TV-Z]{10}$/;

/** The keys `project.setMetadata` accepts in its patch. A fifth key is refused, not dropped. */
export const METADATA_PATCH_KEYS = ['author', 'language', 'isbn', 'coverAssetId'] as const;

/**
 * The keys a recipe's options carry (exporter.md §2; `charLimit` is dialogue-narrative.md §4's column, made a recipe option;
 * `sceneNumbers`, `continued` and `scriptFont` are the screenplay PDF's options, screenplay.md §5.3; `pageSize` is the paper of both PDFs
 * (Letter for the screenplay PDF, A4 for the contact sheet when it is absent) and `paperFrames` the contact sheet's blank frames,
 * storyboard.md §6; `colourEmoji` is both PDFs' colour emoji, screenplay.md §5.3).
 */
const RECIPE_OPTION_KEYS = ['titlePage', 'toc', 'author', 'charLimit', 'sceneNumbers', 'continued', 'pageSize', 'scriptFont', 'paperFrames', 'colourEmoji'] as const;

/** Where the screenplay PDF may print scene numbers (screenplay.md §5.3). */
export const SCENE_NUMBER_OPTIONS = ['off', 'left', 'right', 'both'] as const;

/**
 * The same placements as one type, derived from the list so the two cannot drift
 * inside the bus (issue #29: the union was a second literal copy, and a placement
 * added to the list would not have been a compile error at the type).
 */
export type SceneNumbersOption = (typeof SCENE_NUMBER_OPTIONS)[number];

/** The papers the PDFs are drawn on (screenplay.md §5.3, storyboard.md §6). */
export const RECIPE_PAGE_SIZES = ['A4', 'Letter'] as const;

/** The Latin faces of the screenplay PDF (screenplay.md §5.3). The screenplay package holds the same list; a test keeps the two equal. */
export const RECIPE_SCRIPT_FONTS = ['courier-prime', 'courier', 'cousine'] as const;

export type RecipeScriptFont = (typeof RECIPE_SCRIPT_FONTS)[number];

const VOCABULARY_KINDS: readonly VocabularyKind[] = ['status', 'label'];

/* ------------------------------------------------------------------ *
 * ISBN: the check digit and the ONIX form (epub-metadata.md)
 * ------------------------------------------------------------------ */

/**
 * A writer's ISBN, as an EPUB identifier: `urn:isbn:` and thirteen digits, or `undefined` when the text is not an ISBN.
 *
 * Hyphens and spaces are ignored. An ISBN-10 is converted to ISBN-13, because the EPUB refines meta names the ONIX code
 * for ISBN-13 (`onix:codelist5` value 15), and a single form keeps the package document honest.
 */
export function normalizeIsbn(input: string): string | undefined {
  const compact = input.replace(/[\s-]/g, '').toUpperCase();
  if (/^\d{13}$/.test(compact)) return isbn13Valid(compact) ? `urn:isbn:${compact}` : undefined;
  if (/^\d{9}[\dX]$/.test(compact)) {
    if (!isbn10Valid(compact)) return undefined;
    const body = `978${compact.slice(0, 9)}`;
    return `urn:isbn:${body}${isbn13CheckDigit(body)}`;
  }
  return undefined;
}

function isbn13Valid(digits: string): boolean {
  return isbn13CheckDigit(digits.slice(0, 12)) === digits.slice(12);
}

/** The ISBN-13 check digit for the first twelve digits: weights 1 and 3, alternating. */
function isbn13CheckDigit(twelve: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(twelve[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}

function isbn10Valid(code: string): boolean {
  let sum = 0;
  for (let i = 0; i < 10; i += 1) {
    const ch = code[i] ?? '';
    const value = ch === 'X' ? 10 : Number(ch);
    sum += value * (10 - i);
  }
  return sum % 11 === 0;
}

/* ------------------------------------------------------------------ *
 * Shared small checks
 * ------------------------------------------------------------------ */

/** The optional recipe options, typed. An unknown key or a wrong type is refused, so an option cannot be silently lost. */
function recipeOptionsOf(value: unknown): Result<RecipeOptionsParams | undefined, CommandError> {
  if (value === undefined) return ok(undefined);
  if (!isRecord(value)) {
    return invalid(`params.options must be an object, got ${showValue(value)}`, `pass any of: ${RECIPE_OPTION_KEYS.join(', ')}`, 'options');
  }
  for (const key of Object.keys(value)) {
    if (!(RECIPE_OPTION_KEYS as readonly string[]).includes(key)) {
      return invalid(
        `params.options.${key} is not a recipe option`,
        `a recipe's options carry only: ${RECIPE_OPTION_KEYS.join(', ')}`,
        `options.${key}`,
      );
    }
  }
  const typed: RecipeOptionsParams = {};
  for (const flag of ['titlePage', 'toc', 'continued', 'paperFrames', 'colourEmoji'] as const) {
    const v = value[flag];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') return invalid(`params.options.${flag} must be true or false, got ${showValue(v)}`, undefined, `options.${flag}`);
    typed[flag] = v;
  }
  const author = value['author'];
  if (author !== undefined) {
    if (typeof author !== 'string') {
      return invalid(`params.options.author must be a string, got ${showValue(author)}`, undefined, 'options.author');
    }
    if (author.length > AUTHOR_MAX) {
      return invalid(`params.options.author is longer than ${AUTHOR_MAX} characters`, 'shorten the author line', 'options.author');
    }
    typed.author = author.trim();
  }
  const charLimit = value['charLimit'];
  if (charLimit !== undefined) {
    if (!Number.isSafeInteger(charLimit) || (charLimit as number) < 1 || (charLimit as number) > CHAR_LIMIT_MAX) {
      return invalid(
        `params.options.charLimit must be a whole number of characters from 1 to ${CHAR_LIMIT_MAX}, got ${showValue(charLimit)}`,
        'pass a limit such as 42, or leave it out for no limit',
        'options.charLimit',
      );
    }
    typed.charLimit = charLimit as number;
  }
  const sceneNumbers = value['sceneNumbers'];
  if (sceneNumbers !== undefined) {
    if (typeof sceneNumbers !== 'string' || !(SCENE_NUMBER_OPTIONS as readonly string[]).includes(sceneNumbers)) {
      return invalid(
        `params.options.sceneNumbers must be one of ${SCENE_NUMBER_OPTIONS.join(', ')}, got ${showValue(sceneNumbers)}`,
        `pass one of ${SCENE_NUMBER_OPTIONS.join(', ')}`,
        'options.sceneNumbers',
      );
    }
    typed.sceneNumbers = sceneNumbers as (typeof SCENE_NUMBER_OPTIONS)[number];
  }
  const pageSize = value['pageSize'];
  if (pageSize !== undefined) {
    if (pageSize !== 'A4' && pageSize !== 'Letter') {
      return invalid(
        `params.options.pageSize must be one of ${RECIPE_PAGE_SIZES.join(', ')}, got ${showValue(pageSize)}`,
        `pass ${RECIPE_PAGE_SIZES.join(' or ')}, or leave it out for the format's own paper (Letter for the screenplay PDF, A4 for the contact sheet)`,
        'options.pageSize',
      );
    }
    typed.pageSize = pageSize;
  }
  const scriptFont = value['scriptFont'];
  if (scriptFont !== undefined) {
    if (typeof scriptFont !== 'string' || !(RECIPE_SCRIPT_FONTS as readonly string[]).includes(scriptFont)) {
      return invalid(
        `params.options.scriptFont must be one of ${RECIPE_SCRIPT_FONTS.join(', ')}, got ${showValue(scriptFont)}`,
        `pass one of ${RECIPE_SCRIPT_FONTS.join(', ')}, or leave it out for courier-prime`,
        'options.scriptFont',
      );
    }
    typed.scriptFont = scriptFont as (typeof RECIPE_SCRIPT_FONTS)[number];
  }
  return ok(typed);
}

/* ------------------------------------------------------------------ *
 * project.rename
 * ------------------------------------------------------------------ */

export const projectRename: CommandDescriptor<ProjectRenameParams> = {
  mutates: 'project',
  agentRisk: 'write-confirm',
  undo: 'inverse',
  validate: (params) => {
    const p = requireDeclaredParams('project.rename', params);
    if (!p.ok) return p;
    const title = requireNonBlankString(p.value, 'title', { maxChars: PROJECT_TITLE_MAX, blankHint: 'give the project a name' });
    if (!title.ok) return title;
    return ok({ title: title.value.trim() });
  },
};

/* ------------------------------------------------------------------ *
 * project.setMetadata
 * ------------------------------------------------------------------ */

export const projectSetMetadata: CommandDescriptor<ProjectSetMetadataParams> = {
  mutates: 'project',
  agentRisk: 'write-confirm',
  undo: 'inverse',
  validate: (params) => {
    const p = requireDeclaredParams('project.setMetadata', params);
    if (!p.ok) return p;
    const patch = p.value['patch'];
    if (!isRecord(patch)) {
      return invalid(
        `params.patch must be an object, got ${showValue(patch)}`,
        `pass any of: ${METADATA_PATCH_KEYS.join(', ')}`,
        'patch',
      );
    }
    for (const key of Object.keys(patch)) {
      if (!(METADATA_PATCH_KEYS as readonly string[]).includes(key)) {
        return invalid(
          `params.patch.${key} is not a project field`,
          `a project patch carries only: ${METADATA_PATCH_KEYS.join(', ')}`,
          `patch.${key}`,
        );
      }
    }
    const typed: ProjectSetMetadataParams['patch'] = {};

    if (patch['author'] !== undefined) {
      const author = patch['author'];
      if (author !== null && typeof author !== 'string') {
        return invalid(`params.patch.author must be a string or null, got ${showValue(author)}`, undefined, 'patch.author');
      }
      const trimmed = author === null ? '' : author.trim();
      if (trimmed.length > AUTHOR_MAX) {
        return invalid(`the author is longer than ${AUTHOR_MAX} characters`, 'shorten the author line', 'patch.author');
      }
      typed.author = trimmed === '' ? null : trimmed;
    }

    if (patch['language'] !== undefined) {
      const language = patch['language'];
      if (typeof language !== 'string' || !LANGUAGE_PATTERN.test(language.trim())) {
        return invalid(
          `${showValue(language)} is not a language tag`,
          'use a BCP-47 tag such as en, de or en-GB',
          'patch.language',
        );
      }
      typed.language = language.trim();
    }

    if (patch['isbn'] !== undefined) {
      const isbn = patch['isbn'];
      if (isbn === null || (typeof isbn === 'string' && isbn.trim() === '')) {
        typed.isbn = null;
      } else if (typeof isbn !== 'string') {
        return invalid(`params.patch.isbn must be a string or null, got ${showValue(isbn)}`, undefined, 'patch.isbn');
      } else {
        const urn = normalizeIsbn(isbn);
        if (urn === undefined) {
          return invalid(
            `${showValue(isbn)} is not an ISBN with a valid check digit`,
            'type the ISBN as printed (ISBN-10 or ISBN-13, hyphens allowed), or clear it',
            'patch.isbn',
          );
        }
        typed.isbn = urn;
      }
    }

    if (patch['coverAssetId'] !== undefined) {
      const cover = patch['coverAssetId'];
      if (cover !== null && (typeof cover !== 'string' || !ASSET_ID_PATTERN.test(cover))) {
        return invalid(
          `${showValue(cover)} is not an asset id`,
          'choose the cover image in the project panel, or clear the cover with null',
          'patch.coverAssetId',
        );
      }
      typed.coverAssetId = cover;
    }

    if (Object.keys(typed).length === 0) {
      return invalid('the patch sets nothing', `name at least one of: ${METADATA_PATCH_KEYS.join(', ')}`, 'patch');
    }
    return ok({ patch: typed });
  },
};

/* ------------------------------------------------------------------ *
 * project.importAsset
 * ------------------------------------------------------------------ */

/**
 * The bytes are staged by the host and named here, so a JSON param never carries an image. An agent has no way to stage
 * bytes, so its call is refused as not-found before anything is written; `write-confirm` (not `never`) because the image
 * is a file the writer chose, and the gate should ask rather than hard-deny a writer's own cover.
 */
export const projectImportAsset: CommandDescriptor<ProjectImportAssetParams> = {
  mutates: 'project',
  agentRisk: 'write-confirm',
  undo: 'inverse',
  asyncApply: true,
  validate: (params) => {
    const p = requireDeclaredParams('project.importAsset', params);
    if (!p.ok) return p;
    const stagingId = requireNonBlankString(p.value, 'stagingId', { maxChars: 64 });
    if (!stagingId.ok) return stagingId;
    if (p.value['target'] !== 'cover') {
      return invalid(
        `${showValue(p.value['target'])} is not an import target`,
        'the only target this build takes is "cover"',
        'target',
      );
    }
    return ok({ stagingId: stagingId.value, target: 'cover' as const });
  },
};

/* ------------------------------------------------------------------ *
 * vocabulary.upsert and vocabulary.remove
 * ------------------------------------------------------------------ */

function termsOf(snapshot: ValidationSnapshot, kind: VocabularyKind): readonly { readonly id: string; readonly name?: string }[] {
  return kind === 'status' ? snapshot.manifest.vocabulary.statuses : snapshot.manifest.vocabulary.labels;
}

function vocabularyKindOf(params: Record<string, unknown>): Result<VocabularyKind, CommandError> {
  const kind = params['kind'];
  if (typeof kind === 'string' && (VOCABULARY_KINDS as readonly string[]).includes(kind)) return ok(kind as VocabularyKind);
  return invalid(`${showValue(kind)} is not a vocabulary`, `use one of: ${VOCABULARY_KINDS.join(', ')}`, 'kind');
}

export const vocabularyUpsert: CommandDescriptor<VocabularyUpsertParams> = {
  mutates: 'project',
  agentRisk: 'write-confirm',
  undo: 'inverse',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('vocabulary.upsert', params);
    if (!p.ok) return p;
    const kind = vocabularyKindOf(p.value);
    if (!kind.ok) return kind;
    const name = requireNonBlankString(p.value, 'name', { maxChars: VOCABULARY_NAME_MAX, blankHint: 'give the term a name' });
    if (!name.ok) return name;
    const color = p.value['color'];
    if (typeof color !== 'string' || !HEX_COLOR_PATTERN.test(color)) {
      return invalid(`${showValue(color)} is not a colour`, 'use a hex colour such as #3fa66a', 'color');
    }
    const id = p.value['id'];
    if (id !== undefined && (typeof id !== 'string' || id.trim() === '')) {
      return invalid('params.id must be a non-blank string when given', 'omit id to create a new term', 'id');
    }
    const terms = termsOf(snapshot, kind.value);
    if (id !== undefined && !terms.some((term) => term.id === id)) {
      return notFound(`there is no ${kind.value} with id "${id}" to update`, `omit id to create a new ${kind.value}`, 'id');
    }
    const wanted = name.value.trim().toLowerCase();
    const clash = terms.find((term) => term.id !== id && (term.name ?? '').trim().toLowerCase() === wanted);
    if (clash !== undefined) {
      return invalid(
        `a ${kind.value} named "${name.value.trim()}" already exists`,
        `pick another name, or rename "${clash.name ?? clash.id}" instead`,
        'name',
      );
    }
    return ok({
      kind: kind.value,
      ...(id === undefined ? {} : { id: id as string }),
      name: name.value.trim(),
      color: color.toLowerCase(),
    });
  },
};

export const vocabularyRemove: CommandDescriptor<VocabularyRemoveParams> = {
  mutates: 'project',
  agentRisk: 'write-confirm',
  undo: 'compensable',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('vocabulary.remove', params);
    if (!p.ok) return p;
    const kind = vocabularyKindOf(p.value);
    if (!kind.ok) return kind;
    const id = requireNonBlankString(p.value, 'id', { maxChars: 64 });
    if (!id.ok) return id;
    if (!termsOf(snapshot, kind.value).some((term) => term.id === id.value)) {
      return notFound(`there is no ${kind.value} with id "${id.value}"`, `the ${kind.value}s are listed in the vocabulary editor`, 'id');
    }
    return ok({ kind: kind.value, id: id.value });
  },
};

/* ------------------------------------------------------------------ *
 * recipe.save and recipe.delete
 * ------------------------------------------------------------------ */

/*
 * `recipeNameMissing` is defined in recipe-names.ts, which the export descriptors import as well. It is re-exported here so the
 * `projectCommands` namespace keeps every recipe check in one place it can be read from. `recipe.delete` and an export check the same
 * list, which is the stored one or, for a project that stores none, the default the exporter offers: the delete's apply stores that
 * default before it removes it, so the delete writes an empty list.
 */
export { recipeNameMissing } from './recipe-names.js';

export const recipeSave: CommandDescriptor<RecipeSaveParams> = {
  mutates: 'project',
  agentRisk: 'write-confirm',
  undo: 'inverse',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('recipe.save', params);
    if (!p.ok) return p;
    const name = requireNonBlankString(p.value, 'name', { maxChars: RECIPE_NAME_MAX, blankHint: 'name the recipe' });
    if (!name.ok) return name;
    const includeRootIds = requireStringArray(p.value, 'includeRootIds');
    if (!includeRootIds.ok) return includeRootIds;
    if (includeRootIds.value.length === 0) {
      return invalid('a recipe selects at least one node', 'name the manuscript or a folder to export', 'includeRootIds');
    }
    for (const id of includeRootIds.value) {
      if (!snapshot.manifest.tree.some((node) => node.id === id)) {
        return notFound(`the recipe selects "${id}", which is not in the project`, 'select nodes that exist', 'includeRootIds');
      }
    }
    const format = requireNonBlankString(p.value, 'format');
    if (!format.ok) return format;
    if (!(EXPORT_FORMATS as readonly string[]).includes(format.value)) {
      return invalid(
        `${showValue(format.value)} is not an export format in this build`,
        `pick one of ${EXPORT_FORMATS.join(', ')}`,
        'format',
      );
    }
    const templateId = p.value['templateId'];
    if (templateId !== undefined && typeof templateId !== 'string') {
      return invalid(`params.templateId must be a string, got ${showValue(templateId)}`, undefined, 'templateId');
    }
    const options = recipeOptionsOf(p.value['options']);
    if (!options.ok) return options;
    return ok({
      name: name.value.trim(),
      includeRootIds: includeRootIds.value,
      format: format.value,
      ...(templateId === undefined ? {} : { templateId }),
      ...(options.value === undefined ? {} : { options: options.value }),
    });
  },
};

export const recipeDelete: CommandDescriptor<RecipeDeleteParams> = {
  mutates: 'project',
  agentRisk: 'write-confirm',
  undo: 'inverse',
  validate: (params, snapshot) => {
    const p = requireDeclaredParams('recipe.delete', params);
    if (!p.ok) return p;
    const name = requireNonBlankString(p.value, 'name');
    if (!name.ok) return name;
    const missing = recipeNameMissing(snapshot, name.value);
    if (missing !== undefined) return err(missing);
    return ok({ name: name.value });
  },
};

/** The project-export descriptors by name, for the registry and for a test that reads them as a set. */
export const PROJECT_DESCRIPTORS = {
  'project.rename': projectRename,
  'project.setMetadata': projectSetMetadata,
  'project.importAsset': projectImportAsset,
  'vocabulary.upsert': vocabularyUpsert,
  'vocabulary.remove': vocabularyRemove,
  'recipe.save': recipeSave,
  'recipe.delete': recipeDelete,
} as const;
