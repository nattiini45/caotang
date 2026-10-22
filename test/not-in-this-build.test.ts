/**
 * The user-facing "not in this build" lists name only what is missing. Each list is prose a writer reads, and nothing
 * else checks it, so a feature that ships (visual references, the dialogue table's character limit, the demo's continuity
 * findings in the Findings tab, weekly and monthly goals, spreadsheet export, the engine target and locale in dialogue exports, the Source
 * tab's element menu, the storyboard contact sheet PDF) can stay on the list after it is built. These tests read the three lists and fail when one of them
 * names a built feature as missing.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..');

function read(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

/** The text under a heading, up to the next heading of the same or a higher level. */
function sectionUnder(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start, `the heading "${heading}" is missing`).toBeGreaterThanOrEqual(0);
  const body = text.slice(start + heading.length);
  const next = body.search(/\n#{1,2} /);
  return next < 0 ? body : body.slice(0, next);
}

/** Built features that no list may name as missing. Each pattern is one feature, in the words the lists used. */
const BUILT_FEATURES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'codex visual references', pattern: /visual references?/i },
  { name: 'the dialogue table character limit', pattern: /character limit/i },
  { name: 'the continuity check reporting outside the Findings tab', pattern: /continuity check/i },
  { name: 'weekly and monthly goals', pattern: /weekly|monthly/i },
  { name: 'goals counted in characters', pattern: /characters, are not|counted in characters/i },
  // In these lists the phrase "spreadsheet export(s)" itself names the export as missing, so it is flagged wherever it stands;
  // a true limitation sentence about the files names them as "the .xlsx files" or "the spreadsheet files" and also avoids the
  // words "no spreadsheet" / "no xlsx" and the verbs of the last branch (not built, exported, available, supported, in this
  // build), e.g. "have not been opened in Excel".
  // The other branches catch a claim that the export is missing in other words.
  {
    name: 'spreadsheet export',
    pattern: /spreadsheet exports?|no (?:spreadsheet|xlsx)\b|(?:xlsx|spreadsheet)[^.\n]*not (?:yet )?(?:built|exported|available|supported|in this build)/i,
  },
  { name: 'the engine target and locale in dialogue exports', pattern: /engine target|dialogue export settings|locale in exports/i },
  { name: 'the Source tab element menu', pattern: /element menu/i },
  // A sentence that names Arabic or Hebrew as unprintable, with Hindi or as a question mark; the limits that remain (marks, Nastaliq, no mirrored page) do not.
  { name: 'Arabic and Hebrew in the PDFs', pattern: /such as (?:an? )?(?:Arabic|Hebrew)|Arabic,? (?:and|or) Hindi|Hindi,? (?:and|or) Arabic/i },
  // A sentence that names Hindi or Devanagari as unprintable; a limit on another Indic script (Tamil, Bengali) does not.
  { name: 'Devanagari in the PDFs', pattern: /such as (?:an? )?(?:Hindi|Devanagari)\b|\b(?:Hindi|Devanagari)(?: (?:text|letters?|characters?|words?))?(?: is| are)? (?:printed|prints?) as (?:a )?(?:`\?`|question marks?)/i },
  // A limitation sentence about skills names what it is about (scripts, the other files, allowed tools, sharing, running by name), before or
  // after the word. Any other sentence in these lists that names skills says the feature is missing, and it is built.
  { name: 'skills', pattern: /(?:^|[.!?]\s+|\n)(?:(?!scripts?|other files|allowed tools|shared across|by name)[^.\n])*?\bskills?\b(?![^.\n]*(?:scripts?|other files|allowed tools|shared across|by name))/i },
  { name: 'the storyboard contact sheet PDF', pattern: /storyboard PDF|PDF (?:exports? |output )?(?:of|for) (?:a )?storyboards?|PDF of a storyboard/i },
];

describe('the built-feature patterns flag a stale claim and nothing else', () => {
  const spreadsheet = BUILT_FEATURES.find((feature) => feature.name === 'spreadsheet export')?.pattern ?? /$^/;

  it('the spreadsheet pattern flags a claim that spreadsheet export is missing', () => {
    expect('PDF exports of screenplays and storyboards, spreadsheet exports, the Source tab').toMatch(spreadsheet);
    expect('There is no spreadsheet export yet.').toMatch(spreadsheet);
    expect('XLSX is not built yet.').toMatch(spreadsheet);
    expect('There is no XLSX export yet.').toMatch(spreadsheet);
    expect('XLSX export is not in this build.').toMatch(spreadsheet);
  });

  it('the spreadsheet pattern treats the phrase "spreadsheet exports" as naming the export missing, wherever it stands', () => {
    // A limitation sentence in these lists words the files another way (see the next test); this one is flagged by design.
    expect('Spreadsheet exports have not been opened in Excel, Numbers or LibreOffice by the test suite.').toMatch(spreadsheet);
  });

  it('the spreadsheet pattern lets a true limitation sentence about the spreadsheet files through', () => {
    expect('The spreadsheet files have not been opened in Excel, Numbers or LibreOffice by the test suite.').not.toMatch(spreadsheet);
    expect('The `.xlsx` files are checked by unit tests against the Office Open XML parts.').not.toMatch(spreadsheet);
  });
});

