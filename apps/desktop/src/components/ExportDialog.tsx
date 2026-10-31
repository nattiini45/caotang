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

import { isolate } from '@caotang/i18n';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  DEFAULT_TEMPLATE,
  EXPORT_MIME,
  recipesOf,
  type ExportCommandDigest,
  type ExportFormat,
  type ExportRecipe,
} from '@caotang/exporter';
import { loadComicPage } from '@caotang/comic';
import { loadZipEngine } from '@caotang/store';
import { CHAR_LIMIT_MAX, SCENE_NUMBER_OPTIONS, type SceneNumbersOption } from '@caotang/bus';

import { downloadBytes } from '../app/download.js';
import {
  pictureControlsShownFor,
  pictureOptionsOf,
  shownPictureOptionsOf,
  withPictureMode,
  type PictureMode,
  type ShownPictureOptions,
} from '../app/export-picture-options.js';
import { comicBookOf, comicPageNodesOf } from '../media/comic-model.js';
import { PACK_TEMPLATES } from '../media/prompt-pack-model.js';
import { recipeChoicesOf } from '../app/recipe-choices.js';
import type { ProjectSession } from '../app/session.js';
import { compileManuscript, compileSelection, explain, saveRecipe } from './actions.js';
import { formatCount, useReport, type StatusMessage } from './shared.js';
import { accessibleText } from '../i18n/accessible-text.js';


/* lingui-set comment="The export dialog. Interpolated values: name, title and file are the writer's own names; reason is a failure message; format is a file format name; counts are numbers grouped for the formatter locale." */
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
function formatGroups(comicSelected: boolean): readonly { readonly name: string; readonly formats: readonly FormatOption[] }[] {
  return [
  {
    name: t`Prose`,
    formats: [
      { format: 'md', label: t`Markdown (.md)`, help: t`Plain Markdown, with a contents list after the title.` },
      { format: 'txt', label: t`Plain text (.txt)`, help: t`Chapter headings in capitals, scenes set apart by a line.` },
      { format: 'docx', label: t`Word (.docx)`, help: t`Styled headings, and a contents field Word can update.` },
      { format: 'epub', label: t`EPUB (.epub)`, help: t`A reading-system book, one file per chapter.` },
    ],
  },
  {
    name: t`Media`,
    formats: [
      { format: 'fountain', label: t`Fountain (.fountain)`, help: t`The screenplay as plain Fountain text, for Beat or Highland.` },
      { format: 'fdx', label: t`Final Draft (.fdx)`, help: t`The screenplay in Final Draft’s XML.` },
      { format: 'pdf', label: t`Screenplay PDF (.pdf)`, help: t`The screenplay on US Letter pages in Courier Prime, ready to print.` },
      { format: 'ink-json', label: t`Ink story (.ink.json)`, help: t`The dialogue compiled for a game engine that reads Ink. One file per story.` },
      { format: 'dialogue-csv', label: t`Dialogue table (.csv)`, help: t`Each spoken line with its id, speaker, text and locale, for translation or recording. A Yarn container gets a Yarn strings file.` },
      { format: 'shot-list-csv', label: t`Shot list (.csv)`, help: t`Each shot in order, with its size, angle, movement and duration.` },
      { format: 'dialogue-xlsx', label: t`Dialogue table (.xlsx)`, help: t`The dialogue table as a spreadsheet, for Excel, Numbers or LibreOffice.` },
      { format: 'shot-list-xlsx', label: t`Shot list (.xlsx)`, help: t`The shot list as a spreadsheet, with shot numbers and durations as numbers.` },
      {
        format: 'promptpack',
        label: t`Prompt pack (video)`,
        help: t`The JSON, Markdown and CSV packs for one video model, written together and downloaded as one zip.`,
      },
      {
        format: 'contact-sheet-pdf',
        label: t`Storyboard contact sheet (.pdf)`,
        help: t`Each shot as a card with its picture, number, camera details and action, with the animatic total on every page.`,
      },
      // Offered only while a comic book or one of its pages is selected: the compile takes exactly one book.
      ...(comicSelected
        ? [
            {
              format: 'comic-pdf' as const,
              label: t`Comic PDF (.pdf)`,
              help: t`One page per comic page, at its trim size plus bleed, with the pictures and the lettering in Comic Neue and Bangers.`,
            },
            {
              format: 'cbz' as const,
              label: t`Comic book archive (.cbz)`,
              help: t`One picture per comic page, 1988 px tall with the lettering drawn in, for a comic reader. Made in the app.`,
            },
            {
              format: 'comic-epub' as const,
              label: t`Comic EPUB (.epub)`,
              help: t`A fixed-layout EPUB with one picture per comic page and the balloon text kept as readable text, for an ebook reader. Made in the app.`,
            },
          ]
        : []),
    ],
  },
  // The coherence report (media-track.md, Review): the findings file and its run history, for reading outside Caotang.
  {
    name: t`Review`,
    formats: [
      { format: 'coherence-md', label: t`Coherence report (.md)`, help: t`The findings by fact, with their quotes and verdicts, and the run history.` },
      { format: 'coherence-json', label: t`Coherence report (.json)`, help: t`The findings and runs as the findings file holds them.` },
    ],
  },
  // The timeline's own exports (timeline.md §8): the scenes as a table, and the drawn axis as an image or a print PDF.
  {
    name: t`Timeline`,
    formats: [
      { format: 'timeline-csv', label: t`Timeline table (.csv)`, help: t`One row per scene — part, day, duration, mode, point of view, presence, dependencies, threads, open findings, picture ids and alt text — in canonical scene order.` },
      { format: 'timeline-xlsx', label: t`Timeline table (.xlsx)`, help: t`The same rows as a spreadsheet, with the reading index and the days as numbers.` },
      { format: 'timeline-svg', label: t`Timeline image (.svg)`, help: t`The timeline as a vector drawing, in the direction of the language you write in; above 2,000 scenes it shows chapters.` },
      { format: 'timeline-pdf', label: t`Timeline PDF (.pdf)`, help: t`The timeline on landscape pages you can print, one part per fresh page, with the day scale and a footer on every page.` },
    ],
  },
  ];
}

