import type { DayUsageRow } from '@caotang/gateway';
import { csvField } from '@caotang/dialogue';
import { guardFormula } from '@caotang/storyboard';

export function usageCsv(rows: readonly DayUsageRow[], names: ReadonlyMap<string, string>): string {
  const header = ['day', 'profile_id', 'profile', 'model', 'role', 'requests', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'estimated_requests', 'unpriced_requests', 'provider_cost_requests', 'cost_usd'];
  return [header, ...rows.map((row) => [
    row.date, row.profileId, names.get(row.profileId) ?? '', row.model, row.role,
    row.requests, row.promptTokens, row.completionTokens, row.cachedPromptTokens, row.cacheWritePromptTokens,
    row.reasoningTokens, row.estimatedRequests, row.unpricedRequests, row.providerCostRequests, row.costUsd ?? '',
  ])].map((row) => row.map((cell) => csvField(guardFormula(String(cell)))).join(',')).join('\r\n') + '\r\n';
}
