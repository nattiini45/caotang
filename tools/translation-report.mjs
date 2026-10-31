/**
 * The translation report (i18n.md §9, L11 / #202): completion per language from the committed catalogues, the gate each one sits behind,
 * and translator credits from Git. It reads actual catalogue and Git data and writes Markdown to stdout, so a release note can paste it.
 *
 *   node tools/translation-report.mjs            the report for the committed catalogues
 *   node tools/translation-report.mjs --release 0.4.0   the same, headed with a release label
 *
 * The credits are the authors of commits that touched a language's folder, by commit count; they come from `git log`, never from a list
 * someone has to keep up. Nothing here contacts a service.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { LOCALES_ROOT, PSEUDO_LOCALES, SOURCE_LOCALE, computeStats, readCatalogues } from './check-translations.mjs';
import { isMain } from './i18n-lib.mjs';

/** The picker's gate for a completion figure (decision D5): plain at 95, Preview at 60, hidden below, kept down to 55 once listed. */
export function gateOf(completion, wasListed = false) {
  if (completion >= 95) return 'plain';
  if (completion >= 60) return 'preview';
  return wasListed && completion >= 55 ? 'preview (kept by hysteresis)' : 'hidden';
}

/** The commit authors of `git log` output (one `Name` per line), most commits first, then by name. */
export function creditsOf(logOutput) {
  const counts = new Map();
  for (const line of logOutput.split('\n')) {
    const name = line.trim();
    if (name === '') continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, commits]) => ({ name, commits }));
}

/** The authors who touched one locale's folder, from Git. An absent repository gives no credits. */
export function gitCredits(repoRoot, locale, run = execFileSync) {
  try {
    const out = run('git', ['log', '--format=%an', '--', `${LOCALES_ROOT}/${locale}`], { cwd: repoRoot, encoding: 'utf8' });
    return creditsOf(String(out));
  } catch {
    return [];
  }
}

/** The Markdown report for a stats document and a credits lookup. */
export function renderReport(stats, creditsFor, release) {
  const lines = [`# Translation report${release === undefined ? '' : `: ${release}`}`, ''];
  const locales = Object.keys(stats.locales).sort();
  if (locales.length === 0) {
    lines.push(`Only the source language (${SOURCE_LOCALE}) is shipped, so there is nothing to report yet.`, '');
    return `${lines.join('\n')}\n`;
  }
  lines.push('| Language | Messages | Translated | Missing | Fuzzy | Completion | Picker |', '| --- | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const locale of locales) {
    const row = stats.locales[locale];
    lines.push(`| ${locale} | ${row.total} | ${row.translated} | ${row.missing} | ${row.fuzzy} | ${row.completion} % | ${gateOf(row.completion)} |`);
  }
  lines.push('');
  for (const locale of locales) {
    const credits = creditsFor(locale);
    lines.push(`## ${locale} credits`, '');
    if (credits.length === 0) lines.push('No commits touch this language yet.');
    else for (const credit of credits) lines.push(`- ${credit.name} (${credit.commits} commit${credit.commits === 1 ? '' : 's'})`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/** The report for the committed catalogues of a repository. */
export function reportFor(repoRoot, release) {
  const catalogues = readCatalogues(resolve(repoRoot, LOCALES_ROOT));
  for (const tag of PSEUDO_LOCALES) delete catalogues[tag];
  return renderReport(computeStats(catalogues), (locale) => gitCredits(repoRoot, locale), release);
}

if (isMain(import.meta.url)) {
  const at = process.argv.indexOf('--release');
  process.stdout.write(reportFor(process.cwd(), at === -1 ? undefined : process.argv[at + 1]));
}
