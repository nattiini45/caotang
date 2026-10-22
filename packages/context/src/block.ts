/**
 * A budgeted layer as a ranked list of whole entries — [context-assembly.md](../../../docs/architecture/context-assembly.md)
 * §2–§4 and the codex prune rule (codex.md §6, step 5).
 *
 * Each item is rendered once, when its layer is planned. Rank decides what survives a
 * budget: rank 1 is kept longest, and an overflow drops from the bottom of the rank order.
 * The kept entries are rendered in display order, a separate order (codex order,
 * manuscript order, oldest first) that never changes what is kept.
 *
 * Kept entries are always a prefix of the rank order. That is what makes the bottom-up
 * drop a single loop, and what makes the prune order a function of rank alone.
 *
 * The character table is exact. Entries are joined by a blank line, so a layer with `k`
 * kept entries is `header + sum(2 + length)` characters, and the same arithmetic gives
 * the length of the text `renderBlock` returns. A budget check on the table is therefore
 * a check on the rendered text, and the test suite pins the two together.
 */

import { charsFor, tokensForChars } from './tokens.js';
import type { DropReason, LayerId } from './types.js';

export interface BlockItem {
  readonly label: string;
  /** Shown in the preview when the item is kept. */
  readonly reason: string;
  /** The rendered entry, without the blank line that joins entries. */
  readonly body: string;
  /** Exempt from the total-budget pass. Codex `always` entries are (context-assembly §2). */
  readonly protected: boolean;
  /** Which kind of entry it is, for the preview's grouping. */
  readonly group: string;
}

export interface Block {
  readonly id: LayerId;
  /** The layer's heading. Always kept, and counted against the budget. */
  readonly header: string;
  /** The body rendered when the layer has no entries at all. It names the absence (§7's visibility rule). */
  readonly empty: string;
  /**
   * The body rendered when the layer has entries and the budget keeps none. It says the
   * entries were not sent, so the model is not told that nothing existed (§7).
   */
  readonly cut: string;
  /** In rank order. */
  readonly items: readonly BlockItem[];
  /** Indices of `items`, in display order. */
  readonly display: readonly number[];
  /** The length in characters of each item's body, in rank order. */
  readonly lengths: readonly number[];
  /** How many leading items of the rank order are kept. */
  kept: number;
  /** The effective budget in tokens, once the block has been fitted. */
  budget: number | undefined;
  /** Why each dropped item was dropped, keyed by its rank index. */
  readonly cuts: Map<number, DropReason>;
  /** Set by `fitReserved` when the protected entries alone are over the budget: what they need, in tokens. */
  overflow: { readonly need: number; readonly budget: number } | undefined;
}

export interface BlockInput {
  readonly id: LayerId;
  readonly header: string;
  readonly empty: string;
  /** Defaults to `empty`, which is right for a layer that only ever has no entries. */
  readonly cut?: string;
  readonly items: readonly BlockItem[];
  readonly display: readonly number[];
}

export function newBlock(input: BlockInput): Block {
  return {
    ...input,
    cut: input.cut ?? input.empty,
    lengths: input.items.map((item) => item.body.length),
    kept: input.items.length,
    budget: undefined,
    cuts: new Map(),
    overflow: undefined,
  };
}

/** The body a block renders when no entry is kept: `cut` if it has entries, `empty` if it has none. */
function bodyWhenNoneKept(block: Block): string {
  return block.items.length > 0 ? block.cut : block.empty;
}

/**
 * Characters of the rendered block for every kept count. Index `k` is the length when the
 * first `k` entries of the rank order are kept, for `k` from 0 to the item count.
 */
export function charTable(block: Block): number[] {
  const table = [block.header.length + 2 + bodyWhenNoneKept(block).length];
  let sum = block.header.length;
  for (const length of block.lengths) {
    sum += 2 + length;
    table.push(sum);
  }
  return table;
}

/** Characters of the block when `kept` entries are kept. */
export function charsAt(block: Block, kept: number = block.kept): number {
  return charTable(block)[kept] ?? 0;
}

/**
 * The kept count, between `floor` and the current one, that renders the fewest characters. It is
 * the current count unless a smaller one exists: the cut text can be longer than the nearest entry,
 * and then the cheapest state keeps that entry. Ties keep more entries. The total-budget pass cuts
 * each block to this count and no further.
 */
export function cheapestKept(block: Block, floor: number): number {
  let best = block.kept;
  let bestChars = charsAt(block, block.kept);
  for (let kept = block.kept - 1; kept >= floor; kept -= 1) {
    const chars = charsAt(block, kept);
    if (chars < bestChars) {
      best = kept;
      bestChars = chars;
    }
  }
  return best;
}

/** Tokens of the block when `kept` entries are kept, on the context-assembly §3 estimate. */
export function tokensAt(block: Block, kept: number = block.kept): number {
  return tokensForChars(charsAt(block, kept));
}

/** The block's text, with its first `kept` entries of the rank order, in display order. */
export function renderBlock(block: Block, kept: number = block.kept): string {
  const bodies: string[] = [];
  for (const index of block.display) {
    if (index >= kept) continue;
    const item = block.items[index];
    if (item !== undefined) bodies.push(item.body);
  }
  return [block.header, ...(bodies.length > 0 ? bodies : [bodyWhenNoneKept(block)])].join('\n\n');
}

/**
 * Fit a block to a token budget. Keeps the longest prefix of the rank order whose table
 * entry fits, and records a budget cut for each entry it drops. A header that is larger
 * than the budget keeps no entries: the layer still renders its heading and empty line,
 * and the report shows the overrun.
 */
export function fitBlock(block: Block, budget: number): number {
  const table = charTable(block);
  const limit = charsFor(budget);
  let kept = 0;
  while (kept < block.lengths.length && (table[kept + 1] ?? Number.POSITIVE_INFINITY) <= limit) kept += 1;
  return keepPrefix(block, budget, kept);
}

function keepPrefix(block: Block, budget: number, kept: number): number {
  block.budget = budget;
  block.kept = kept;
  block.cuts.clear();
  block.overflow = undefined;
  for (let rank = kept; rank < block.items.length; rank += 1) {
    block.cuts.set(rank, { kind: 'budget', layer: block.id, budget, rank: rank + 1 });
  }
  return kept;
}

/**
 * Fit a block in two phases (context-assembly A3): the protected entries, which rank first, are
 * reserved; the rest are fitted into what they leave. When the reservation fits, the result is
 * `fitBlock`'s exactly. When it does not, every protected entry is kept whole, every other entry
 * is cut for the budget, and `overflow` records what the protected entries need.
 */
export function fitReserved(block: Block, budget: number): number {
  let reserved = 0;
  while (block.items[reserved]?.protected === true) reserved += 1;
  const need = charTable(block)[reserved] ?? 0;
  if (reserved === 0 || need <= charsFor(budget)) return fitBlock(block, budget);
  keepPrefix(block, budget, reserved);
  block.overflow = { need: tokensForChars(need), budget };
  return reserved;
}

/** Cut the rank entries from `kept` down to `floor`, one at a time, each for the total-budget pass. */
export function cutOne(block: Block, total: number): void {
  block.kept -= 1;
  block.cuts.set(block.kept, { kind: 'total-budget', layer: block.id, total, rank: block.kept + 1 });
}

/** The number of entries the total-budget pass may never remove: the protected prefix. */
export function protectedCount(block: Block): number {
  return block.items.filter((item) => item.protected).length;
}
