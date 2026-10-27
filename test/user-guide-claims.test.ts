/**
 * The user guide names controls and stops by the words the app shows, so a guide sentence can drift from the code without anything
 * failing. These tests pin the claims that are easiest to get wrong: what a reopened folder can save to, the
 * shot board's card sizes and derive offer, and the stop a tab shows when Caotang was updated in another tab. Each reads the source
 * the claim describes too, so a renamed control fails here rather than leaving the guide naming a button that is gone.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { COMMAND_REGISTRY, HOOKS_MAX, HOOK_EVENTS_RUN, HOOK_PATTERNS_MAX, HOOK_TEXT_MAX, MACROS_MAX, MACRO_DESCRIPTION_MAX, MACRO_STEPS_MAX, readHook } from '../packages/bus/src/index.js';
import { BUILTIN_COMMAND_NAMES } from '../packages/harness/src/commands/slash.js';
import { macroCommandName } from '../packages/harness/src/macro.js';

const repoRoot = resolve(__dirname, '..');

function read(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

const guide = read('docs/USER-GUIDE.md');
const changelog = read('CHANGELOG.md');

describe('the user guide matches what the app does', () => {
  it('says a folder this browser does not keep saves back to the folder, and only a different version is an unsaveable copy', () => {
    // lifecycle.ts: adopt() keeps the folder's id unless this browser already holds it, and saveFolder refuses only a copy in the folder of
    // the book it was copied from (integrity-model `folderProjectRoute` 'original'); any other project is asked about.
    const lifecycle = read('apps/desktop/src/app/lifecycle.ts');
    expect(lifecycle).toMatch(/if \(taken\.has\(originalId\)\)/);
    expect(lifecycle).toMatch(/if \(route === 'original'\) throw new Error\(COPY_CANNOT_SAVE_INTO_FOLDER\)/);
    expect(read('apps/desktop/src/app/integrity-model.ts')).toMatch(/facts\.copiedFrom !== null && facts\.folderId === facts\.copiedFrom \? 'original' : 'other'/);
    expect(guide).toMatch(/A second copy of a book, opened from that book's folder, still cannot be saved into it\./);
    expect(guide).toMatch(/A folder whose project this browser does not keep opens as its project, and saving writes back to the folder\./);
    // docs/decisions.md: a different version asks which to keep, and the separate copy is one of the three answers (answerFolderDiffers).
    expect(lifecycle).toMatch(/if \(route === 'ask' && stored !== null\)/);
    expect(read('apps/desktop/src/components/Home.tsx')).toContain('Open as a separate copy');
    expect(guide).toMatch(/If it holds a different version, Caotang asks which to keep/);
    expect(guide).toMatch(/\*\*Open as a separate copy\*\* opens the folder as a second copy with its own id, which cannot be saved into the folder\./);
    expect(guide).not.toMatch(/Otherwise the folder opens as a copy/);
    expect(guide).not.toMatch(/The project opens as a copy in your browser/);
    expect(changelog).not.toMatch(/any other folder opens as a copy/);
  });

  it('names the shot board’s card sizes and the empty board’s derive offer in the words the board shows', () => {
    const view = read('apps/desktop/src/media/StoryboardView.tsx');
    expect(view).toMatch(/ariaLabel="Shot card size"/);
    expect(view).toMatch(/Derive shots from “/);
    const storyboard = guide.slice(guide.indexOf('## Planning a storyboard'), guide.indexOf('## The codex'));
    expect(storyboard).toMatch(/\*\*Shot card size\*\*/);
    expect(storyboard).toMatch(/\*\*S\*\* shows the shot number and the picture/);
    expect(storyboard).toMatch(/\*\*Derive shots from “Scene”\*\*/);
  });

  it('names the offer before a big plan and the Background tasks controls in the words the panel shows, and lists what background tasks do not do yet', () => {
    // PlanOfferCard.tsx and BackgroundTasks.tsx are the words the guide names; the threshold is the harness's constant.
    const offer = read('apps/desktop/src/components/PlanOfferCard.tsx');
    for (const label of ['Run now', 'Run in background', 'Cancel']) expect(offer).toContain(label);
    expect(read('packages/harness/src/agent/background.ts')).toMatch(/BACKGROUND_OFFER_MIN_CALLS = 5;/);
    const tasks = read('apps/desktop/src/components/BackgroundTasks.tsx');
    for (const label of ['Background tasks', 'Review', 'Resume', 'Cancel', 'Dismiss']) expect(tasks).toContain(label);
    const agent = guide.slice(guide.indexOf('## The agent'), guide.indexOf('## Skills'));
    expect(agent).toContain('**Run now**, **Run in background** or **Cancel**');
    expect(agent).toContain('A task is drafted only while the project is open in this tab.');
    expect(agent).toContain('Nothing is written until you choose **Review**');
    const missing = guide.slice(guide.indexOf('## What is not in this build yet'));
    expect(missing).toContain('**Background tasks.** A task is drafted only while the project is open in this tab');
    expect(missing).toContain('A coherence review cannot be queued yet');
    expect(changelog).toContain('there is no Web Worker (no typing jank has been measured)');
  });

  it('lists the stop a tab shows when Caotang was updated in another tab, with what to do', () => {
    expect(read('apps/desktop/src/components/StaleTabNotice.tsx')).toMatch(/'Caotang was updated in another tab'/);
    const wrong = guide.slice(guide.indexOf('## When something seems wrong'));
    expect(wrong).toMatch(/\*\*Caotang was updated in another tab\.\*\*[^\n]*Export a backup[^\n]*then reload this tab/);
  });
});

