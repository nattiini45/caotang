/**
 * The apply of `codex.importBatch` ([codex.md §7.1](docs/architecture/codex.md)): the writer's import of codex entries, and the
 * Research pages that hold their full text, as one command and so one undo group. Its descriptor is the bus's
 * (`codexImportCommands`), which validates the whole batch first: the field limits, the enums, the document or page each entry
 * cites, the citation's text at its offsets, and every name and alias against the codex and the rest of the batch. What the
 * store does here is the write and the one restore that reverses it.
 *
 * **Pages first, then entries.** A page is created through `addDocument` with its body, as the other imports make their nodes
 * (`commands-script.ts`), so the undo returns the manifest to the bytes it had. An entry that names a page is attached to the
 * node that page became, and cites it at the offsets validate checked against the page's body.
 *
 * **One restore.** `UndoScope` holds one payload, so the apply registers one `compensate` that removes every entry it created
 * and then every page, newest first.
 */

import { newId } from '@caotang/ids';
import {
  codexImportCommands,
  type ApplyContext,
  type CommandApply,
  type CommandParams,
  type CommandRegistry,
} from '@caotang/bus';

import type { CodexEntry, CodexIncludePolicy } from './manifest.js';
import { addDocument, nodeById, removeNode, type ProjectState } from './state.js';

/** The clock seam the entries' and pages' stamps are read from, as the rest of the store does. */
export interface CodexImportClock {
  now(): number;
}

type ProjectApply<P> = CommandApply<P, ProjectState>;

/** codex.md §2's default type for an entry that names none. */
const DEFAULT_TYPE = 'other';
/** The pages' folder when the command names none: research (the descriptor resolves it; this is the apply's own fallback). */
const DEFAULT_PARENT = 'research';

function importApply(clock: CodexImportClock): ProjectApply<CommandParams['codex.importBatch']> {
  return (state, params, context: ApplyContext) => {
    const at = new Date(clock.now());
    const stamp = at.toISOString();
    const parentId = params.parentId ?? DEFAULT_PARENT;
    const pageIds: string[] = [];
    for (const page of params.pages ?? []) {
      pageIds.push(addDocument(state, { parentId, title: page.title, body: page.body, now: at }).id);
    }

    const codex = state.manifest.codex ?? (state.manifest.codex = []);
    const taken = new Set(codex.map((entry) => entry.id));
    const created: CodexEntry[] = [];
    const attached: string[] = [];
    for (const op of params.entries) {
      const docId = op.attachTo ?? pageIds[op.page ?? -1];
      // Validate resolved every page index and document; reaching this means a command skipped it, which must be loud.
      if (docId === undefined) throw new Error(`codex.importBatch reached its apply with an entry ("${op.name}") that names no document`);
      const id = newId('c', { taken });
      taken.add(id);
      const entry: CodexEntry = {
        id,
        name: op.name,
        aliases: [...(op.aliases ?? [])],
        type: op.type ?? DEFAULT_TYPE,
        description: op.description ?? '',
        includePolicy: (op.includePolicy as CodexIncludePolicy | undefined) ?? 'detected',
        caseSensitive: op.caseSensitive ?? false,
        exclude: [...(op.exclude ?? [])],
        attachments: [docId],
        keywords: [...(op.keywords ?? [])],
        // The command is the import, so its entries carry the import provenance (codex.md §2) whoever issued it.
        origin: 'import',
        sources: [{ docId, quote: op.cite.quote, from: op.cite.from, to: op.cite.to, extractedAt: stamp }],
        createdAt: stamp,
        updatedAt: stamp,
      };
      codex.push(entry);
      created.push(entry);
      if (!attached.includes(docId)) attached.push(docId);
    }

    context.undo.compensate(`undo the import of ${created.length} codex entries and ${pageIds.length} pages`, () => {
      const gone = new Set(created.map((entry) => entry.id));
      const kept = codex.filter((entry) => !gone.has(entry.id));
      codex.splice(0, codex.length, ...kept);
      for (const pageId of [...pageIds].reverse()) {
        if (nodeById(state, pageId) !== undefined) removeNode(state, pageId);
      }
    });

    const entriesWord = `${created.length} codex ${created.length === 1 ? 'entry' : 'entries'}`;
    const pagesWord = pageIds.length === 0 ? '' : ` and ${pageIds.length} research ${pageIds.length === 1 ? 'page' : 'pages'}`;
    context.report({
      affected: attached.map((nodeId) => ({ nodeId, title: nodeById(state, nodeId)?.title ?? nodeId })),
      summary: `imported ${entriesWord}${pagesWord}`,
    });
    return { created: created.map((entry) => entry.id), pages: pageIds };
  };
}

/** The apply, narrowed to the registry's state type (the bus does not type project state; see `commands.ts`'s `narrow`). */
function narrow<P>(apply: ProjectApply<P>): CommandApply<P, unknown> {
  return apply as CommandApply<P, unknown>;
}

/** The registration, for the store's registry. */
export function codexImportCommandRegistrations(options: { readonly clock: CodexImportClock }): Partial<CommandRegistry> {
  return {
    'codex.importBatch': { descriptor: codexImportCommands.codexImportBatch, apply: narrow(importApply(options.clock)) },
  };
}