/** The recipe's options as the dialog shows them. An unset option shows the template's default. */
interface ShownOptions {
  readonly titlePage: boolean;
  readonly toc: boolean;
  readonly author: string;
  /** A heading for the contents list that overrides the project language's word; empty uses the project language's word (i18n.md §7.1). */
  readonly contentsLabel: string;
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
  /** The comic PDF's bleed: on unless the recipe turns it off (comics.md §5). */
  readonly bleed: boolean;
  /** The comic PDF's crop marks in the margin; off unless the recipe sets them. */
  readonly cropMarks: boolean;
  /** The timeline PDF draws each scene's pictures as thumbnails on its bar; off unless the recipe sets it (timeline.md §9.1). */
  readonly timelinePictures: boolean;
  /** How the prose formats treat the pictures in the bodies: the mode, keeping their metadata, and the EPUB's WebP (pictures.md §4). */
  readonly pictures: ShownPictureOptions;
}

/** The picture modes, in the words the dialog shows. */
const PICTURE_MODE_LABELS: Readonly<Record<PictureMode, string>> = {
  get copy() {
    return t`Copy them into a folder beside the file`;
  },
  get link() {
    return t`Link to them in the project folder`;
  },
  get drop() {
    return t`Leave them out, and keep their text`;
  },
  get placeholder() {
    return t`Write a [Picture: caption] line in their place`;
  },
};

