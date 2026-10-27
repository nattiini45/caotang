/**
 * What the Trace tab shows (agent-harness §5.2): one turn of the in-tab store as a timeline of rows, in the order the records were
 * written. A pure function of the store, so the view is a function of what was recorded and nothing else.
 *
 * Every text here is a string the panel renders as text. Nothing is parsed as markup.
 */

import { TRACE_REVIEWS, type TraceMessage, type TraceRecord, type TraceStore, type TraceText } from '@caotang/harness';

export interface TraceMessageView {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  /** The content as it was sent: what the text shows plus what was cut from the content. */
  readonly chars: number;
  /** The tool calls the message carries, as `name(arguments)`. */
  readonly calls: readonly string[];
  /** Characters cut from the whole message to keep the record within its cap, including tool-call arguments and reasoning. */
  readonly cut?: number;
}

export interface TraceCallRow {
  readonly kind: 'call';
  readonly key: string;
  readonly callId: number;
  readonly callIndex?: number;
  readonly agentPath?: string;
  readonly model: string;
  readonly role?: string;
  readonly thinking?: string;
  readonly profileId: string;
  readonly startMs: number;
  /** Absent while the call is still in flight. */
  readonly durationMs?: number;
  readonly firstTokenMs?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly usageSource?: 'provider' | 'estimate';
  readonly finishReason?: string;
  readonly attempts?: number;
  readonly tries: readonly { readonly attempt: number; readonly outcome: string; readonly status?: number }[];
  readonly messages: readonly TraceMessageView[];
  readonly tools: readonly string[];
  readonly reply?: string;
  readonly reasoning?: string;
  readonly replyCalls: readonly string[];
  readonly error?: string;
  /** Characters cut from the response to keep the record within its cap. */
  readonly cut?: number;
  /** Said when the row had to be made from the reply alone. */
  readonly note?: string;
}

export interface TraceToolRow {
  readonly kind: 'tool';
  readonly key: string;
  readonly callId: string;
  readonly tool: string;
  readonly risk: string;
  readonly agentPath?: string;
  readonly outcome?: string;
  readonly code?: string;
  readonly params: string;
  readonly result?: string;
  readonly startMs: number;
  readonly durationMs?: number;
  readonly cut?: number;
  /** Characters cut from the parameters to keep the record within its cap. `cut` is the result's. */
  readonly paramsCut?: number;
}

export interface TraceNoteRow {
  readonly kind: 'card' | 'context' | 'ladder' | 'hook';
  readonly key: string;
  readonly startMs: number;
  readonly text: string;
}

export type TraceRow = TraceCallRow | TraceToolRow | TraceNoteRow;

export interface TraceTimeline {
  readonly turnId: string;
  readonly reviews: boolean;
  readonly intent: string;
  readonly rows: readonly TraceRow[];
  /** The time from the first record to the last, the scale the waterfall bars are drawn on. */
  readonly spanMs: number;
  readonly calls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly status?: string;
}

const textOf = (value: TraceText | undefined): string => (value === undefined ? '' : typeof value === 'string' ? value : `[left out: ${value.omitted.chars} characters]`);

const jsonOf = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '';
  }
};

function viewOf(id: string, message: TraceMessage | undefined, cut: number, contentCut: number): TraceMessageView {
  if (message === undefined) return { id, role: 'unknown', text: '', chars: 0, calls: [] };
  const text = textOf(message.content);
  return {
    id,
    role: message.role,
    text,
    chars: text.length + contentCut,
    calls: (message.toolCalls ?? []).map((call) => `${call.name}(${textOf(call.argumentsJson)})`),
    ...(cut > 0 ? { cut } : {}),
  };
}

