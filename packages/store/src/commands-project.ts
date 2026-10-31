// i18n: package-refs
/**
 * Project export: the applies of the project block, the saved export recipes, the vocabulary and the cover import.
 * Their descriptors are the bus's (`projectCommands` in `@caotang/bus`, `descriptors-project.ts`), so a refusal here is
 * never the first place a bad value is caught: the validators have already run on the same snapshot.
 *
 * Every apply that mutates reports its own undo, once, after the write (command-bus §5 and §8). Each undo is the
 * exact inverse command: a rename undoes to the old title, a recipe save undoes to the recipe it replaced or to a
 * delete. The one compensation is a vocabulary removal, which detaches the nodes that held the term; its restore puts
 * the term and each node's value back in one step, because the removal changed more than one place.
 *
 * `project.importAsset` is the one asynchronous apply. The image's bytes are written through a port the host injects,
 * and they never travel as a command param (a param is JSON and is copied into the undo group). The host stages the
 * bytes first, and the command names the staging id.
 */

import { newId } from '@caotang/ids';
import type { ProcessPicture } from '@caotang/pictures';
import {
  projectCommands,
  type ApplyContext,
  type Command,
  type CommandApply,
  type CommandName,
  type CommandRegistry,
  type ProjectImportAssetParams,
  type ProjectRenameParams,
  type ProjectSetMetadataParams,
  type RecipeDeleteParams,
  type RecipeOptionsParams,
  type RecipeSaveParams,
  type VocabularyKind,
  type VocabularyRemoveParams,
  type VocabularyUpsertParams,
} from '@caotang/bus';
import { defaultLanguage, mintIdentifier } from './project-identity.js';
import { defaultRecipe } from './create.js';
import type { ExportRecipe, ProjectIdentity, VocabularyTerm } from './manifest.js';
import type { AssetStaging } from './asset-staging.js';
import { withAssetFileGate, type AssetDeletionPort } from './picture-retention.js';
import { PictureWriteError, planPictureImport, publishPlan, type ImportWording } from './picture-import.js';
import { nodeById, type ProjectState } from './state.js';

type ProjectApply<P> = CommandApply<P, ProjectState>;

/** The clock seam the inverse commands are stamped from. Structural, so the store's `CommandClock` satisfies it. */
export interface ApplyClock {
  now(): number;
}

/* ------------------------------------------------------------------ *
 * The host's ports
 * ------------------------------------------------------------------ */

export { createAssetStaging, type AssetStaging, type RetryableAssetStaging } from './asset-staging.js';

/**
 * The write side of the cover import. `writeBytes` puts one file under `assets/` atomically (the same contract as the
 * artifact fs's `writeBytesAtomic`), and a rejection means nothing was applied.
 */
export interface ProjectAssetPort {
  readonly staging: AssetStaging;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  /**
   * The file names under assets/ (a_XXXXXXXXXX.png, not paths), and whether the list is the whole folder. A host that cannot list
   * leaves this out: an import then matches only the project's records, and never concludes that a file is missing.
   */
  list?(): Promise<{ readonly authoritative: boolean; readonly files: readonly string[] }>;
  /** One file's bytes by project path (assets/a_….png), or nothing when it is not there. Lets an import match a file that has no record. */
  readBytes?(path: string): Promise<Uint8Array | null | undefined>;
  /** Makes a smaller copy of a picture (the browser's canvas). A host without it refuses working copies before it writes. */
  readonly process?: ProcessPicture;
  /** Random bytes for the picture ids, so a test can pin them. */
  readonly randomBytes?: (length: number) => Uint8Array;
  /**
   * The removal half of the port (pictures.md §6.4.2): the retention inventory the sweep reads and the removal itself, separate from
   * writing, because a writer-only port cannot answer "is this file safe to delete". `asset.sweep` is registered only when the host
   * injects this; without it the name stays descriptor-only and the bus refuses it as not wired.
   */
  readonly deletion?: AssetDeletionPort;
}

/* ------------------------------------------------------------------ *
 * Image checks and ids
 * ------------------------------------------------------------------ */

