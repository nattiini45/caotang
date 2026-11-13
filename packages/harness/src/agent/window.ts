import { contentTokens, promptTokensOf, type ChatMessage } from '@caotang/gateway';

export interface WindowBudget {
  readonly windowTokens?: number;
  readonly reserveTokens: number;
  readonly keepToolResults: number;
}

export interface ClearedToolResult {
  readonly tool: string;
  readonly toolCallId?: string;
  readonly tokens: number;
}

export function fitToWindow(
  messages: readonly ChatMessage[],
  budget: WindowBudget,
): { readonly messages: ChatMessage[]; readonly cleared: readonly ClearedToolResult[]; readonly fits: boolean } {
  const fitted = [...messages];
  const cleared: ClearedToolResult[] = [];
  const fits = (): boolean => budget.windowTokens === undefined || promptTokensOf(fitted) + budget.reserveTokens <= budget.windowTokens;
  if (fits()) return { messages: fitted, cleared, fits: true };

  const names = new Map(messages.flatMap((message) => (message.toolCalls ?? []).map((call) => [call.id, call.name])));
  const results = messages.flatMap((message, index) => message.role === 'tool' ? [index] : []);
  for (const index of results.slice(0, Math.max(0, results.length - budget.keepToolResults))) {
    const message = messages[index]!;
    const tool = names.get(message.toolCallId ?? '') ?? 'tool';
    const placeholder = `[${tool} result cleared to save room; call it again if you need it]`;
    const tokens = contentTokens(message.content);
    if (tokens <= contentTokens(placeholder)) continue;
    const replacement = { ...message, content: placeholder };
    delete replacement.parts;
    fitted[index] = replacement;
    cleared.push({ tool, ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }), tokens });
    if (fits()) return { messages: fitted, cleared, fits: true };
  }
  return { messages: fitted, cleared, fits: false };
}
