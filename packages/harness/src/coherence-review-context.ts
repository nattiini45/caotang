/**
 * What a coherence review reads and where it sends it (coherence.md §5.3), shared by the app and the SDK: the context a review
 * takes (the codex for one document, the story so far) and the provider gateway as the engine's model port.
 *
 * The engine (`@caotang/coherence`) plans and runs a review, and it takes its context and its model through ports. These are the
 * two ports' implementations, held in the harness so `createProductHarness` can wire the agent's `coherence.review` the same way
 * wherever the agent runs. Nothing here writes the manuscript.
 */

import {
  type CoherenceModel,
  type ContextBlock,
  type ModelReply,
  type ModelRequest,
  type ReviewContext,
} from '@caotang/coherence';
import { detect, selectCandidates } from '@caotang/codex';
import { contentTokens, textOf, type ProfileView, type ProviderGateway, type ThinkingLevel } from '@caotang/gateway';
import { getBody, type ProjectState, type TreeNode } from '@caotang/store';
import { appendLanguageLine, type LanguagePolicy } from './agent/context.js';

/** The manuscript's documents in binder order, the order the story-so-far layer reads them in. */
function manuscriptDocuments(state: ProjectState): TreeNode[] {
  const byParent = new Map<string, TreeNode[]>();
  for (const node of state.manifest.tree) {
    if (node.parentId === null) continue;
    const list = byParent.get(node.parentId) ?? [];
    list.push(node);
    byParent.set(node.parentId, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: TreeNode[] = [];
  const walk = (parentId: string): void => {
    for (const child of byParent.get(parentId) ?? []) {
      if (child.type === 'document' && child.status !== 'archived') out.push(child);
      walk(child.id);
    }
  };
  walk('manuscript');
  return out;
}

/** The first words of a document, when it has no synopsis, so the story-so-far block says what the scene is about. */
function gist(state: ProjectState, node: TreeNode): string {
  if (node.synopsis.trim() !== '') return node.synopsis.trim();
  return getBody(state, node.id).trim().slice(0, 160);
}

/**
 * The codex entries one document's review may send (codex.md §5 and §6, the L2 layer): the candidates the include-policy rule
 * selects for this document, in codex order. A `never` entry is never sent. A `manual` entry is sent only when it is attached
 * to the document or an ancestor folder. A `detected` entry is sent only when its name or alias is in the document's text, which
 * is the same scan `continuity.scan` makes (codex.md §4 rule 6). An empty description is dropped (codex.md §2).
 */
function codexBlocksOf(state: ProjectState, docId: string): ContextBlock[] {
  const entries = state.manifest.codex ?? [];
  const detected = detect([{ id: docId, text: getBody(state, docId) }], entries);
  const { candidates } = selectCandidates({ entries, tree: state.manifest.tree, focusDocId: docId, detected });
  return candidates.map(({ entry }) => ({ key: entry.name, text: `${entry.name} (${entry.type}): ${entry.description}` }));
}

/**
 * The context a review reads: the codex for one document (the L2 layer, selected as the context assembly selects it), and the
 * story so far as one block per earlier document (the L4 layer). The engine fits both to its budgets and names what it left out
 * on the plan card.
 */
export function reviewContextOf(state: ProjectState): ReviewContext {
  const documents = manuscriptDocuments(state);
  return {
    codex: (docId: string) => codexBlocksOf(state, docId),
    storySoFar: (docId: string) => {
      const index = documents.findIndex((node) => node.id === docId);
      if (index <= 0) return [];
      return documents.slice(0, index).map((node) => ({ key: node.title, text: `${node.title}: ${gist(state, node)}` }));
    },
  };
}

/** A review model whose every request carries the language line (i18n §6.1). The languages are read at each call, so a switch applies to the next review. */
export function withReviewLanguages(model: CoherenceModel, languages: () => LanguagePolicy | undefined): CoherenceModel {
  return {
    model: model.model,
    complete: (request) => model.complete({ ...request, system: textOf(appendLanguageLine(request.system, languages())) }),
  };
}

/**
 * The provider gateway as the engine's model port. The reply is the model's text; the token counts are the engine's own estimate
 * (`ceil(chars/4)`, context-assembly §3), because a one-shot reply carries no usage. The run says so in its notes.
 */
export function gatewayCoherenceModel(
  gateway: ProviderGateway,
  profile: ProfileView,
  defaults?: { readonly model?: string; readonly thinking?: ThinkingLevel; readonly languages?: LanguagePolicy },
): CoherenceModel {
  return {
    model: defaults?.model ?? profile.defaultModel,
    async complete(request: ModelRequest): Promise<ModelReply> {
      const message = await gateway.completeOnce(
        {
          profileId: profile.id,
          // The review is a 'chat'-role task (provider-gateway §6): the role rides the ledger row, while the
          // profile stays pinned to the one the caller resolved.
          role: 'chat',
          messages: [
            { role: 'system', content: appendLanguageLine(request.system, defaults?.languages) },
            { role: 'user', content: request.user },
          ],
          responseFormat: { jsonSchemaHint: request.jsonSchemaHint },
          temperature: 0,
          ...(defaults?.model === undefined ? {} : { model: defaults.model }),
          ...(defaults?.thinking === undefined ? {} : { thinking: defaults.thinking }),
          ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
        },
        request.signal,
      );
      return {
        content: textOf(message.content),
        usage: {
          promptTokens: contentTokens(request.system + request.user),
          completionTokens: contentTokens(message.content),
        },
      };
    },
  };
}