/**
 * The review's claims: each sentence the guide gained names a control, a refusal or a count, and the source that says it.
 * A claim checks the guide sentence and the code line it describes, so a change to either side fails here, not in the writer's hands.
 */
describe('the user guide’s reviewed claims match the code', () => {
  it('says a new document needs a chapter, and the empty editor offers New chapter', () => {
    expect(guide).toContain('With nothing selected, or only the manuscript, it makes no document and says that a document goes inside a chapter. The empty editor then offers **New chapter**.');
    // The sentence is the bus's, and the binder says it.
    expect(read('packages/bus/src/descriptors.ts')).toContain("CHAPTERLESS_DOCUMENT_REFUSAL = 'A document goes inside a chapter, not directly under the manuscript.'");
    expect(read('apps/desktop/src/app/binder-model.ts')).toContain('return CHAPTERLESS_DOCUMENT_REFUSAL;');
    expect(read('apps/desktop/src/components/EditorPane.tsx')).toContain('New chapter');
  });

  it('says the window is at least 960 px wide and the toolbar wraps below 1100 px', () => {
    expect(guide).toContain('The window needs at least 960 px of width. Under 1100 px the toolbar wraps onto a second row');
    const css = read('apps/desktop/src/styles.css');
    expect(css).toContain('min-width: 960px');
    expect(css).toContain('@media (max-width: 1100px)');
  });

  it('says focus mode’s status line tells the writer when the panels stay', () => {
    expect(guide).toContain('The status line says so when you turn focus on, and its **Settings › Writing** opens that setting.');
    // The wording, with "Settings › Writing" a link to the section.
    const workspace = read('apps/desktop/src/components/Workspace.tsx');
    expect(workspace).toContain("text: 'Focus mode is on. The binder and inspector stay open, as set in '");
    expect(workspace).toContain("link: { label: 'Settings › Writing', after: '.', onClick: () => setSettingsSection('writing') }");
  });

  it('says History’s Today includes the open sitting, as the status line does', () => {
    expect(guide).toContain('**Today** includes the sitting that is open, so it matches the status line.');
    expect(read('apps/desktop/src/components/WritingHistory.tsx')).toContain('historyReading(sessions, new Date(), target.target, target.words)');
  });

  it('says a folder of a project another tab has open is refused, and a removed caotang.json is asked about', () => {
    expect(guide).toContain('A folder of a project another tab has open is refused, as opening that project from the projects list is.');
    expect(guide).toContain('If another program removed `caotang.json`, the question says so, and saving writes it back from this tab.');
    expect(read('apps/desktop/src/components/Workspace.tsx')).toContain('This folder’s caotang.json was removed');
  });

  it('says a project file that names another app, or a newer format, is refused with nothing written and no rebuild', () => {
    expect(guide).toContain('A project file that names another app, or a format newer than this version of Caotang reads, is refused instead');
    expect(read('packages/store/src/read.ts')).toContain('so it will not open the project');
  });

  it('says in troubleshooting that a newer format opens in a newer Caotang and a file naming another app is not a Caotang project', () => {
    expect(guide).toContain('A file in a newer format opens in a newer Caotang. A file that names another app is not a Caotang project.');
    const reader = read('packages/store/src/read.ts');
    expect(reader).toContain('so it will not open the project. Open it in a newer Caotang.');
    expect(reader).toContain('so it is not a Caotang project, and Caotang will not open it.');
  });

  it('says what an open notes is said in whole sentences, with the smaller things counted', () => {
    expect(guide).toContain('When a project or folder opens, Caotang says what it noted, in whole sentences.');
    expect(read('apps/desktop/src/app/integrity-model.ts')).toContain('Caotang also noted');
  });

  it('says the shot prompt keeps the text typed for each vendor, and says when a stored prompt replaced it', () => {
    expect(guide).toContain('The text you type for one vendor stays when you switch to another vendor and back.');
    expect(read('apps/desktop/src/media/ShotPromptEditor.tsx')).toContain('the text you had typed for it was replaced by the saved prompt');
  });

  it('says the demo says so in words and changes nothing when it cannot draft or fill synopses', () => {
    expect(guide).toContain('When it cannot make its draft or fill its synopses, it says so in words, and nothing changes.');
    const scripts = read('packages/gateway/src/mock/agent-scripts.ts');
    expect(scripts).toContain('No draft was made, so nothing changed.');
    expect(scripts).toContain('No synopses were written, so nothing changed.');
  });

  it('says a compile Caotang refuses is said inside the Export dialog, beside Compile, and no file is saved', () => {
    expect(guide).toContain('A compile that Caotang refuses is said inside the dialog, beside **Compile**, and no file is saved.');
    expect(read('apps/desktop/src/components/ExportDialog.tsx')).toContain('the reason is said here, next to Compile');
  });

  it('says the title page date is the writer’s own day, not the UTC day', () => {
    expect(guide).toContain("The title page's date is the day you compile, in your own time zone, not the UTC day.");
    expect(read('packages/exporter/src/exporter.ts')).toContain('const date = localDayOf(at);');
  });

  it('says the model review sends each scene only the codex entries its include policies select', () => {
    expect(guide).toContain('The review sends each scene only the codex entries its include policies select for that scene');
    expect(read('packages/harness/src/coherence-review-context.ts')).toContain('selectCandidates({ entries, tree: state.manifest.tree, focusDocId: docId, detected })');
  });

  it('says a large scope asks on the status line at more than 20 documents, and Scan it anyway runs the scope that asked', () => {
    expect(guide).toContain('A scope of more than 20 documents asks first: the status line asks, and the panel shows **Scan it anyway**. **Scan it anyway** runs the scope that asked');
    const panel = read('apps/desktop/src/components/FindingsPanel.tsx');
    expect(panel).toContain("report({ text: APPROVAL_SENTENCE, tone: 'info' });");
    expect(panel).toContain('const scope = approved && pendingScope !== null ? pendingScope : scopeFor(scopeChoice, currentDocId);');
    expect(read('packages/coherence/src/model.ts')).toContain('export const SCAN_DOC_GUARD = 20;');
  });

  it('says the dismissal picker takes focus when it opens', () => {
    expect(guide).toContain('its picker takes focus');
    expect(read('apps/desktop/src/components/FindingsPanel.tsx')).toContain('firstReason.current?.focus();');
  });

  it('says a visual reference card names a picture no longer in the project', () => {
    expect(guide).toContain('says so when a picture is no longer in the project');
    expect(read('apps/desktop/src/app/plan-preview.ts')).toContain("'a picture that is no longer in the project'");
  });

  it('says a manual codex entry is sent in the documents under the folder it is attached to', () => {
    expect(guide).toContain('**Manual**: only in the documents it is attached to, and in the documents inside a folder it is attached to.');
    const candidates = read('packages/codex/src/candidates.ts');
    // The focus scope is the document and every folder above it, and a manual entry is sent when it is attached to any of them.
    expect(candidates).toContain('cursor = parentOf.get(cursor);');
    expect(candidates).toContain('const via = attachedVia(entry, scope);');
  });

  it('says focus moves to the item that takes a deleted one’s place', () => {
    expect(guide).toContain("After a delete, focus goes to the item that takes the deleted one's place.");
    expect(guide).toContain('After a delete, focus goes to the card that takes its place.');
    const workspace = read('apps/desktop/src/components/Workspace.tsx');
    expect(workspace).toContain('return siblings[at + 1]?.id ?? siblings[at - 1]?.id ?? node.parentId;');
    expect(workspace).toContain('if (place !== null) focusAfterDelete(place);');
  });

  it('says the screenplay PDF prints Arabic, Persian, Urdu and Hebrew in their own fonts, ordered by UAX #9, loaded only when needed, with the page not mirrored', () => {
    const pdfSection = guide.slice(guide.indexOf('### The screenplay PDF'), guide.indexOf('## Writing dialogue'));
    expect(pdfSection).toContain('Arabic, Persian, Urdu and Hebrew print in Noto Sans Arabic and Noto Sans Hebrew, which are loaded only for a script that has them');
    expect(pdfSection).toContain('the margins, the page numbers, the transitions and the order of dual dialogue are not mirrored');
    expect(pdfSection).toContain('a character name in them needs a `@` in front');
    expect(pdfSection).toContain('are left out of the print');
    expect(pdfSection).toContain('Nastaliq');
    const render = read('packages/screenplay/src/render-pdf.ts');
    expect(render).toContain('if (layout.shapedScripts.length === 0 || support === undefined) return undefined;');
    expect(render).toContain("await import('./rtl-font.js')");
    expect(read('packages/pdf-fonts/src/bidi.ts')).toContain("const RTL_LANGUAGES: ReadonlySet<string> = new Set(['ar', 'fa', 'ur', 'he', 'yi']);");
    expect(read('packages/screenplay/src/paginate.ts')).toContain('\\u061f\\u06d4\\u061b');
    expect(changelog).toContain('machine-verified, not reader-verified');
  });

  it('says the screenplay PDF prints Hindi, Marathi, Nepali and Sanskrit in Noto Sans Devanagari, shaped, broken between syllables, split after the danda, with a @ for a cue', () => {
    const pdfSection = guide.slice(guide.indexOf('### The screenplay PDF'), guide.indexOf('## Writing dialogue'));
    expect(pdfSection).toContain('Hindi, Marathi, Nepali and Sanskrit print in Noto Sans Devanagari, which is loaded only for a file that has Devanagari');
    expect(pdfSection).toContain('a word wider than the column breaks only between syllables, never inside a conjunct');
    expect(pdfSection).toContain('needs a `@` in front, as in `@राम`');
    expect(pdfSection).toContain('only Devanagari has a font so far');
    const render = read('packages/screenplay/src/render-pdf.ts');
    expect(render).toContain("devanagariFontPrints(base) ? 'devanagari' : undefined");
    expect(read('packages/screenplay/src/paginate.ts')).toContain('\\u0964\\u0965');
    expect(read('packages/pdf-fonts/package.json')).toContain('"fontkit": "2.0.4"');
    expect(read('packages/pdf-fonts/package.json')).toContain('"harfbuzzjs": "1.6.3"');
    expect(guide).toContain('Characters that none of its fonts has, such as Tamil, print as `?`');
  });

  it('says the screenplay PDF prints CJK in its fallback font, two columns a character, loaded only when needed', () => {
    const pdfSection = guide.slice(guide.indexOf('### The screenplay PDF'), guide.indexOf('## Writing dialogue'));
    expect(pdfSection).toContain('Other characters, such as Chinese, Japanese and Korean, print in Noto Sans Mono CJK SC.');
    expect(pdfSection).toContain('A script with no such character does not load this font.');
    expect(pdfSection).toContain('A Chinese, Japanese or Korean character takes the width of two Courier letters.');
    expect(pdfSection).toContain('Korean breaks at spaces.');
    expect(pdfSection).not.toMatch(/such as Chinese or emoji, prints as a question mark/);
    const render = read('packages/screenplay/src/render-pdf.ts');
    expect(render).toContain('if (layout.fallbackCharacters.length === 0 || load === undefined) return undefined;');
    expect(render).toContain("await import('./cjk-font.js')");
    expect(read('packages/screenplay/src/width.ts')).toContain("return inRanges(ch.codePointAt(0) ?? 0, WIDE) ? 2 : 1;");
    expect(read('packages/screenplay/src/cjk-font.ts')).toContain("NOTO_CJK_POSTSCRIPT_NAME = 'NotoSansMonoCJKsc-Regular'");
    expect(changelog).not.toMatch(/A character the font does not cover, such as Chinese, prints as a question mark/);
  });

  it('states the screenplay PDF’s margins, page numbering and recipe controls as the layout and the dialog have them', () => {
    const pdfSection = guide.slice(guide.indexOf('### The screenplay PDF'), guide.indexOf('## Writing dialogue'));
    const paginate = read('packages/screenplay/src/paginate.ts');
    // US Letter at 72 points an inch: 1.5 inches is 108 points, 1 inch is 72. A4 is 210 by 297 mm.
    expect(pdfSection).toContain('sets the script on US Letter or A4 pages');
    expect(paginate).toContain('pageWidth: 612,');
    expect(paginate).toContain('pageHeight: 792,');
    expect(paginate).toContain('A4: Object.freeze({ pageWidth: 595.28, pageHeight: 841.89, marginRight: 55.28, marginBottom: 121.89 })');
    expect(pdfSection).toContain('The margins are 1.5 inches on the left and 1 inch on the other three sides on Letter.');
    for (const margin of ['marginLeft: 108,', 'marginRight: 72,', 'marginTop: 72,', 'marginBottom: 72,']) expect(paginate).toContain(margin);
    // The paper and the face are controls of the dialog, in the words the guide uses, and Letter and Courier Prime are what it preselects.
    expect(pdfSection).toContain('**Paper size** is US Letter unless you choose A4 in the recipe.');
    expect(pdfSection).toContain('A4 is taller, and the extra height is white space at the foot of the page.');
    expect(pdfSection).toContain('**Font** is Courier Prime at 12 point unless you choose another in the recipe: **Cousine (like Courier New)**, or **Courier (the reader\u2019s own)**.');
    const dialogSource = read('apps/desktop/src/components/ExportDialog.tsx');
    expect(dialogSource).toContain('<span className="export-option-label">Paper size</span>');
    expect(dialogSource).toContain('<span className="export-option-label">Font</span>');
    expect(dialogSource).toContain("value={shown.pageSize ?? 'Letter'}");
    expect(dialogSource).toContain("value={shown.scriptFont ?? 'courier-prime'}");
    expect(dialogSource).toContain("'courier-prime': 'Courier Prime',");
    expect(dialogSource).toContain("courier: 'Courier (the reader\u2019s own)',");
    expect(dialogSource).toContain("cousine: 'Cousine (like Courier New)',");
    expect(read('packages/exporter/src/media.ts')).toContain('...(request.scriptFont === undefined ? {} : { scriptFont: request.scriptFont }),');
    expect(pdfSection).toContain('Script pages count from 1. The number is printed at the top right from page 2.');
    expect(paginate).toContain('const all = number >= 2 ? [...lines, pageNumberLine(number)] : [...lines];');
    expect(paginate).toContain('x: LAYOUT.textRight - text.length * LAYOUT.charWidth,');
    expect(paginate).toContain('y: LAYOUT.pageNumberY,');
    expect(paginate).toContain('pageNumberY: 46,');
    // The recipe controls, in the words the export dialog shows.
    const dialog = read('apps/desktop/src/components/ExportDialog.tsx');
    expect(pdfSection).toContain('**Scene numbers** can be printed in the left margin, the right margin or both. They are off unless you choose them.');
    expect(dialog).toContain('<span className="export-option-label">Scene numbers</span>');
    expect(read('packages/screenplay/src/paginate.ts')).toContain("opts.sceneNumbers ?? 'off'");
    expect(dialog).toContain("sceneNumbers: recipe?.options?.sceneNumbers ?? 'off',");
    expect(read('packages/exporter/src/media.ts')).toContain("sceneNumbers: request.sceneNumbers ?? 'off',");
    expect(dialog).toContain("left: 'Left margin',");
    expect(dialog).toContain("right: 'Right margin',");
    expect(dialog).toContain("both: 'Both margins',");
    expect(dialog).toContain("...(shown.sceneNumbers === 'off' ? {} : { sceneNumbers: shown.sceneNumbers }),");
    expect(pdfSection).toContain('You can turn this off in the recipe: clear **(MORE) and (CONT’D) where a speech crosses a page**.');
    expect(dialog).toContain('<span className="export-option-label">(MORE) and (CONT’D) where a speech crosses a page</span>');
  });

  it('says the screenplay PDF prints emoji in Noto Emoji, two columns each, whole, loaded only when needed', () => {
    const pdfSection = guide.slice(guide.indexOf('### The screenplay PDF'), guide.indexOf('## Writing dialogue'));
    expect(pdfSection).toContain('Emoji print in Noto Emoji, a black-and-white emoji font.');
    expect(pdfSection).toContain('An emoji takes the width of two Courier letters, however it is built');
    expect(pdfSection).toContain('it is never split across lines');
    expect(pdfSection).toContain('so 👍🏽 prints as 👍, but text you copy out of the PDF keeps the emoji you typed');
    expect(pdfSection).toContain('turn on **Colour emoji** in the recipe');
    expect(pdfSection).toContain('It is off unless you turn it on, because scripts are usually printed and photocopied in black and white, and colour is the only way to get a skin tone.');
    expect(pdfSection).not.toContain('The font has no colours and no skin tones');
    expect(pdfSection).toContain('A script with no emoji does not load this font.');
    expect(pdfSection).toContain('A character no font has prints as a question mark, and the compile log names it.');
    expect(pdfSection).not.toMatch(/such as an emoji, prints as a question mark/);
    const render = read('packages/screenplay/src/render-pdf.ts');
    expect(render).toContain('if (layout.emojiCharacters.length === 0 || load === undefined) return undefined;');
    expect(render).toContain("await import('./emoji-font.js')");
    expect(read('packages/screenplay/src/width.ts')).toContain('if ((unit.length > 1 || unit.charCodeAt(0) >= 0x231a) && isEmojiCluster(unit)) return 2;');
    expect(read('packages/screenplay/src/emoji-font.ts')).toContain("NOTO_EMOJI_POSTSCRIPT_NAME = 'NotoEmoji-Regular'");
    expect(read('packages/screenplay/src/emoji-font.ts')).toContain('font.layout(text)');
    expect(changelog).not.toMatch(/A character neither font covers, such as an emoji, prints as a question mark/);
  });

  it('says how the engine target and the locale change the dialogue exports, in the names the compile writes', () => {
    expect(guide).toContain("A container set to **Yarn string table (CSV)** goes into a Yarn Spinner strings file, `<name> (dialogue, Yarn).csv`, with Yarn's columns and `line:` ids.");
    expect(guide).toContain('A container with no locale uses the project\'s language. A container with its own locale puts it in the Ink story\'s file name, such as `Tavern.de.ink.json`.');
    expect(read('apps/desktop/src/components/InspectorDialogue.tsx')).toContain("'yarn-csv': 'Yarn string table (CSV)'");
    const media = read('packages/exporter/src/media.ts');
    expect(media).toContain('name: `${request.base} (dialogue, Yarn).csv`');
    expect(media).toContain('`${fileStem(title)}.${locale}.ink.json`');
    expect(media).toContain('{ includeLocale: true }');
    expect(read('packages/dialogue/src/table.ts')).toContain("export const YARN_COLUMNS = ['language', 'id', 'text', 'file', 'node', 'lineNumber', 'lock', 'comment'] as const;");
  });

  it('says the Yarn strings file fills lock with the first 8 hex characters of the SHA-256 of the text, and what the file is for', () => {
    expect(guide).toContain("Its `lock` column holds the first 8 hex characters of the SHA-256 of the line's `text` cell, the hash Yarn Spinner for Unity writes");
    expect(guide).toContain("It is a localisation file for a Yarn project whose lines carry Caotang's `#line:` ids, not the base-language strings Yarn generates from its own scripts.");
    expect(guide).not.toContain('Its `lock` column is empty.');
    expect(changelog).toContain("The `lock` column is filled. It holds the first 8 hex characters of the SHA-256 of the row's `text` cell as written before the spreadsheet guard");
    expect(changelog).not.toContain('leaves its `lock` column empty');
    const table = read('packages/dialogue/src/table.ts');
    expect(table).toContain('sha256Hex(text).slice(0, 8),');
    expect(table).not.toContain('leaves it empty');
    expect(read('docs/architecture/dialogue-narrative.md')).not.toContain('`lock` = empty');
  });

  it('says which leading characters get the Yarn guard apostrophe, that it is written into the cell, and that Yarn Spinner was not checked', () => {
    const claim =
      "In the Yarn strings file, a line or choice whose text cell starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets an apostrophe in front, as in every CSV export, so a spreadsheet does not run it as a formula.";
    expect(guide).toContain(claim);
    expect(guide).toContain("A spoken line's cell starts with the speaker's name when it has one.");
    expect(guide).toContain('The language, file and comment cells get the same guard.');
    expect(changelog).toContain("A spoken line's `text` cell starts with the speaker's name when it has one.");
    expect(guide).toContain("The apostrophe is written into the cell itself, so a tool that reads the file gets it with the line; Caotang has not checked how Yarn Spinner shows it.");
    expect(changelog).toContain('how Yarn Spinner shows it has not been checked.');
    // The trigger list in the guide is the guard's own list, and the Yarn writer applies that guard to its cells.
    expect(read('packages/storyboard/src/render-csv.ts')).toContain("const FORMULA_TRIGGERS: readonly string[] = ['=', '+', '-', '@', '\\t', '\\r'];");
    expect(read('packages/exporter/src/media.ts')).toContain('return toYarnCsv(rows, { fileOf: titleOf, cell: guardFormula });');
    const table = read('packages/dialogue/src/table.ts');
    expect(table).toContain('cell(row.locale),');
    expect(table).toContain('cell(text),');
    expect(table).toContain('cell(fileOf(row.container)),');
    expect(table).toContain('cell(row.context),');
  });

  it('names the Source tab’s element menu, its key and its entries in the words the view shows', () => {
    const view = read('apps/desktop/src/media/ScreenplayView.tsx');
    const menu = read('apps/desktop/src/media/element-menu.ts');
    // The button's visible word, and the chord the view opens the menu on.
    expect(view).toMatch(/>\s*Element\s*<\/button>/);
    expect(menu).toMatch(/event\.key\.toLowerCase\(\) === 'e'/);
    // The chord the menu accepts: Ctrl+E, or Cmd+E on a Mac — both modifiers are read from the event.
    expect(menu).toMatch(/event\.ctrlKey\s*\|\|\s*event\.metaKey/);
    const screenplay = guide.slice(guide.indexOf('## Writing a screenplay'), guide.indexOf('## Writing dialogue'));
    expect(screenplay).toContain('**Element**, above the text, or Ctrl+E (Cmd+E on a Mac), opens the element menu for the line the caret is on.');
    // Each entry the guide names is a label of the menu, and the guide names every one, in the menu's order.
    const labels = [...menu.matchAll(/^ {2}[a-z_]+: '([^']+)',$/gm)].map((match) => match[1] ?? '');
    expect(labels).toHaveLength(9);
    expect(screenplay).toContain(`It lists ${labels.slice(0, -1).map((label) => `**${label}**`).join(', ')} and **${labels.at(-1)}**,`);
    // The keyboard table's one Mac note covers every Ctrl row, because the keymap's command() reads Ctrl or Cmd
    // for all of them; no row may single itself out as the only shortcut with a Mac equivalent.
    const keyboard = guide.slice(guide.indexOf('## Keyboard'));
    expect(keyboard).toContain('On a Mac, Cmd takes the place of Ctrl.');
    expect(read('apps/desktop/src/app/keymap.ts')).toMatch(/return facts\.ctrl \|\| facts\.meta;/);
    expect(keyboard).toMatch(/\| Ctrl\+E \| On a screenplay's Source tab, open the element menu for the caret's line\. \|/);
    expect(keyboard).not.toContain('Cmd+E');
    // The element chords are the one row that names its Mac spelling, because Cmd+Shift+digit is not free on a Mac.
    expect(keyboard).toContain('The element chords are the one exception: they use Cmd+Alt');
    expect(keyboard).toContain('| Ctrl+Shift+1 to 9 (Cmd+Alt+1 to 9 on a Mac) |');
    expect(screenplay).toContain('**Ctrl+Shift+1** to **9** (**Cmd+Alt+1** to **9** on a Mac)');
    expect(menu).toContain("other: { ctrl: true, meta: false, alt: false, shift: true, label: 'Ctrl+Shift'");
    expect(menu).toContain("mac: { ctrl: false, meta: true, alt: true, shift: false, label: 'Cmd+Alt'");
  });

  it('names the agent panel’s Stop, queue and note controls, and their keys, as the panel and the keymap have them', () => {
    const keymap = read('apps/desktop/src/app/keymap.ts');
    expect(keymap).toMatch(/case 'agent-send':\s+return 'Enter';/);
    expect(keymap).toMatch(/case 'agent-steer':\s+return 'Ctrl\+Enter';/);
    expect(keymap).toMatch(/case 'agent-stop':\s+return 'Esc';/);
    expect(guide).toContain('**Enter** queues what you type as the next turn, and **Ctrl+Enter** (Cmd+Enter on a Mac) sends it to the turn that is running as a note');
    expect(guide).toContain('**Stop**, in the header while a turn runs, ends the turn; so does **Esc** with the Intent box empty. With text in the box, Esc leaves the turn alone.');
    expect(guide).toContain('| Esc | Close a menu or a dialog. A menu returns focus to the control that opened it. In the agent panel, with the Intent box empty, stop the running turn. |');
    expect(guide).toContain("| Enter, in the agent's Intent box | Send the message, or queue it as the next turn while the agent works. |");
    expect(guide).toContain("| Ctrl+Enter, in the agent's Intent box | Send the message to the running turn as a note. |");
    // The controls the guide names are the buttons and headings the panel shows.
    const panel = read('apps/desktop/src/components/AgentPanel.tsx');
    const queue = read('apps/desktop/src/components/AgentQueue.tsx');
    expect(panel).toContain("{snapshot.stopping ? 'Stopping…' : 'Stop'}");
    for (const label of ['Send with Cancel', 'Queue as next turn', 'Run the queue', 'Steer now', 'Queued messages']) {
      expect(queue).toContain(label);
      expect(guide).toContain(`**${label}**`);
    }
    // The queue's pause sentence is the controller's, and the guide names the choice it offers.
    expect(read('apps/desktop/src/app/agent.ts')).toContain("'The last turn stopped on a question. Answer it or choose Run the queue.'");
    expect(guide).toContain('answer the question or choose **Run the queue**');
    expect(changelog).toContain('**Stop** (or **Esc**, with the Intent box empty) ends a running turn');
  });

  it('says in the guide what the panel says when an interrupted run’s log cannot be read', () => {
    const controller = read('apps/desktop/src/app/agent.ts');
    expect(controller).toContain('Interrupted agent runs could not be checked: ');
    expect(controller).toContain('The run was not resumed. Try again, or discard the log.');
    expect(controller).toContain('so the run was not resumed. You can discard the log.');
    expect(guide).toContain('the panel says once that interrupted runs could not be checked and shows no card');
    expect(guide).toContain('the run is not resumed and the panel says so: try again, or choose **Discard log**');
  });

  it('names the Agent setting in the words the section shows, and says it is off by default', () => {
    const section = read('apps/desktop/src/components/Settings.tsx');
    expect(section).toContain("{ id: 'agent', label: 'Agent' }");
    expect(section).toContain('<span>Load every tool on every request</span>');
    expect(read('apps/desktop/src/app/settings.ts')).toContain("DEFAULT_AGENT_SETTINGS: AgentSettings = Object.freeze({ loadEveryTool: false, defaultMode: 'ask'");
    expect(guide).toContain('**Settings › Agent** has **Load every tool on every request** for a model that searches poorly. It is off by default, and it makes every request longer.');
    expect(guide).toContain('- **Agent.** **Load every tool on every request**, off by default.');
    expect(guide).toContain('It has nine sections: Providers, Context, Agent, Macros, Writing, Coherence, MCP & tools, Appearance and Data.');
    expect(changelog).toContain('**Settings › Agent** has **Load every tool on every request**, off by default');
  });

  it('names the permission modes and their controls in the words the panel and Settings show', () => {
    const panel = read('apps/desktop/src/components/AgentPanel.tsx');
    const settings = read('apps/desktop/src/components/AgentModeSettings.tsx');
    const modes = read('packages/harness/src/agent/mode.ts');
    expect(panel).toContain('<legend>Mode</legend>');
    expect(panel).toContain('Switch to Ask and run this plan');
    expect(panel).toContain('Plan, not run');
    expect(read('apps/desktop/src/components/AgentPanel.tsx')).toContain('Auto-approved');
    expect(settings).toContain('<span>Turn Auto mode off</span>');
    for (const label of ["'plan-only': 'Plan only'", "ask: 'Ask'", "'accept-edits': 'Accept edits'", "auto: 'Auto'"]) expect(modes).toContain(label);
    for (const text of ['**Mode**', '**Plan only**', '**Ask**', '**Accept edits**', '**Auto**', '**Switch to Ask and run this plan**', '**Auto-approved**', '**Turn Auto mode off**', '**Permission mode**']) {
      expect(guide).toContain(text);
    }
    expect(guide).toContain('it is never saved in a project');
    expect(changelog).toContain('**Permission modes.** The agent panel has a **Mode** control');
    // The decision that superseded "no auto-approve mode" is recorded, and the sentence it replaced is gone.
    const decisions = read('docs/decisions.md');
    expect(decisions).toContain('The agent has four permission modes: Plan only, Ask (the default), Accept edits and Auto');
    expect(decisions).not.toContain('No classifier or auto-approve mode');
    expect(read('docs/architecture/agent-harness.md')).not.toContain('Explicitly **rejected for v0.1**: a classifier/auto-approve mode');
  });

  it('says both PDFs print a Han character in the forms of the project language, from the language tags han-locale.ts maps', () => {
    const pdfSection = guide.slice(guide.indexOf('### The screenplay PDF'), guide.indexOf('## Writing dialogue'));
    expect(pdfSection).toContain("A Han character takes the form of the project's language");
    expect(pdfSection).toContain('Japanese for `ja`, Korean for `ko`, Traditional Chinese for `zh-Hant`, `zh-TW` and `zh-MO`, Hong Kong for `zh-HK`');
    expect(guide).toContain("A Han character takes the form of the project's language, as it does in the screenplay PDF");
    expect(guide).not.toContain('Han characters take their Simplified Chinese forms');
    const tags = read('packages/pdf-fonts/src/han-locale.ts');
    for (const tag of ["'JAN '", "'KOR '", "'ZHT '", "'ZHH '"]) expect(tags).toContain(tag);
    expect(read('packages/screenplay/src/render-pdf.ts')).toContain('hanLocaleTag(language)');
    expect(read('packages/exporter/src/cjk-font.ts')).toContain('hanLocaleTag(language)');
  });

  it('lists exactly the slash commands the harness has, in its order, in the guide’s Commands table, the spec and the changelog', () => {
    // The names come from the closed set the composer resolves (commands/slash.ts), so a renamed or added command fails here until the guide says so.
    const agentSection = guide.slice(guide.indexOf('## The agent'), guide.indexOf('## Skills'));
    const rows = agentSection.split('\n').filter((line) => line.startsWith('| `/'));
    const named = rows.map((line) => (/^\| `\/([a-z]+)/.exec(line) ?? [])[1]);
    expect(named).toEqual([...BUILTIN_COMMAND_NAMES]);
    expect(agentSection).toContain('**Commands.** Type `/` at the start of the Intent box');
    expect(agentSection).toContain('**no command skips a card, a rule or the mode.**');
    const spec = read('docs/architecture/agent-harness.md');
    const quoted = BUILTIN_COMMAND_NAMES.map((name) => `\`/${name}\``);
    expect(spec).toContain(`${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)} (\`BUILTIN_COMMAND_NAMES\`)`);
    for (const name of BUILTIN_COMMAND_NAMES) {
      expect(spec).toContain(`\`/${name}\``);
      expect(changelog.slice(changelog.indexOf('**Slash commands in the agent panel.**'), changelog.indexOf('**Agent instructions and memory.**'))).toContain(`\`/${name}\``);
    }
    // The words the guide names are the words the panel shows.
    expect(read('apps/desktop/src/components/CommandComposer.tsx')).toContain('aria-label="Commands"');
    expect(read('apps/desktop/src/components/AgentPanel.tsx')).toContain('Dismiss');
    expect(read('docs/decisions.md')).toContain('Slash commands in the agent panel are a closed set of built-ins');
  });

  it('names the Macros panel and Save as macro in the words the app shows, with the limits the bus enforces', () => {
    // MacrosPanel.tsx and SaveAsMacro.tsx are the words the guide names; the limits are the bus's own constants, and the agent's part is the registry's.
    const panel = read('apps/desktop/src/components/MacrosPanel.tsx');
    for (const label of ['Run…', 'Show the card', 'Edit', 'Delete', 'This project has no macros yet.']) expect(panel).toContain(label);
    expect(read('apps/desktop/src/components/SaveAsMacro.tsx')).toContain('Save as macro…');
    expect(read('apps/desktop/src/components/Settings.tsx')).toContain("{ id: 'macros', label: 'Macros' }");
    const section = guide.slice(guide.indexOf('## Macros'), guide.indexOf('## Export'));
    for (const label of ['**Save as macro…**', '**Run…**', '**Show the card**', '**Edit**', '**Delete**']) expect(section).toContain(label);
    expect(section).toContain(`A macro can hold at most ${MACRO_STEPS_MAX} steps, a project at most ${MACROS_MAX} macros, and a description at most ${MACRO_DESCRIPTION_MAX} characters`);
    expect(section).toContain(`the turn is named \`/macro-\` and the macro's short name`);
    expect(macroCommandName('revise')).toBe('macro-revise');
    // Only the writer saves or deletes one, and the agent has no command for it.
    expect(COMMAND_REGISTRY['macro.save'].descriptor.agentRisk).toBe('never');
    expect(COMMAND_REGISTRY['macro.delete'].descriptor.agentRisk).toBe('never');
    expect(section).toContain('The agent does not run macros, cannot see them and cannot change them.');
    // A mode never approves a card it would not approve for any plan, and the run is one turn.
    expect(section).toContain('a mode approves only the cards it approves for any plan');
    expect(read('apps/desktop/src/app/agent.ts')).toContain('forcePlan: checked.value.risk !== \'read\'');
    expect(changelog).toContain('**Macros.** Under a plan you approved, **Save as macro…**');
    expect(read('docs/decisions.md')).toContain('Macros are writer-authored, parameterised plan templates');
  });

  it('describes hooks as the app and the bus treat them: the file shape, the events, the limits and who may change one', () => {
    const section = guide.slice(guide.indexOf('## Hooks'), guide.indexOf('## Export'));
    // The example in the guide is a hook the bus and the loader accept, with the id a stored hook must have.
    const json = /```json\n([\s\S]*?)\n```/.exec(section)?.[1];
    expect(json).toBeDefined();
    const parsed = JSON.parse(`{${json}}`) as { agent: { hooks: unknown[] } };
    expect(parsed.agent.hooks).toHaveLength(1);
    expect(readHook(parsed.agent.hooks[0], true).ok).toBe(true);
    // Each check the guide shows is one the bus reads.
    const base = { id: 'h_7K2QX9M4A1', name: 'A hook', event: 'tool.before', enabled: true };
    const checks = [
      { kind: 'pattern', patterns: [{ match: 'suddenly', message: 'Show it.' }] },
      { kind: 'status', allowed: ['Final'] },
      { kind: 'words', min: 200, max: 900 },
      { kind: 'coherence', checks: ['codex.alias-collisions'] },
    ];
    for (const check of checks) expect(readHook({ ...base, handler: { kind: 'check', check } }, true).ok).toBe(true);
    for (const shape of ['{ "kind": "status", "allowed": ["Final"] }', '{ "kind": "words", "min": 200, "max": 900 }', '{ "kind": "coherence", "checks": ["codex.alias-collisions"] }']) {
      expect(section).toContain(shape);
    }
    // A program or a model handler is not a project-file hook, as the guide says.
    expect(readHook({ ...base, handler: { kind: 'command', command: 'x' } }, true).ok).toBe(false);
    // The events the guide names are the ones this build runs, and the limits are the bus's own.
    expect([...HOOK_EVENTS_RUN]).toEqual(['tool.before', 'tool.after']);
    expect(section).toContain(`A project holds at most ${HOOKS_MAX} hooks, a check at most ${HOOK_PATTERNS_MAX} patterns, and a pattern or a message at most ${HOOK_TEXT_MAX} characters.`);
    // Only the writer changes a hook: the agent has no command for it.
    expect(COMMAND_REGISTRY['hook.save'].descriptor.agentRisk).toBe('never');
    expect(COMMAND_REGISTRY['hook.delete'].descriptor.agentRisk).toBe('never');
    expect(section).toContain('The agent cannot add, change, turn off or remove a hook');
    // The refusal the card shows, and the three places the guide and the README point a writer to.
    expect(read('packages/harness/src/hooks.ts')).toContain('stopped ${tool}: ${run.decision.reason}');
    expect(guide).toContain('- **Hooks.** A hook is a check you write for the agent');
    expect(guide.slice(guide.indexOf('## What is not in this build yet'))).toContain('- **Hooks.** There is no Settings › Hooks');
    expect(read('README.md')).toContain('- **Hooks.** Write a check the agent is held to');
    expect(read('docs/decisions.md')).toMatch(/hooks/i);
  });
});
