/**
 * The coherence report's writer-facing words in the interface language (i18n.md §7.1). The exporter holds no translation runtime, so the
 * app supplies these each time it compiles a report; a language switch reaches the next report. The JSON report, run statuses, check ids
 * and dates stay as they are.
 */

import { plural, t } from '@lingui/core/macro';
import type { CoherenceReportWords } from '@caotang/exporter';

import { accessibleText } from '../i18n/accessible-text.js';
import { checkLabelForRun, dismissalLabelOf } from './findings-model.js';

/* lingui-set comment="Lines of a Markdown report the writer reads outside Caotang. Titles, reasons, dates and statuses are values; a check name stands alone after a middle dot." */

export function coherenceReportWords(): CoherenceReportWords {
  return {
    heading: (title) => t`Coherence report: ${{ title }}`,
    dated: (date) => t`Dated ${{ date }}.`,
    noCheckRun: t`No check has run on this project yet, so there are no findings to report.`,
    summaryHeading: t`Summary`,
    counts: (open, dismissed, fixed) =>
      plural(open, {
        one: `# open finding, ${dismissed} dismissed, ${fixed} marked fixed.`,
        other: `# open findings, ${dismissed} dismissed, ${fixed} marked fixed.`,
      }),
    noRunRecorded: t`No run is recorded.`,
    latestRun: (runs, at, status) =>
      plural(runs, {
        one: `# run recorded; the latest is ${at} (${status}).`,
        other: `# runs recorded; the latest is ${at} (${status}).`,
      }),
    severity: { error: t`Errors`, warning: t`Warnings`, info: t`Notes` },
    status: { open: t`Open`, dismissed: t`Dismissed`, fixed: t`Marked fixed` },
    expected: (text) => t`Expected: ${{ text }}`,
    dismissedAs: (reason) => t`Dismissed as: ${{ reason }}`,
    note: (text) => t`Note: ${{ text }}`,
    runHistoryHeading: t`Run history`,
    finding: t`Finding`,
    runKind: { deterministic: t`Quick scan`, llm: t`Model review` },
    noChecksNamed: t`no checks named`,
    findingCount: (count) => plural(count, { one: '# finding', other: '# findings' }),
    checkWords: (checkId) => accessibleText(checkLabelForRun(checkId)),
    dismissalLabel: (reason) => accessibleText(dismissalLabelOf(reason)),
  };
}
