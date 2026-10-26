/**
 * `assemble(task, app, cfg)` — [context-assembly.md §4](../../../docs/architecture/context-assembly.md).
 *
 * A pure function of its inputs: the same task, app state and config give the same
 * messages, byte for byte, whatever order the app's arrays were built in. Nothing reads
 * the clock. Nothing writes the state.
 *
 * The steps, in order:
 *
 * 1. Resolve the focus and the scope. A missing or unknown id is a contract violation and
 *    throws. An empty field is not: it degrades with a reason in its layer.
 * 2. Flow-up through L3, L4 and L5. Each layer's unused budget becomes the next included
 *    layer's extra budget, so the nearest context wins. This runs before L2 because L5's
 *    text is a detection surface for the codex.
 * 3. Fit L1, L2 and L6 to their own budgets. L2 and L6 do not take flow-up.
 * 4. The total-budget pass. If the prompt is over `contextBudget`, the items go in the
 *    spec's order: L6 whole (its section stays and says the turns were not sent), then L2's
 *    non-`always` entries from the bottom, then L4's tail, then L3's tail. It runs only if
 *    the cheapest state of every layer would make the prompt fit. If it would not, nothing
 *    is removed and the result says the prompt is over budget.
 * 5. Render the messages, and report every layer, every kept entry and every drop.
 */

import type { DetectionDoc, DetectionResult } from '@caotang/codex';
import { isDialogueNodeType } from '@caotang/dialogue';
import type { ChatMessage } from '@caotang/gateway';
import { getBody, type CodexEntry, type ProjectState, type TreeNode } from '@caotang/store';

import { charsAt, cheapestKept, cutOne, fitBlock, fitReserved, protectedCount, renderBlock, tokensAt, type Block } from './block.js';
import { describeDrop, dropLine, dropRecord } from './drops.js';
import { withhold } from './withheld.js';
import { ContextError } from './errors.js';
import { codexBlock, detectCodex } from './layers/codex.js';
import { beatStoryBlock, speakerHitsOf } from './layers/dialogue.js';
import { instructionsLayer } from './layers/instructions.js';
import { focusText, scopeBlock, type FocusPlan, type ScopePlan } from './layers/focus.js';
import { projectLayer, type ProjectLayer } from './layers/project.js';
import { scopeStoryBlock, storyBlock } from './layers/story.js';
import { structureBlock } from './layers/structure.js';
import { systemPrompt } from './layers/system.js';
import { taskText } from './layers/task.js';
import { turnsBlock } from './layers/turns.js';
import {
  DEFAULT_CONTINUATION_CHARS,
  SCOPE_DOCUMENT_LIMIT,
  effectiveBudgets,
  profileFor,
  totalBudgetFor,
} from './profiles.js';
import { charsFor, tokensForChars } from './tokens.js';
import { indexTree, manuscriptDocuments, type TreeIndex } from './tree.js';
import {
  LAYER_IDS,
  LAYER_NAMES,
  type AgentTask,
  type AppSnapshot,
  type AssembledPrompt,
  type ContextConfig,
  type DraftMode,
  type DropReason,
  type DropRecord,
  type FocusReport,
  type LayerId,
  type LayerItemReport,
  type LayerReport,
} from './types.js';

