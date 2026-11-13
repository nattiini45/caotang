import { ok } from '@caotang/bus';
import { MEMORY_WITHHELD_OUTCOME, memoryReadable, nonceFor, spotlight } from '@caotang/context';

import { failure, invalidParams } from '../errors.js';
import { param, type ObjectSpec } from '../schema.js';
import { estimateTokens, fitsCap } from '../tokens.js';
import type { ToolPort } from '../types.js';
import { firstCodePoints, isRecord } from '../util.js';

export const SESSION_HISTORY_CAP = 4_000;

export interface SessionHistoryTurn {
  readonly turnId: string;
  readonly intent: string;
  readonly outcome: string;
  readonly undoGroupId?: string;
  readonly restoredAt?: number;
  readonly restoredFromStep?: number;
  readonly external?: true;
  readonly outcomeWithheld?: true;
}

export type SessionHistoryPage = {
  readonly turns: readonly SessionHistoryTurn[];
  readonly total: number;
  readonly nextBefore: string | null;
  readonly truncated: boolean;
};

export const sessionHistoryParams: ObjectSpec = param.object('Earlier turns in the current role’s conversation, newest first.', {
  before: param.string('Return only turns older than this turn id from a previous page.', { nonBlank: true }),
  limit: param.integer('The most turns to return, from 1 to 50. Default 10.', { minimum: 1, maximum: 50, default: 10 }),
}, []);

const historyTurnSpec = param.object('One earlier turn, without a plan or draft body.', {
  turnId: param.string('The turn’s stable id.'),
  intent: param.string('The writer’s request, as one bounded line.'),
  outcome: param.string('The settled outcome, as one bounded line.'),
  undoGroupId: param.string('The undo group, when one exists.'),
  restoredAt: param.number('When the writer restored these project changes, in epoch milliseconds.'),
  restoredFromStep: param.integer('The first restored step, when the restore was partial.'),
  external: param.boolean('This outcome may include connected-server text; it is not approval.'),
  outcomeWithheld: param.boolean('The earlier outcome is withheld because its read boundary no longer agrees with the current rules.'),
}, ['turnId', 'intent', 'outcome']);

export const sessionHistoryResult = param.object('A page of current-role conversation history.', {
  turns: param.list('Readable turns, newest first.', historyTurnSpec),
  total: param.integer('The number of readable turns in this role’s conversation.'),
  nextBefore: param.nullable(param.string('The exclusive cursor for the next page, or null at the end.')),
  truncated: param.boolean('More turns remain or a returned line was clipped.'),
}, ['turns', 'total', 'nextBefore', 'truncated']);

function line(text: string): string {
  const value = text.replace(/\s+/g, ' ').trim();
  return value.length <= 1_200 ? value : `${firstCodePoints(value, 1_199)}…`;
}

export function sessionHistoryText(body: unknown, nonce: string, named = true): string {
  const head = named ? { tool: 'session.history' } : {};
  if (isRecord(body) && Array.isArray(body['turns']) && body['turns'].some((turn) => isRecord(turn) && turn['external'] === true)) {
    return `${JSON.stringify({ ...head, ok: true, data: 'in the untrusted block below' })}\n${spotlight(JSON.stringify(body), { kind: 'session-history' }, nonce)}`;
  }
  return JSON.stringify({ ...head, ok: true, data: body });
}

export const sessionHistoryPort: ToolPort = (params, context) => {
  if (context.sessionHistory === undefined) {
    return failure(invalidParams('session.history needs the current role’s agent conversation. No history was read.', 'call it inside an agent turn, not from an external caller or a delegated child', 'name'));
  }
  const history = context.sessionHistory.filter((turn) => turn.hidden !== true && turn.rewound !== true).reverse();
  const before = params['before'];
  const cursor = before === undefined ? -1 : history.findIndex((turn) => turn.turnId === before);
  if (before !== undefined && cursor < 0) {
    return failure(invalidParams('The before turn is not in this role’s readable history.', 'use nextBefore from the previous page', 'before'));
  }
  const limit = typeof params['limit'] === 'number' ? params['limit'] : 10;
  const turns: SessionHistoryTurn[] = [];
  let clipped = false;
  let nextBefore: string | null = null;
  for (let index = cursor + 1; index < history.length && turns.length < limit; index++) {
    const source = history[index]!;
    const readable = memoryReadable(source, context.readPolicy);
    const turn: SessionHistoryTurn = {
      turnId: source.turnId,
      intent: line(source.intent),
      outcome: readable ? line(source.outcome ?? 'no recorded changes') : MEMORY_WITHHELD_OUTCOME,
      ...(readable ? {} : { outcomeWithheld: true }),
      ...(source.undoGroupId === undefined ? {} : { undoGroupId: source.undoGroupId }),
      ...(source.restoredAt === undefined ? {} : { restoredAt: source.restoredAt }),
      ...(source.restoredFromStep === undefined ? {} : { restoredFromStep: source.restoredFromStep }),
      ...(source.external === true ? { external: true } : {}),
    };
    const page = { turns: [...turns, turn], total: history.length, nextBefore: turn.turnId, truncated: false };
    if (estimateTokens(sessionHistoryText(page, nonceFor(context.turnId))) > SESSION_HISTORY_CAP ||
      !fitsCap({ data: page, summary: `read ${turns.length + 1} earlier turns in this role’s conversation`, affected: [] }, SESSION_HISTORY_CAP)) break;
    turns.push(turn);
    clipped ||= source.intent.replace(/\s+/g, ' ').trim().length > 1_200 || (source.outcome ?? '').replace(/\s+/g, ' ').trim().length > 1_200;
    nextBefore = index < history.length - 1 ? turn.turnId : null;
  }
  if (turns.length === 0 && cursor + 1 < history.length) {
    return failure(invalidParams('A turn’s history record is too large for the history response cap. No turn was skipped.', 'export the session to inspect that turn', 'before'));
  }
  return ok({ data: { turns, total: history.length, nextBefore, truncated: clipped || nextBefore !== null }, summary: `read ${turns.length} earlier turns in this role’s conversation`, affected: [] });
};
