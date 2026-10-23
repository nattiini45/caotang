/**
 * The export dialog — exporter.md §2 and §5, in a writer's terms: a recipe, a format, a scope, a compile.
 *
 * The compile is `export.compile` (the whole manuscript) or `export.compileSelection` (the item the binder has selected),
 * dispatched through the bus, so it is in the activity log, its undo removes the file (exporter.md §5), and it is one row of
 * the compile log. A recipe supplies the options a compile reads: the title page, the contents, the author, the character limit
 * for the dialogue table, and the scene numbers and continuation marks for the screenplay PDF. Those controls are saved to the recipe (`recipe.save`), so a change is undoable like any other, and
 * the compile names the recipe, for the whole manuscript or for the one item.
 *
 * Every format the exporter ships is offered, the book formats first and the media formats after. A compile that writes more
 * than one file (a prompt pack, or a story per container) is downloaded as one zip; a single file downloads as itself.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  DEFAULT_TEMPLATE,
  EXPORT_MIME,
  recipesOf,
  type ExportCommandDigest,
  type ExportFormat,
  type ExportRecipe,
} from '@caotang/exporter';
import { loadZipEngine } from '@caotang/store';
import { CHAR_LIMIT_MAX, SCENE_NUMBER_OPTIONS, type SceneNumbersOption } from '@caotang/bus';

import { downloadBytes } from '../app/download.js';
import { PACK_TEMPLATES } from '../media/prompt-pack-model.js';
import { recipeChoicesOf } from '../app/recipe-choices.js';
import type { ProjectSession } from '../app/session.js';
import { compileManuscript, compileSelection, explain, saveRecipe } from './actions.js';
import { formatCount, useReport, type StatusMessage } from './shared.js';

/** What the dialog compiles when the selection is a single item: its id and its title, for the scope's label. */
export interface ExportSelection {
  readonly id: string;
  readonly title: string;
}

interface FormatOption {
  readonly format: ExportFormat;
  readonly label: string;
  readonly help: string;
}

/** The formats the exporter ships (exporter.md §3, §5 and media-track.md "one story, many outputs"), in two groups: the prose, then the media. */
const FORMAT_GROUPS: readonly { readonly name: string; readonly formats: readonly FormatOption[] }[] = [
  {
    name: 'Prose',
    formats: [
      { format: 'md', label: 'Markdown (.md)', help: 'Plain Markdown, with a contents list after the title.' },
      { format: 'txt', label: 'Plain text (.txt)', help: 'Chapter headings in capitals, scenes set apart by a line.' },
      { format: 'docx', label: 'Word (.docx)', help: 'Styled headings, and a contents field Word can update.' },
      { format: 'epub', label: 'EPUB (.epub)', help: 'A reading-system book, one file per chapter.' },
    ],
  },
  {
    name: 'Media',
    formats: [
      { format: 'fountain', label: 'Fountain (.fountain)', help: 'The screenplay as plain Fountain text, for Beat or Highland.' },
      { format: 'fdx', label: 'Final Draft (.fdx)', help: 'The screenplay in Final Draft’s XML.' },
      { format: 'pdf', label: 'Screenplay PDF (.pdf)', help: 'The screenplay on US Letter pages in Courier Prime, ready to print.' },
      { format: 'ink-json', label: 'Ink story (.ink.json)', help: 'The dialogue compiled for a game engine that reads Ink. One file per story.' },
      { format: 'dialogue-csv', label: 'Dialogue table (.csv)', help: 'Each spoken line with its id, speaker, text and locale, for translation or recording. A Yarn container gets a Yarn strings file.' },
      { format: 'shot-list-csv', label: 'Shot list (.csv)', help: 'Each shot in order, with its size, angle, movement and duration.' },
      { format: 'dialogue-xlsx', label: 'Dialogue table (.xlsx)', help: 'The dialogue table as a spreadsheet, for Excel, Numbers or LibreOffice.' },
      { format: 'shot-list-xlsx', label: 'Shot list (.xlsx)', help: 'The shot list as a spreadsheet, with shot numbers and durations as numbers.' },
      {
        format: 'promptpack',
        label: 'Prompt pack (video)',
        help: 'The JSON, Markdown and CSV packs for one video model, written together and downloaded as one zip.',
      },
      {
        format: 'contact-sheet-pdf',
        label: 'Storyboard contact sheet (.pdf)',
        help: 'Each shot as a card with its picture, number, camera details and action, with the animatic total on every page.',
      },
    ],
  },
  // The coherence report (media-track.md, Review): the findings file and its run history, for reading outside Caotang.
  {
    name: 'Review',
    formats: [
      { format: 'coherence-md', label: 'Coherence report (.md)', help: 'The findings by fact, with their quotes and verdicts, and the run history.' },
      { format: 'coherence-json', label: 'Coherence report (.json)', help: 'The findings and runs as the findings file holds them.' },
    ],
  },
];