/** One turn of the store (or the reviews group) as rows. A turn the store no longer holds is an empty timeline. */
export function turnTimeline(store: TraceStore, turnId: string): TraceTimeline {
  const records = store.records(turnId);
  const t0 = records[0]?.at ?? 0;
  let intent = '';
  let status: string | undefined;
  let last = t0;
  const rows: TraceRow[] = [];
  const calls = new Map<number, number>();
  const tools = new Map<string, number>();
  let promptTokens = 0;
  let completionTokens = 0;

  const patch = <T extends TraceRow>(at: number | undefined, change: (row: T) => T): void => {
    if (at === undefined) return;
    rows[at] = change(rows[at] as T);
  };

  for (const record of records as readonly TraceRecord[]) {
    last = Math.max(last, record.at);
    switch (record.kind) {
      case 'turn.start':
        intent = textOf(record.intent);
        break;
      case 'model.request':
        calls.set(record.callId, rows.length);
        rows.push({
          kind: 'call',
          key: `call-${record.callId}`,
          callId: record.callId,
          ...(record.callIndex === undefined ? {} : { callIndex: record.callIndex }),
          ...(record.agentPath === undefined ? {} : { agentPath: record.agentPath }),
          model: record['gen_ai.request.model'],
          ...(record.role === undefined ? {} : { role: record.role }),
          ...(record.thinking === undefined ? {} : { thinking: record.thinking }),
          profileId: record.profileId,
          startMs: record.at - t0,
          tries: [],
          messages: record.messages.map((id) => viewOf(id, store.message(id), store.messageCut(id), store.messageContentCut(id))),
          tools: (record.tools ?? []).map((tool) => tool.name),
          replyCalls: [],
        });
        break;
      case 'model.response': {
        promptTokens += record['gen_ai.usage.input_tokens'];
        completionTokens += record['gen_ai.usage.output_tokens'];
        // A reply whose request was never recorded (recording was turned off and on during the call) still gets a row, so the rows and the totals agree.
        if (!calls.has(record.callId)) {
          calls.set(record.callId, rows.length);
          rows.push({
            kind: 'call',
            key: `call-${record.callId}`,
            callId: record.callId,
            ...(record.callIndex === undefined ? {} : { callIndex: record.callIndex }),
            ...(record.agentPath === undefined ? {} : { agentPath: record.agentPath }),
            model: 'unknown model',
            profileId: 'unknown',
            startMs: record.at - t0,
            tries: [],
            messages: [],
            tools: [],
            replyCalls: [],
            note: 'The reply was recorded without its request, because recording was turned off and on again during the call.',
          });
        }
        patch<TraceCallRow>(calls.get(record.callId), (row) => ({
          ...row,
          durationMs: record.finishedAt - t0 - row.startMs,
          ...(record.firstTokenAt === undefined ? {} : { firstTokenMs: record.firstTokenAt - t0 - row.startMs }),
          promptTokens: record['gen_ai.usage.input_tokens'],
          completionTokens: record['gen_ai.usage.output_tokens'],
          usageSource: record.usageSource,
          finishReason: record['gen_ai.response.finish_reasons'][0] ?? 'stop',
          attempts: record.attempts,
          tries: record.tries.map((entry) => ({ attempt: entry.attempt, outcome: entry.outcome, ...(entry.status === undefined ? {} : { status: entry.status }) })),
          reply: textOf(record.content),
          ...(record.reasoningText === undefined ? {} : { reasoning: textOf(record.reasoningText) }),
          replyCalls: (record.toolCalls ?? []).map((call) => `${call.name}(${textOf(call.argumentsJson)})`),
          ...(record.error === undefined ? {} : { error: `${record.error.kind}: ${textOf(record.error.message)}` }),
          ...(record.truncated === undefined ? {} : { cut: record.truncated.chars }),
        }));
        break;
      }
      case 'tool.call':
        tools.set(record.callId, rows.length);
        rows.push({
          kind: 'tool',
          key: `tool-${record.callId}-${rows.length}`,
          callId: record.callId,
          tool: record.tool,
          risk: record.risk,
          ...(record.agentPath === undefined ? {} : { agentPath: record.agentPath }),
          params: jsonOf(record.params),
          startMs: record.at - t0,
          ...(record.truncated === undefined ? {} : { paramsCut: record.truncated.chars }),
        });
        break;
      case 'tool.result':
        patch<TraceToolRow>(tools.get(record.callId), (row) => ({
          ...row,
          outcome: record.outcome,
          ...(record.code === undefined ? {} : { code: record.code }),
          ...(record.body === undefined ? {} : { result: typeof record.body === 'string' ? record.body : jsonOf(record.body) }),
          durationMs: record.finishedAt - (record.startedAt ?? record.finishedAt),
          ...(record.truncated === undefined ? {} : { cut: record.truncated.chars }),
        }));
        break;
      case 'card':
        rows.push({
          kind: 'card',
          key: `card-${record.seq}`,
          startMs: record.at - t0,
          text: `${record.card.kind} card for ${record.card.tools.join(', ')}: ${record.card.decision}${record.card.edits > 0 ? `, ${record.card.edits} edit${record.card.edits === 1 ? '' : 's'}` : ''}${record.card.retries > 0 ? `, ${record.card.retries} redraft${record.card.retries === 1 ? '' : 's'}` : ''}`,
        });
        break;
      case 'context': {
        const tokens = record.layers.reduce((sum, layer) => sum + layer.tokens, 0);
        rows.push({
          kind: 'context',
          key: `context-${record.seq}`,
          startMs: record.at - t0,
          text: `Context for call ${record.callIndex}: ${tokens.toLocaleString('en-US')} tokens in ${record.layers.filter((layer) => layer.tokens > 0).length} layers${record.dropped.length === 0 ? '' : `, ${record.dropped.length} left out`}`,
        });
        break;
      }
      case 'ladder':
        rows.push({ kind: 'ladder', key: `ladder-${record.seq}`, startMs: record.at - t0, text: `Verify ladder, attempt ${record.attempt}: ${textOf(record.reason)}` });
        break;
      case 'hook':
        rows.push({
          kind: 'hook',
          key: `hook-${record.seq}`,
          startMs: record.at - t0,
          text: `Hook “${textOf(record.name)}” ${record.action === 'block' ? 'stopped' : record.action === 'warn' ? 'warned about' : 'added a note to'} ${record.tool} (${record.event}): ${textOf(record.text)}`,
        });
        break;
      case 'turn.end':
        status = (record.report as { status?: string }).status;
        break;
      default:
        break;
    }
  }

  return {
    turnId,
    reviews: turnId === TRACE_REVIEWS,
    intent,
    rows,
    spanMs: Math.max(1, last - t0),
    calls: rows.filter((row) => row.kind === 'call').length,
    promptTokens,
    completionTokens,
    ...(status === undefined ? {} : { status }),
  };
}

/** The sentence that says where a waterfall bar sits, for the reader who does not see the bar. */
export function barSentence(startMs: number, durationMs: number | undefined): string {
  return durationMs === undefined ? `started ${startMs} ms in, still running` : `started ${startMs} ms in and took ${durationMs} ms`;
}