/** The scene-number choices, in the words the dialog shows. */
const SCENE_NUMBER_LABELS: Readonly<Record<SceneNumbersOption, string>> = {
  get off() {
    return t`Off`;
  },
  get left() {
    return t`Left margin`;
  },
  get right() {
    return t`Right margin`;
  },
  get both() {
    return t`Both margins`;
  },
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
    contentsLabel: recipe?.options?.contentsLabel ?? '',
    charLimit: recipe?.options?.charLimit,
    pageSize: recipe?.options?.pageSize,
    paperFrames: recipe?.options?.paperFrames ?? false,
    bleed: recipe?.options?.bleed ?? true,
    cropMarks: recipe?.options?.cropMarks ?? false,
    timelinePictures: recipe?.options?.timelinePictures ?? false,
    sceneNumbers: recipe?.options?.sceneNumbers ?? 'off',
    continued: recipe?.options?.continued ?? true,
    pictures: shownPictureOptionsOf(recipe?.options),
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
  useLingui();
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
  // A comic compile takes one book, so the format is offered while a comic or one of its pages is the selected item.
  const comicSelected = selection !== null && comicBookOf(session.state.manifest.tree, selection.id) !== undefined;

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
    const contentsLabel = next.contentsLabel.trim();
    const outcome = saveRecipe(session, {
      name: recipe.name,
      includeRootIds: [...recipe.includeRootIds],
      format: recipe.format,
      ...(recipe.templateId === undefined ? {} : { templateId: recipe.templateId }),
      options: {
        titlePage: next.titlePage,
        toc: next.toc,
        ...(author === '' ? {} : { author }),
        ...(contentsLabel === '' ? {} : { contentsLabel }),
        ...(next.charLimit === undefined ? {} : { charLimit: next.charLimit }),
        ...pdfOptionsOf(next),
        ...(next.pageSize === undefined ? {} : { pageSize: next.pageSize }),
        ...(next.paperFrames ? { paperFrames: true } : {}),
        ...(next.bleed ? {} : { bleed: false }),
        ...(next.cropMarks ? { cropMarks: true } : {}),
        ...(next.timelinePictures ? { timelinePictures: true } : {}),
        ...pictureOptionsOf(next.pictures),
      },
    });
    if (outcome.ok) setNotice(null);
    else setNotice({ text: explain(outcome.error), tone: 'error' });
  };

  /** Saves the current settings as a new recipe, and selects it. */
  const saveAsNew = (): void => {
    const name = newName.trim();
    if (name === '') {
      setNotice({ text: t`Name the recipe first.`, tone: 'error' });
      return;
    }
    if (format === 'promptpack' && vendor === '') {
      setNotice({ text: t`Choose a vendor template first: a prompt pack recipe is written for one.`, tone: 'error' });
      return;
    }
    const author = shown.author.trim();
    const contentsLabel = shown.contentsLabel.trim();
    const outcome = saveRecipe(session, {
      name,
      includeRootIds: ['manuscript'],
      format,
      ...(format === 'promptpack' ? { templateId: vendor } : {}),
      options: {
        titlePage: shown.titlePage,
        toc: shown.toc,
        ...(author === '' ? {} : { author }),
        ...(contentsLabel === '' ? {} : { contentsLabel }),
        ...(shown.charLimit === undefined ? {} : { charLimit: shown.charLimit }),
        ...pdfOptionsOf(shown),
        ...(shown.pageSize === undefined ? {} : { pageSize: shown.pageSize }),
        ...(shown.paperFrames ? { paperFrames: true } : {}),
        ...(shown.bleed ? {} : { bleed: false }),
        ...(shown.cropMarks ? { cropMarks: true } : {}),
        ...(shown.timelinePictures ? { timelinePictures: true } : {}),
        ...pictureOptionsOf(shown.pictures),
      },
    });
    if (outcome.ok) {
      setRecipeName(name);
      setNewName('');
      setNotice({ text: t`Saved the recipe “${{ name: isolate(name) }}”.`, tone: 'info' });
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
      const comicPanels = useSelection ? comicPanelCountOf(session, selection.id) : undefined;
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
          setNotice({ text: t`The ${format} file could not be made: ${{ reason: failure.message }}`, tone: 'error' });
          return;
        }
      }
      const files: { name: string; bytes: Uint8Array }[] = [];
      for (const path of paths) {
        const bytes = await session.readExport(path);
        if (bytes === null) {
          setNotice({ text: t`The ${format} file was not found after it was made.`, tone: 'error' });
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
      report({ text: exportedSentence(digest, session.exportsToFolder(), comicPanels), tone: 'info' });
      onClose();
    } catch (error) {
      setNotice({ text: t`The export could not be made: ${{ reason: error instanceof Error ? error.message : String(error) }}`, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  // The recipe's options apply to a whole manuscript and to a single item alike, so they are on whenever a recipe is chosen.
  const optionsEnabled = recipe !== undefined;
  // Only the formats that place pictures ask about them; the rest of the picture options keep what the recipe stored.
  const pictureControls = pictureControlsShownFor(format, shown.pictures.pictures);

  const selectionLabel = selection === null ? t`The selected item (select one in the binder)` : t`Only “${{ title: isolate(selection.title) }}”`;
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
        <h2 id="export-title"><Trans>Export</Trans></h2>

        <label className="export-field">
          <span className="field-label"><Trans>Recipe</Trans></span>
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
            {recipes.length === 0 ? <option value=""><Trans>No recipes saved</Trans></option> : null}
            {recipes.map((candidate) => (
              <option key={candidate.name} value={candidate.name}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>

        {formatGroups(comicSelected).map((group) => (
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
                    // The comic formats are the selected book's, never the whole manuscript's.
                    if ((option.format === 'comic-pdf' || option.format === 'cbz' || option.format === 'comic-epub') && selection !== null) setScope('selection');
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
            <span className="field-label"><Trans>Vendor template</Trans></span>
            <select
              value={vendor}
              onChange={(event) => {
                setVendor(event.target.value);
                setNotice(null);
              }}
            >
              <option value=""><Trans>Choose a vendor template</Trans></option>
              {PACK_TEMPLATES.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.displayName}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <fieldset className="export-group">
          <legend className="field-label"><Trans>What to export</Trans></legend>
          <label className="export-option">
            <input
              type="radio"
              name="export-scope"
              value="manuscript"
              checked={scope === 'manuscript'}
              onChange={() => setScope('manuscript')}
            />
            <span className="export-option-label"><Trans>The whole manuscript</Trans></span>
          </label>
          <label className={`export-option${selection === null ? ' is-disabled' : ''}`}>
            <input
              type="radio"
              name="export-scope"
              value="selection"
              aria-label={accessibleText(selectionLabel)}
              disabled={selection === null}
              checked={scope === 'selection' && selection !== null}
              onChange={() => setScope('selection')}
            />
            <span className="export-option-label">
              {selectionLabel}
            </span>
          </label>
        </fieldset>

        <fieldset className="export-group" disabled={!optionsEnabled}>
          <legend className="field-label"><Trans>Settings for this recipe</Trans></legend>
          <label className="export-option">
            <input
              type="checkbox"
              checked={shown.titlePage}
              onChange={(event) => saveOptions({ ...shown, titlePage: event.target.checked })}
            />
            <span className="export-option-label"><Trans>Title page</Trans></span>
          </label>
          <label className="export-option">
            <input type="checkbox" checked={shown.toc} onChange={(event) => saveOptions({ ...shown, toc: event.target.checked })} />
            <span className="export-option-label"><Trans>Contents list</Trans></span>
          </label>
          {/* Each field is keyed by the recipe, so it starts again from that recipe's value when the recipe changes. The two are
              siblings, so each key also names its field: one key for both is React's duplicate-key warning. */}
          <AuthorField
            key={`author:${recipe?.name ?? ''}`}
            value={shown.author}
            onSave={(author) => saveOptions({ ...shown, author })}
          />
          {shown.toc && (format === 'md' || format === 'docx' || format === 'epub') ? (
            <ContentsLabelField
              key={`contents:${recipe?.name ?? ''}`}
              value={shown.contentsLabel}
              onSave={(contentsLabel) => saveOptions({ ...shown, contentsLabel })}
            />
          ) : null}
          {pictureControls === undefined ? null : (
            <>
              {pictureControls.mode === undefined ? null : (
                <label className="export-field">
                  <span className="export-option-label"><Trans>Pictures in the text</Trans></span>
                  <select
                    value={pictureControls.mode}
                    onChange={(event) =>
                      saveOptions({ ...shown, pictures: withPictureMode(shown.pictures, format, event.target.value as PictureMode) })
                    }
                  >
                    {pictureControls.modes.map((mode) => (
                      <option key={mode} value={mode}>
                        {PICTURE_MODE_LABELS[mode]}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {pictureControls.linkNote ? (
                <p className="export-option-help">
                  <Trans>The links point into the project folder, so they break if the exported file is moved away from it.</Trans>
                </p>
              ) : null}
              {pictureControls.keepMetadata ? (
                <label className="export-option">
                  <input
                    type="checkbox"
                    checked={shown.pictures.keepPictureMetadata}
                    onChange={(event) => saveOptions({ ...shown, pictures: { ...shown.pictures, keepPictureMetadata: event.target.checked } })}
                  />
                  <span className="export-option-label"><Trans>Keep the pictures’ private details, such as where they were taken</Trans></span>
                </label>
              ) : null}
              {pictureControls.keepWebp ? (
                <label className="export-option">
                  <input
                    type="checkbox"
                    checked={shown.pictures.epubKeepWebp}
                    onChange={(event) => saveOptions({ ...shown, pictures: { ...shown.pictures, epubKeepWebp: event.target.checked } })}
                  />
                  <span className="export-option-label"><Trans>Keep WebP pictures as they are (for Apple Books; other readers may show them blank)</Trans></span>
                </label>
              ) : null}
            </>
          )}
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
                <span className="export-option-label"><Trans>Scene numbers</Trans></span>
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
                <span className="export-option-label"><Trans>(MORE) and (CONT’D) where a speech crosses a page</Trans></span>
              </label>
            </>
          ) : null}
          {format === 'comic-pdf' ? (
            <>
              <label className="export-option">
                <input type="checkbox" checked={shown.bleed} onChange={(event) => saveOptions({ ...shown, bleed: event.target.checked })} />
                <span className="export-option-label"><Trans>Bleed: extend the art past the trim, for a printer</Trans></span>
              </label>
              <label className="export-option">
                <input type="checkbox" checked={shown.cropMarks} onChange={(event) => saveOptions({ ...shown, cropMarks: event.target.checked })} />
                <span className="export-option-label"><Trans>Crop marks: print the trim lines in the margin</Trans></span>
              </label>
              <label className="export-option">
                <input
                  type="checkbox"
                  checked={shown.paperFrames}
                  onChange={(event) => saveOptions({ ...shown, paperFrames: event.target.checked })}
                />
                <span className="export-option-label"><Trans>Paper frames: blank numbered frames to draw in, without the pictures</Trans></span>
              </label>
              <p className="export-option-help"><Trans>The reading direction is the book’s own setting, so a recipe does not change it.</Trans></p>
            </>
          ) : null}
          {format === 'contact-sheet-pdf' || format === 'timeline-pdf' ? (
            <>
              <label className="export-field">
                <span className="export-option-label"><Trans>Paper size</Trans></span>
                <select
                  value={shown.pageSize ?? 'A4'}
                  onChange={(event) => saveOptions({ ...shown, pageSize: event.target.value === 'Letter' ? 'Letter' : 'A4' })}
                >
                  <option value="A4"><Trans>A4</Trans></option>
                  <option value="Letter"><Trans>US Letter</Trans></option>
                </select>
              </label>
              {format === 'contact-sheet-pdf' ? (
              <label className="export-option">
                <input
                  type="checkbox"
                  checked={shown.paperFrames}
                  onChange={(event) => saveOptions({ ...shown, paperFrames: event.target.checked })}
                />
                <span className="export-option-label"><Trans>Paper frames: blank numbered frames to draw in, without the pictures</Trans></span>
              </label>
              ) : null}
              {format === 'timeline-pdf' ? (
                <label className="export-option">
                  <input
                    type="checkbox"
                    checked={shown.timelinePictures}
                    onChange={(event) => saveOptions({ ...shown, timelinePictures: event.target.checked })}
                  />
                  <span className="export-option-label"><Trans>Pictures: show each scene’s pictures as small thumbnails on its bar</Trans></span>
                </label>
              ) : null}
            </>
          ) : null}
        </fieldset>

        <div className="export-field export-save-new">
          <label className="export-field">
            <span className="export-option-label"><Trans>Save these settings as a new recipe</Trans></span>
            <input
              type="text"
              value={newName}
              maxLength={80}
              placeholder={t`For example, Beta read`}
              onChange={(event) => setNewName(event.target.value)}
            />
          </label>
          <button type="button" className="button" onClick={saveAsNew} disabled={newName.trim() === ''}>
            <Trans>Save as recipe</Trans>
          </button>
        </div>

        <p className="export-note">
          <Trans>Empty documents are left out and listed in the compile log. Undo removes the file again.</Trans>
        </p>

        <div className="export-footer">
          {notice === null ? null : (
            <p className={`form-message is-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
              {notice.text}
            </p>
          )}
          <div className="confirm-actions">
            <button type="button" className="button" onClick={onClose} disabled={busy}>
              <Trans>Cancel</Trans>
            </button>
            <button type="button" className="button is-primary" onClick={() => void compile()} disabled={busy}>
              {busy ? t`Compiling…` : t`Compile`}
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
  useLingui();
  const [draft, setDraft] = useState(value);
  return (
    <label className="export-field">
      <span className="export-option-label"><Trans>Author on the title page</Trans></span>
      <input
        type="text"
        value={draft}
        maxLength={200}
        placeholder={t`Uses the project’s author when empty`}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft.trim() !== value.trim()) onSave(draft);
        }}
      />
    </label>
  );
}

/** The contents list's heading. Empty uses the word of the project's language, so a German book reads Inhalt without any setting. */
function ContentsLabelField({ value, onSave }: { value: string; onSave: (label: string) => void }): ReactNode {
  useLingui();
  const [draft, setDraft] = useState(value);
  return (
    <label className="export-field">
      <span className="export-option-label"><Trans>Contents heading</Trans></span>
      <input
        type="text"
        value={draft}
        maxLength={80}
        placeholder={t`Uses the project language’s word when empty`}
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
  useLingui();
  const saved = value === undefined ? '' : String(value);
  const [draft, setDraft] = useState(saved);
  return (
    <label className="export-field">
      <span className="export-option-label"><Trans>Character limit for each line</Trans></span>
      <input
        type="number"
        min={1}
        max={CHAR_LIMIT_MAX}
        value={draft}
        placeholder={t`No limit`}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const text = draft.trim();
          if (text === '') {
            if (value !== undefined) onSave(undefined);
            return;
          }
          const limit = Number(text);
          if (!Number.isInteger(limit) || limit < 1 || limit > CHAR_LIMIT_MAX) {
            onInvalid(`A character limit is a whole number from 1 to ${formatCount(CHAR_LIMIT_MAX)}, or empty for no limit.`);
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

/** The panels on the comic pages a selected book or page compiles, or `undefined` when the selection is not a comic. */
function comicPanelCountOf(session: ProjectSession, selectionId: string): number | undefined {
  const tree = session.state.manifest.tree;
  const book = comicBookOf(tree, selectionId);
  if (book === undefined) return undefined;
  const pages = comicPageNodesOf(tree, book.id).filter((page) => book.id === selectionId || page.id === selectionId);
  return pages.reduce((total, page) => total + loadComicPage(page.comicPage).value.panels.length, 0);
}

/**
 * What a compile's file holds, in the words of its format (media-track.md). A script counts its scenes and sections, a
 * table its lines and containers, a shot list or a prompt pack its shots, and an Ink story its containers. A prose format
 * counts chapters, scenes and words, as it always has. The counts are the compile's own, so the sentence says what was written.
 */
function holdsOf(digest: ExportCommandDigest, comicPanels?: number): string {
  // Each count is grouped for the formatter locale and picks its noun's form from the same number, inside one message.
  const sceneCount = digest.sceneCount;
  const sectionCount = digest.chapterCount;
  const chapterCount = digest.chapterCount;
  const lineCount = digest.blockCount;
  const shotCount = digest.blockCount;
  const wordCount = digest.wordCount;
  const scenes = formatCount(sceneCount);
  const sections = formatCount(sectionCount);
  const chapters = formatCount(chapterCount);
  const lines = formatCount(lineCount);
  const shots = formatCount(shotCount);
  const words = formatCount(wordCount);
  switch (digest.format) {
    case 'fountain':
    case 'fdx':
    case 'pdf':
      return t`${scenes} ${plural(sceneCount, { one: 'scene', other: 'scenes' })} in ${sections} ${plural(sectionCount, { one: 'section', other: 'sections' })}, ${words} ${plural(wordCount, { one: 'word', other: 'words' })}`;
    case 'ink-json':
      return t`${scenes} ${plural(sceneCount, { one: 'container', other: 'containers' })}`;
    case 'dialogue-csv':
    case 'dialogue-xlsx':
      return t`${lines} ${plural(lineCount, { one: 'line', other: 'lines' })} in ${scenes} ${plural(sceneCount, { one: 'container', other: 'containers' })}, ${words} ${plural(wordCount, { one: 'word', other: 'words' })}`;
    case 'shot-list-csv':
    case 'shot-list-xlsx':
    case 'promptpack':
    case 'contact-sheet-pdf':
      return t`${shots} ${plural(shotCount, { one: 'shot', other: 'shots' })}`;
    case 'comic-pdf':
    case 'cbz':
    case 'comic-epub': {
      // A comic compile counts pages in `blockCount`; its chapter, scene and word counts are always zero and are never said.
      const pageCount = digest.blockCount;
      const pages = formatCount(pageCount);
      if (comicPanels === undefined) return t`${pages} ${plural(pageCount, { one: 'page', other: 'pages' })}`;
      const panels = formatCount(comicPanels);
      return t`${pages} ${plural(pageCount, { one: 'page', other: 'pages' })}, ${panels} ${plural(comicPanels, { one: 'panel', other: 'panels' })}`;
    }
    case 'coherence-md':
    case 'coherence-json':
      return t`the coherence report`;
    default:
      return t`${chapters} ${plural(chapterCount, { one: 'chapter', other: 'chapters' })}, ${scenes} ${plural(sceneCount, { one: 'scene', other: 'scenes' })}, ${words} ${plural(wordCount, { one: 'word', other: 'words' })}`;
  }
}

/** What the status line says about a finished compile: what it holds, what was skipped, and where it went. */
function exportedSentence(digest: ExportCommandDigest, alsoInFolder: boolean, comicPanels?: number): string {
  const skipped = digest.skippedDocs.length;
  const file = fileName(digest.output);
  const holds = holdsOf(digest, comicPanels);
  const files = digest.outputs !== undefined && digest.outputs.length > 1 ? digest.outputs.length : 1;
  const parts = [files > 1 ? t`Exported ${file} (${files} files): ${holds}.` : t`Exported ${file}: ${holds}.`];
  if (skipped > 0) {
    const skippedCount = skipped;
    const skippedText = formatCount(skipped);
    parts.push(t`Skipped ${skippedText} empty ${plural(skippedCount, { one: 'document', other: 'documents' })}.`);
  }
  if (alsoInFolder) parts.push(t`It is also in the project folder.`);
  return parts.join(' ');
}