/** The recipe's options as the dialog shows them. An unset option shows the template's default. */
interface ShownOptions {
  readonly titlePage: boolean;
  readonly toc: boolean;
  readonly author: string;
  /** The dialogue table's character limit; `undefined` is no limit (dialogue-narrative.md §4). */
  readonly charLimit: number | undefined;
  /** The screenplay PDF's scene numbers (screenplay.md §5.3). Off unless the recipe sets them. */
  readonly sceneNumbers: SceneNumbersOption;
  /** `(MORE)` and `(CONT'D)` where the screenplay PDF splits a speech. On unless the recipe turns it off. */
  readonly continued: boolean;
  /** The contact sheet's paper; `undefined` is A4 (storyboard.md §6). */
  readonly pageSize: PageSize | undefined;
  /** The contact sheet prints blank frames to draw on, not the pictures; off unless the recipe sets it (storyboard.md §6). */
  readonly paperFrames: boolean;
}

/** The scene-number choices, in the words the dialog shows. */
const SCENE_NUMBER_LABELS: Readonly<Record<SceneNumbersOption, string>> = {
  off: 'Off',
  left: 'Left margin',
  right: 'Right margin',
  both: 'Both margins',
};

/** The screenplay PDF's options as recipe options. The defaults (off, on) are left out, so a recipe saved without them stays as it was. */
function pdfOptionsOf(shown: ShownOptions): { sceneNumbers?: SceneNumbersOption; continued?: boolean } {
  return {
    ...(shown.sceneNumbers === 'off' ? {} : { sceneNumbers: shown.sceneNumbers }),
    ...(shown.continued ? {} : { continued: false }),
  };
}

/** The papers a contact sheet is drawn on. */
type PageSize = 'A4' | 'Letter';

/**
 * The vendor template a recipe names, or empty. A recipe's `templateId` is a layout template for every format but the prompt pack
 * (the seeded Manuscript recipe carries `default`), so it is a vendor only when it is one of the installed vendor templates.
 */
function vendorOf(recipe: ExportRecipe | undefined): string {
  const id = recipe?.templateId;
  return id !== undefined && PACK_TEMPLATES.some((template) => template.id === id) ? id : '';
}

function shownOptionsOf(recipe: ExportRecipe | undefined): ShownOptions {
  return {
    titlePage: recipe?.options?.titlePage ?? DEFAULT_TEMPLATE.titlePage,
    toc: recipe?.options?.toc ?? DEFAULT_TEMPLATE.toc,
    author: recipe?.options?.author ?? '',
    charLimit: recipe?.options?.charLimit,
    pageSize: recipe?.options?.pageSize,
    paperFrames: recipe?.options?.paperFrames ?? false,
    sceneNumbers: recipe?.options?.sceneNumbers ?? 'off',
    continued: recipe?.options?.continued ?? true,
  };
}

