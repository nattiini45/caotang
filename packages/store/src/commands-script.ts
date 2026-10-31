/**
 * The store's applies for the script and dialogue commands ([screenplay.md §2.2](docs/architecture/screenplay.md),
 * [dialogue-narrative.md §2.1 and §4](docs/architecture/dialogue-narrative.md)): the two imports and a container's settings,
 * and the AV script's show and episode settings ([av-script.md §2](docs/architecture/av-script.md)).
 * Their descriptors are the bus's own (`packages/bus/src/descriptors-script.ts`), which check the shape, the parent and the
 * limits. What the store does here is the write, and the undo that reverses it.
 *
 * **The imports make their nodes through `addDocument` with the body given**, not through `setBody`. `setBody` stamps the
 * word-count cache's `computedAt`, and an undo that removed the nodes would leave that stamp behind; `addDocument` records
 * the count without one (state.ts), so the undo returns the manifest to the bytes it had. An import is one undo group: its
 * apply registers one `compensate` that removes every node it created, in reverse, because `UndoScope` holds one payload.
 *
 * The Fountain and FDX text is parsed here, because the store depends on the screenplay engine (which depends on nothing).
 * The Ink plan is made by the caller: the dialogue package depends on the store, so the store cannot call `planInkImport`.
 */

import { newId } from '@caotang/ids';
import {
  colourName,
  importFdx,
  importFountainScript,
  namingScene,
  nearestLabel,
  type ImportedScene,
  type ImportedSection,
} from '@caotang/screenplay';
import {
  ApplyRefusal,
  type ApplyContext,
  type CommandApply,
  type CommandParams,
} from '@caotang/bus';

import { mintTermId } from './commands-project.js';
import type { CodexEntry, TreeNode, VocabularyTerm } from './manifest.js';
import { addDocument, addNode, nodeById, removeNode, type ProjectState } from './state.js';

/** The clock seam the applies read for `createdAt` and `updatedAt`, as the rest of the store does. */
export interface ScriptClock {
  now(): number;
}

type ProjectApply<P> = CommandApply<P, ProjectState>;

/** The three applies, keyed by the command name they serve. */
export interface ScriptApplies {
  readonly 'screenplay.import': ProjectApply<CommandParams['screenplay.import']>;
  readonly 'dialogue.importInk': ProjectApply<CommandParams['dialogue.importInk']>;
  readonly 'dialogue.setMeta': ProjectApply<CommandParams['dialogue.setMeta']>;
  readonly 'script.setShowMeta': ProjectApply<CommandParams['script.setShowMeta']>;
  readonly 'script.setEpisodeMeta': ProjectApply<CommandParams['script.setEpisodeMeta']>;
}

/** The binder's synopsis limit (ui-modules §4.1). An imported `=` line longer than this is cut to it, with a notice. */
const SYNOPSIS_LIMIT = 2000;

/** The folder an import lands in when the caller names none: the manuscript (ui-modules §2.1). */
const DEFAULT_PARENT = 'manuscript';

/** The chapter a screenplay import makes, in the manuscript, for the scenes its file puts before any section. */
export const IMPORTED_SCENES_CHAPTER = 'Imported scenes';

/** The chapter a dialogue import makes, in the manuscript, for its containers. */
export const IMPORTED_DIALOGUE_CHAPTER = 'Imported dialogue';

/** A synopsis as the binder keeps it: cut to the limit, and whether it was cut. */
function fitSynopsis(text: string): { readonly value: string; readonly cut: boolean } {
  if ([...text].length <= SYNOPSIS_LIMIT) return { value: text, cut: false };
  return { value: [...text].slice(0, SYNOPSIS_LIMIT).join(''), cut: true };
}

/** A title the binder can show: the imported text, or a name for the node when the text is blank. */
function titleOrDefault(text: string, fallback: string): string {
  const trimmed = text.trim();
  return trimmed === '' ? fallback : trimmed;
}

/**
 * Removes the nodes an import created, last first: a child is removed before its parent, so each removal finds its node.
 * A node already gone (a parent's removal took it) is skipped. Each removal takes its subtree and its body record.
 */
function removeCreated(state: ProjectState, created: readonly string[]): void {
  for (const id of [...created].reverse()) {
    if (nodeById(state, id) !== undefined) removeNode(state, id);
  }
}