describe('the skills pattern flags a claim that skills are missing and lets the true limits through', () => {
  const skills = BUILT_FEATURES.find((feature) => feature.name === 'skills')?.pattern ?? /$^/;

  it('flags a list that names skills as missing', () => {
    expect('Not in this build yet: skills.').toMatch(skills);
    expect('There are no skills in this build.').toMatch(skills);
  });

  it('lets through a limitation sentence about scripts, the other files, allowed tools, sharing or running by name', () => {
    expect('Skills that include scripts: Caotang uses their instructions and does not run the scripts.').not.toMatch(skills);
    expect('The agent cannot read the other files kept with a skill.').not.toMatch(skills);
    expect('A skill\'s list of allowed tools does not limit the agent.').not.toMatch(skills);
    expect('There are no skills shared across projects and no way to run a skill by name.').not.toMatch(skills);
  });
});

describe('the not-in-this-build lists name only what is missing', () => {
  it('the user guide’s last section names no built feature', () => {
    const section = sectionUnder(read('docs/USER-GUIDE.md'), '## What is not in this build yet');
    for (const feature of BUILT_FEATURES) expect(section, `names ${feature.name} as missing`).not.toMatch(feature.pattern);
  });

  it('the changelog’s known limits name no built feature, in any of its bullets', () => {
    // The whole section is read, not only the "Not in this build" bullet: the stale continuity-check claim was a bullet of its own.
    const limits = sectionUnder(read('CHANGELOG.md'), '### Known limits');
    expect(limits.split('\n').some((line) => line.startsWith('- **Not in this build:**')), 'the changelog has a "Not in this build" line').toBe(true);
    for (const feature of BUILT_FEATURES) expect(limits, `names ${feature.name} as missing`).not.toMatch(feature.pattern);
  });

  it('the readme’s not-yet list names no built feature', () => {
    const readme = read('README.md');
    const line = readme.split('\n').find((text) => text.startsWith('Not in this build yet:')) ?? '';
    expect(line, 'the readme has a "Not in this build yet" line').not.toBe('');
    for (const feature of BUILT_FEATURES) expect(line, `names ${feature.name} as missing`).not.toMatch(feature.pattern);
  });

  it('the media notes do not say a codex entry’s visual references cannot be set from the app', () => {
    const media = read('apps/desktop/src/media/README.md');
    expect(sectionUnder(media, '## What is not wired')).not.toMatch(/visual references/i);
    // The panel sets them and the pack names them; the wired-behaviour list says so.
    expect(media).toMatch(/The codex panel's \*Visual references\* section sets them/);
  });
});

describe('the Arabic and Hebrew pattern', () => {
  const pattern = BUILT_FEATURES.find((feature) => feature.name === 'Arabic and Hebrew in the PDFs')?.pattern ?? /$^/;

  it('flags the old claims that Arabic does not print', () => {
    expect('Characters that none of its fonts has, such as Arabic and Hindi, print as `?`.').toMatch(pattern);
    expect('A character no font covers, such as an Arabic letter, prints as a question mark.').toMatch(pattern);
  });

  it('lets the limits that remain through', () => {
    expect('Characters that none of its fonts has (Noto Sans Arabic, Noto Sans Hebrew), such as Hindi, print as `?`.').not.toMatch(pattern);
    expect('Arabic marks and Hebrew points are left out of the print.').not.toMatch(pattern);
  });
});

describe('the Devanagari pattern', () => {
  const pattern = BUILT_FEATURES.find((feature) => feature.name === 'Devanagari in the PDFs')?.pattern ?? /$^/;

  it('flags the old claims that Hindi does not print', () => {
    expect('Characters that none of its fonts has, such as Hindi, print as `?`.').toMatch(pattern);
    expect('A character no font covers, such as a Devanagari letter, prints as a question mark.').toMatch(pattern);
    expect('Hindi text prints as a question mark.').toMatch(pattern);
  });

  it('lets the limits that remain through', () => {
    expect('Characters that none of its fonts has, such as Tamil, print as `?`.').not.toMatch(pattern);
    expect('Bengali, Tamil and Sinhala print as question marks until each has a font.').not.toMatch(pattern);
  });
});
