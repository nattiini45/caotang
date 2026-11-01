/** Types for tools/translation-report.mjs, so the repository tests can import it. */

export interface Credit {
  readonly name: string;
  readonly commits: number;
}

export function gateOf(completion: number, wasListed?: boolean): string;
export function creditsOf(logOutput: string): Credit[];
export function gitCredits(repoRoot: string, locale: string, run?: (...args: unknown[]) => unknown): Credit[];
export function renderReport(
  stats: { readonly locales: Readonly<Record<string, { total: number; translated: number; missing: number; fuzzy: number; completion: number }>> },
  creditsFor: (locale: string) => Credit[],
  release?: string,
): string;
export function reportFor(repoRoot: string, release?: string): string;
