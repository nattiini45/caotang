/**
 * The coherence report — the one-source compile's Review row (media-track.md §1: "Coherence report (MD/JSON)"), the findings
 * export that is the standard report path (coherence.md §8).
 *
 * It reads the findings file the store holds and writes what it says: every finding with its status, grouped as the
 * inbox groups them (by severity, then by fact, so one problem with its citations is one heading), and the run history.
 * The report changes nothing. A finding dismissed or fixed by the writer is in it with that status, because the report is
 * a record of the file, not a to-do list.
 *
 * Pure: the caller passes the file, the project's title and the day the report is dated. Nothing here reads a clock. The
 * Markdown report's words are the interface language's (i18n.md §7.1): the host passes them, and without them the report is English.
 */

import { checkWordsOf, dismissalLabelOf, type CoherenceFindingState, type CoherenceRunState, type CoherenceState } from '@caotang/store';

/** The Markdown report's MIME type (the same one the prose Markdown export carries). */
export const COHERENCE_MARKDOWN_MIME = 'text/markdown;charset=utf-8';
/** The JSON report's MIME type. */
export const COHERENCE_JSON_MIME = 'application/json';

/**
 * The writer-facing words of the Markdown report. The package holds no translation runtime, so the host supplies them. Whole
 * sentences take their values as parameters, so a language can order them its own way. The JSON report and every machine token
 * (a run's status, a check id, a date) are not translated.
 */
