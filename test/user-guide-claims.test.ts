/**
 * The user guide names controls and stops by the words the app shows, so a guide sentence can drift from the code without anything
 * failing. These tests pin the claims that are easiest to get wrong: what a reopened folder can save to, the
 * shot board's card sizes and derive offer, and the stop a tab shows when Caotang was updated in another tab. Each reads the source
 * the claim describes too, so a renamed control fails here rather than leaving the guide naming a button that is gone.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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
    expect(read('apps/desktop/src/app/coherence-review.ts')).toContain('selectCandidates({ entries, tree: state.manifest.tree, focusDocId: docId, detected })');
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
});
