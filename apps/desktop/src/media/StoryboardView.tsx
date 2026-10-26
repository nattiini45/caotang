/**
 * The storyboard view — storyboard.md §3. A folder marked `kind: 'storyboard'` renders as a board of shot cards in shot mode: the
 * image, the derived number, and one spec row. Every change goes through `commitShotCommand` (commit.ts): a new card is a
 * `binder.create`, a reorder a `binder.move` (by the Earlier and Later buttons, or by dragging a card), and the fields a
 * `shot.setMeta`. A picture is added by `shot.importImage` (`importImage` on the ports), and the files of a drop on the board, not on a
 * card, by one `shot.importImages` (`importImages`), each on the shot its file name numbers (storyboard.md §6). The fields are edited only when the App
 * supplies a `commitShot` port, because a field editor that could not save would be a lie. The Prompt pack tab is the video
 * prompt pack panel over the same shots.
 */

import { useEffect, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';

import type { TreeNode } from '@caotang/store';

import type { ZoomLevel } from '../app/corkboard-model.js';
import type { ProjectSession } from '../app/session.js';
import { radioStep } from '../components/radio-keys.js';
import { EmptyState, useReport, useSession } from '../components/shared.js';
import { ZoomControl } from '../components/ZoomControl.js';
import { animaticLineOf } from './board-model.js';
import { commitShotCommand } from './commit.js';
import { ShotCoverage } from './ShotCoverage.js';
import { ShotLightbox } from './ShotLightbox.js';
import { ShotPromptEditor } from './ShotPromptEditor.js';
import { ENUM_OPTIONS, EDITABLE_FIELDS, derivableSceneOf, deriveIntentOf, draftAfterStoredChange, emptyBoardCopyOf, draftOf, moveShotCommand, newShotParams, shotCardsOf, shotEditCommand, type EditableField, type ShotCard, type ShotDraft } from './storyboard-model.js';
import {
  IMAGE_ACCEPT,
  assignImageCommand,
  clearImageCommand,
  dropReportOf,
  firstPicture,
  missingPictureLabelOf,
  planPictureDrop,
  type DropCommit,
  type PictureListing,
} from './shot-image-model.js';
import { useAssetListing, useImageUrl } from './hooks.js';
import { LazyBoundary, lazyView } from '../components/lazy-view.js';
import type { PromptFieldKey } from './prompt-edit-model.js';
import type { MediaPorts } from './ports.js';
import { ACTION_MAX_CHARS, SHOT_ENUMS, enumLabelOf, type AssetRecord } from './engines.js';

// The prompt pack carries the video prompt packages, so its code loads when the tab is first opened, not with the board.
const PromptPackPanel = lazyView(() => import('./PromptPackPanel.js').then((module) => ({ default: module.PromptPackPanel })));

export interface StoryboardViewProps {
  readonly session: ProjectSession;
  /** The storyboard folder. */
  readonly node: TreeNode;
  readonly ports?: MediaPorts;
  /** The card size, which the corkboard shares (ui-modules §3.2). Absent: the board keeps the size it chose itself. */
  readonly zoom?: ZoomLevel;
  readonly onZoom?: (zoom: ZoomLevel) => void;
  /** Sends a request to the agent. The empty board's derive action uses it (storyboard.md §3.1). Absent: the action is not offered. */
  readonly onAgentIntent?: (intent: string) => void;
}

type Tab = 'board' | 'pack';

/** The board and the prompt pack, in the order the radio group has them. The visible words are the names (WCAG 2.5.3). */
const TABS: readonly Tab[] = ['board', 'pack'];

const TAB_LABEL: Readonly<Record<Tab, string>> = {
  board: 'The shots as cards',
  pack: 'The shots as a video prompt pack',
};

/**
 * What each card size shows on the shot board (storyboard.md §3.1): S is the number and the picture, M adds the title, the spec row
 * and the coverage line, and L adds the action, the status and the label. The names say so, since the card is the only place the
 * writer sees the level. A label is a phrase without a colon (ZoomControl puts the letter before it).
 */
const SHOT_ZOOM_LABEL: Readonly<Record<ZoomLevel, string>> = {
  S: 'Small cards, number and picture only',
  M: 'Medium cards, number, picture, title, spec row and coverage',
  L: 'Large cards, the medium card with the action, status and label',
};

/** A check's link from the Prompt pack tab: the shot and the field to bring into view on the board. */
export interface PromptFocus {
  readonly shotId: string;
  readonly key: PromptFieldKey;
  readonly vendor?: string;
}

/** The dataTransfer type a card drag carries, so a card move is told apart from a picture dropped from the desktop. */
const SHOT_DRAG_TYPE = 'application/x-caotang-shot';

export function StoryboardView({ session, node, ports, zoom, onZoom, onAgentIntent }: StoryboardViewProps): ReactNode {
  const [tab, setTab] = useState<Tab>('board');
  const [focus, setFocus] = useState<PromptFocus | null>(null);
  /** The arrow keys move the choice and the focus with it, as the centre switch does (the WAI-ARIA radio pattern). */
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = radioStep(TABS, tab, event.key);
    if (next === null) return;
    event.preventDefault();
    setTab(next);
    event.currentTarget.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
  };
  return (
    <section className="media-view sb-view" aria-label={`Storyboard: ${node.title}`}>
      <header className="media-head">
        <div>
          <p className="eyebrow">Storyboard</p>
          <h2 className="media-title">{node.title}</h2>
        </div>
        <div role="radiogroup" aria-label="Storyboard view" className="segmented" onKeyDown={onTabKey}>
          {TABS.map((item) => (
            <button
              key={item}
              type="button"
              role="radio"
              data-tab={item}
              aria-checked={tab === item}
              tabIndex={tab === item ? 0 : -1}
              title={TAB_LABEL[item]}
              className="segmented-item"
              onClick={() => setTab(item)}
            >
              {item === 'board' ? 'Board' : 'Prompt pack'}
            </button>
          ))}
        </div>
      </header>
      {tab === 'board' ? (
        <ShotBoard session={session} folder={node} ports={ports} focus={focus} zoom={zoom} onZoom={onZoom} onAgentIntent={onAgentIntent} />
      ) : (
        <LazyBoundary label="the prompt pack">
          <PromptPackPanel
            session={session}
            folder={node}
            ports={ports}
            onFix={(shotId, key, vendor) => {
              setFocus({ shotId, key, ...(vendor === undefined ? {} : { vendor }) });
              setTab('board');
            }}
          />
        </LazyBoundary>
      )}
    </section>
  );
}