export interface CoherenceReportWords {
  readonly heading: (title: string) => string;
  readonly dated: (date: string) => string;
  readonly noCheckRun: string;
  readonly summaryHeading: string;
  readonly counts: (open: number, dismissed: number, fixed: number) => string;
  readonly noRunRecorded: string;
  readonly latestRun: (runs: number, at: string, status: string) => string;
  readonly severity: Readonly<Record<'error' | 'warning' | 'info', string>>;
  readonly status: Readonly<Record<'open' | 'dismissed' | 'fixed', string>>;
  readonly expected: (text: string) => string;
  readonly dismissedAs: (reason: string) => string;
  readonly note: (text: string) => string;
  readonly runHistoryHeading: string;
  readonly finding: string;
  readonly runKind: Readonly<Record<'deterministic' | 'llm', string>>;
  readonly noChecksNamed: string;
  readonly findingCount: (count: number) => string;
  readonly checkWords: (checkId: string) => string;
  readonly dismissalLabel: (reason: string) => string;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** The English words, which a host that gives none gets and which a headless scan prints. */
export const ENGLISH_REPORT_WORDS: CoherenceReportWords = {
  heading: (title) => `Coherence report: ${title}`,
  dated: (date) => `Dated ${date}.`,
  noCheckRun: 'No check has run on this project yet, so there are no findings to report.',
  summaryHeading: 'Summary',
  counts: (open, dismissed, fixed) => `${plural(open, 'open finding')}, ${dismissed} dismissed, ${fixed} marked fixed.`,
  noRunRecorded: 'No run is recorded.',
  latestRun: (runs, at, status) => `${plural(runs, 'run')} recorded; the latest is ${at} (${status}).`,
  severity: { error: 'Errors', warning: 'Warnings', info: 'Notes' },
  status: { open: 'Open', dismissed: 'Dismissed', fixed: 'Marked fixed' },
  expected: (text) => `Expected: ${text}`,
  dismissedAs: (reason) => `Dismissed as: ${reason}`,
  note: (text) => `Note: ${text}`,
  runHistoryHeading: 'Run history',
  finding: 'Finding',
  runKind: { deterministic: 'Quick scan', llm: 'Model review' },
  noChecksNamed: 'no checks named',
  findingCount: (count) => plural(count, 'finding'),
  checkWords: checkWordsOf,
  dismissalLabel: dismissalLabelOf,
};

export interface CoherenceReportInput {
  /** The project's title, for the heading. */
  readonly title: string;
  /** `YYYY-MM-DD`, the day the report is dated. */
  readonly date: string;
  /** The findings file as the store holds it. Absent means the project has none, and the report says so. */
  readonly file: CoherenceState | undefined;
  /** A document's title by id, or a plain fallback for a document that is no longer in the project. */
  readonly docTitle: (docId: string) => string;
  /** The Markdown report's words. Absent is English. */
  readonly words?: CoherenceReportWords;
}

/** The severity sections, most severe first, in the order the inbox uses (findings-model.ts). */
const SECTIONS = ['error', 'warning', 'info'] as const;

function countOf(findings: readonly CoherenceFindingState[], status: string): number {
  return findings.filter((finding) => finding.status === status).length;
}

/** The findings of one severity, grouped by fact: one group per `factGroup`, in the order the file holds them. */
function groupsOf(findings: readonly CoherenceFindingState[]): CoherenceFindingState[][] {
  const groups = new Map<string, CoherenceFindingState[]>();
  for (const finding of findings) {
    const key = finding.factGroup ?? `finding:${finding.id}`;
    const group = groups.get(key) ?? [];
    group.push(finding);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function statusWord(words: CoherenceReportWords, status: string): string {
  return status === 'open' || status === 'dismissed' || status === 'fixed' ? words.status[status] : status;
}

/** One finding as a Markdown bullet with its quotes and its verdict. */
function findingLines(finding: CoherenceFindingState, docTitle: (docId: string) => string, words: CoherenceReportWords): string[] {
  const check = finding.checkId === undefined ? '' : ` · ${words.checkWords(finding.checkId)}`;
  const head = `- ${statusWord(words, finding.status)}${check}`;
  const lines = [head];
  if (finding.message !== undefined) lines.push(`  ${finding.message}`);
  if (finding.expected !== undefined) lines.push(`  ${words.expected(finding.expected)}`);
  for (const passage of finding.evidence ?? []) {
    if (passage.quote === undefined || passage.quote === '') continue;
    lines.push(`  > “${passage.quote}” (${docTitle(passage.docId)})`);
  }
  if (finding.dismissedReason !== undefined) lines.push(`  ${words.dismissedAs(words.dismissalLabel(finding.dismissedReason))}`);
  if (finding.note !== undefined) lines.push(`  ${words.note(finding.note)}`);
  return lines;
}

function runLines(run: CoherenceRunState, words: CoherenceReportWords): string[] {
  const checks = run.checkIds.length === 0 ? words.noChecksNamed : run.checkIds.map((id) => words.checkWords(id)).join('; ');
  const kind = run.kind === 'deterministic' || run.kind === 'llm' ? words.runKind[run.kind] : run.kind;
  const lines = [`- ${run.at} · ${kind} · ${run.status} · ${words.findingCount(run.findingsUpserted.length)} · ${checks}`];
  for (const note of run.notes ?? []) lines.push(`  ${note}`);
  return lines;
}

/** The Markdown report: a summary, the findings by severity and fact, and the run history, newest first. */
export function coherenceReportMarkdown(input: CoherenceReportInput): string {
  const words = input.words ?? ENGLISH_REPORT_WORDS;
  const lines: string[] = [`# ${words.heading(input.title)}`, '', words.dated(input.date), ''];
  const file = input.file;
  if (file === undefined || (file.findings.length === 0 && file.runs.length === 0)) {
    lines.push(words.noCheckRun, '');
    return `${lines.join('\n')}\n`;
  }

  const runs = file.runs;
  lines.push(`## ${words.summaryHeading}`, '');
  lines.push(`- ${words.counts(countOf(file.findings, 'open'), countOf(file.findings, 'dismissed'), countOf(file.findings, 'fixed'))}`);
  const latest = runs[runs.length - 1];
  lines.push(latest === undefined ? `- ${words.noRunRecorded}` : `- ${words.latestRun(runs.length, latest.at, latest.status)}`);
  lines.push('');

  for (const severity of SECTIONS) {
    const findings = file.findings.filter((finding) => finding.severity === severity);
    if (findings.length === 0) continue;
    lines.push(`## ${words.severity[severity]}`, '');
    for (const group of groupsOf(findings)) {
      const first = group[0];
      if (first === undefined) continue;
      lines.push(`### ${first.message ?? first.type ?? words.finding}`, '');
      for (const finding of group) lines.push(...findingLines(finding, input.docTitle, words), '');
    }
  }

  if (runs.length > 0) {
    lines.push(`## ${words.runHistoryHeading}`, '');
    for (const run of [...runs].reverse()) lines.push(...runLines(run, words));
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

/**
 * The JSON report: the same findings and runs as the file holds them, with the summary counts. The findings are written
 * as the file carries them, so a reader of the report and a reader of `coherence.json` see the same records. It is machine data
 * and never translated.
 */
export function coherenceReportJson(input: CoherenceReportInput): string {
  const file = input.file;
  const findings = file?.findings ?? [];
  const runs = file?.runs ?? [];
  const payload = {
    formatVersion: 1,
    project: input.title,
    date: input.date,
    summary: {
      open: countOf(findings, 'open'),
      dismissed: countOf(findings, 'dismissed'),
      fixed: countOf(findings, 'fixed'),
      runs: runs.length,
    },
    findings,
    runs,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}
