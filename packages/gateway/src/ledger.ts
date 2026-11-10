import { type Clock, systemClock } from './clock.js';
import type { TaskRole, TokenPrice, Usage, UsageAttribution } from './types.js';

export const USAGE_LEDGER_VERSION = 1;

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  requests: number;
  cachedPromptTokens: number;
  cacheWritePromptTokens: number;
  reasoningTokens: number;
  estimatedRequests: number;
  unpricedRequests: number;
  providerCostRequests: number;
  costUsd?: number;
}

export interface DayUsageRow extends UsageTotals {
  version: typeof USAGE_LEDGER_VERSION;
  date: string;
  profileId: string;
  model: string;
  role: TaskRole;
}

export interface TurnUsageRow extends UsageTotals {
  version: typeof USAGE_LEDGER_VERSION;
  turnId: string;
  sessionId?: string;
  agentPath?: string;
  profileId: string;
  model: string;
  role: TaskRole;
}

export interface UsageSnapshot {
  version: typeof USAGE_LEDGER_VERSION;
  days: DayUsageRow[];
  turns: TurnUsageRow[];
}

export function localDayKey(ms: number): string {
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

const ZERO: UsageTotals = {
  promptTokens: 0, completionTokens: 0, requests: 0,
  cachedPromptTokens: 0, cacheWritePromptTokens: 0, reasoningTokens: 0,
  estimatedRequests: 0, unpricedRequests: 0, providerCostRequests: 0,
};

export function costOf(usage: Usage, price: TokenPrice | undefined): number | undefined {
  if (usage.providerCostUsd !== undefined && Number.isFinite(usage.providerCostUsd) && usage.providerCostUsd >= 0) return usage.providerCostUsd;
  if (price === undefined) return undefined;
  const cached = usage.cachedPromptTokens ?? 0;
  const written = usage.cacheWritePromptTokens ?? 0;
  if (cached + written > usage.promptTokens) return undefined;
  return (
    (usage.promptTokens - cached - written) * price.prompt +
    cached * (price.cachedPrompt ?? price.prompt) +
    written * (price.cacheWritePrompt ?? price.prompt) +
    usage.completionTokens * price.completion
  ) / 1000;
}

export class UsageLedger {
  private readonly days = new Map<string, DayUsageRow>();
  private readonly turns = new Map<string, TurnUsageRow>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly clock: Clock = systemClock) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  record(by: UsageAttribution, usage: Usage, requests = 1): void {
    const date = localDayKey(by.at ?? this.clock.now());
    const role = by.role ?? 'chat';
    const costUsd = costOf(usage, by.pricePer1k);
    const totals: UsageTotals = {
      promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, requests,
      cachedPromptTokens: usage.cachedPromptTokens ?? 0,
      cacheWritePromptTokens: usage.cacheWritePromptTokens ?? 0,
      reasoningTokens: usage.reasoningTokens ?? 0,
      estimatedRequests: usage.source === 'estimate' ? 1 : 0,
      unpricedRequests: costUsd === undefined ? requests : Math.max(0, requests - 1),
      providerCostRequests: usage.providerCostUsd === undefined ? 0 : 1,
      ...(costUsd === undefined ? {} : { costUsd }),
    };
    const dayKey = JSON.stringify([date, by.profileId, by.model, role]);
    const day: DayUsageRow = this.days.get(dayKey) ?? { version: USAGE_LEDGER_VERSION, date, profileId: by.profileId, model: by.model, role, ...ZERO };
    add(day, totals);
    this.days.set(dayKey, day);

    if (by.turnId !== undefined) {
      const turnKey = JSON.stringify([by.turnId, by.sessionId, by.agentPath, by.profileId, by.model, role]);
      const turn: TurnUsageRow = this.turns.get(turnKey) ?? {
        version: USAGE_LEDGER_VERSION, turnId: by.turnId,
        ...(by.sessionId === undefined ? {} : { sessionId: by.sessionId }),
        ...(by.agentPath === undefined ? {} : { agentPath: by.agentPath }),
        profileId: by.profileId, model: by.model, role, ...ZERO,
      };
      add(turn, totals);
      this.turns.set(turnKey, turn);
    }
    for (const listener of this.listeners) listener();
  }

  dayRows(): DayUsageRow[] {
    return [...this.days.values()].map((row) => ({ ...row }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.profileId.localeCompare(b.profileId) || a.model.localeCompare(b.model));
  }

  turnRows(): TurnUsageRow[] {
    return [...this.turns.values()].map((row) => ({ ...row }));
  }

  turnRowsOf(turnId: string): TurnUsageRow[] {
    return this.turnRows().filter((row) => row.turnId === turnId);
  }

  turnTotals(turnId: string): UsageTotals {
    return this.total((row) => row.turnId === turnId);
  }

  sessionTotals(sessionId: string): UsageTotals {
    return this.total((row) => row.sessionId === sessionId);
  }

  private total(include: (row: TurnUsageRow) => boolean): UsageTotals {
    const totals = { ...ZERO };
    for (const row of this.turns.values()) if (include(row)) add(totals, row);
    return totals;
  }

  snapshot(): UsageSnapshot {
    return { version: USAGE_LEDGER_VERSION, days: this.dayRows(), turns: this.turnRows() };
  }

  restore(input: unknown): void {
    const snapshot = readSnapshot(input);
    this.days.clear();
    this.turns.clear();
    for (const row of snapshot.days) {
      const key = JSON.stringify([row.date, row.profileId, row.model, row.role]);
      const prior = this.days.get(key);
      if (prior === undefined) this.days.set(key, row);
      else add(prior, row);
    }
    for (const row of snapshot.turns) {
      const key = JSON.stringify([row.turnId, row.sessionId, row.agentPath, row.profileId, row.model, row.role]);
      const prior = this.turns.get(key);
      if (prior === undefined) this.turns.set(key, row);
      else add(prior, row);
    }
  }
}

function add(target: UsageTotals, row: UsageTotals): void {
  for (const key of ['promptTokens', 'completionTokens', 'requests', 'cachedPromptTokens', 'cacheWritePromptTokens', 'reasoningTokens', 'estimatedRequests', 'unpricedRequests', 'providerCostRequests'] as const) {
    target[key] += row[key];
  }
  if (row.costUsd !== undefined) target.costUsd = (target.costUsd ?? 0) + row.costUsd;
}

function readSnapshot(input: unknown): UsageSnapshot {
  const object = (value: unknown): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid usage ledger.');
    return value as Record<string, unknown>;
  };
  const snapshot = Array.isArray(input) ? { days: input, turns: [] } : object(input);
  if (snapshot['version'] !== undefined && snapshot['version'] !== USAGE_LEDGER_VERSION) throw new Error('Unsupported usage ledger version.');
  const rows = (value: unknown, kind: 'date' | 'turnId'): (DayUsageRow | TurnUsageRow)[] => {
    if (!Array.isArray(value)) throw new Error('Invalid usage ledger rows.');
    return value.map((raw): DayUsageRow | TurnUsageRow => {
      const row = object(raw);
      if (row['version'] !== undefined && row['version'] !== USAGE_LEDGER_VERSION) throw new Error('Unsupported usage row version.');
      for (const key of [kind, 'profileId', 'model']) if (typeof row[key] !== 'string') throw new Error('Invalid usage ledger identity.');
      const role = row['role'] ?? 'chat';
      if (role !== 'chat' && role !== 'drafting' && role !== 'background') throw new Error('Invalid usage ledger role.');
      const totals = { ...ZERO };
      for (const key of ['promptTokens', 'completionTokens', 'requests']) {
        if (typeof row[key] !== 'number') throw new Error('Missing usage ledger count.');
      }
      for (const key of Object.keys(ZERO) as (keyof typeof ZERO)[]) {
        const count = row[key] ?? (key === 'unpricedRequests' && row['costUsd'] === undefined ? row['requests'] : 0);
        if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) throw new Error('Invalid usage ledger count.');
        totals[key] = count;
      }
      const cost = row['costUsd'];
      if (cost !== undefined && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0)) throw new Error('Invalid usage ledger cost.');
      const identity = kind === 'date' ? { date: row[kind] as string } : { turnId: row[kind] as string };
      const extra: { sessionId?: string; agentPath?: string } = {};
      if (kind === 'turnId') for (const key of ['sessionId', 'agentPath'] as const) {
        if (row[key] === undefined) continue;
        if (typeof row[key] !== 'string') throw new Error('Invalid usage ledger attribution.');
        extra[key] = row[key];
      }
      return { version: USAGE_LEDGER_VERSION, ...identity, ...extra, profileId: row['profileId'] as string, model: row['model'] as string, role, ...totals, ...(cost === undefined ? {} : { costUsd: cost as number }) };
    });
  };
  return { version: USAGE_LEDGER_VERSION, days: rows(snapshot['days'], 'date') as DayUsageRow[], turns: rows(snapshot['turns'] ?? [], 'turnId') as TurnUsageRow[] };
}