interface ShotBoardProps {
  readonly session: ProjectSession;
  readonly folder: TreeNode;
  readonly ports: MediaPorts | undefined;
  /** A check's link from the pack: the shot to select, and the field to focus in its editor. */
  readonly focus?: PromptFocus | null;
  readonly zoom?: ZoomLevel;
  readonly onZoom?: (zoom: ZoomLevel) => void;
  readonly onAgentIntent?: (intent: string) => void;
}

export function ShotBoard({ session, folder, ports, focus = null, zoom: zoomProp, onZoom, onAgentIntent }: ShotBoardProps): ReactNode {
  useSession(session);
  const report = useReport();
  const cards = shotCardsOf(session.state, folder.id);
  // The images are listed when they can have changed, not on every change of the session (media/hooks.ts).
  const pictureList = useAssetListing(ports?.assets, session.assetsVersion());
  const assetRecords = pictureList.records;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // The editor's message lives here, not in the editor: a save changes the card's stored value, which remounts the editor.
  const [editMessage, setEditMessage] = useState<string | null>(null);
  // The picture open in the lightbox, and the element that opened it, which gets focus back when it closes.
  const [lightbox, setLightbox] = useState<{ readonly url: string; readonly title: string; readonly opener: HTMLElement | null } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const [noticesShown, setNoticesShown] = useState(true);
  // What the last drop of files on the board did with each of them (storyboard.md §6).
  const [dropReport, setDropReport] = useState<{ readonly summary: string; readonly lines: readonly string[] } | null>(null);
  // The card size is the one the corkboard shares, when the centre passes it; a board shown without it keeps its own.
  const [ownZoom, setOwnZoom] = useState<ZoomLevel>('M');
  const zoom = zoomProp ?? ownZoom;
  const setZoom = onZoom ?? setOwnZoom;
  const editable = ports?.commitShot !== undefined;
  const selected = cards.find((card) => card.id === selectedId) ?? null;
  const [appliedFocus, setAppliedFocus] = useState<PromptFocus | null>(null);
  const notices = session.imageNotices();

  // The board is the first place a picture is shown, so the session's image check (a dangling reference is dropped, once) runs
  // when it opens. The open has finished loading the project's images by then, so the check reads a complete list.
  useEffect(() => {
    void session.checkImageReferences();
  }, [session]);

  // A check's link from the pack selects its shot, so the editor the link names is the one on screen. A new link is applied
  // while rendering, the way React adjusts state for a changed prop, so the board never shows the previous shot for a frame.
  if (focus !== null && focus !== appliedFocus) {
    setAppliedFocus(focus);
    setSelectedId(focus.shotId);
    setEditMessage(null);
  }

  const step = (card: ShotCard, toIndex: number): void => {
    const planned = moveShotCommand(session.state, card.id, toIndex);
    if (!planned.ok) {
      setMessage(planned.refusal.message);
      return;
    }
    const result = commitShotCommand(session, planned.value, ports);
    if (!result.ok) {
      setMessage(result.message);
      report({ text: result.message, tone: 'error' });
      return;
    }
    setMessage(null);
    setSelectedId(card.id);
  };

  /**
   * A new empty shot at the end of the folder, created by `binder.create` (storyboard.md §3.1) through the same commit as every
   * other storyboard change, and opened for its fields when it lands.
   */
  const newShot = (): void => {
    const planned = newShotParams(session.state, folder.id);
    if (!planned.ok) {
      setMessage(planned.refusal.message);
      return;
    }
    const result = commitShotCommand(session, { name: 'binder.create', params: planned.value }, ports);
    if (!result.ok) {
      setMessage(result.message);
      report({ text: result.message, tone: 'error' });
      return;
    }
    setMessage(null);
    if (result.createdId !== undefined) {
      setSelectedId(result.createdId);
      setEditMessage(null);
    }
  };

  /** A picture the writer chose, dropped or pasted onto a card: read, then imported as that shot's image (storyboard.md §3.1). */
  const picture = async (shotId: string, file: File): Promise<void> => {
    if (ports?.importImage === undefined) {
      setMessage('Pictures cannot be added to a shot in this build.');
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await ports.importImage(shotId, bytes);
    if (!result.ok) {
      setMessage(result.message);
      report({ text: result.message, tone: 'error' });
      return;
    }
    setMessage(null);
  };

  /**
   * The files dropped on the board, not on a card: each is matched to a shot by the number its name starts with, and the matched pictures
   * are imported as one command, so one Undo takes them all back (storyboard.md §6). The notice says what became of every file.
   */
  const dropPictures = async (files: readonly File[]): Promise<void> => {
    if (ports?.importImages === undefined || !editable) {
      setMessage('Pictures cannot be added to a shot in this build.');
      return;
    }
    const verdicts = planPictureDrop(
      files,
      cards.map((card) => ({ id: card.id, number: card.number, title: card.title })),
    );
    const items: { shotId: string; bytes: Uint8Array }[] = [];
    for (const verdict of verdicts) {
      const file = files[verdict.file];
      if (verdict.kind === 'import' && file !== undefined) items.push({ shotId: verdict.shot.id, bytes: new Uint8Array(await file.arrayBuffer()) });
    }
    const commit: DropCommit = items.length === 0 ? { ok: true } : await ports.importImages(items);
    setMessage(null);
    setDropReport(dropReportOf(verdicts, cards.length, commit));
    if (!commit.ok) report({ text: commit.message, tone: 'error' });
  };

  const newShotButton = editable ? (
    <button type="button" className="button is-primary" onClick={newShot}>
      New shot
    </button>
  ) : null;

  if (cards.length === 0) {
    // The derive action names the one scene this board can derive (derivableSceneOf). Where no scene is named, the copy points to the scene.
    const sceneToDerive = editable && onAgentIntent !== undefined ? derivableSceneOf(session.state, folder) : undefined;
    const derive =
      sceneToDerive === undefined || onAgentIntent === undefined ? null : (
        <button type="button" className="button" onClick={() => onAgentIntent(deriveIntentOf(sceneToDerive))}>
          Derive shots from “{sceneToDerive.title}”
        </button>
      );
    const copy = emptyBoardCopyOf({ editable, canDerive: onAgentIntent !== undefined, scene: sceneToDerive });
    return (
      // A file dropped here is cancelled, so the tab does not open it; there is no shot for it to go on.
      <div
        onDragOver={(event) => {
          if (isFileDrag(event)) event.preventDefault();
        }}
        onDrop={(event) => {
          if (!isFileDrag(event)) return;
          event.preventDefault();
          setMessage('This board has no shots yet, so there is nothing to put the pictures on.');
        }}
      >
        <EmptyState
          title={copy.title}
          actions={
            <>
              {newShotButton}
              {derive}
            </>
          }
        >
          {copy.body}
        </EmptyState>
        {message === null ? null : (
          <p className="drop-note" role="status" aria-live="polite">
            {message}
          </p>
        )}
      </div>
    );
  }

  const animatic = animaticLineOf(session.state, folder.id);
  const dragging = dragId !== null;

  return (
    // A drop of files on the board, outside any card, is the batch import. A card takes the files dropped on it itself, and a card
    // drag is not a file drag, so neither is taken here. Whatever the files are, the tab must not open them.
    <div
      className="sb-board"
      onDragOver={(event) => {
        if (isFileDrag(event)) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        void dropPictures(Array.from(event.dataTransfer.files));
      }}
    >
      <div className="sb-bar">
        <p className="muted">
          {cards.length === 1 ? '1 shot' : `${cards.length} shots`}, {animatic.text}. The numbers follow the order of the cards, so a move renumbers them.
          {editable ? ' Drag a card, or use Earlier and Later, to move it.' : ' The fields are read only in this build.'}
        </p>
        <div className="sb-bar-controls">
          <ZoomControl zoom={zoom} onZoom={setZoom} labels={SHOT_ZOOM_LABEL} ariaLabel="Shot card size" />
          {newShotButton}
        </div>
      </div>
      {notices.length === 0 || !noticesShown ? null : (
        <div className="sb-notices" role="status">
          <p className="field-note">
            {notices.length === 1 ? 'An image was dropped when the project opened, because its file is not in the project.' : `${notices.length} images were dropped when the project opened, because their files are not in the project.`}
          </p>
          <ul className="findings" aria-label="Image notices">
            {notices.map((notice) => (
              <li key={notice}>{notice}</li>
            ))}
          </ul>
          <button type="button" className="button is-quiet" onClick={() => setNoticesShown(false)}>
            Dismiss
          </button>
        </div>
      )}
      {dropReport === null ? null : (
        <div className="sb-notices" role="status">
          <p className="field-note">{dropReport.summary}</p>
          <ul className="findings" aria-label="Pictures dropped on the board">
            {dropReport.lines.map((line, index) => (
              <li key={`${index}:${line}`}>{line}</li>
            ))}
          </ul>
          <button type="button" className="button is-quiet" onClick={() => setDropReport(null)}>
            Dismiss
          </button>
        </div>
      )}
      <div className={`sb-workspace${editable ? ' has-editor' : ''}`}>
        <ol className={`cards zoom-${zoom} sb-cards`} aria-label={`Shots in ${folder.title}`}>
          {cards.map((card) => (
            <li key={card.id} className="card-slot">
              <ShotCardView
                card={card}
                zoom={zoom}
                selected={card.id === selected?.id}
                editable={editable}
                assets={ports?.assets}
                dropping={dropId === card.id && dragging && dragId !== card.id}
                onSelect={() => {
                  setSelectedId(card.id);
                  setEditMessage(null);
                }}
                onStep={(delta) => step(card, card.index + delta)}
                onOpenImage={(url, opener) => setLightbox({ url, title: card.title, opener })}
                onPicture={(file) => void picture(card.id, file)}
                onShotDragStart={(event) => {
                  event.dataTransfer.setData(SHOT_DRAG_TYPE, card.id);
                  event.dataTransfer.effectAllowed = 'move';
                  setDragId(card.id);
                }}
                onShotDragOver={(event) => {
                  if (!isShotDrag(event) && dragId === null) return;
                  event.preventDefault();
                  setDropId(card.id);
                }}
                onShotDrop={(event) => {
                  if (!isShotDrag(event) && dragId === null) return;
                  event.preventDefault();
                  // Keep the in-page source id as a fallback for browsers that redact custom transfer payloads.
                  const movedId = event.dataTransfer.getData(SHOT_DRAG_TYPE) || dragId;
                  const moved = movedId === null ? undefined : cards.find((candidate) => candidate.id === movedId);
                  setDragId(null);
                  setDropId(null);
                  if (moved !== undefined && moved.id !== card.id) step(moved, card.index);
                }}
                onShotDragEnd={() => {
                  setDragId(null);
                  setDropId(null);
                }}
              />
            </li>
          ))}
        </ol>
        {editable && selected !== null ? (
          <ShotEditor
            key={selected.id}
            session={session}
            card={selected}
            folderId={folder.id}
            ports={ports}
            assets={assetRecords}
            pictures={pictureList.listing}
            focus={focus !== null && focus.shotId === selected.id ? focus : null}
            message={editMessage}
            onMessage={setEditMessage}
            onPicture={(file) => void picture(selected.id, file)}
          />
        ) : null}
      </div>
      {message === null ? null : (
        <p className="drop-note" role="status" aria-live="polite">
          {message}
        </p>
      )}
      {lightbox === null ? null : (
        <ShotLightbox url={lightbox.url} title={lightbox.title} returnFocusTo={lightbox.opener} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}

/** Whether a drag carries a card move, as opposed to a file dropped from the desktop. */
function isShotDrag(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes(SHOT_DRAG_TYPE);
}

/** Whether a drag carries files, which a card takes as its picture. */
function isFileDrag(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

interface ShotCardViewProps {
  readonly card: ShotCard;
  /** The card size: S shows the number and the picture, M adds the title, the spec row and the coverage, L adds the action, status, label. */
  readonly zoom: ZoomLevel;
  readonly selected: boolean;
  readonly editable: boolean;
  readonly assets: MediaPorts['assets'];
  /** Whether a card is being dragged over this one, so the drop position shows. */
  readonly dropping: boolean;
  readonly onSelect: () => void;
  readonly onStep: (delta: -1 | 1) => void;
  /** Opens the picture larger. The element is the picture's button, which gets focus back when the lightbox closes. */
  readonly onOpenImage: (url: string, opener: HTMLElement) => void;
  readonly onPicture: (file: File) => void;
  readonly onShotDragStart: (event: DragEvent<HTMLElement>) => void;
  readonly onShotDragOver: (event: DragEvent<HTMLElement>) => void;
  readonly onShotDrop: (event: DragEvent<HTMLElement>) => void;
  readonly onShotDragEnd: () => void;
}

function ShotCardView({
  card,
  zoom,
  selected,
  editable,
  assets,
  dropping,
  onSelect,
  onStep,
  onOpenImage,
  onPicture,
  onShotDragStart,
  onShotDragOver,
  onShotDrop,
  onShotDragEnd,
}: ShotCardViewProps): ReactNode {
  const url = useImageUrl(assets, card.image);
  // The load's notices already say what was kept or dropped, the unknown values included, so each is shown once.
  const notes = card.notices;
  // storyboard.md §3.1: S is the number and the picture. M adds the title, one spec row (the four spec parts, then the lens and the
  // transition) and the coverage line; L adds the action, the status and the label. The number, the picture and the warnings stay at
  // every size, because a value the load kept as unknown must be seen (storyboard.md §2.2).
  const detail = zoom !== 'S';
  const showAction = zoom === 'L' && card.action !== '';
  const specRow = card.spec;
  return (
    <article
      className={`card sb-card${selected ? ' is-selected' : ''}${dropping ? ' is-drop-target' : ''}`}
      data-shot-id={card.id}
      aria-label={`Shot ${card.number}: ${card.title}`}
      tabIndex={0}
      draggable={editable}
      onClick={onSelect}
      onDragStart={editable ? onShotDragStart : undefined}
      onDragOver={(event) => {
        if (isFileDrag(event)) {
          if (!editable) return;
          // The card takes the files dropped on it; the board's batch import is for a drop outside every card.
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (editable) onShotDragOver(event);
      }}
      onDrop={(event) => {
        if (isFileDrag(event)) {
          // A file dropped anywhere on the card is the card's picture, when it is one. Whatever it is, the browser must not open it
          // in this tab, so the drop is cancelled here, not only on the picture slot.
          event.preventDefault();
          event.stopPropagation();
          const file = editable ? firstPicture(Array.from(event.dataTransfer.files)) : undefined;
          if (file !== undefined) onPicture(file);
          return;
        }
        if (editable) onShotDrop(event);
      }}
      onDragEnd={onShotDragEnd}
      onPaste={(event: ClipboardEvent<HTMLElement>) => {
        if (!editable) return;
        const file = firstPicture(Array.from(event.clipboardData.files));
        if (file === undefined) return;
        event.preventDefault();
        onPicture(file);
      }}
    >
      <header className="card-head">
        <span className="chip sb-number" aria-label={`Shot number ${card.number}`}>
          {card.number}
        </span>
        {detail ? <h3 className="card-title">{card.title}</h3> : null}
        {card.unknown.length === 0 ? null : <span className="badge is-warn">Unknown value</span>}
        {zoom === 'L' ? (
          // Every node carries a status, so the chip is always named (the corkboard card does the same, ui-modules §3.1).
          <span className="chip chip-status" title="Status">
            <span className="chip-dot" style={{ background: card.status.color ?? 'var(--dot-empty)' }} aria-hidden="true" />
            {card.status.name}
          </span>
        ) : null}
      </header>
      {/* A picture dropped here is taken by the card (its drop handler), so the figure needs none of its own. */}
      <figure className="sb-frame">
        {url === null ? (
          <figcaption className="sb-frame-empty">{card.imageAlt === '' ? 'No image yet' : card.imageAlt}</figcaption>
        ) : (
          <button
            type="button"
            className="sb-frame-button"
            aria-label={`Look at the image of shot ${card.number} larger`}
            onClick={(event) => {
              event.stopPropagation();
              onOpenImage(url, event.currentTarget);
            }}
          >
            <img src={url} alt={card.imageAlt === '' ? card.title : card.imageAlt} />
          </button>
        )}
      </figure>
      {!detail || specRow === '' ? null : <p className="sb-spec">{specRow}</p>}
      {showAction ? <p className="sb-action">{card.action}</p> : null}
      {zoom !== 'L' || card.label === null ? null : (
        <div className="card-labels">
          <span className="chip chip-label">{card.label}</span>
        </div>
      )}
      {notes.length === 0 ? null : (
        <ul className="findings sb-notes" aria-label={`Notes on shot ${card.number}`}>
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {/* At S the footer is hidden from sight but stays in the tab order, so Earlier, Later and Fields are reached from the keyboard. */}
      <footer className={`card-foot sb-foot${detail ? '' : ' is-visually-hidden'}`}>
        {detail ? <span>{card.coverage === 1 ? '1 line covered' : `${card.coverage} lines covered`}</span> : null}
        <span className="sb-step">
          <button
            type="button"
            className="button is-quiet"
            aria-label={`Move shot ${card.number} earlier`}
            disabled={card.index === 0}
            onClick={(event) => {
              event.stopPropagation();
              onStep(-1);
            }}
          >
            Earlier
          </button>
          <button
            type="button"
            className="button is-quiet"
            aria-label={`Move shot ${card.number} later`}
            disabled={card.index >= card.count - 1}
            onClick={(event) => {
              event.stopPropagation();
              onStep(1);
            }}
          >
            Later
          </button>
          {editable ? (
            <button
              type="button"
              className="button is-quiet"
              aria-label={`Edit the fields of shot ${card.number}`}
              onClick={(event) => {
                event.stopPropagation();
                onSelect();
              }}
            >
              Fields
            </button>
          ) : null}
        </span>
      </footer>
    </article>
  );
}

interface ShotEditorProps {
  readonly session: ProjectSession;
  readonly card: ShotCard;
  readonly folderId: string;
  readonly ports: MediaPorts | undefined;
  readonly assets: ReadonlyMap<string, AssetRecord>;
  readonly pictures: PictureListing;
  readonly focus: PromptFocus | null;
  readonly message: string | null;
  readonly onMessage: (message: string | null) => void;
  readonly onPicture: (file: File) => void;
}

/**
 * The Inspector-style fields of one shot (storyboard.md §3.2), with its image, its script coverage and its prompt under them.
 * Saving the fields builds the `shot.setMeta` the engine checks, then commits it. A refused save says why and changes nothing, and
 * the draft stays as the writer left it. Each section commits on its own, so a save of one never resets another.
 */
function ShotEditor({ session, card, folderId, ports, assets, pictures, focus, message, onMessage, onPicture }: ShotEditorProps): ReactNode {
  return (
    <div className="sb-editor-column">
      {/* The fields are keyed on the shot, and take a stored change only for the fields it changed (ShotFields). The sections below keep their own state. */}
      <ShotFields key={card.id} session={session} card={card} ports={ports} message={message} onMessage={onMessage} />
      <ShotImage session={session} card={card} ports={ports} assets={assets} pictures={pictures} onPicture={onPicture} />
      <ShotCoverage session={session} shotId={card.id} ports={ports} />
      <ShotPromptEditor session={session} shotId={card.id} folderId={folderId} assets={assets} ports={ports} focus={focus} />
    </div>
  );
}

interface ShotFieldsProps {
  readonly session: ProjectSession;
  readonly card: ShotCard;
  readonly ports: MediaPorts | undefined;
  readonly message: string | null;
  readonly onMessage: (message: string | null) => void;
}

/**
 * The Inspector-style fields of one shot: the form that `shot.setMeta` saves. The draft is the writer's typed text. When the shot's stored
 * values change, only the fields whose stored value changed are reset to it (draftAfterStoredChange), so a save of the prompt or the
 * coverage does not discard an action the writer has typed and not yet saved.
 */
function ShotFields({ session, card, ports, message, onMessage }: ShotFieldsProps): ReactNode {
  const stored = draftOf(card);
  const [draft, setDraft] = useState<ShotDraft>(stored);
  // The stored values the draft was last brought up to date with, so a render can tell what the shot's own store changed since.
  const [synced, setSynced] = useState<ShotDraft>(stored);
  if (EDITABLE_FIELDS.some((field) => stored[field] !== synced[field])) {
    setDraft((previous) => draftAfterStoredChange(previous, synced, stored));
    setSynced(stored);
  }

  const set = (field: EditableField, value: string): void => {
    setDraft((previous) => ({ ...previous, [field]: value }));
  };

  const save = (): void => {
    const planned = shotEditCommand(session.state, card.id, draft);
    if (!planned.ok) {
      onMessage(planned.refusal.message);
      return;
    }
    const result = commitShotCommand(session, planned.value, ports);
    onMessage(result.ok ? 'Saved.' : result.message);
  };

  const enumSelect = (field: 'shotSize' | 'cameraAngle' | 'cameraMovement' | 'transition', label: string): ReactNode => {
    const value = draft[field];
    const listed = (SHOT_ENUMS[field] as readonly string[]).includes(value);
    return (
      <label>
        <span>{label}</span>
        <select value={value} onChange={(event) => set(field, event.target.value)}>
          <option value="">Not set</option>
          {value !== '' && !listed ? <option value={value}>{value} (not in the list)</option> : null}
          {ENUM_OPTIONS[field].map((option) => (
            <option key={option} value={option}>
              {enumLabelOf(field, option)}
            </option>
          ))}
        </select>
      </label>
    );
  };

  return (
    <>
      <form
        className="sb-editor"
        aria-label={`Fields of shot ${card.number}`}
        // The engine checks every field and says why, so the browser's own minimum check is off: one set of words.
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <p className="eyebrow">Shot {card.number}</p>
        {enumSelect('shotSize', 'Shot size')}
        {enumSelect('cameraAngle', 'Camera angle')}
        {enumSelect('cameraMovement', 'Camera movement')}
        {enumSelect('transition', 'Transition out')}
        <label>
          <span>Lens</span>
          <input type="text" value={draft.lens} onChange={(event) => set('lens', event.target.value)} />
        </label>
        <label>
          <span>Duration, seconds</span>
          <input type="number" min={0} step="any" value={draft.durationSec} onChange={(event) => set('durationSec', event.target.value)} />
        </label>
        <label>
          <span>Action</span>
          <textarea className="notes" rows={4} value={draft.action} onChange={(event) => set('action', event.target.value)} />
        </label>
        <p className={`counter${[...draft.action].length > ACTION_MAX_CHARS ? ' is-near' : ''}`}>
          {[...draft.action].length} of {ACTION_MAX_CHARS} characters
        </p>
        <label>
          <span>Caption when there is no image</span>
          <input type="text" value={draft.imageAlt} onChange={(event) => set('imageAlt', event.target.value)} />
        </label>
        <div className="empty-actions">
          <button type="submit" className="button is-primary">
            Save shot
          </button>
        </div>
        {message === null ? null : (
          <p className="drop-note" role="status" aria-live="polite">
            {message}
          </p>
        )}
      </form>
    </>
  );
}

interface ShotImageProps {
  readonly session: ProjectSession;
  readonly card: ShotCard;
  readonly ports: MediaPorts | undefined;
  readonly assets: ReadonlyMap<string, AssetRecord>;
  /** Where the project's list of pictures stands, which decides what the picker says about a picture the list does not hold. */
  readonly pictures: PictureListing;
  readonly onPicture: (file: File) => void;
}

/**
 * The image of one shot (storyboard.md §3.2): a file chosen from the desktop, which is imported, or one of the project's own images,
 * which is pointed at. Removing the image keeps the file in the project; only the shot stops naming it.
 */
function ShotImage({ session, card, ports, assets, pictures, onPicture }: ShotImageProps): ReactNode {
  const [message, setMessage] = useState<string | null>(null);
  const editable = ports?.commitShot !== undefined;
  const importable = ports?.importImage !== undefined;

  const point = (assetId: string | null): void => {
    const planned = assetId === null ? clearImageCommand(session.state, card.id) : assignImageCommand(session.state, card.id, assetId);
    if (!planned.ok) {
      setMessage(planned.refusal.message);
      return;
    }
    const result = commitShotCommand(session, planned.value, ports);
    setMessage(result.ok ? (assetId === null ? 'The image was removed from this shot.' : 'The shot now uses that image.') : result.message);
  };

  return (
    <section className="sb-image" aria-label={`Image of shot ${card.number}`}>
      <h3 className="field-label">Image</h3>
      <p className="muted">{card.image === null ? 'No image yet.' : 'This shot has an image.'}</p>
      {editable ? (
        <>
          {/* Each control's name starts with its visible words, so a voice control that says them finds it (WCAG 2.5.3). */}
          {importable ? (
            <label className="sb-file">
              <span>Choose an image file</span>
              <input
                type="file"
                accept={IMAGE_ACCEPT}
                aria-label={`Choose an image file for shot ${card.number}`}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file !== undefined) onPicture(file);
                }}
              />
            </label>
          ) : null}
          <label>
            <span>Or use an image already in the project</span>
            <select aria-label={`Or use an image already in the project for shot ${card.number}`} value={card.image ?? ''} onChange={(event) => point(event.target.value === '' ? null : event.target.value)}>
              <option value="">No image</option>
              {card.image !== null && !assets.has(card.image) ? <option value={card.image}>{missingPictureLabelOf(pictures)}</option> : null}
              {[...assets.values()].map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.fileName}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : null}
      {message === null ? null : (
        <p className="drop-note" role="status" aria-live="polite">
          {message}
        </p>
      )}
    </section>
  );
}
