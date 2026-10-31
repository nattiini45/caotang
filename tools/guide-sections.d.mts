/** Types for tools/guide-sections.mjs, so the repository tests can import it. */

export interface GuideSection {
  readonly level: number;
  readonly heading: string;
  readonly lines: string[];
  readonly text: string;
}

export interface IdentifiedSection extends GuideSection {
  readonly id: string;
}

export type SectionStatus = 'current' | 'stale' | 'missing' | 'renamed';

export interface SectionRow {
  readonly index: number;
  readonly id: string;
  readonly heading: string;
  readonly level: number;
  readonly hash: string | null;
  readonly marker: string | null;
  readonly status: SectionStatus;
}

export interface SectionReport {
  readonly sections: SectionRow[];
  readonly counts: Record<SectionStatus, number>;
  readonly total: number;
}

export type ResolveReason = 'current' | 'stale' | 'missing';

export interface ResolvedGuideSection {
  readonly locale: string;
  readonly sectionId: string;
  readonly reason: ResolveReason;
  readonly text: string;
  readonly heading: string | null;
  readonly hash: string | null;
}

export interface ReportLocale {
  readonly locale: string;
  readonly path: string;
  readonly exists: boolean;
  readonly report: SectionReport;
}

export interface GuideStatusDocument {
  readonly sourceLocale: 'en';
  readonly locales: Record<string, { readonly sections: Record<string, { readonly hash: string; readonly anchor: string }> }>;
}

export const ENGLISH_GUIDE_PATH: string;
export const GUIDES_ROOT: string;
export const GUIDE_STATUS_PATH: string;
export const SECTION_STATUSES: readonly SectionStatus[];
export const STALE_BANNER_LINE: string;

export function translatedGuidePath(locale: string): string;
export function normaliseGuide(text: string): string;
export function splitSections(markdown: string): GuideSection[];
export function sectionIdOf(heading: string): string;
export function assignSectionIds(sections: GuideSection[]): IdentifiedSection[];
export function sourceHashOf(sectionText: string): string;
export function markerOf(section: GuideSection): string | null;
export function stripSourceMarkers(text: string): string;
export function stampSourceMarkers(englishMarkdown: string, translationMarkdown: string): string;
export function isStaleStatus(status: SectionStatus): boolean;
export function markStaleSections(englishMarkdown: string, translationMarkdown: string | null | undefined): string | null;
export function reportSections(englishMarkdown: string, translationMarkdown: string | null | undefined): SectionReport;
export function resolveGuideSection(options: {
  locale: string;
  sectionId: string;
  english: string;
  translated: string | null | undefined;
}): ResolvedGuideSection;
export function guideStatusDocument(
  locales: ReadonlyArray<{ readonly locale: string; readonly translation: string | null | undefined; readonly report: SectionReport }>,
): GuideStatusDocument;
export function renderReport(options: { englishPath: string; englishMarkdown: string; locales: ReportLocale[] }): string;