/** The layers that go in the user message, in §2's order. L0 is the system message. */
const USER_LAYERS: readonly LayerId[] = ['LI', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'];

/** Labels a detection surface reports as. Any other `where` is a node id, and reads as its title. `speakers` is a container's speakers (dialogue-narrative §7). */
const SURFACE_LABELS: ReadonlySet<string> = new Set(['instruction', 'tail', 'selection', 'focus', 'speakers']);

function perLayer<T>(make: () => T): Record<LayerId, T> {
  return { L0: make(), LI: make(), L1: make(), L2: make(), L3: make(), L4: make(), L5: make(), L6: make(), L7: make() };
}

function resolveFocus(task: AgentTask, tree: TreeIndex): TreeNode | undefined {
  const needed = task.tool === 'scene.draft' || task.tool === 'synopsis.fill' || task.tool === 'dialogue.draft';
  // dialogue.draft's focus is its dialogue container (dialogue-narrative §7); every other focus is a document.
  const wanted = task.tool === 'dialogue.draft' ? 'dialogue' : 'document';
  if (task.focus === undefined) {
    if (needed) throw new ContextError('missing-focus', `${task.tool} needs a focus ${wanted === 'dialogue' ? 'container' : 'document'}`);
    return undefined;
  }
  const node = tree.nodes.get(task.focus);
  if (node === undefined) throw new ContextError('unknown-focus', `no node with id "${task.focus}"`);
  // A container is any dialogue node type the container resolver takes (dialogue's own predicate, the one `resolveContainer` uses),
  // so a focus the loop resolves as a container is also one the assembly accepts.
  const matches = wanted === 'dialogue' ? isDialogueNodeType(node.type) : node.type === wanted;
  if (!matches) {
    throw new ContextError('focus-not-document', `"${task.focus}" is a ${node.type}, not ${wanted === 'dialogue' ? 'a dialogue container' : 'a document'}`);
  }
  return node;
}

/**
 * `dialogue.draft`'s speakers join the detected lane (dialogue-narrative §7): each character who speaks in the container is detected once
 * per line, so the codex's policies decide what it adds. Every other call's detection is returned as it is.
 */
function withSpeakers(task: AgentTask, entries: readonly CodexEntry[], detected: DetectionResult, container: TreeNode | undefined, state: ProjectState): DetectionResult {
  if (task.tool !== 'dialogue.draft' || container === undefined) return detected;
  const merged = new Map(detected);
  for (const [entryId, hit] of speakerHitsOf(entries, getBody(state, container.id))) {
    const prior = merged.get(entryId);
    merged.set(entryId, {
      count: (prior?.count ?? 0) + hit.count,
      where: [...new Set([...(prior?.where ?? []), ...hit.where])],
    });
  }
  return merged;
}

/** The tools whose L4 and L5 are built from a scope of documents rather than from one focus. */
const scoped = (tool: AgentTask['tool']): boolean => tool === 'continuity.scan' || tool === 'delegate';

function resolveScope(task: AgentTask, tree: TreeIndex): TreeNode[] {
  if (!scoped(task.tool)) return [];
  // A scan with no scope reads the whole manuscript; a delegated agent with none is sent no documents and reads by its tools.
  if (task.scope === undefined) return task.tool === 'delegate' ? [] : manuscriptDocuments(tree);
  const seen = new Set<string>();
  const out: TreeNode[] = [];
  for (const id of task.scope) {
    if (seen.has(id)) continue;
    seen.add(id);
    const node = tree.nodes.get(id);
    if (node === undefined || node.type !== 'document') {
      throw new ContextError('unknown-scope', `scope entry "${id}" is not a document`);
    }
    out.push(node);
  }
  return out;
}

/** Fit a block to its budget. Returns what it left unused, in tokens: the amount that flows up. */
function fitAndMeasure(block: Block, budget: number): number {
  const kept = fitBlock(block, budget);
  return Math.max(0, budget - tokensAt(block, kept));
}

function keptReports(block: Block): LayerItemReport[] {
  const out: LayerItemReport[] = [];
  for (const index of block.display) {
    if (index >= block.kept) continue;
    const item = block.items[index];
    if (item !== undefined) {
      out.push({ label: item.label, reason: item.reason, tokens: tokensForChars(item.body.length) });
    }
  }
  return out;
}

export function assemble(given: AgentTask, snapshot: AppSnapshot, config: ContextConfig = {}): AssembledPrompt {
  const { task, app, drops: withheldDrops } = withhold(given, snapshot);
  const tree = indexTree(app.state.manifest.tree);
  const entries = app.state.manifest.codex ?? [];
  const profile = profileFor(task.tool);
  const budgets = effectiveBudgets(profile, config, task.compact === true);
  // LI is in every profile, but a project with no instructions and no memory index has no such layer: its prompt is the one it was before
  // LI existed, and the cap of a layer that is not sent does not raise a tool's total.
  const instructions = instructionsLayer(app, budgets.LI ?? 0);
  const totalBudget = totalBudgetFor(profile, instructions === undefined ? { ...budgets, LI: 0 } : budgets, config);
  const continuationChars = Math.max(0, Math.floor(config.continuationChars ?? DEFAULT_CONTINUATION_CHARS));
  const baseOf = (id: LayerId): number => budgets[id] ?? 0;

  const focusNode = resolveFocus(task, tree);
  const scopeNodes = resolveScope(task, tree);

  // The layers this call is assembled from. The total-budget pass can cut one whole.
  const active = new Set<LayerId>(profile.layers);
  if (instructions === undefined) active.delete('LI');
  const notes = perLayer<string[]>(() => []);
  const drops = perLayer<DropRecord[]>(() => []);
  // Every layer works on the view without the withheld nodes; the project layer lists them, since every profile has it.
  if (withheldDrops.length > 0) {
    drops.L1.push(...withheldDrops);
    notes.L1.push(`${withheldDrops.length} ${withheldDrops.length === 1 ? 'item is' : 'items are'} withheld by a read rule and not in this prompt.`);
  }
  const effective: Partial<Record<LayerId, number>> = {};

  // L0 and L7 are fixed text: never truncated, and outside every budget (§2).
  const system = systemPrompt(app.tools, config.responseFormat);
  const taskBody = taskText(task);

  // Step 2: the flow-up chain, L3 then L4 then L5.
  let carry = 0;
  let structure: Block | undefined;
  if (active.has('L3')) {
    const budget = baseOf('L3') + carry;
    effective.L3 = budget;
    structure = structureBlock(tree, focusNode);
    carry = fitAndMeasure(structure, budget);
  }

  let story: Block | undefined;
  if (active.has('L4')) {
    const budget = baseOf('L4') + carry;
    effective.L4 = budget;
    const plan =
      scoped(task.tool)
        ? scopeStoryBlock(tree, scopeNodes, SCOPE_DOCUMENT_LIMIT)
        : task.tool === 'dialogue.draft'
          ? beatStoryBlock(focusNode === undefined ? '' : getBody(app.state, focusNode.id))
          : storyBlock(tree, focusNode, { includeForward: task.includeForwardOutline === true });
    story = plan.block;
    notes.L4.push(...plan.notes);
    drops.L4.push(...plan.drops);
    carry = fitAndMeasure(story, budget);
  }

  let focus: FocusPlan | undefined;
  let scope: ScopePlan | undefined;
  if (active.has('L5')) {
    const budget = baseOf('L5') + carry;
    effective.L5 = budget;
    if (scoped(task.tool)) {
      scope = scopeBlock(app.state, scopeNodes);
      drops.L5.push(...scope.drops);
      notes.L5.push(...scope.notes);
      fitBlock(scope.block, budget);
    } else {
      if (focusNode === undefined) throw new ContextError('missing-focus', `${task.tool} needs a focus ${task.tool === 'dialogue.draft' ? 'container' : 'document'}`);
      // A container's Ink is read as its tail, the part a new beat follows; an empty container stands in as a document does.
      const mode: DraftMode | 'full' =
        task.tool === 'synopsis.fill' ? 'full' : task.tool === 'dialogue.draft' ? 'continue' : (task.mode ?? 'draft');
      focus = focusText({
        node: focusNode,
        body: getBody(app.state, focusNode.id),
        mode,
        selection: task.selection,
        budgetTokens: budget,
        carryTokens: carry,
        flowUp: config.focusFlowUp === true,
        continuationChars,
      });
      notes.L5.push(...focus.notes);
    }
  }

  // Step 3: L2 is detected against the instruction and the focus text, then fitted.
  let codex: Block | undefined;
  if (active.has('L2')) {
    const texts: DetectionDoc[] = [{ id: 'instruction', text: task.instruction }, ...(focus?.surfaces ?? [])];
    const bodies = scope?.sent ?? [];
    const detected = withSpeakers(task, entries, detectCodex(entries, { texts, bodies }, app.mentions), focusNode, app.state);
    const focusDocs =
      scope !== undefined ? bodies.map((doc) => doc.id) : focusNode !== undefined ? [focusNode.id] : [];
    const plan = codexBlock({
      entries,
      tree: app.state.manifest.tree,
      focusDocs,
      detected,
      labelOf: (where) => (SURFACE_LABELS.has(where) ? where : (tree.nodes.get(where)?.title ?? where)),
    });
    codex = plan.block;
    drops.L2.push(...plan.suppressed);
    const budget = baseOf('L2');
    effective.L2 = budget;
    fitReserved(codex, budget);
    if (codex.overflow !== undefined) {
      const { need } = codex.overflow;
      const reason: DropReason = { kind: 'reserve-overflow', layer: 'L2', need, budget };
      drops.L2.push(dropRecord('always entries', reason, 'always'));
      notes.L2.push(`${describeDrop(reason)}. They are sent whole${codex.cuts.size > 0 ? ', and no other codex entry is' : ''}.`);
    }
  }

  let turns: Block | undefined;
  if (active.has('L6')) {
    const plan = turnsBlock(app.turns ?? [], app.activity ?? []);
    turns = plan.block;
    notes.L6.push(...plan.notes);
    const budget = baseOf('L6');
    effective.L6 = budget;
    fitBlock(turns, budget);
  }

  let project: ProjectLayer | undefined;
  if (active.has('L1')) {
    const budget = baseOf('L1');
    effective.L1 = budget;
    project = projectLayer(tree, app, budget);
    notes.L1.push(...project.notes);
  }

  if (instructions !== undefined && active.has('LI')) {
    effective.LI = baseOf('LI');
    notes.LI.push(...instructions.notes);
    drops.LI.push(...instructions.drops);
  }

  const blockOf = (id: LayerId): Block | undefined => {
    switch (id) {
      case 'L2':
        return codex;
      case 'L3':
        return structure;
      case 'L4':
        return story;
      case 'L5':
        return scope?.block;
      case 'L6':
        return turns;
      default:
        return undefined;
    }
  };
  const textOf = (id: LayerId): string => {
    const block = blockOf(id);
    if (block !== undefined) return renderBlock(block);
    switch (id) {
      case 'L0':
        return system;
      case 'LI':
        return instructions?.text ?? '';
      case 'L1':
        return project?.text ?? '';
      case 'L5':
        return focus?.text ?? '';
      case 'L7':
        return taskBody;
      default:
        return '';
    }
  };
  const charsOf = (id: LayerId): number => {
    const block = blockOf(id);
    return block !== undefined ? charsAt(block) : textOf(id).length;
  };
  const userLayers = (): LayerId[] => USER_LAYERS.filter((id) => active.has(id));
  const promptChars = (): number => {
    const layers = userLayers();
    return system.length + layers.reduce((sum, id) => sum + charsOf(id), 0) + 2 * Math.max(0, layers.length - 1);
  };

  // Step 4: the total-budget pass. The reachability check is exact: it measures the prompt
  // as it would be with every droppable entry gone, and only then starts removing anything.
  const limit = charsFor(totalBudget);
  if (promptChars() > limit) {
    // The codex keeps its always entries, and a block never goes below its floor.
    const codexFloor = codex === undefined ? 0 : Math.min(codex.kept, protectedCount(codex));
    // The smallest prompt the pass can reach: every droppable entry gone, or the cheapest count of
    // each layer where that is smaller. A layer that loses all its entries still renders its heading
    // and the line that says so, and that line is counted.
    const minimalChars = (): number => {
      const layers = userLayers();
      const sizeOf = (id: LayerId): number => {
        if (id === 'L2' && codex !== undefined) return charsAt(codex, cheapestKept(codex, codexFloor));
        if (id === 'L3' && structure !== undefined) return charsAt(structure, cheapestKept(structure, 0));
        if (id === 'L4' && story !== undefined) return charsAt(story, cheapestKept(story, 0));
        if (id === 'L6' && turns !== undefined) return charsAt(turns, 0);
        return charsOf(id);
      };
      return system.length + layers.reduce((sum, id) => sum + sizeOf(id), 0) + 2 * Math.max(0, layers.length - 1);
    };

    if (minimalChars() <= limit) {
      // The order is §2's: turns whole, then the codex, the story so far, and the structure.
      const steps: { block: Block; floor: number; whole: boolean }[] = [];
      if (turns !== undefined) steps.push({ block: turns, floor: 0, whole: true });
      if (codex !== undefined) steps.push({ block: codex, floor: codexFloor, whole: false });
      if (story !== undefined) steps.push({ block: story, floor: 0, whole: false });
      if (structure !== undefined) steps.push({ block: structure, floor: 0, whole: false });

      for (const step of steps) {
        if (promptChars() <= limit) break;
        if (step.whole) {
          // The turns are cut whole, but the section stays: its line says they were not sent, so
          // the model is not left to infer that the turns never happened (§2, §7).
          if (step.block.kept > 0) {
            while (step.block.kept > 0) cutOne(step.block, totalBudget);
            const count = step.block.items.length;
            notes.L6.push(`${count} ${count === 1 ? 'turn is' : 'turns are'} not sent: the total prompt budget was reached.`);
          }
        } else {
          const target = cheapestKept(step.block, step.floor);
          while (step.block.kept > target && promptChars() > limit) cutOne(step.block, totalBudget);
        }
      }
    }
  }
  const overBudget = promptChars() > limit;
  if (overBudget && codex?.overflow !== undefined) {
    notes.L2.push('The prompt is over the total budget: the always entries are never cut to reach it.');
  }

  // Step 5: the messages, and the report of every layer.
  const user = userLayers().map((id) => textOf(id)).join('\n\n');
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const promptTokens = tokensForChars(messages.reduce((sum, message) => sum + message.content.length, 0));

  const byLayer = perLayer(() => 0);
  const layers: LayerReport[] = LAYER_IDS.map((id) => {
    const included = active.has(id);
    const block = blockOf(id);
    const tokens = included ? tokensForChars(charsOf(id)) : 0;
    byLayer[id] = tokens;

    const kept: LayerItemReport[] = [];
    if (included && block !== undefined) kept.push(...keptReports(block));
    if (included && id === 'LI' && instructions !== undefined) kept.push(...instructions.kept);
    if (included && id === 'L5' && focus !== undefined) {
      kept.push({ label: focus.item.label, reason: focus.item.reason, tokens });
    }

    const cuts: DropRecord[] = [];
    if (block !== undefined) {
      for (const rank of [...block.cuts.keys()].sort((a, b) => a - b)) {
        const reason = block.cuts.get(rank);
        const item = block.items[rank];
        if (reason !== undefined && item !== undefined) cuts.push(dropRecord(item.label, reason, item.group));
      }
    }
    const allDrops = [...drops[id], ...cuts];

    const baseBudget = profile.budgets[id] === undefined ? undefined : baseOf(id);
    const budget = included ? effective[id] : undefined;
    return {
      id,
      name: LAYER_NAMES[id],
      included,
      ...(baseBudget === undefined ? {} : { baseBudget }),
      ...(budget === undefined ? {} : { budget }),
      tokens,
      kept,
      dropped: allDrops.map(dropLine),
      drops: allDrops,
      notes: notes[id],
    };
  });

  const focusReport: FocusReport | undefined = focus?.report;
  return {
    tool: task.tool,
    messages,
    layers,
    estimate: { promptTokens, byLayer },
    totalBudget,
    overBudget,
    ...(focusReport === undefined ? {} : { focus: focusReport }),
    model: { ...(config.model ?? {}) },
  };
}