/** The cover formats: EPUB 3.3 core media types for images that a reading system must show (epub-metadata.md). */
export interface CoverImageKind {
  readonly extension: 'png' | 'jpg' | 'webp';
  readonly mime: 'image/png' | 'image/jpeg' | 'image/webp';
}

/** The largest cover file the command takes. A cover is a few megabytes at most; a larger file is refused, not stored. */
export const COVER_MAX_BYTES = 16 * 1024 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

function startsWithBytes(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/**
 * The image format a file's leading bytes name, or `undefined` for anything that is not PNG, JPEG or WebP. The bytes
 * decide, never the name: a file renamed to `.png` is still whatever it is.
 */
export function sniffCoverImage(bytes: Uint8Array): CoverImageKind | undefined {
  if (startsWithBytes(bytes, PNG_SIGNATURE)) return { extension: 'png', mime: 'image/png' };
  if (startsWithBytes(bytes, JPEG_SIGNATURE)) return { extension: 'jpg', mime: 'image/jpeg' };
  if (startsWithBytes(bytes, RIFF) && startsWithBytes(bytes, WEBP, 8)) return { extension: 'webp', mime: 'image/webp' };
  return undefined;
}

/** The cover import's three refusals, as the writer has always read them. */
const COVER_WORDING: ImportWording = {
  missing: () => 'the image is no longer held, so nothing was imported',
  tooBig: (_label, bytes) => `the image is ${Math.round(bytes / (1024 * 1024))} MB, and a cover may be at most ${COVER_MAX_BYTES / (1024 * 1024)} MB`,
  notPicture: () => 'the file is not a PNG, JPEG or WebP image, which is what a cover can be',
};
/** A vocabulary id from a name: lower-case words joined by hyphens (`Act 1` → `act-1`), made unique among the terms. */
function mintTermId(name: string, terms: readonly VocabularyTerm[]): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'term';
  const taken = new Set(terms.map((term) => term.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/* ------------------------------------------------------------------ *
 * Helpers shared by the applies
 * ------------------------------------------------------------------ */

function termsOf(state: ProjectState, kind: VocabularyKind): VocabularyTerm[] {
  return kind === 'status' ? state.manifest.vocabulary.statuses : state.manifest.vocabulary.labels;
}

/** The recipe as the command's own params, so an inverse replays it through the same validator. */
function recipeParamsOf(recipe: ExportRecipe): RecipeSaveParams {
  const options = recipe.options === undefined ? undefined : optionsParamsOf(recipe.options);
  return {
    name: recipe.name,
    includeRootIds: [...recipe.includeRootIds],
    format: recipe.format,
    ...(recipe.templateId === undefined ? {} : { templateId: recipe.templateId }),
    ...(options === undefined ? {} : { options }),
  };
}

function optionsParamsOf(options: NonNullable<ExportRecipe['options']>): RecipeOptionsParams {
  return {
    ...(options.titlePage === undefined ? {} : { titlePage: options.titlePage }),
    ...(options.toc === undefined ? {} : { toc: options.toc }),
    ...(options.author === undefined ? {} : { author: options.author }),
    ...(options.charLimit === undefined ? {} : { charLimit: options.charLimit }),
    ...(options.sceneNumbers === undefined ? {} : { sceneNumbers: options.sceneNumbers }),
    ...(options.continued === undefined ? {} : { continued: options.continued }),
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
    ...(options.paperFrames === undefined ? {} : { paperFrames: options.paperFrames }),
    ...(options.bleed === undefined ? {} : { bleed: options.bleed }),
    ...(options.cropMarks === undefined ? {} : { cropMarks: options.cropMarks }),
    ...(options.contentsLabel === undefined ? {} : { contentsLabel: options.contentsLabel }),
    ...(options.pictures === undefined ? {} : { pictures: options.pictures }),
    ...(options.epubImageMaxPx === undefined ? {} : { epubImageMaxPx: options.epubImageMaxPx }),
    ...(options.epubKeepWebp === undefined ? {} : { epubKeepWebp: options.epubKeepWebp }),
    ...(options.keepPictureMetadata === undefined ? {} : { keepPictureMetadata: options.keepPictureMetadata }),
    ...(options.timelinePictures === undefined ? {} : { timelinePictures: options.timelinePictures }),
  };
}

/** The project block the metadata commands write. A never-set identifier is minted here, once, as the open would have. */
function identityOf(state: ProjectState): ProjectIdentity {
  const project = state.manifest.project;
  if (project.identifier === undefined) project.identifier = { uuid: mintIdentifier() };
  return project;
}

/* ------------------------------------------------------------------ *
 * The applies
 * ------------------------------------------------------------------ */

function projectRenameApply(clock: ApplyClock): ProjectApply<ProjectRenameParams> {
  return (state, params, context: ApplyContext) => {
    const project = state.manifest.project;
    const previous = project.name;
    project.name = params.title;
    // The root node is the project's own title in the tree; the two are kept equal, and the undo restores both.
    const root = nodeById(state, 'root');
    if (root !== undefined) root.title = params.title;
    context.undo.inverse(inverseCommand('project.rename', { title: previous }, clock));
    context.report({
      affected: [{ nodeId: 'root', title: params.title }],
      summary: `renamed the project to "${params.title}"`,
      summaryRef: {
        id: 'store.project.renameSummary',
        message: 'renamed the project to "{title}"',
        values: { title: params.title },
      },
    });
    return { title: params.title };
  };
}

function projectSetMetadataApply(clock: ApplyClock): ProjectApply<ProjectSetMetadataParams> {
  return (state, params, context) => {
    const project = identityOf(state);
    const patch = params.patch;
    const inverse: ProjectSetMetadataParams['patch'] = {};
    const changed: string[] = [];

    if (patch.author !== undefined) {
      inverse.author = project.author ?? null;
      if (patch.author === null) delete project.author;
      else project.author = patch.author;
      changed.push('author');
    }
    if (patch.language !== undefined) {
      inverse.language = project.language ?? defaultLanguage();
      project.language = patch.language;
      changed.push('language');
    }
    if (patch.isbn !== undefined) {
      const identifier = project.identifier;
      if (identifier === undefined) throw new Error('the identifier was minted above, so it cannot be absent here');
      inverse.isbn = identifier.isbn ?? null;
      identifier.isbn = patch.isbn;
      changed.push('ISBN');
    }
    if (patch.coverAssetId !== undefined) {
      inverse.coverAssetId = project.coverAssetId ?? null;
      project.coverAssetId = patch.coverAssetId;
      changed.push('cover');
    }

    context.undo.inverse(inverseCommand('project.setMetadata', { patch: inverse }, clock));
    context.report({
      affected: [{ nodeId: 'root', title: project.name }],
      summary: `changed the project's ${changed.join(', ')}`,
    });
    return { changed };
  };
}

/**
 * Writes a staged image into `assets/` and makes it the cover. The file is written first and the reference set second:
 * a failed write leaves the project as it was, and the reference never names a file that was not written.
 *
 * The picture goes through the shared import engine (picture-import.ts): private metadata is removed, the bytes are hashed, and the same
 * bytes as a picture the project already holds reuse its file and id. The undo restores the previous reference and leaves the file and
 * its record in place: a picture the reference no longer names is harmless to every reader, and removing it here would make undo depend
 * on a write this apply does not own.
 */
function projectImportAssetApply(clock: ApplyClock, assets: ProjectAssetPort): ProjectApply<ProjectImportAssetParams> {
  return async (state, params, context) => withAssetFileGate(assets, async () => {
    const now = new Date(clock.now());
    const plan = await planPictureImport(state, assets, [{ stagingId: params.stagingId }], {
      mode: 'legacy',
      wording: COVER_WORDING,
      now,
      randomBytes: assets.randomBytes,
    });
    try {
      await plan.writeFiles();
    } catch (failure) {
      // The cover import has always let the host's own write error through, so a caller reads the host's words.
      throw failure instanceof PictureWriteError ? failure.cause : failure;
    }

    // The picture is recorded with the reference that names it, in the same synchronous step, so no save sees one without the other.
    const [picture] = plan.items;
    if (picture === undefined) throw new Error('a one-picture plan holds one picture');
    publishPlan(state, plan, now, { links: false });
    const project = identityOf(state);
    const previous = project.coverAssetId ?? null;
    project.coverAssetId = picture.assetId;
    context.undo.inverse(inverseCommand('project.setMetadata', { patch: { coverAssetId: previous } }, clock));
    context.report({ affected: [{ nodeId: 'root', title: project.name }], summary: 'set the cover image' });
    return { assetId: picture.assetId, path: picture.path };
  });
}
function vocabularyUpsertApply(clock: ApplyClock): ProjectApply<VocabularyUpsertParams> {
  return (state, params, context) => {
    const terms = termsOf(state, params.kind);
    if (params.id !== undefined) {
      const term = terms.find((candidate) => candidate.id === params.id);
      // The validator read this term from the same snapshot, so a missing one is a defect in the descriptor.
      if (term === undefined) throw new Error(`vocabulary.upsert reached its apply with no ${params.kind} "${params.id}"`);
      const before = { name: term.name, color: term.color };
      term.name = params.name;
      term.color = params.color;
      context.undo.inverse(
        inverseCommand('vocabulary.upsert', { kind: params.kind, id: term.id, name: before.name, color: before.color }, clock),
      );
      context.report({ affected: [], summary: `renamed the ${params.kind} "${before.name}" to "${term.name}"` });
      return { id: term.id };
    }
    const id = mintTermId(params.name, terms);
    terms.push({ id, name: params.name, color: params.color });
    context.undo.inverse(inverseCommand('vocabulary.remove', { kind: params.kind, id }, clock));
    context.report({ affected: [], summary: `added the ${params.kind} "${params.name}"` });
    return { id };
  };
}

/**
 * Removes a term and detaches every node that held it. The nodes' previous values are captured first, so the restore
 * puts the term back at its position and each node's value back, in the one step the undo group runs.
 */
function vocabularyRemoveApply(): ProjectApply<VocabularyRemoveParams> {
  return (state, params, context) => {
    const terms = termsOf(state, params.kind);
    const index = terms.findIndex((term) => term.id === params.id);
    const removed = terms[index];
    // The validator read this term from the same snapshot, so a missing one is a defect in the descriptor.
    if (removed === undefined) throw new Error(`vocabulary.remove reached its apply with no ${params.kind} "${params.id}"`);
    const term: VocabularyTerm = { ...removed };
    terms.splice(index, 1);

    const field = params.kind === 'status' ? 'status' : 'label';
    const held: { nodeId: string; title: string; previous: string | null }[] = [];
    for (const node of state.manifest.tree) {
      if (node[field] === params.id) {
        held.push({ nodeId: node.id, title: node.title, previous: node[field] });
        node[field] = null;
      }
    }

    context.undo.compensate(`restore the ${params.kind} "${term.name}"`, () => {
      terms.splice(Math.min(index, terms.length), 0, term);
      for (const entry of held) {
        const node = nodeById(state, entry.nodeId);
        if (node !== undefined) node[field] = entry.previous;
      }
    });
    const detached = held.length === 0 ? '' : `; ${held.length} ${held.length === 1 ? 'item lost it' : 'items lost it'}`;
    context.report({
      affected: held.map((entry) => ({ nodeId: entry.nodeId, title: entry.title })),
      summary: `removed the ${params.kind} "${term.name}"${detached}`,
    });
    return { id: params.id };
  };
}

function recipeSaveApply(clock: ApplyClock): ProjectApply<RecipeSaveParams> {
  return (state, params, context) => {
    // A project that stores no recipes holds the default one without storing it (exporter.md §4). The default is stored first, so
    // the save keeps it beside the new recipe, rather than the list starting empty and the default vanishing.
    const recipes = (state.manifest.recipes ??= [defaultRecipe()]);
    const next: ExportRecipe = {
      name: params.name,
      includeRootIds: [...params.includeRootIds],
      format: params.format,
      ...(params.templateId === undefined ? {} : { templateId: params.templateId }),
      ...(params.options === undefined ? {} : { options: { ...params.options } }),
    };
    const index = recipes.findIndex((recipe) => recipe.name === params.name);
    if (index >= 0) {
      const before = recipes[index];
      recipes[index] = next;
      // Replacing a recipe is undone by saving the one it replaced, not by deleting the name.
      if (before !== undefined) context.undo.inverse(inverseCommand('recipe.save', recipeParamsOf(before), clock));
    } else {
      recipes.push(next);
      context.undo.inverse(inverseCommand('recipe.delete', { name: params.name }, clock));
    }
    context.report({ affected: [], summary: `saved the recipe "${params.name}"` });
    return { name: params.name };
  };
}

function recipeDeleteApply(clock: ApplyClock): ProjectApply<RecipeDeleteParams> {
  return (state, params, context) => {
    // A project that stores no recipes holds the default without storing it, and the bus allows its delete (recipe-names.ts). The
    // list is stored before the default leaves it, so the delete writes an empty list, which the exporter reads as no recipes.
    const recipes = state.manifest.recipes ?? [defaultRecipe()];
    const index = recipes.findIndex((recipe) => recipe.name === params.name);
    if (index < 0) throw new Error(`recipe.delete reached its apply with no recipe "${params.name}"`);
    state.manifest.recipes = recipes;
    const [removed] = recipes.splice(index, 1);
    if (removed !== undefined) context.undo.inverse(inverseCommand('recipe.save', recipeParamsOf(removed), clock));
    context.report({ affected: [], summary: `deleted the recipe "${params.name}"` });
    return { name: params.name };
  };
}

/**
 * The inverse command, minted as the user's own gesture (command-bus §4: an undo is never refused by the gate).
 * `turnId` and `callId` are absent, as they are for the store's own inverses.
 */
function inverseCommand<P>(name: CommandName, params: P, clock: ApplyClock): Command<P> {
  return { id: newId('cmd'), name, params, issuedBy: 'user', createdAt: clock.now() };
}

/** The apply, narrowed to the registry's state type (the bus does not type project state; see `commands.ts`'s `narrow`). */
function narrow<P>(apply: ProjectApply<P>): CommandApply<P, unknown> {
  return apply as CommandApply<P, unknown>;
}

/**
 * The project-export registrations, for the store's registry. `project.importAsset` is registered only when the host injects the
 * asset port, the same way the exporter and the MCP client are: without it the name stays descriptor-only and the bus
 * refuses it as not wired, so an import is never reachable by accident.
 */
export function projectCommandRegistrations(options: {
  readonly clock: ApplyClock;
  readonly assets?: ProjectAssetPort;
}): Partial<CommandRegistry> {
  const { clock } = options;
  const registrations: Partial<CommandRegistry> = {
    'project.rename': { descriptor: projectCommands.projectRename, apply: narrow(projectRenameApply(clock)) },
    'project.setMetadata': { descriptor: projectCommands.projectSetMetadata, apply: narrow(projectSetMetadataApply(clock)) },
    'vocabulary.upsert': { descriptor: projectCommands.vocabularyUpsert, apply: narrow(vocabularyUpsertApply(clock)) },
    'vocabulary.remove': { descriptor: projectCommands.vocabularyRemove, apply: narrow(vocabularyRemoveApply()) },
    'recipe.save': { descriptor: projectCommands.recipeSave, apply: narrow(recipeSaveApply(clock)) },
    'recipe.delete': { descriptor: projectCommands.recipeDelete, apply: narrow(recipeDeleteApply(clock)) },
  };
  if (options.assets !== undefined) {
    registrations['project.importAsset'] = {
      descriptor: projectCommands.projectImportAsset,
      apply: narrow(projectImportAssetApply(clock, options.assets)),
    };
  }
  return registrations;
}
