/**
 * Usage ledger — [provider-gateway.md §6](docs/architecture/provider-gateway.md).
 *
 * Two kinds of row, both keyed so that one request lands in exactly one row of each
 * kind it belongs to:
 *  - a **day row** per (calendar day, profile, model): the settings screen's totals;
 *  - a **turn row** per (agent turn, profile, model): the activity log's per-turn cost.
 *
 * Counts are kept, not estimates of money. §6 is explicit that this is display-only
 * accounting and that `pricePer1k` is applied by the reader, not stored here. No row
 * has a field that could carry a credential, so a serialised ledger is safe to show.
 */

import { type Clock, systemClock } from './clock.js';
import type { TaskRole, Usage, UsageAttribution } from './types.js';

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  requests: number;
}

export interface DayUsageRow extends UsageTotals {
  /** local calendar day, `YYYY-MM-DD` */
  date: string;
  profileId: string;
  model: string;
  /** the task role the usage ran under; 'chat' when the caller did not name one */
  role: TaskRole;
}

export interface TurnUsageRow extends UsageTotals {
  turnId: string;
  /** the delegated agent inside the turn that the row counts; absent for the turn's own calls */
  agentPath?: string;
  profileId: string;
  model: string;
  role: TaskRole;
}

export interface UsageSnapshot {
  days: DayUsageRow[];
  turns: TurnUsageRow[];
}

/**
 * Turn rows are the one unbounded thing in the ledger, so they are capped. The oldest
 * turn is dropped first. Day rows are one per (day, profile, model), which stays small
 * for years, so they are never dropped.
 */
export const MAX_TURN_ROWS = 200;

/** The local calendar day of `ms`. Local rather than UTC, because "today" means the user's today. */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

const ZERO: UsageTotals = { promptTokens: 0, completionTokens: 0, requests: 0 };

export class UsageLedger {
  private readonly days = new Map<string, DayUsageRow>();
  private readonly turns = new Map<string, TurnUsageRow>();

  constructor(private readonly clock: Clock = systemClock) {}

  /** Adds one usage record. `requests` is how many HTTP requests it covers, retries included. */
  record(by: UsageAttribution, usage: Usage, requests = 1): void {
    const at = by.at ?? this.clock.now();
    const date = localDayKey(at);

    const role = by.role ?? 'chat';
    const dayKey = `${date}\u0000${by.profileId}\u0000${by.model}\u0000${role}`;
    const day = this.days.get(dayKey) ?? { date, profileId: by.profileId, model: by.model, role, ...ZERO };
    add(day, usage, requests);
    this.days.set(dayKey, day);

    if (by.turnId !== undefined) {
      const turnKey = `${by.turnId}\u0000${by.agentPath ?? ''}\u0000${by.profileId}\u0000${by.model}\u0000${role}`;
      const existing = this.turns.get(turnKey);
      const turn = existing ?? {
        turnId: by.turnId,
        ...(by.agentPath === undefined ? {} : { agentPath: by.agentPath }),
        profileId: by.profileId,
        model: by.model,
        role,
        ...ZERO,
      };
      add(turn, usage, requests);
      if (existing === undefined) this.turns.set(turnKey, turn);
      this.trimTurns();
    }
  }

  /** Day rows, oldest day first. Copies: a caller cannot edit the ledger through them. */
  dayRows(): DayUsageRow[] {
    return [...this.days.values()]
      .map((row) => ({ ...row }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.profileId.localeCompare(b.profileId) || a.model.localeCompare(b.model));
  }

  /** Turn rows, oldest first. */
  turnRows(): TurnUsageRow[] {
    return [...this.turns.values()].map((row) => ({ ...row }));
  }

  /** The totals for one agent turn across every profile and model it used. */
  turnTotals(turnId: string): UsageTotals {
    const totals = { ...ZERO };
    for (const row of this.turns.values()) {
      if (row.turnId === turnId) add(totals, row, row.requests);
    }
    return totals;
  }

  snapshot(): UsageSnapshot {
    return { days: this.dayRows(), turns: this.turnRows() };
  }

  private trimTurns(): void {
    while (this.turns.size > MAX_TURN_ROWS) {
      const oldest = this.turns.keys().next().value;
      if (oldest === undefined) return;
      this.turns.delete(oldest);
    }
  }
}

function add(target: UsageTotals, usage: Usage, requests: number): void {
  target.promptTokens += usage.promptTokens;
  target.completionTokens += usage.completionTokens;
  target.requests += requests;
}
