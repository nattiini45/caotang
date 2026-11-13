import type { RecentTurn, SessionSummary } from './types.js';

export const MEMORY_WITHHELD_OUTCOME = 'earlier outcome withheld by current read rules';

export function memoryReadable(source: { readonly readPolicy?: string }, readPolicy: string | undefined): boolean {
  return readPolicy === undefined || source.readPolicy === readPolicy;
}

export function summaryPrefix(summary: SessionSummary, turns: readonly RecentTurn[]): readonly RecentTurn[] | undefined {
  const readable = turns.filter((turn) => turn.hidden !== true && turn.rewound !== true);
  const prefix = readable.slice(0, summary.covers.turns);
  if (prefix.length !== summary.covers.turns || prefix[0]?.turnId !== summary.covers.from || prefix.at(-1)?.turnId !== summary.covers.to) return undefined;
  return prefix;
}
