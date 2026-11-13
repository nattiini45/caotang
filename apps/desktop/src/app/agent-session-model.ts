import { parseRunEvents, type TurnReport } from '@caotang/harness';
import { redactDeep, sumUsage, textOf, type TurnUsageRow } from '@caotang/gateway';
import type { AgentSessionRow, AgentSessionTurnRef, RunRow } from '@caotang/store';
import { newTurnRecord, type TurnRecord } from './agent-model.js';

export interface SessionTurnPresentation {
  readonly version: 1;
  readonly turn: TurnRecord;
  readonly hidden: boolean;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const invalid = Symbol('invalid presentation');
type Reader = (value: unknown) => unknown;
const text: Reader = (value) => typeof value === 'string' ? value : invalid;
const bool: Reader = (value) => typeof value === 'boolean' ? value : invalid;
const amount: Reader = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : invalid;
const count: Reader = (value) => Number.isSafeInteger(value) && (value as number) >= 0 ? value : invalid;
const optional = (read: Reader): Reader => (value) => value === undefined ? undefined : read(value);
const nullable = (read: Reader): Reader => (value) => value === null ? null : read(value);
const choice = (...values: readonly unknown[]): Reader => (value) => values.includes(value) ? value : invalid;
const list = (read: Reader): Reader => (value) => {
  if (!Array.isArray(value)) return invalid;
  const result = value.map(read);
  return result.includes(invalid) ? invalid : result;
};
const object = (fields: Readonly<Record<string, Reader>>): Reader => (value) => {
  if (!record(value)) return invalid;
  const result: Record<string, unknown> = {};
  for (const [key, read] of Object.entries(fields)) {
    const item = read(value[key]);
    if (item === invalid) return invalid;
    if (item !== undefined) result[key] = item;
  }
  return result;
};
const dictionary = (read: Reader): Reader => (value) => {
  if (!record(value)) return invalid;
  const entries = Object.entries(value).map(([key, item]) => [key, read(item)] as const);
  return entries.some(([, item]) => item === invalid) ? invalid : Object.fromEntries(entries);
};
function data(value: unknown, depth = 0): unknown {
  if (depth > 64) return invalid;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : invalid;
  if (Array.isArray(value)) {
    const items = value.map((item) => data(item, depth + 1));
    return items.includes(invalid) ? invalid : items;
  }
  if (!record(value)) return invalid;
  const entries = Object.entries(value).filter(([key, item]) => {
    const name = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    return item !== undefined && !name.endsWith('headers') && !/^(?:proto|constructor|prototype|auth|authentication|authorization|proxyauthorization|key|apikey|token|credentials?|password|secret|secretkey|privatekey|clientsecret|accesstoken|refreshtoken)(config|configuration|s)?$/.test(name);
  })
    .map(([key, item]) => [key, data(item, depth + 1)] as const);
  return entries.some(([, item]) => item === invalid) ? invalid : Object.fromEntries(entries);
}
const params: Reader = (value) => record(value) ? data(value) : invalid;
const strings = list(text);
const phase = choice('started', 'planning', 'awaiting-approval', 'running', 'retrying', 'done', 'failed', 'cancelled', 'idle');
const mode = choice('plan-only', 'ask', 'accept-edits', 'auto');
const status = choice('replied', 'applied', 'failed', 'cancelled');
const message = object({ id: text, message: text, values: optional(dictionary((value) => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? value : invalid)) });
const askBack = object({ code: choice('verify_failed', 'anchor_unresolvable', 'needs_input', 'conflict', 'budget_exhausted', 'hook_blocked'), reason: text, revisionDrift: optional(amount), options: strings,
  window: optional(object({ promptTokens: count, reserveTokens: count, windowTokens: count })),
  candidates: optional(list(object({ from: count, to: count, similarity: amount }))) });
const steering = list(object({ noteId: text, text, deliveredAtCall: optional(count) }));
const trace = list(object({ tool: text, callId: text, outcome: choice('ok', 'refused', 'not-run'), code: optional(text), params, agentPath: optional(text) }));
const spend = object({ modelCalls: count, promptTokens: amount, completionTokens: amount, estimatedTokens: amount, costUsd: optional(amount), steps: count, activeMs: amount });
const usageRow = object({ version: choice(1), turnId: text, sessionId: optional(text), agentPath: optional(text), profileId: text, model: text, role: choice('chat', 'drafting', 'background'),
  promptTokens: amount, completionTokens: amount, requests: count, cachedPromptTokens: amount, cacheWritePromptTokens: amount, reasoningTokens: amount,
  estimatedRequests: count, unpricedRequests: count, providerCostRequests: count, costUsd: optional(amount) });
const tokens = object({ promptTokens: amount, completionTokens: amount, requests: count });
const compactions = list(object({ at: amount, origin: choice('auto', 'manual'), role: choice('chat', 'drafting', 'background'), status: choice('replied', 'failed', 'cancelled'),
  covers: object({ from: text, to: text, turns: count }), usage: list(usageRow) }));
const budgetUse = object({ modelCalls: count, tokens: amount, costUsd: optional(amount), wordsChanged: count, documents: count, steps: count });
const hooks = list(object({ hookId: text, name: text, event: text, tool: text, callId: optional(text), ms: amount, failed: optional(text),
  decision: (value) => {
    if (!record(value)) return invalid;
    if (value['action'] === 'allow') return { action: 'allow' };
    if (value['action'] === 'context') return object({ action: choice('context'), text })(value);
    return object({ action: choice('warn', 'block'), reason: text })(value);
  } }));
const planStep = object({ tool: text, params, expect: text });
const reportValue = object({
  turnId: text, status, summary: text, text: optional(text), external: optional(bool), readPolicy: optional(text), compactions: optional(compactions),
  steps: list(object({ index: count, tool: text, expect: text, status: choice('done', 'failed', 'cancelled'), mayHaveActed: optional(choice(true)), summary: optional(text), data: optional(params), error: optional(text) })),
  cards: list(object({ kind: choice('plan', 'confirm', 'auto'), tools: strings, decision: choice('approved', 'cancelled', 'auto'), edits: count, retries: count })),
  trace, undoGroupId: optional(text), askBack: optional(askBack), tokens, usage: optional(list(usageRow)), costUsd: optional(amount), dropped: strings, modelCalls: count, cutReplies: optional(count),
  cache: optional(object({ promptTokens: amount, cachedPromptTokens: amount, cacheWritePromptTokens: amount, misses: list(object({ call: count, cause: text })) })),
  stop: optional(object({ by: choice('user'), during: phase })),
  budgetStop: optional(object({ dimension: choice('model-calls', 'tokens', 'cost', 'words', 'documents', 'steps', 'repeats', 'active-time', 'deadline'), limit: amount, spent: amount, needed: optional(amount), unpriced: optional(choice(true)) })),
  spend: optional(spend), steering: optional(steering), mode, budgetUse, heldSteps: optional(list(planStep)), heldRequiresRestart: optional(choice(true)), hooks: optional(hooks), command: optional(text),
});
const cards = list(object({ id: text, turnId: text, callId: text, tool: text, risk: text, status: choice('pending-approval', 'running', 'done', 'cancelled', 'failed'), args: params,
  summary: optional(text), error: optional(text), startedAt: optional(amount), finishedAt: optional(amount), mayHaveActed: optional(choice(true)),
  delegation: optional(object({ agent: text, agentPath: text, reserved: count, outcome: choice('running', 'done', 'partial', 'failed'), result: optional(text), proposed: optional(count), trace })) }));
const plan = nullable(object({ id: text, turnId: text, kind: choice('plan', 'confirm'), revision: count, previewRevision: count, from: count,
  steps: list(object({ index: count, origin: count, tool: text, expect: text, risk: text, params, status: choice('ready', 'deferred', 'refused', 'done'),
    error: optional(object({ code: text, message: text, target: optional(text), risk: optional(choice('read', 'write-auto', 'write-confirm', 'never')), correctiveHint: optional(text), messageRef: optional(message), correctiveHintRef: optional(message), details: optional(params) })),
    hooks: optional(hooks), badges: strings, stale: bool, cut: bool, proposedBy: optional(text),
    cost: optional(object({ promptUsd: amount, completionUsd: amount, totalUsd: amount, cachedTokens: optional(count), includesThinking: optional(choice(true)) })) })),
  approvable: bool, canAcceptCut: bool, cut: bool, replyCut: optional(choice(true)), notice: optional(text),
  caution: optional(object({ followsUntrusted: strings, requiresSecondClick: bool, lead: optional(text),
    quotes: list(object({ nodeId: text, title: text, words: count, argPath: text, step: optional(count) })),
    hits: list(object({ kind: choice('invisible', 'role-marker', 'override-phrase', 'foreign-link'), excerpt: text })) })) }));
const turnValue = object({ turnId: text, intent: text, command: nullable(text), provider: nullable(text), phase: choice('done', 'failed', 'cancelled'), cards, plan, planSeq: count, planAuto: bool, mode: nullable(mode),
  clearedResults: optional(list(object({ tool: text, toolCallId: optional(text), tokens: amount }))),
  ladder: list(object({ callId: text, attempt: count, askBack })), findings: list(object({ aspect: text, severity: choice('info', 'minor', 'major'), docs: strings, quote: text, note: text })),
  checkpoint: nullable(object({ undoGroupId: text, label: text, mode, note: optional(text) })), report: reportValue,
  tasks: object({ turnId: text, items: list(object({ key: text, content: text, activeForm: text, state: choice('pending', 'waiting', 'in_progress', 'done', 'skipped', 'failed'),
    contentRef: optional(message), activeFormRef: optional(message), tool: optional(text), callId: optional(text), reason: optional(text) })), modelCalls: object({ used: count, limit: amount }), phase }),
  steering, run: nullable(object({ spend, limits: object({ maxModelCalls: optional(amount), maxTokens: optional(amount), maxCostUsd: optional(amount), maxSteps: optional(amount), maxActiveMs: optional(amount), deadline: optional(amount) }) })),
  accountingUnavailable: optional(choice(true)),
});

export function sessionPresentation(turn: TurnRecord, hidden: boolean): SessionTurnPresentation {
  const status = turn.report?.status;
  const clean = turnValue({ ...turn, phase: status === 'replied' || status === 'applied' ? 'done' : status });
  if (clean === invalid) throw new Error('The settled turn presentation is invalid.');
  const projected = clean as TurnRecord;
  const report = projected.report!;
  return {
    version: 1, hidden,
    turn: redactDeep({
      ...newTurnRecord(projected.turnId, projected.intent), ...projected,
      tasks: { ...newTurnRecord(projected.turnId, projected.intent).tasks, ...projected.tasks },
      plan: projected.plan === null ? null : { ...projected.plan, approvable: false, canAcceptCut: false },
      report: { ...report, ...(report.steering === undefined ? {} : { steering: report.steering.filter((note) => note.deliveredAtCall !== undefined) }) },
      steering: projected.steering.filter((note) => note.deliveredAtCall !== undefined),
    }),
  };
}

export function projectSessionTurn(run: RunRow, rows: readonly unknown[], usage?: (turnId: string) => readonly TurnUsageRow[]): SessionTurnPresentation | null {
  if (run.status !== 'finished' && run.status !== 'failed') return null;
  const parsed = parseRunEvents(rows);
  if (!parsed.ok) return null;
  const start = parsed.events.findLast((event) => event.t === 'turn.start');
  const end = parsed.events.findLast((event) => event.t === 'turn.end');
  if (start?.t !== 'turn.start' || end?.t !== 'turn.end' || start.turnId !== end.turnId) return null;
  const activity = end.compactions === undefined ? undefined : compactions(end.compactions);
  if (activity === invalid) return null;
  const recordedCompactions = activity as TurnReport['compactions'];
  const external = end.external === true || parsed.events.some((event) =>
    ('tool' in event && event.tool.startsWith('mcp__')) ||
    (event.t === 'messages' && event.appended.some((message) => /<<untrusted source=\\*"mcp/.test(textOf(message.content)))),
  );
  const value = run.presentation;
  if (record(value) && value['version'] === 1 && record(value['turn'])) {
    const clean = turnValue(value['turn']);
    if (clean !== invalid) {
      const turn = clean as TurnRecord;
      if (turn.turnId === end.turnId && turn.report?.turnId === end.turnId && turn.report.status === end.status && turn.tasks.turnId === end.turnId) {
        return sessionPresentation({ ...turn, report: { ...turn.report,
          ...(external || turn.report.trace.some((entry) => entry.tool.startsWith('mcp__')) ? { external: true } : {}),
          ...(end.readPolicy === undefined ? {} : { readPolicy: end.readPolicy }),
          ...(recordedCompactions === undefined ? {} : { compactions: recordedCompactions }),
        } }, start.hiddenFromPlanner === true);
      }
    }
  }
  const applied = parsed.events.filter((event) => event.t === 'step.applied');
  const recordedSpend = parsed.events.findLast((event) => event.t === 'spend');
  const savedUsage = (usage?.(end.turnId) ?? []).filter((row) => row.turnId === end.turnId).map((row) => usageRow(row)).filter((row): row is TurnUsageRow => row !== invalid);
  const totals = savedUsage.length === 0 ? undefined : sumUsage(savedUsage);
  const recorded = recordedSpend?.t === 'spend' ? recordedSpend.spend : undefined;
  const calls = totals?.requests ?? recorded?.modelCalls ?? 0;
  const promptTokens = totals?.promptTokens ?? recorded?.promptTokens ?? 0;
  const completionTokens = totals?.completionTokens ?? recorded?.completionTokens ?? 0;
  const costUsd = totals?.costUsd ?? recorded?.costUsd;
  const report: TurnReport = {
    turnId: end.turnId, status: end.status, summary: end.summary,
    ...(external ? { external: true } : {}),
    ...(end.readPolicy === undefined ? {} : { readPolicy: end.readPolicy }),
    ...(recordedCompactions === undefined ? {} : { compactions: recordedCompactions }),
    ...(end.status === 'replied' ? { text: end.summary } : {}),
    steps: applied.map((event) => ({ index: event.index, tool: event.tool, expect: '', status: 'done', ...(event.summary === undefined ? {} : { summary: event.summary }) })),
    cards: [], trace: [], tokens: { promptTokens, completionTokens, requests: calls },
    ...(savedUsage.length === 0 ? {} : { usage: savedUsage }), ...(costUsd === undefined ? {} : { costUsd }),
    ...(recorded === undefined ? {} : { spend: recorded }),
    ...(run.outcome === 'stopped' ? { stop: { by: 'user', during: 'running' } as const } : {}),
    dropped: [], modelCalls: calls, mode: 'ask', budgetUse: { wordsChanged: 0, documents: 0, modelCalls: calls, tokens: promptTokens + completionTokens, steps: recorded?.steps ?? applied.length },
    ...(start.command === undefined ? {} : { command: start.command }),
  };
  const base = newTurnRecord(end.turnId, run.intent, null, start.command ?? null);
  return { version: 1, hidden: start.hiddenFromPlanner === true, turn: {
    ...base, report, mode: report.mode, ...(totals === undefined && recorded === undefined ? { accountingUnavailable: true as const } : {}),
    phase: end.status === 'replied' || end.status === 'applied' ? 'done' : end.status,
    cards: applied.map((event) => ({ id: event.callId, callId: event.callId, turnId: end.turnId, tool: event.tool, risk: 'write-confirm', args: {}, status: 'done', ...(event.summary === undefined ? {} : { summary: event.summary }) })),
  } };
}

export function recentSessionTurns(turns: readonly TurnRecord[], refs: readonly AgentSessionTurnRef[], runs: ReadonlyMap<string, SessionTurnPresentation>) {
  const ids = new Set(turns.map((turn) => turn.turnId));
  return refs.flatMap((ref) => {
    const stored = runs.get(ref.runId);
    const turn = stored?.turn;
    if (turn === undefined || !ids.has(turn.turnId)) return [];
    return [{ turnId: turn.turnId, intent: turn.intent, outcome: turn.report?.summary.slice(0, 1200) ?? '',
      ...(turn.report?.external === true ? { external: true } : {}),
      ...(turn.report?.readPolicy === undefined ? {} : { readPolicy: turn.report.readPolicy }),
      ...(turn.report?.undoGroupId === undefined ? {} : { undoGroupId: turn.report.undoGroupId }),
      ...(stored?.hidden === true ? { hidden: true } : {}),
      ...(ref.rewound === undefined ? {} : { rewound: ref.rewound }),
      ...(ref.restoredAt === undefined ? {} : { restoredAt: ref.restoredAt }),
      ...(ref.restoredFromStep === undefined ? {} : { restoredFromStep: ref.restoredFromStep }),
    }];
  });
}

export function recordedSessionTokens(run: RunRow | undefined): number | null {
  const value = run?.presentation;
  if (!record(value) || value['version'] !== 1 || !record(value['turn']) || value['turn']['accountingUnavailable'] === true || !record(value['turn']['report'])) return null;
  const saved = tokens(value['turn']['report']['tokens']);
  if (saved === invalid) return null;
  const counts = saved as TurnReport['tokens'];
  const total = counts.promptTokens + counts.completionTokens;
  return Number.isFinite(total) ? total : null;
}

export function sessionMarkdown(session: AgentSessionRow, turns: readonly TurnRecord[]): string {
  const projected = turns.map((turn) => sessionPresentation(turn, false).turn);
  const metadata = redactDeep(session);
  const head = JSON.stringify({ session: metadata, turns: projected }, null, 2);
  return `---\n${head}\n---\n\n# ${metadata.title || 'Agent session'}\n\n${projected.map((turn, index) => `## ${index + 1}. ${turn.intent}\n\n${turn.report?.text ?? turn.report?.summary ?? ''}\n`).join('\n')}`;
}
