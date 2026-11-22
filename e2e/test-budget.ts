export function modernWebkitBudget(browserName: string, tags: readonly string[], timeout: number): number {
  return browserName === 'webkit' && tags.includes('@modern') && timeout === 30_000 ? 60_000 : timeout;
}
