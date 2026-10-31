/**
 * The scan's outputs — [coherence.md §10](../../../docs/architecture/coherence.md): text for a terminal, the exporter's Markdown report,
 * JSON for a script, and GitHub workflow commands for annotations.
 *
 * A finding's message quotes the manuscript, and a workflow log is read by the runner line by line, so a quote must never be able to end
 * its own command and start another. The github format escapes what the runner treats as structure (`%`, CR and LF in the data, and
 * `:` and `,` in a property too), caps the length of what it prints, and prints one line per finding.
 */

import { coherenceReportMarkdown } from '@caotang/exporter/coherence-report';

import type { PlacedFinding, ScanResult } from './scan.js';

export const SCAN_FORMATS = ['text', 'markdown', 'json', 'github'] as const;
export type ScanFormat = (typeof SCAN_FORMATS)[number];

/** Whether `value` is a `--format` value. */
export function isScanFormat(value: string): value is ScanFormat {
  return (SCAN_FORMATS as readonly string[]).includes(value);
}

/** The longest message an annotation carries, in code points. A quote in a message is the manuscript's, so a long one stays short. */
export const GITHUB_MESSAGE_LIMIT = 300;

/** The longest text before it is cut to the limit with an ellipsis. Counted in code points, so a surrogate pair is never split. */
export function capText(text: string, limit: number): string {
  const points = [...text];
  return points.length <= limit ? text : `${points.slice(0, limit - 1).join('')}…`;
}

/** Workflow-command data: `%` first, so the escapes that follow are not escaped again. */
export function escapeData(text: string): string {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

/** A workflow-command property: the data escapes, and `:` and `,`, which end a property. */
export function escapeProperty(text: string): string {
  return escapeData(text).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

const COMMAND: Readonly<Record<PlacedFinding['severity'], string>> = { error: 'error', warning: 'warning', info: 'notice' };

/** One finding as one workflow command. `info` is a `notice`. */
export function githubCommand(finding: PlacedFinding): string {
  const properties: string[] = [];
  if (finding.file !== undefined) {
    properties.push(`file=${escapeProperty(finding.file)}`);
    if (finding.line !== undefined) properties.push(`line=${finding.line}`);
    if (finding.endLine !== undefined) properties.push(`endLine=${finding.endLine}`);
  }
  properties.push(`title=${escapeProperty(capText(finding.checkId, 100))}`);
  return `::${COMMAND[finding.severity]} ${properties.join(',')}::${escapeData(capText(finding.message, GITHUB_MESSAGE_LIMIT))}`;
}

/** What the scan has to say beside its findings: a partial scan, and what reading `coherence.json` found. */
function remarks(result: ScanResult): string[] {
  const lines = [...result.notices];
  if (result.status === 'partial') {
    const skipped = result.skipped.length > 0 ? ` Not run: ${result.skipped.join(', ')}.` : '';
    lines.push(`This was a partial scan.${skipped}`, ...result.notes);
  }
  return lines;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function summaryLine(result: ScanResult): string {
  const { error, warning, info } = result.counts;
  return `${plural(error + warning + info, 'open finding')} (${plural(error, 'error')}, ${plural(warning, 'warning')}, ${plural(info, 'note')}) in ${plural(result.documents, 'document')}.`;
}

/** One line per finding, `file:line: severity check message`, then the summary and the remarks. */
export function formatText(result: ScanResult): string {
  const lines = result.findings.map((finding) => {
    const where = finding.file === undefined ? '' : `${finding.file}:${finding.line ?? 1}: `;
    return `${where}${finding.severity} ${finding.checkId} ${oneLine(finding.message)}`;
  });
  lines.push(summaryLine(result), ...remarks(result).map(oneLine));
  return `${lines.join('\n')}\n`;
}

/** A message on one line: a quote with a line break in it is one finding, not two lines of output. */
function oneLine(text: string): string {
  return text.split(/\r\n|\r|\n/).join(' ');
}

/** The exporter's Markdown report, as `--summary` writes it. */
export function formatMarkdown(result: ScanResult): string {
  return coherenceReportMarkdown(result.report);
}

/** The scan as JSON: the exit code, the counts and the placed findings. `coherence.json` itself is the exporter's JSON report. */
export function formatJson(result: ScanResult): string {
  const payload = {
    formatVersion: 1,
    project: result.project,
    date: result.date,
    status: result.status,
    checks: result.checks,
    skipped: result.skipped,
    documents: result.documents,
    counts: result.counts,
    exitCode: result.exitCode,
    unread: result.unread,
    written: result.written,
    notes: result.notes,
    notices: result.notices,
    findings: result.findings,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** One workflow command per finding, then a notice for each remark, so a partial scan is never silent. */
export function formatGithub(result: ScanResult): string {
  const lines = result.findings.map(githubCommand);
  for (const remark of remarks(result)) lines.push(`::notice title=${escapeProperty('caotang scan')}::${escapeData(capText(remark, GITHUB_MESSAGE_LIMIT))}`);
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

export function formatScan(result: ScanResult, format: ScanFormat): string {
  switch (format) {
    case 'text':
      return formatText(result);
    case 'markdown':
      return formatMarkdown(result);
    case 'json':
      return formatJson(result);
    case 'github':
      return formatGithub(result);
  }
}