export function ExportDialog({
  session,
  selection,
  onClose,
}: {
  session: ProjectSession;
  selection: ExportSelection | null;
  onClose: () => void;
}): ReactNode {
  const report = useReport();
  const dialog = useRef<HTMLDialogElement>(null);
  const recipes = recipeChoicesOf(recipesOf(session.state));
  const [recipeName, setRecipeName] = useState<string | null>(recipes[0]?.name ?? null);
  const recipe = recipes.find((candidate) => candidate.name === recipeName);
  const [format, setFormat] = useState<ExportFormat>(recipe?.format ?? 'docx');
  // The vendor template a prompt pack is written for. Empty until chosen, and a compile of the pack without one is refused.
  const [vendor, setVendor] = useState(vendorOf(recipe));
  // The whole manuscript unless the writer chooses a part: a selection is a choice to make, not a default.
  const [scope, setScope] = useState<'manuscript' | 'selection'>('manuscript');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  // What the dialog says about its own work: a refusal, a failed save, or a recipe saved. It is shown inside the dialog, beside Compile,
  // because the status line sits under the dialog and the writer is reading the dialog. A finished compile is said on the status line.
  const [notice, setNotice] = useState<StatusMessage | null>(null);
  const shown = shownOptionsOf(recipe);

  // The control that opened the dialog takes focus back when it closes, so the keyboard is where it was. It is read on
  // the first render, before any effect runs: an effect that runs twice (React's development double run) would
  // otherwise read a control inside the dialog it has just opened.
  const [opener] = useState<Element | null>(() => document.activeElement);
  useEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) element.showModal();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [opener]);

  /** Saves the recipe's options (`recipe.save`), keeping its selection and format. A refusal is said in the dialog. */
  const saveOptions = (next: ShownOptions): void => {
    if (recipe === undefined) return;
    const author = next.author.trim();
    const outcome = saveRecipe(session, {
      name: recipe.name,
      includeRootIds: [...recipe.includeRootIds],
      format: recipe.format,
      ...(recipe.templateId === undefined ? {} : { templateId: recipe.templateId }),
      options: {
        titlePage: next.titlePage,
        toc: next.toc,
        ...(author === '' ? {} : { author }),
        ...(next.charLimit === undefined ? {} : { charLimit: next.charLimit }),
        ...pdfOptionsOf(next),
        ...(next.pageSize === undefined ? {} : { pageSize: next.pageSize }),
        ...(next.paperFrames ? { paperFrames: true } : {}),
      },
    });
    if (outcome.ok) setNotice(null);
    else setNotice({ text: explain(outcome.error), tone: 'error' });
  };

  /** Saves the current settings as a new recipe, and selects it. */
  const saveAsNew = (): void => {
    const name = newName.trim();
    if (name === '') {
      setNotice({ text: 'Name the recipe first.', tone: 'error' });
      return;
    }
    if (format === 'promptpack' && vendor === '') {
      setNotice({ text: 'Choose a vendor template first: a prompt pack recipe is written for one.', tone: 'error' });
      return;
    }
    const author = shown.author.trim();
    const outcome = saveRecipe(session, {
      name,
      includeRootIds: ['manuscript'],
      format,
      ...(format === 'promptpack' ? { templateId: vendor } : {}),
      options: {
        titlePage: shown.titlePage,
        toc: shown.toc,
        ...(author === '' ? {} : { author }),
        ...(shown.charLimit === undefined ? {} : { charLimit: shown.charLimit }),
        ...pdfOptionsOf(shown),
        ...(shown.pageSize === undefined ? {} : { pageSize: shown.pageSize }),
        ...(shown.paperFrames ? { paperFrames: true } : {}),
      },
    });
    if (outcome.ok) {
      setRecipeName(name);
      setNewName('');
      setNotice({ text: `Saved the recipe “${name}”.`, tone: 'info' });
    } else {
      setNotice({ text: explain(outcome.error), tone: 'error' });
    }
  };

  const compile = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await session.exportsReady();
      // Failures are cumulative for the life of the exporter, and a path a later compile re-used may carry an older
      // failure. Only the entries this compile adds are matched, so a path that wrote successfully now is not reported
      // as failed because an earlier compile of the same name failed.
      const priorFailures = session.exportFailures().length;
      const useSelection = scope === 'selection' && selection !== null;
      // The pack's vendor is sent on the command, never read from the recipe: a recipe's templateId may be a layout template.
      // With none chosen the recipe is left off too, so the refusal is the bus's one about the vendor and not about the layout id.
      const pack = format === 'promptpack';
      const templateId = pack && vendor !== '' ? vendor : undefined;
      const recipeFor = pack && vendor === '' ? undefined : recipe?.name;
      // A part compiles with the recipe's options too, so the title page, the contents and the author apply to one item.
      const outcome = useSelection
        ? compileSelection(session, [selection.id], format, recipeFor, templateId)
        : compileManuscript(session, format, recipeFor, templateId);
      if (!outcome.ok) {
        // A refusal keeps the dialog open, so the reason is said here, next to Compile, and not on the status line under the dialog.
        setNotice({ text: explain(outcome.error), tone: 'error' });
        return;
      }
      const digest = outcome.value.result as ExportCommandDigest;
      // The files are written by the exporter's queue, after the command has returned. Wait for them, then download.
      await session.exportsIdle();
      const paths = digest.outputs ?? [digest.output];
      const thisCompile = session.exportFailures().slice(priorFailures);
      for (const path of paths) {
        const failure = thisCompile.find((candidate) => candidate.path === path);
        if (failure !== undefined) {
          setNotice({ text: `The ${format} file could not be made: ${failure.message}`, tone: 'error' });
          return;
        }
      }
      const files: { name: string; bytes: Uint8Array }[] = [];
      for (const path of paths) {
        const bytes = await session.readExport(path);
        if (bytes === null) {
          setNotice({ text: `The ${format} file was not found after it was made.`, tone: 'error' });
          return;
        }
        files.push({ name: fileName(path), bytes });
      }
      if (files.length === 1) {
        const [only] = files;
        if (only !== undefined) downloadBytes(only.bytes, only.name, EXPORT_MIME[format]);
      } else {
        downloadBytes(await zipFiles(files), `${zipStem(recipe?.name ?? session.state.manifest.project.name)}.zip`, 'application/zip');
      }
      report({ text: exportedSentence(digest, session.exportsToFolder()), tone: 'info' });
      onClose();
    } catch (error) {
      setNotice({ text: `The export could not be made: ${error instanceof Error ? error.message : String(error)}`, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  // The recipe's options apply to a whole manuscript and to a single item alike, so they are on whenever a recipe is chosen.
  const optionsEnabled = recipe !== undefined;

  return (
    <dialog
      ref={dialog}
      className="export-dialog"
      aria-labelledby="export-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="export-body">
        <h2 id="export-title">Export</h2>

        <label className="export-field">
          <span className="field-label">Recipe</span>
          <select
            value={recipeName ?? ''}
            disabled={recipes.length === 0}
            onChange={(event) => {
              const next = recipes.find((candidate) => candidate.name === event.target.value);
              setRecipeName(event.target.value);
              if (next !== undefined) {
                setFormat(next.format);
                setVendor(vendorOf(next));
              }
              // A refusal was about the compile as it was set; another recipe is another compile.
              setNotice(null);
            }}
          >
            {recipes.length === 0 ? <option value="">No recipes saved</option> : null}
            {recipes.map((candidate) => (
              <option key={candidate.name} value={candidate.name}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>

        {FORMAT_GROUPS.map((group) => (
          <fieldset key={group.name} className="export-group">
            <legend className="field-label">{group.name}</legend>
            {group.formats.map((option) => (
              <label key={option.format} className={`export-option${format === option.format ? ' is-chosen' : ''}`}>
                <input
                  type="radio"
                  name="export-format"
                  value={option.format}
                  checked={format === option.format}
                  onChange={() => {
                    setFormat(option.format);
                    setNotice(null);
                  }}
                />
                <span>
                  <span className="export-option-label">{option.label}</span>
                  <span className="export-option-help">{option.help}</span>
                </span>
              </label>
            ))}
          </fieldset>
        ))}

        {format === 'promptpack' ? (
          <label className="export-field">
            <span className="field-label">Vendor template</span>
            <select
              value={vendor}
              onChange={(event) => {
                setVendor(event.target.value);
                setNotice(null);
              }}
            >
              <option value="">Choose a vendor template</option>
              {PACK_TEMPLATES.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.displayName}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <fieldset className="export-group">
          <legend className="field-label">What to export</legend>
          <label className="export-option">
            <input
              type="radio"
              name="export-scope"
              value="manuscript"
              checked={scope === 'manuscript'}
              onChange={() => setScope('manuscript')}
            />
            <span className="export-option-label">The whole manuscript</span>
          </label>
          <label className={`export-option${selection === null ? ' is-disabled' : ''}`}>
            <input
              type="radio"
              name="export-scope"
              value="selection"
              disabled={selection === null}
              checked={scope === 'selection' && selection !== null}
              onChange={() => setScope('selection')}
            />
            <span className="export-option-label">
              {selection === null ? 'The selected item (select one in the binder)' : `Only “${selection.title}”`}
            </span>
          </label>
        </fieldset>

        <fieldset className="export-group" disabled={!optionsEnabled}>
          <legend className="field-label">Settings for this recipe</legend>
          <label className="export-option">
            <input
              type="checkbox"
              checked={shown.titlePage}
              onChange={(event) => saveOptions({ ...shown, titlePage: event.target.checked })}
            />
            <span className="export-option-label">Title page</span>
          </label>
          <label className="export-option">
            <input type="checkbox" checked={shown.toc} onChange={(event) => saveOptions({ ...shown, toc: event.target.checked })} />
            <span className="export-option-label">Contents list</span>
          </label>
          {/* Each field is keyed by the recipe, so it starts again from that recipe's value when the recipe changes. The two are
              siblings, so each key also names its field: one key for both is React's duplicate-key warning. */}
          <AuthorField
            key={`author:${recipe?.name ?? ''}`}
            value={shown.author}
            onSave={(author) => saveOptions({ ...shown, author })}
          />
          {format === 'dialogue-csv' || format === 'dialogue-xlsx' ? (
            <CharLimitField
              key={`limit:${recipe?.name ?? ''}`}
              value={shown.charLimit}
              onSave={(charLimit) => saveOptions({ ...shown, charLimit })}
              onInvalid={(text) => setNotice({ text, tone: 'error' })}
            />
          ) : null}
          {format === 'pdf' ? (
            <>
              <label className="export-field">
                <span className="export-option-label">Scene numbers</span>
                <select
                  value={shown.sceneNumbers}
                  onChange={(event) => saveOptions({ ...shown, sceneNumbers: event.target.value as SceneNumbersOption })}
                >
                  {SCENE_NUMBER_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {SCENE_NUMBER_LABELS[option]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="export-option">
                <input
                  type="checkbox"
                  checked={shown.continued}
                  onChange={(event) => saveOptions({ ...shown, continued: event.target.checked })}
                />
                <span className="export-option-label">(MORE) and (CONT’D) where a speech crosses a page</span>
              </label>
            </>
          ) : null}
          {format === 'contact-sheet-pdf' ? (
            <>
              <label className="export-field">
                <span className="export-option-label">Paper size</span>
                <select
                  value={shown.pageSize ?? 'A4'}
                  onChange={(event) => saveOptions({ ...shown, pageSize: event.target.value === 'Letter' ? 'Letter' : 'A4' })}
                >
                  <option value="A4">A4</option>
                  <option value="Letter">US Letter</option>
                </select>
              </label>
              <label className="export-option">
                <input
                  type="checkbox"
                  checked={shown.paperFrames}
                  onChange={(event) => saveOptions({ ...shown, paperFrames: event.target.checked })}
                />
                <span className="export-option-label">Paper frames: blank numbered frames to draw in, without the pictures</span>
              </label>
            </>
          ) : null}
        </fieldset>

        <div className="export-field export-save-new">
          <label className="export-field">
            <span className="export-option-label">Save these settings as a new recipe</span>
            <input
              type="text"
              value={newName}
              maxLength={80}
              placeholder="For example, Beta read"
              onChange={(event) => setNewName(event.target.value)}
            />
          </label>
          <button type="button" className="button" onClick={saveAsNew} disabled={newName.trim() === ''}>
            Save as recipe
          </button>
        </div>

        <p className="export-note">
          Empty documents are left out and listed in the compile log. Undo removes the file again.
        </p>

        <div className="export-footer">
          {notice === null ? null : (
            <p className={`form-message is-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
              {notice.text}
            </p>
          )}
          <div className="confirm-actions">
            <button type="button" className="button" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="button is-primary" onClick={() => void compile()} disabled={busy}>
              {busy ? 'Compiling…' : 'Compile'}
            </button>
          </div>
        </div>
      </div>
    </dialog>
  );
}

/**
 * The author line of a recipe. It keeps its own draft and saves when the writer leaves it. It is keyed by the recipe, so a
 * different recipe starts from that recipe's author and never from the one the writer was just typing into.
 */
function AuthorField({ value, onSave }: { value: string; onSave: (author: string) => void }): ReactNode {
  const [draft, setDraft] = useState(value);
  return (
    <label className="export-field">
      <span className="export-option-label">Author on the title page</span>
      <input
        type="text"
        value={draft}
        maxLength={200}
        placeholder="Uses the project’s author when empty"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft.trim() !== value.trim()) onSave(draft);
        }}
      />
    </label>
  );
}

/**
 * The dialogue table's character limit (dialogue-narrative.md §4), a recipe option. It keeps its own draft and saves when the writer
 * leaves it, as the author line does. Empty is no limit; a value the bus would refuse is said in the dialog (`onInvalid`), and the field
 * goes back to the saved value.
 */
function CharLimitField({
  value,
  onSave,
  onInvalid,
}: {
  value: number | undefined;
  onSave: (limit: number | undefined) => void;
  onInvalid: (text: string) => void;
}): ReactNode {
  const saved = value === undefined ? '' : String(value);
  const [draft, setDraft] = useState(saved);
  return (
    <label className="export-field">
      <span className="export-option-label">Character limit for each line</span>
      <input
        type="number"
        min={1}
        max={CHAR_LIMIT_MAX}
        value={draft}
        placeholder="No limit"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const text = draft.trim();
          if (text === '') {
            if (value !== undefined) onSave(undefined);
            return;
          }
          const limit = Number(text);
          if (!Number.isInteger(limit) || limit < 1 || limit > CHAR_LIMIT_MAX) {
            onInvalid(`A character limit is a whole number from 1 to ${CHAR_LIMIT_MAX.toLocaleString('en-US')}, or empty for no limit.`);
            setDraft(saved);
            return;
          }
          if (limit !== value) onSave(limit);
        }}
      />
    </label>
  );
}

/** The file's name in `exports/`: the last segment of its path. */
function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** A file name stem for a zip: the name with the characters a file name cannot carry replaced. */
function zipStem(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '-').trim();
  return cleaned === '' ? 'export' : cleaned;
}

/** The files of one compile in a single zip. The archive is built in the browser, from the bytes the session holds. */
async function zipFiles(files: readonly { readonly name: string; readonly bytes: Uint8Array }[]): Promise<Uint8Array> {
  const { zipSync } = await loadZipEngine();
  const entries: Record<string, Uint8Array> = {};
  for (const file of files) entries[file.name] = file.bytes;
  return zipSync(entries, { level: 6 });
}

/**
 * What a compile's file holds, in the words of its format (media-track.md). A script counts its scenes and sections, a
 * table its lines and containers, a shot list or a prompt pack its shots, and an Ink story its containers. A prose format
 * counts chapters, scenes and words, as it always has. The counts are the compile's own, so the sentence says what was written.
 */
function holdsOf(digest: ExportCommandDigest): string {
  switch (digest.format) {
    case 'fountain':
    case 'fdx':
    case 'pdf':
      return `${countPhrase(digest.sceneCount, 'scene')} in ${countPhrase(digest.chapterCount, 'section')}, ${countPhrase(digest.wordCount, 'word')}`;
    case 'ink-json':
      return countPhrase(digest.sceneCount, 'container');
    case 'dialogue-csv':
    case 'dialogue-xlsx':
      return `${countPhrase(digest.blockCount, 'line')} in ${countPhrase(digest.sceneCount, 'container')}, ${countPhrase(digest.wordCount, 'word')}`;
    case 'shot-list-csv':
    case 'shot-list-xlsx':
    case 'promptpack':
    case 'contact-sheet-pdf':
      return countPhrase(digest.blockCount, 'shot');
    case 'coherence-md':
    case 'coherence-json':
      return 'the coherence report';
    default:
      return `${countPhrase(digest.chapterCount, 'chapter')}, ${countPhrase(digest.sceneCount, 'scene')}, ${countPhrase(digest.wordCount, 'word')}`;
  }
}

/** A count and its noun, in the singular or the plural: "1 scene", "3 scenes", "1,204 words". */
function countPhrase(count: number, noun: string): string {
  return `${formatCount(count)} ${count === 1 ? noun : `${noun}s`}`;
}

/** What the status line says about a finished compile: what it holds, what was skipped, and where it went. */
function exportedSentence(digest: ExportCommandDigest, alsoInFolder: boolean): string {
  const skipped = digest.skippedDocs.length;
  const count = digest.outputs !== undefined && digest.outputs.length > 1 ? ` (${digest.outputs.length} files)` : '';
  const parts = [`Exported ${fileName(digest.output)}${count}: ${holdsOf(digest)}.`];
  if (skipped > 0) {
    parts.push(`Skipped ${formatCount(skipped)} empty ${skipped === 1 ? 'document' : 'documents'}.`);
  }
  if (alsoInFolder) parts.push('It is also in the project folder.');
  return parts.join(' ');
}