export function scriptApplies(clock: ScriptClock): ScriptApplies {
  const now = (): Date => new Date(clock.now());

  /**
   * `screenplay.import` — a whole Fountain or FDX file onto the binder (screenplay.md §2.2). Sections become folders, nested
   * by their depth; each scene becomes a screenplay document under the innermost section above it, holding its own Fountain
   * text and its synopsis. Everything is one undo group.
   */
  const screenplayImport: ProjectApply<CommandParams['screenplay.import']> = (state, params, context: ApplyContext) => {
    const script = params.format === 'fdx' ? importFdx(params.text) : importFountainScript(params.text);
    if (script.nodes.length === 0) {
      throw new ApplyRefusal({
        code: 'invalid-params',
        message: 'the file holds no scene headings or sections, so there is nothing to import',
        correctiveHint: 'choose a script file with at least one scene heading (INT. or EXT.) or one act or sequence',
      });
    }
    const parentId = params.parentId ?? DEFAULT_PARENT;
    const at = now();
    const hadCodex = state.manifest.codex !== undefined;
    const created: string[] = [];
    const notices: string[] = [...script.notices];
    // The sections still open, outermost first, each with its depth. A section closes every open section at its depth or
    // deeper, so its parent is the nearest shallower section above it (a skipped level does not change that). A scene goes
    // under the innermost section still open, or under the import's parent when none is.
    const open: { readonly depth: number; readonly id: string }[] = [];
    let folders = 0;
    let scenes = 0;
    // The chapter rule: a scene the file puts before any section, imported into the manuscript, would be a document
    // directly under it. Those scenes go into one chapter the import makes for them, the first time one needs it.
    let looseChapter: string | null = null;
    const sceneParent = (): string => {
      const section = open[open.length - 1]?.id;
      if (section !== undefined) return section;
      if (parentId !== DEFAULT_PARENT) return parentId;
      if (looseChapter === null) {
        const chapter = addNode(state, { parentId, title: IMPORTED_SCENES_CHAPTER, type: 'folder', now: at });
        created.push(chapter.id);
        looseChapter = chapter.id;
        notices.push(`The scenes before the first section went into a new chapter, "${IMPORTED_SCENES_CHAPTER}", because a document goes inside a chapter.`);
      }
      return looseChapter;
    };
    const innermost = (): string => open[open.length - 1]?.id ?? parentId;

    // Scene colours become binder labels (issue #265): the label of the nearest colour in the vocabulary, or one the
    // import adds, named after the colour. The labels it adds go with the undo.
    const labels = state.manifest.vocabulary.labels;
    const addedLabels: VocabularyTerm[] = [];
    const labelFor = (colour: string): string => {
      const near = nearestLabel(colour, labels);
      if (near !== undefined) return near.id;
      const name = colourName(colour);
      const named = labels.find((term) => term.name.trim().toLowerCase() === name.toLowerCase());
      if (named !== undefined) return named.id;
      const term: VocabularyTerm = { id: mintTermId(name, labels), name, color: colour };
      labels.push(term);
      addedLabels.push(term);
      return term.id;
    };
    const writtenScenes: { readonly scene: ImportedScene; readonly id: string }[] = [];

    /** One scene: a screenplay document holding its Fountain text, with its synopsis fitted to the binder's limit. */
    const writeScene = (scene: ImportedScene, parent: string): void => {
      const title = titleOrDefault(scene.nodeTitle ?? scene.title, 'Untitled scene');
      const synopsis = fitSynopsis(scene.synopsis);
      if (synopsis.cut) notices.push(`"${title}": its synopsis is longer than ${SYNOPSIS_LIMIT} characters and was cut to fit.`);
      const doc = addDocument(state, {
        parentId: parent,
        title,
        body: scene.body,
        type: 'document',
        kind: 'screenplay',
        synopsis: synopsis.value,
        now: at,
      });
      if (scene.colour !== undefined) doc.label = labelFor(scene.colour);
      created.push(doc.id);
      writtenScenes.push({ scene, id: doc.id });
    };

    for (const node of script.nodes) {
      if (node.kind === 'section') {
        folders += 1;
        const section: ImportedSection = node;
        while (open.length > 0 && (open[open.length - 1]?.depth ?? 0) >= section.depth) open.pop();
        const parent = innermost();
        const title = titleOrDefault(section.title, 'Untitled section');
        const folder = addNode(state, { parentId: parent, title, type: 'folder', now: at });
        const synopsis = fitSynopsis(section.synopsis);
        folder.synopsis = synopsis.value;
        if (synopsis.cut) notices.push(`"${title}": its synopsis is longer than ${SYNOPSIS_LIMIT} characters and was cut to fit.`);
        created.push(folder.id);
        open.push({ depth: section.depth, id: folder.id });
        continue;
      }
      scenes += 1;
      const scene: ImportedScene = node;
      writeScene(scene, sceneParent());
    }

    // The codex rows the writer ticked (issue #265), in the same undo group. A name or alias the codex already holds is
    // skipped and named, never merged; each entry attaches to the first imported scene that names it and cites that line.
    const codex = state.manifest.codex ?? [];
    const madeEntries: CodexEntry[] = [];
    const collisions: string[] = [];
    const unnamed: string[] = [];
    if (params.codex !== undefined && params.codex.length > 0) {
      state.manifest.codex = codex;
      const takenNames = new Set<string>();
      for (const entry of codex) for (const name of [entry.name, ...entry.aliases]) takenNames.add(name.trim().toLowerCase());
      const takenIds = new Set(codex.map((entry) => entry.id));
      const stamp = at.toISOString();
      const bodies = writtenScenes.map((written) => written.scene);
      for (const seed of params.codex) {
        const key = seed.name.trim().toLowerCase();
        if (takenNames.has(key)) {
          collisions.push(seed.name);
          continue;
        }
        takenNames.add(key);
        const naming = namingScene(bodies, seed.name);
        const docId = naming === null ? undefined : writtenScenes[naming.index]?.id;
        if (docId === undefined) unnamed.push(seed.name);
        const entry: CodexEntry = {
          id: newId('c', { taken: takenIds }),
          name: seed.name,
          aliases: [],
          type: seed.type,
          description: seed.description ?? '',
          includePolicy: 'detected',
          caseSensitive: false,
          exclude: [],
          attachments: docId === undefined ? [] : [docId],
          keywords: [],
          origin: 'import',
          sources:
            naming === null || docId === undefined
              ? []
              : [{ docId, quote: naming.quote, from: naming.from, to: naming.to, extractedAt: stamp }],
          createdAt: stamp,
          updatedAt: stamp,
        };
        takenIds.add(entry.id);
        codex.push(entry);
        madeEntries.push(entry);
      }
    }
    if (collisions.length > 0) {
      notices.push(`${collisions.length === 1 ? 'A codex entry' : `${collisions.length} codex entries`} already named ${collisions.map((name) => `"${name}"`).join(', ')} ${collisions.length === 1 ? 'was' : 'were'} left as ${collisions.length === 1 ? 'it was' : 'they were'}: an import never merges into an entry.`);
    }
    if (unnamed.length > 0) {
      notices.push(`${unnamed.map((name) => `"${name}"`).join(', ')} ${unnamed.length === 1 ? 'is' : 'are'} not named in any imported scene, so ${unnamed.length === 1 ? 'its codex entry is' : 'their codex entries are'} attached to no scene.`);
    }
    if (addedLabels.length > 0) {
      notices.push(`Scene colours added ${addedLabels.length === 1 ? 'the label' : `${addedLabels.length} labels:`} ${addedLabels.map((term) => `"${term.name}"`).join(', ')}.`);
    }

    context.undo.compensate(`undo the import of ${scenes} scenes and ${folders} sections`, () => {
      removeCreated(state, created);
      const made = new Set(madeEntries.map((entry) => entry.id));
      if (made.size > 0 && state.manifest.codex !== undefined) {
        state.manifest.codex = state.manifest.codex.filter((entry) => !made.has(entry.id));
        // A project with no codex before the import goes back to having none, so the manifest returns to its bytes.
        if (state.manifest.codex.length === 0 && !hadCodex) delete state.manifest.codex;
      }
      const added = new Set(addedLabels.map((term) => term.id));
      if (added.size > 0) {
        const kept = state.manifest.vocabulary.labels.filter((term) => !added.has(term.id));
        state.manifest.vocabulary.labels.splice(0, state.manifest.vocabulary.labels.length, ...kept);
      }
    });
    const top = created.filter((id) => nodeById(state, id)?.parentId === parentId);
    const format = params.format === 'fdx' ? 'FDX' : 'Fountain';
    context.report({
      affected: top.map((id) => {
        const node = nodeById(state, id);
        return { nodeId: id, title: node?.title ?? id };
      }),
      summary: `imported a ${format} script: ${scenes} scene${scenes === 1 ? '' : 's'} and ${folders} section${folders === 1 ? '' : 's'}${
        madeEntries.length === 0 ? '' : `, with ${madeEntries.length} codex entr${madeEntries.length === 1 ? 'y' : 'ies'}`
      }`,
    });
    if (script.titlePage !== null) {
      notices.push('The title page was read but not stored: set the project title and author on the project block.');
    }
    return {
      parentId,
      nodeIds: created,
      scenes,
      folders,
      codexEntries: madeEntries.length,
      labels: addedLabels.length,
      notices,
    };
  };

  /**
   * `dialogue.importInk` — one dialogue container per planned container, each holding its Ink body (dialogue-narrative.md §4).
   * The containers are created in plan order under the parent, marked `branching`, and undone as one group.
   */
  const dialogueImportInk: ProjectApply<CommandParams['dialogue.importInk']> = (state, params, context: ApplyContext) => {
    const requested = params.parentId ?? DEFAULT_PARENT;
    const at = now();
    const created: string[] = [];
    // The chapter rule: containers imported into the manuscript go into one chapter the import makes for them,
    // since a dialogue container directly under the manuscript would be a chapterless document.
    let parentId = requested;
    let chapterId: string | null = null;
    if (requested === DEFAULT_PARENT) {
      chapterId = addNode(state, { parentId: requested, title: IMPORTED_DIALOGUE_CHAPTER, type: 'folder', now: at }).id;
      parentId = chapterId;
    }
    for (const container of params.containers) {
      const node = addDocument(state, {
        parentId,
        title: container.title,
        body: container.body,
        type: 'dialogue',
        kind: 'branching',
        now: at,
      });
      created.push(node.id);
    }
    context.undo.compensate(`undo the import of ${created.length} dialogue containers`, () => {
      // The chapter the import made goes too, after the containers in it.
      removeCreated(state, chapterId === null ? created : [chapterId, ...created]);
    });
    context.report({
      affected: created.map((id) => ({ nodeId: id, title: nodeById(state, id)?.title ?? id })),
      summary: `imported ${created.length} dialogue container${created.length === 1 ? '' : 's'} from an Ink story`,
    });
    return { parentId, nodeIds: created };
  };

  /**
   * `dialogue.setMeta` — a container's settings (dialogue-narrative.md §2.1). A key the patch names is set, or cleared when it
   * is `null`. The whole record is copied before the change, so the undo restores it, and the node's `updatedAt` with it.
   */
  const dialogueSetMeta: ProjectApply<CommandParams['dialogue.setMeta']> = (state, params, context: ApplyContext) => {
    const node: TreeNode | undefined = nodeById(state, params.nodeId);
    if (node === undefined) throw new Error(`no node "${params.nodeId}" to set the dialogue settings of`);
    const before = node.dialogue === undefined ? undefined : (JSON.parse(JSON.stringify(node.dialogue)) as Record<string, unknown>);
    const beforeStamp = node.updatedAt;
    const next: Record<string, unknown> = { ...(node.dialogue ?? {}) };
    for (const [key, value] of Object.entries(params.patch)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    if (Object.keys(next).length === 0) delete node.dialogue;
    else node.dialogue = next;
    node.updatedAt = now().toISOString();
    context.undo.compensate(`restore the dialogue settings of "${node.title}"`, () => {
      if (before === undefined) delete node.dialogue;
      else node.dialogue = before;
      if (beforeStamp === undefined) delete node.updatedAt;
      else node.updatedAt = beforeStamp;
    });
    context.report({
      affected: [{ nodeId: node.id, title: node.title }],
      summary: `changed the dialogue settings of "${node.title}"`,
    });
    return { nodeId: node.id, patch: params.patch };
  };

  /**
   * `script.setShowMeta` and `script.setEpisodeMeta` — a show's and an episode's settings (av-script.md §2), with the same
   * patch semantics as `dialogue.setMeta`: a key the patch names is set, or cleared when it is `null`, and the record goes
   * when its last key does. The whole record and the node's `updatedAt` are copied before the change, so one undo restores both.
   */
  function patchRecord(field: 'showMeta' | 'episodeMeta', words: string): ProjectApply<{ nodeId: string; patch: Readonly<Record<string, unknown>> }> {
    return (state, params, context: ApplyContext) => {
      const node: TreeNode | undefined = nodeById(state, params.nodeId);
      if (node === undefined) throw new Error(`no node "${params.nodeId}" to set the ${words} of`);
      const current = node[field];
      const before = current === undefined ? undefined : (JSON.parse(JSON.stringify(current)) as Record<string, unknown>);
      const beforeStamp = node.updatedAt;
      const next: Record<string, unknown> = { ...(current ?? {}) };
      for (const [key, value] of Object.entries(params.patch)) {
        if (value === undefined) continue;
        if (value === null) delete next[key];
        else next[key] = Array.isArray(value) ? [...(value as unknown[])] : value;
      }
      if (Object.keys(next).length === 0) delete node[field];
      else node[field] = next;
      node.updatedAt = now().toISOString();
      context.undo.compensate(`restore the ${words} of "${node.title}"`, () => {
        if (before === undefined) delete node[field];
        else node[field] = before;
        if (beforeStamp === undefined) delete node.updatedAt;
        else node.updatedAt = beforeStamp;
      });
      context.report({
        affected: [{ nodeId: node.id, title: node.title }],
        summary: `changed the ${words} of "${node.title}"`,
      });
      return { nodeId: node.id, patch: params.patch };
    };
  }

  return {
    'screenplay.import': screenplayImport,
    'dialogue.importInk': dialogueImportInk,
    'dialogue.setMeta': dialogueSetMeta,
    'script.setShowMeta': patchRecord('showMeta', 'show settings'),
    'script.setEpisodeMeta': patchRecord('episodeMeta', 'episode settings'),
  };
}
