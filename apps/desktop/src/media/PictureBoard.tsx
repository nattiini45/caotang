/**
 * The picture board (pictures.md §5): every picture the project holds, as a grid the writer filters, sizes, selects from and imports
 * into. Importing is a Choose, a drop or a paste, each one `asset.importBatch`; every edit after that is an `asset.*` command, so it is
 * undoable and logged. The board's own state (the size, the filters, the selection, the open details) is view state and never saved.
 *
 * The board's pictures are read lazily: a tile far from the screen holds no bytes, so a project with hundreds of pictures does not hold
 * hundreds of object URLs.
 */

import { isolate } from '@caotang/i18n';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import type { AssetTarget } from '@caotang/pictures';
import type { SweepCandidate } from '@caotang/store';
import { useEffect, useId, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from 'react';

import type { ZoomLevel } from '../app/corkboard-model.js';
import { isImeEnter } from '../app/keymap.js';
import type { ProjectSession } from '../app/session.js';
import { explain } from '../components/actions.js';
import { ConfirmDialog, EmptyState, useReport, useSession } from '../components/shared.js';
import { ZoomControl } from '../components/ZoomControl.js';
import { accessibleText } from '../i18n/accessible-text.js';

import { useAssetListing } from './hooks.js';
import { PictureDetails } from './PictureDetails.js';
import { deletePicture, setPictureMeta } from './picture-actions.js';
import {
  NO_FILTERS,
  PICTURE_ACCEPT,
  PICTURE_DRAG_TYPE,
  altOf,
  bytesText,
  dragKindOf,
  entriesOf,
  filterChoicesOf,
  filterEntries,
  filtersActive,
  importSummary,
  liveSelection,
  meterSentence,
  nodeChoicesOf,
  parseTags,
  pixelsText,
  sizeMeterOf,
  sourceLabelOf,
  toggledSelection,
  usedInLines,
  withTags,
  type BoardFilters,
  type ImportReport,
  type PictureEntry,
  type PictureFocusRequest,
} from './picture-board-model.js';
import { ImportNotice, PASTE_SOURCE, useNearViewport, usePictureImage, usePictureImporter, usePictureThumb } from './picture-hooks.js';
import {
  RelinkConfirm,
  RelinkNotice,
  SweepConfirm,
  WorkingCopyConfirm,
  beginSweep,
  confirmRelink,
  confirmSweep,
  confirmWorkingCopies,
  useRelinkPairs,
} from './PictureStorage.js';
import { workingCopyChoiceOf, workingCopyLabel } from './picture-storage-model.js';
import { ShotLightbox } from './ShotLightbox.js';
import { isPictureFile } from './shot-image-model.js';

import './pictures.css';

/* lingui-set comment="The picture board. Interpolated values: title is a picture's caption or file name, a writer's own text; count and total are numbers." */

/** What a thumbnail size shows, as a phrase for the S, M and L buttons. */
function zoomLabels(): Readonly<Record<ZoomLevel, string>> {
  return {
    S: t`Small thumbnails, pictures only`,
    M: t`Medium thumbnails with the caption`,
    L: t`Large thumbnails with the caption, tags and size`,
  };
}



export interface PictureBoardProps {
  readonly session: ProjectSession;
  /** Open the details of one picture, from the Inspector's strip. */
  readonly focus: PictureFocusRequest | null;
  readonly onFocusHandled: () => void;
  /** "Go to it" on a placement: select the binder item and show it. */
  readonly onOpenNode: (nodeId: string) => void;
}

export function PictureBoard({ session, focus, onFocusHandled, onOpenNode }: PictureBoardProps): ReactNode {
  useLingui();
  useSession(session);
  const report = useReport();
  const importer = usePictureImporter(session);
  const version = session.assetsVersion();
  const listing = useAssetListing(session.assets.artifactFs(), version);
  const state = session.state;
  const contentLang = state.manifest.project.language;

  const [zoom, setZoom] = useState<ZoomLevel>('M');
  const [wanted, setFilters] = useState<BoardFilters>(NO_FILTERS);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ readonly id: string; readonly opener: HTMLElement | null } | null>(null);
  const [askDelete, setAskDelete] = useState<string | null>(null);
  const [last, setLast] = useState<ImportReport | null>(null);
  const [dragging, setDragging] = useState(false);
  const [batchTags, setBatchTags] = useState('');
  const [batchTarget, setBatchTarget] = useState('');
  const [tagNote, setTagNote] = useState<string | null>(null);
  const [sweepFiles, setSweepFiles] = useState<readonly SweepCandidate[] | null>(null);
  const [askRelink, setAskRelink] = useState(false);
  const [askCopies, setAskCopies] = useState<readonly string[] | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const root = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const ids = useId();

  const present = listing.listing === 'listed' ? new Set(listing.records.keys()) : null;
  const entries = entriesOf(state, present);
  const choices = filterChoicesOf(state, entries);
  // A filter whose choice the project no longer has (the last picture with that tag was untagged) would hide everything with no way
  // to see why, so it reads as not set.
  const stale =
    (wanted.tag !== null && !choices.tags.includes(wanted.tag)) ||
    (wanted.source !== null && !choices.sources.includes(wanted.source)) ||
    (wanted.target === 'project' && !choices.project) ||
    (wanted.target !== null && wanted.target !== 'project' && !choices.targets.some((target) => target.id === wanted.target)) ||
    (wanted.transcribed && !choices.transcriptions) ||
    (wanted.text !== '' && !choices.transcriptions);
  const filters = stale ? NO_FILTERS : wanted;
  const shown = filterEntries(entries, filters);
  const meter = sizeMeterOf(entries);
  const chosen = liveSelection(selection, entries);
  const chosenCount = chosen.size;
  const open = entries.find((entry) => entry.id === openId);
  const copyChoice = workingCopyChoiceOf(entries, chosen);
  const renamed = useRelinkPairs(session, version, listing.listing === 'listed' && entries.some((entry) => entry.missing));

  // A request from the Inspector opens that picture's details. The request is taken in render, once per serial, so the board shows the
  // picture on the render the request arrives with.
  const [taken, setTaken] = useState<number | null>(null);
  if (focus !== null && focus.serial !== taken) {
    setTaken(focus.serial);
    setOpenId(focus.assetId);
    setFilters(NO_FILTERS);
  }
  useEffect(() => {
    if (focus === null) return;
    onFocusHandled();
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-picture-tile="${CSS.escape(focus.assetId)}"] .pb-thumb`)?.focus();
    });
  }, [focus, onFocusHandled]);

  const focusTile = (id: string): void => {
    requestAnimationFrame(() => {
      const thumb = document.querySelector<HTMLElement>(`[data-picture-tile="${CSS.escape(id)}"] .pb-thumb`);
      (thumb ?? headingRef.current)?.focus();
    });
  };

  const importFiles = async (files: readonly File[], source?: typeof PASTE_SOURCE): Promise<void> => {
    if (files.length === 0) return;
    const done = await importer.importFiles(files, source === undefined ? {} : { source });
    setLast(done);
    if (done.status === 'imported' && done.assetIds[0] !== undefined) {
      setFilters(NO_FILTERS);
    }
  };

  const onChoose = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    void importFiles(files);
  };

  // A paste anywhere in the board, outside a text field, imports the pictures on the clipboard.
  const pasteHandler = useRef<(event: ClipboardEvent) => void>(() => {});
  useEffect(() => {
    pasteHandler.current = (event) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) return;
      const files = Array.from(event.clipboardData?.files ?? []).filter(isPictureFile);
      if (files.length === 0) return;
      event.preventDefault();
      void importFiles(files, PASTE_SOURCE);
    };
  });
  useEffect(() => {
    const listener = (event: ClipboardEvent): void => pasteHandler.current(event);
    window.addEventListener('paste', listener);
    return () => window.removeEventListener('paste', listener);
  }, []);

  const onDragOver = (event: DragEvent<HTMLElement>): void => {
    if (dragKindOf(event.dataTransfer.types) !== 'files') return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  };
  const onDragLeave = (event: DragEvent<HTMLElement>): void => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setDragging(false);
  };
  const onDrop = (event: DragEvent<HTMLElement>): void => {
    setDragging(false);
    if (dragKindOf(event.dataTransfer.types) !== 'files') return;
    event.preventDefault();
    void importFiles(Array.from(event.dataTransfer.files));
  };

  const retry = (): void => {
    const again = last?.retry;
    if (again === undefined) return;
    void again().then((done) => {
      setLast(done);
      report(importSummary(done));
    });
  };

  const tagChosen = (): void => {
    const added = parseTags(batchTags);
    if (added.length === 0) return;
    const targets = entries.filter((entry) => chosen.has(entry.id));
    const plans = targets.map((entry) => ({ entry, plan: withTags(entry.record.tags, added) }));
    const refused = plans.find((planned) => !planned.plan.ok);
    if (refused !== undefined && !refused.plan.ok) {
      setTagNote(`${refused.plan.reason} ${t`No picture was changed.`}`);
      return;
    }
    setTagNote(null);
    let changed = 0;
    for (const { entry, plan } of plans) {
      if (!plan.ok || plan.tags.length === (entry.record.tags ?? []).length) continue;
      if (!setPictureMeta(session, report, entry.id, { tags: plan.tags })) return;
      changed += 1;
    }
    setBatchTags('');
    report({ text: t`${plural(changed, { one: 'Tagged # picture.', other: 'Tagged # pictures.' })}`, tone: 'info' });
  };

  const placeChosen = (): void => {
    if (batchTarget === '') return;
    const target: AssetTarget = batchTarget === 'project' ? { kind: 'project' } : { kind: 'node', nodeId: batchTarget };
    let placed = 0;
    let already = 0;
    let refusedText: string | null = null;
    for (const entry of entries) {
      if (!chosen.has(entry.id)) continue;
      const there = entry.links.some((link) =>
        target.kind === 'project' ? link.target.kind === 'project' : link.target.kind === 'node' && (link.target as { nodeId?: unknown }).nodeId === target.nodeId,
      );
      if (there) {
        already += 1;
        continue;
      }
      const outcome = session.dispatch('asset.link', { assetId: entry.id, target });
      if (outcome.ok) placed += 1;
      else {
        refusedText = explain(outcome.error);
        break;
      }
    }
    if (refusedText !== null) {
      report({ text: refusedText, tone: 'error' });
      return;
    }
    const sentences: string[] = [];
    if (placed > 0) sentences.push(t`${plural(placed, { one: 'Placed # picture.', other: 'Placed # pictures.' })}`);
    if (already > 0) sentences.push(t`${plural(already, { one: '# picture was already there.', other: '# pictures were already there.' })}`);
    report({ text: sentences.join(' '), tone: 'info' });
    if (placed > 0) setBatchTarget('');
  };

  const confirmDelete = (): void => {
    const id = askDelete;
    setAskDelete(null);
    if (id === null) return;
    if (!deletePicture(session, report, id)) return;
    setSelection((now) => {
      const next = new Set(now);
      next.delete(id);
      return next;
    });
    if (openId === id) setOpenId(null);
    requestAnimationFrame(() => headingRef.current?.focus());
  };

  // One storage step at a time: a sweep, a re-link and a working-copy batch each read the listing and write the registry, so two
  // running together would read each other half done.
  const storageStep = async (step: () => Promise<unknown>): Promise<void> => {
    if (storageBusy) return;
    setStorageBusy(true);
    try {
      await step();
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure);
      report({ text: t`That did not finish: ${{ reason }}`, tone: 'error' });
    } finally {
      setStorageBusy(false);
    }
  };
  const startSweep = (): void => {
    void storageStep(async () => setSweepFiles(await beginSweep(session, report)));
  };
  const runSweep = (): void => {
    setSweepFiles(null);
    void storageStep(() => confirmSweep(session, report));
  };
  const runRelink = (): void => {
    const pairs = renamed;
    setAskRelink(false);
    if (pairs === null) return;
    void storageStep(() => confirmRelink(session, report, pairs));
  };
  const runCopies = (): void => {
    const wanted = askCopies;
    setAskCopies(null);
    if (wanted === null) return;
    void storageStep(async () => {
      if (await confirmWorkingCopies(session, report, wanted)) setSelection(new Set());
    });
  };

  const doomed = entries.find((entry) => entry.id === askDelete);
  const nodeChoices = nodeChoicesOf(state);
  const showFilters = choices.tags.length > 0 || choices.sources.length > 0 || choices.targets.length > 0 || choices.project || choices.transcriptions || entries.some((entry) => entry.orphaned) || entries.length > 1;
  const filtered = filtersActive(filters);

  return (
    <section
      ref={root}
      className={`pb-board${dragging ? ' is-dragging' : ''}`}
      aria-labelledby={`${ids}-title`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className="pb-head">
        <h2 id={`${ids}-title`} ref={headingRef} tabIndex={-1} className="pb-title">
          <Trans>Pictures</Trans>
        </h2>
        <div className="pb-head-actions">
          <input ref={fileInput} type="file" accept={PICTURE_ACCEPT} multiple hidden onChange={onChoose} data-testid="pictures-file-input" />
          <button type="button" className="button" disabled={importer.busy} onClick={() => fileInput.current?.click()}>
            <Trans>Choose pictures…</Trans>
          </button>
          <button type="button" className="button is-quiet" disabled={storageBusy} onClick={startSweep}>
            <Trans>Sweep unused files…</Trans>
          </button>
          <ZoomControl zoom={zoom} onZoom={setZoom} labels={zoomLabels()} ariaLabel={t`Thumbnail size`} />
        </div>
      </header>

      {entries.length > 0 ? (
        <p className="pb-meter" data-testid="pictures-meter">
          {meterSentence(meter)}
        </p>
      ) : null}
      <p className="pb-busy" role="status">
        {importer.busy ? t`Importing…` : ''}
      </p>
      {last === null ? null : <ImportNotice report={last} onDismiss={() => setLast(null)} onRetry={retry} />}
      {renamed === null ? null : <RelinkNotice pairs={renamed} busy={storageBusy} onOffer={() => setAskRelink(true)} />}

      {listing.listing === 'failed' ? (
        <p className="field-note" role="status">
          <Trans>The project’s picture files could not be listed, so a missing file cannot be told from one that is only slow to load.</Trans>
        </p>
      ) : null}

      {entries.length === 0 ? (
        <EmptyState
          title={t`No pictures yet`}
          actions={
            <button type="button" className="button" disabled={importer.busy} onClick={() => fileInput.current?.click()}>
              <Trans>Choose pictures…</Trans>
            </button>
          }
        >
          <p>
            <Trans>Choose PNG, JPEG or WebP pictures, drop them here, or paste them. They stay in this project, on your machine.</Trans>
          </p>
        </EmptyState>
      ) : (
        <>
          {showFilters ? (
            <FilterBar
              idBase={ids}
              filters={filters}
              onChange={setFilters}
              tags={choices.tags}
              sources={choices.sources}
              targets={choices.targets}
              project={choices.project}
              transcriptions={choices.transcriptions}
              orphans={entries.some((entry) => entry.orphaned)}
              lang={contentLang}
            />
          ) : null}
          <p className="pb-count" role="status">
            {filtered ? t`Showing ${{ shown: shown.length }} of ${{ total: entries.length }} pictures.` : ''}
          </p>

          {chosen.size > 0 ? (
            <div className="pb-batch" role="group" aria-label={t`Selected pictures`}>
              <strong>{t`${plural(chosenCount, { one: '# picture selected', other: '# pictures selected' })}`}</strong>
              <div className="pb-inline">
                <input
                  type="text"
                  aria-label={t`Tags to add to the selected pictures, separated by commas`}
                  placeholder={t`Add tags`}
                  value={batchTags}
                  lang={contentLang}
                  dir="auto"
                  onChange={(event) => setBatchTags(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' || isImeEnter(event.nativeEvent)) return;
                    event.preventDefault();
                    tagChosen();
                  }}
                />
                <button type="button" className="button" disabled={parseTags(batchTags).length === 0} onClick={tagChosen}>
                  <Trans>Tag selected</Trans>
                </button>
              </div>
              <div className="pb-inline">
                <select aria-label={t`Place the selected pictures on`} value={batchTarget} onChange={(event) => setBatchTarget(event.target.value)}>
                  <option value="">{t`Place on…`}</option>
                  <option value="project">{t`The project`}</option>
                  {nodeChoices.map((choice) => (
                    <option key={choice.id} value={choice.id}>
                      {`${'\u00a0\u00a0'.repeat(choice.depth)}${choice.title}`}
                    </option>
                  ))}
                </select>
                <button type="button" className="button" disabled={batchTarget === ''} onClick={placeChosen}>
                  <Trans>Place selected</Trans>
                </button>
              </div>
              <div className="pb-inline">
                <button type="button" className="button" disabled={copyChoice.ids.length === 0 || storageBusy} onClick={() => setAskCopies(copyChoice.ids)}>
                  {workingCopyLabel(copyChoice.ids.length)}
                </button>
                {copyChoice.leftOut === null ? null : <span className="field-note">{copyChoice.leftOut}</span>}
              </div>
              <div className="pb-inline">
                <button
                  type="button"
                  className="button is-quiet"
                  onClick={() => setSelection(new Set([...chosen, ...shown.map((entry) => entry.id)]))}
                >
                  <Trans>Select all shown</Trans>
                </button>
                <button type="button" className="button is-quiet" onClick={() => setSelection(new Set())}>
                  <Trans>Clear selection</Trans>
                </button>
              </div>
              {tagNote === null ? null : (
                <p className="field-note is-complaint" role="alert">
                  {tagNote}
                </p>
              )}
            </div>
          ) : null}

          <div className={`pb-layout${open === undefined ? '' : ' has-details'}`}>
            <div className="pb-main">
              {shown.length === 0 ? (
                <EmptyState
                  title={t`No picture matches these filters`}
                  actions={
                    <button type="button" className="button" onClick={() => setFilters(NO_FILTERS)}>
                      <Trans>Clear filters</Trans>
                    </button>
                  }
                />
              ) : (
                <ul className={`pb-grid zoom-${zoom}`} aria-label={t`Pictures`}>
                  {shown.map((entry) => (
                    <Tile
                      key={entry.id}
                      session={session}
                      entry={entry}
                      zoom={zoom}
                      version={version}
                      lang={contentLang}
                      selected={chosen.has(entry.id)}
                      open={openId === entry.id}
                      onToggle={() => setSelection(toggledSelection(chosen, entry.id))}
                      onOpen={() => setOpenId(openId === entry.id ? null : entry.id)}
                      onEnlarge={(opener) => setLightbox({ id: entry.id, opener })}
                    />
                  ))}
                </ul>
              )}
              {entries.length > 0 ? (
                <details className="pb-largest">
                  <summary>
                    <Trans>Largest pictures</Trans>
                  </summary>
                  <ol className="pb-largest-list">
                    {meter.largest.map((entry) => (
                      <li key={entry.id}>
                        <button
                          type="button"
                          className="button is-quiet"
                          onClick={() => {
                            setOpenId(entry.id);
                            setFilters(NO_FILTERS);
                            focusTile(entry.id);
                          }}
                        >
                          <span lang={contentLang} dir="auto">
                            {entry.label}
                          </span>
                        </button>
                        <span className="muted">
                          {' '}
                          {bytesText(entry.record.bytes)}
                          {pixelsText(entry.record) === undefined ? '' : `, ${pixelsText(entry.record)}`}
                        </span>
                      </li>
                    ))}
                  </ol>
                </details>
              ) : null}
            </div>
            {open === undefined ? null : (
              <PictureDetails
                key={open.id}
                session={session}
                entry={open}
                onClose={() => {
                  setOpenId(null);
                  focusTile(open.id);
                }}
                onAskDelete={() => setAskDelete(open.id)}
                onEnlarge={(opener) => setLightbox({ id: open.id, opener })}
                onOpenNode={onOpenNode}
              />
            )}
          </div>
        </>
      )}

      <p className="pb-drop-hint" aria-hidden={!dragging}>
        {dragging ? t`Drop to add these pictures to the project.` : ''}
      </p>

      {lightbox === null ? null : <Enlarged session={session} entry={entries.find((entry) => entry.id === lightbox.id)} version={version} opener={lightbox.opener} onClose={() => setLightbox(null)} />}

      <ConfirmDialog
        open={doomed !== undefined}
        title={doomed === undefined ? '' : t`Delete ${{ title: isolate(doomed.label) }}?`}
        confirmLabel={t`Delete picture`}
        onCancel={() => setAskDelete(null)}
        onConfirm={confirmDelete}
      >
        {doomed === undefined ? null : (
          <>
            {doomed.links.length === 0 ? null : (
              <>
                <p>
                  <Trans>Its placements go with it:</Trans>
                </p>
                <ul className="pb-uses">
                  {usedInLines(state, doomed.uses.filter((use) => use.kind === 'link')).map((line) => (
                    <li key={line.key} lang={contentLang} dir="auto">
                      {line.text}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p>
              <Trans>Undo brings the picture back. Its file stays in the project until it is swept.</Trans>
            </p>
          </>
        )}
      </ConfirmDialog>
      <SweepConfirm candidates={sweepFiles} onCancel={() => setSweepFiles(null)} onConfirm={runSweep} />
      <RelinkConfirm state={state} pairs={askRelink ? renamed : null} onCancel={() => setAskRelink(false)} onConfirm={runRelink} />
      <WorkingCopyConfirm ids={askCopies} confirmLabel={workingCopyLabel(askCopies?.length ?? 0)} onCancel={() => setAskCopies(null)} onConfirm={runCopies} />
      {importer.dialog}
    </section>
  );
}

interface FilterBarProps {
  readonly idBase: string;
  readonly filters: BoardFilters;
  readonly onChange: (filters: BoardFilters) => void;
  readonly tags: readonly string[];
  readonly sources: readonly ('import' | 'paste' | 'mcp' | 'scan' | 'agent')[];
  readonly targets: readonly { readonly id: string; readonly title: string }[];
  readonly project: boolean;
  readonly transcriptions: boolean;
  readonly orphans: boolean;
  readonly lang: string | undefined;
}

function FilterBar({ idBase, filters, onChange, tags, sources, targets, project, transcriptions, orphans, lang }: FilterBarProps): ReactNode {
  const set = (patch: Partial<BoardFilters>): void => onChange({ ...filters, ...patch });
  return (
    <div className="pb-filters" role="group" aria-label={t`Filter pictures`}>
      {transcriptions ? (
        <label className="pb-filter">
          <span className="field-label">
            <Trans>Transcription text</Trans>
          </span>
          <input
            id={`${idBase}-text`}
            type="search"
            value={filters.text}
            lang={lang}
            dir="auto"
            placeholder={t`Search transcriptions…`}
            onChange={(event) => set({ text: event.target.value })}
          />
        </label>
      ) : null}
      {tags.length === 0 ? null : (
        <label className="pb-filter">
          <span className="field-label">
            <Trans>Tag</Trans>
          </span>
          <select id={`${idBase}-tag`} value={filters.tag ?? ''} lang={lang} onChange={(event) => set({ tag: event.target.value === '' ? null : event.target.value })}>
            <option value="">{t`Any tag`}</option>
            {tags.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </select>
        </label>
      )}
      {targets.length === 0 && !project ? null : (
        <label className="pb-filter">
          <span className="field-label">
            <Trans>Placed on</Trans>
          </span>
          <select value={filters.target ?? ''} lang={lang} onChange={(event) => set({ target: event.target.value === '' ? null : event.target.value })}>
            <option value="">{t`Anywhere`}</option>
            {project ? <option value="project">{t`The project`}</option> : null}
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {sources.length === 0 ? null : (
        <label className="pb-filter">
          <span className="field-label">
            <Trans>Source</Trans>
          </span>
          <select
            value={filters.source ?? ''}
            onChange={(event) => set({ source: event.target.value === '' ? null : (event.target.value as NonNullable<BoardFilters['source']>) })}
          >
            <option value="">{t`Any source`}</option>
            {sources.map((source) => (
              <option key={source} value={source}>
                {sourceLabelOf(source)}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="pb-check">
        <input type="checkbox" checked={filters.unused} onChange={(event) => set({ unused: event.target.checked })} />
        <span>
          <Trans>Unused</Trans>
        </span>
      </label>
      {orphans ? (
        <label className="pb-check">
          <input type="checkbox" checked={filters.orphaned} onChange={(event) => set({ orphaned: event.target.checked })} />
          <span>
            <Trans>Lost its paragraph</Trans>
          </span>
        </label>
      ) : null}
      {transcriptions ? (
        <label className="pb-check">
          <input type="checkbox" checked={filters.transcribed} onChange={(event) => set({ transcribed: event.target.checked })} />
          <span>
            <Trans>Has a transcription</Trans>
          </span>
        </label>
      ) : null}
      {filtersActive(filters) ? (
        <button type="button" className="button is-quiet" onClick={() => onChange(NO_FILTERS)}>
          <Trans>Clear filters</Trans>
        </button>
      ) : null}
    </div>
  );
}

interface TileProps {
  readonly session: ProjectSession;
  readonly entry: PictureEntry;
  readonly zoom: ZoomLevel;
  readonly version: number;
  readonly lang: string | undefined;
  readonly selected: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onOpen: () => void;
  readonly onEnlarge: (opener: HTMLElement | null) => void;
}

function Tile({ session, entry, zoom, version, lang, selected, open, onToggle, onOpen, onEnlarge }: TileProps): ReactNode {
  const useCount = entry.uses.length;
  useLingui();
  const { watch, near } = useNearViewport<HTMLLIElement>();
  // The S size shows the small thumbnail kept in this browser; M and L show the picture itself, so a tile holds one or the other.
  const small = zoom === 'S';
  const full = usePictureImage(session, entry.record, near && !entry.missing && !small, version);
  const thumb = usePictureThumb(session, entry.record, near && !entry.missing && small, version);
  const image = small ? thumb : full;
  const missing = entry.missing || image.state === 'missing';
  const alt = altOf(entry.record);
  const size = pixelsText(entry.record);
  const tags = entry.record.tags ?? [];
  return (
    <li
      ref={watch}
      className={`pb-tile${selected ? ' is-selected' : ''}${open ? ' is-open' : ''}`}
      data-picture-tile={entry.id}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(PICTURE_DRAG_TYPE, entry.id);
        event.dataTransfer.effectAllowed = 'copyLink';
      }}
    >
      <label className="pb-select">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={accessibleText(t`Select ${{ title: isolate(entry.label) }}`)}
        />
      </label>
      <button
        type="button"
        className="pb-thumb"
        aria-expanded={open}
        aria-label={accessibleText(t`Details of ${{ title: isolate(entry.label) }}`)}
        onClick={onOpen}
      >
        {image.url !== null ? (
          <img src={image.url} alt={alt} loading="lazy" decoding="async" />
        ) : missing ? (
          <span className="pb-placeholder is-missing">
            <Trans>File missing</Trans>
          </span>
        ) : image.state === 'error' ? (
          <span className="pb-placeholder is-missing">{small ? <Trans>No preview</Trans> : <Trans>Could not be read</Trans>}</span>
        ) : (
          <span className="pb-placeholder" aria-busy={image.state === 'loading'}>
            <Trans>Loading…</Trans>
          </span>
        )}
      </button>
      <div className="pb-meta">
        <p className="pb-caption" lang={lang} dir="auto" title={entry.label}>
          {entry.label}
        </p>
        <p className="pb-chips">
          {missing ? (
            <span className="badge is-warn">
              <Trans>File missing</Trans>
            </span>
          ) : null}
          {entry.orphaned ? (
            <span className="badge is-warn">
              <Trans>Lost its paragraph</Trans>
            </span>
          ) : null}
          {entry.unused ? (
            <span className="badge">
              <Trans>Unused</Trans>
            </span>
          ) : (
            <span className="badge">{t`${plural(useCount, { one: 'Used in # place', other: 'Used in # places' })}`}</span>
          )}
        </p>
        {zoom === 'L' ? (
          <>
            {tags.length === 0 ? null : (
              <p className="pb-tags" lang={lang} dir="auto">
                {tags.join(', ')}
              </p>
            )}
            <p className="pb-size muted">
              {bytesText(entry.record.bytes)}
              {size === undefined ? '' : `, ${size}`}
            </p>
          </>
        ) : null}
        {zoom === 'S' ? null : (
          <button
            type="button"
            className="button is-quiet pb-enlarge"
            disabled={image.url === null}
            aria-label={accessibleText(t`View ${{ title: isolate(entry.label) }} larger`)}
            onClick={(event) => onEnlarge(event.currentTarget)}
          >
            <Trans>View larger</Trans>
          </button>
        )}
      </div>
    </li>
  );
}

function Enlarged({
  session,
  entry,
  version,
  opener,
  onClose,
}: {
  readonly session: ProjectSession;
  readonly entry: PictureEntry | undefined;
  readonly version: number;
  readonly opener: HTMLElement | null;
  readonly onClose: () => void;
}): ReactNode {
  const image = usePictureImage(session, entry?.record, entry !== undefined, version);
  const caption = entry?.record.caption?.trim();
  if (entry === undefined || image.url === null) return null;
  return (
    <ShotLightbox
      url={image.url}
      title={entry.label}
      alt={altOf(entry.record)}
      caption={caption === undefined || caption === '' ? null : caption}
      returnFocusTo={opener}
      onClose={onClose}
    />
  );
}
