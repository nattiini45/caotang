/**
 * The writing shell — ui-modules §1. A toolbar on top; a left rail with the binder, codex, activity and findings
 * tab slots; the centre (the editor, or the corkboard for a container); the inspector on the right. Focus mode
 * hides both rails and keeps the centre exactly as it was.
 *
 * This file owns only ephemeral UI state (which tab, which centre, focus mode, card size, the row being renamed,
 * the delete being confirmed, the export dialog, the theme, the status line). Project and view state live in the
 * session, and every change to them is a dispatch.
 */
/* lingui-set comment="Interpolated values: backup, badge, descendants, documents, error, file, folder, folderName, kind, label, shortcut, storageSentence, title, words" */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { plural, select, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { isolate } from '@caotang/i18n';
import { pictureStorageReport, type ProjectState, type RuntimeStore, type SweepCandidate } from '@caotang/store';

import type { AgentController } from '../app/agent.js';
import { childrenOf, newDocumentRefusalText, newItemParent, nodeById, summarizeSubtree } from '../app/binder-model.js';
import { downloadBytes } from '../app/download.js';
import { folderAccessSupported, folderIsEmpty, pickDirectory, type DirectoryHandleLike } from '../app/fs-access.js';
import { isImeEnter, keyboardLayoutStore, resolveKey, shortcutLabel } from '../app/keymap.js';
import { exportBundle, noteLeaveSuggestion, saveFolder, type FolderFileChange, type FolderSaveAnswers } from '../app/lifecycle.js';
import type { ZoomLevel } from '../app/corkboard-model.js';
import type { AppServices } from '../app/services.js';
import { contextConfigOf } from '../app/settings.js';
import type { PendingFailure } from '../app/pending-journal.js';
import type { ProjectSession, SaveState } from '../app/session.js';
import { crossedTarget, localDayOfIso, targetProgress, wordsWrittenToday } from '../app/session-progress.js';
import { focusBinderFilter } from './BinderFilters.js';
import { dismissBannerForVisit, durabilitySentence, isBannerDismissedForVisit } from '../app/storage.js';
import { evictionVariantApplies, type EvictionFacts } from '../app/picture-notices.js';
import { ExportSweepOffer, sweepBeforeExport, sweepOfferBeforeExport } from '../media/PictureStorage.js';
import { PictureNotices } from './PictureNotices.js';
import { saveStateWords } from '../app/integrity-model.js';
import { activeTheme, applyTheme, rememberTheme, type Theme } from '../app/theme.js';
import type { StartIntent } from '../App.js';
import { Binder, type CenterMode } from './Binder.js';
import { CodexPanel } from './CodexPanel.js';
import { mediaKindOf, mediaPortsFor, mediaViewFor } from '../media/index.js';
import type { PictureFocusRequest } from '../media/picture-board-model.js';

import { Corkboard } from './Corkboard.js';
import { LazyBoundary, lazyView } from './lazy-view.js';
import type { TimelineFocusRequest } from '../app/timeline-model.js';
import { clearTray, pendingRows } from '../app/timeline-tray.js';
import { EditorPane, type RevealRequest } from './EditorPane.js';
import { BinderFooter } from './BinderFooter.js';
import { whenAgent } from '../app/agent-registry.js';
import { openFindingCount } from '../app/findings-model.js';
import type { ExportSelection } from './ExportDialog.js';
import { openDialog } from './dialog-requests.js';
import { ProjectPanel } from './ProjectPanel.js';
import { SkillsPanel } from './SkillsPanel.js';
import { VocabularyEditor } from './VocabularyEditor.js';
import { Inspector } from './Inspector.js';
import { Settings, type SettingsSection } from './LazySettings.js';
import { inlineKey } from '../i18n/direction.js';
import { StaleTabNotice } from './StaleTabNotice.js';
import {
  clearSelection,
  createNode,
  createdNodeId,
  deleteNode,
  explain,
  liveSelection,
  selectNode,
} from './actions.js';
import { ChoiceDialog, ConfirmDialog, ReportContext, useSession, type StatusMessage } from './shared.js';

type RailTab = 'binder' | 'codex' | 'activity' | 'findings';

/** The rail's tabs in the order the arrow keys walk them (WAI-ARIA tabs). */
const RAIL_TABS: readonly RailTab[] = ['binder', 'codex', 'activity', 'findings'];
/** The centre views, in the order the arrow keys walk the radio group. */
const CENTER_VIEWS: readonly CenterMode[] = ['editor', 'corkboard', 'timeline', 'pictures'];

/** The timeline is its own chunk: the view and its package are fetched when the writer first opens it. */
const PictureBoard = lazyView(() => import('../media/PictureBoard.js').then((module) => ({ default: module.PictureBoard })));
const TimelineView = lazyView(() => import('./timeline/TimelineView.js').then((module) => ({ default: module.TimelineView })));
const AgentPanel = lazyView(() => import('./AgentPanel.js').then((module) => ({ default: module.AgentPanel })));
const ExportDialog = lazyView(() => import('./ExportDialog.js').then((module) => ({ default: module.ExportDialog })));
// The Findings and Activity tabs carry the coherence review and the agent's turn reports, which the first screen does not read.
const FindingsPanel = lazyView(() => import('./FindingsPanel.js').then((module) => ({ default: module.FindingsPanel })));
const ActivityPanel = lazyView(() => import('./ActivityPanel.js').then((module) => ({ default: module.ActivityPanel })));

/** The id of a rail tab, which its tabpanel names itself by (`aria-labelledby`). */
function railTabId(tab: RailTab): string {
  return `rail-tab-${tab}`;
}

/**
 * The item an arrow, Home or End key moves to from `current`, or `null` for any other key. Arrows wrap at both ends, as the
 * WAI-ARIA tab and radio patterns have them, and Home and End go to the first and last item.
 */
function keyStep<T>(items: readonly T[], current: T, pressed: string): T | null {
  const at = items.indexOf(current);
  if (at === -1) return null;
  const key = inlineKey(pressed);
  if (key === 'ArrowRight' || key === 'ArrowDown') return items[(at + 1) % items.length] ?? null;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return items[(at - 1 + items.length) % items.length] ?? null;
  if (key === 'Home') return items[0] ?? null;
  if (key === 'End') return items[items.length - 1] ?? null;
  return null;
}

/**
 * The one title in rename mode, and where it is shown. The binder and the corkboard can both
 * show the same node, so a rename must name its surface: two fields for one node take focus
 * from each other, and each blur commits and closes the other.
 */
export interface Renaming {
  readonly nodeId: string;
  readonly surface: 'binder' | 'card';
}

export interface WorkspaceProps {
  readonly session: ProjectSession;
  readonly store: RuntimeStore;
  readonly services: AppServices;
  readonly onHome: () => void;
  /** Said once when the project opens: a copy was made, or the file carried things Caotang keeps. */
  readonly notice?: string | null;
  /** A demo run the first-run card started: the agent panel submits it once. */
  readonly startIntent?: StartIntent | null;
  /**
   * A folder to save this project into as it opens: the writer chose to keep this browser's version of a folder's project (lifecycle
   * `answerFolderDiffers`). The save is the folder save, so a document it would write over is asked about first.
   */
  readonly saveToFolder?: DirectoryHandleLike | null;
}

export function Workspace({
  session,
  store,
  services,
  onHome,
  notice = null,
  startIntent = null,
  saveToFolder: pendingFolder = null,
}: WorkspaceProps): ReactNode {
  useSession(session);
  const { state, view } = session;
  // The printed-key layout behind the shortcut labels the toolbar shows (keymap.ts; the same subscription as EditorPane).
  const keyboardLayout = useSyncExternalStore(keyboardLayoutStore.subscribe, keyboardLayoutStore.snapshot);
  const [rail, setRail] = useState<RailTab>('binder');
  const [center, setCenterNow] = useState<CenterMode>('editor');
  /** Where the writer asked to go while proposed timeline changes were waiting, until they have answered the question that asks. */
  const [leaving, setLeaving] = useState<CenterMode | 'home' | null>(null);
  const centerNow = useRef(center);
  useEffect(() => {
    centerNow.current = center;
  }, [center]);
  const setCenter = useCallback(
    (next: CenterMode): void => {
      if (centerNow.current === 'timeline' && next !== 'timeline' && pendingRows(session.projectId) > 0) setLeaving(next);
      else setCenterNow(next);
    },
    [session],
  );
  const [timelineFocus, setTimelineFocus] = useState<TimelineFocusRequest | null>(null);
  const [pictureFocus, setPictureFocus] = useState<PictureFocusRequest | null>(null);
  const [findingsFocus, setFindingsFocus] = useState<{ readonly factGroup: string; readonly serial: number } | null>(null);
  const focusSerial = useRef(0);
  const [focusMode, setFocusMode] = useState(false);
  // The filter chord asks for the field to be focused. The request is a counter, so each chord press is a new request, and
  // the effect below focuses the field once the binder rail has rendered.
  const [filterFocusRequest, setFilterFocusRequest] = useState(0);
  const [zoom, setZoom] = useState<ZoomLevel>('M');
  const [renaming, setRenaming] = useState<Renaming | null>(null);
  const [askingDelete, setAskingDelete] = useState<string | null>(null);
  /** Where focus goes once the asked delete is confirmed (see `askDelete`). Read only from the handlers, never rendered. */
  const deletePlace = useRef<DeletePlace | null>(null);
  const [exporting, setExporting] = useState(false);
  const [focusDocId, setFocusDocId] = useState<string | null>(null);
  const [reveal, setReveal] = useState<RevealRequest | null>(null);
  const [codexFocus, setCodexFocus] = useState<{ readonly entryId: string; readonly serial: number } | null>(null);
  const [theme, setTheme] = useState<Theme>(() => activeTheme());
  const [message, setMessage] = useState<StatusMessage | null>(
    notice === null ? null : { text: notice, tone: 'info' },
  );
  const [agentOpen, setAgentOpen] = useState(startIntent !== null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(() => isBannerDismissedForVisit());
  const [explainStorage, setExplainStorage] = useState(false);
  /** The unused picture files a sweep would remove, offered before an export, until the writer has answered. */
  const [sweepOffer, setSweepOffer] = useState<readonly SweepCandidate[] | null>(null);
  const [storedToday, setStoredToday] = useState(0);
  /** A save to the folder that the folder's state stopped, with the reason, until the writer has answered the question it asks. */
  const [folderOffer, setFolderOffer] = useState<FolderOffer | null>(null);
  /** The name of a folder "Save as a new folder…" refused because it is not empty, until the writer chooses again or cancels. */
  const [notEmptyFolder, setNotEmptyFolder] = useState<string | null>(null);
  // One agent controller per open project: its turns, its pending decision and its ghost belong to this session.
  // The budgets are read at each turn, so a change in Settings › Context applies to the next one (context-assembly §3).
  // The controller is its own download (the agent loop, the tool table and the task queue): the editor and the rails are drawn without
  // it, and it is made as soon as this project is open, so a queued background task resumes and a draft has somewhere to land.
  const [agent, setAgent] = useState<AgentController | null>(null);
  useEffect(() => {
    let alive = true;
    let made: AgentController | null = null;
    void import('../app/agent.js').then(({ AgentController: Controller }) => {
      const controller = new Controller(
        session,
        services.providers,
        () => contextConfigOf(services.settings.current().context),
        () => services.settings.current().agent.loadEveryTool,
        {},
        () => services.settings.current().agent,
      );
      if (alive) {
        made = controller;
        controller.attach();
        setAgent(controller);
      }
    });
    return () => {
      alive = false;
      made?.detach();
      setAgent(null);
    };
  }, [session, services.providers, services.settings]);
  /** Starts a turn for intent once the controller has loaded: the request waits for it, so a click before the download is not lost. */
  const submitToAgent = useCallback((intent: string): void => {
    void whenAgent(session).then((controller) => controller.submit(intent));
  }, [session]);
  // Today's stored words, read now and every few seconds: a sitting that ends elsewhere still counts toward the target.
  useEffect(() => {
    let alive = true;
    const read = (): void => {
      void wordsWrittenToday(store, Date.now()).then((words) => {
        if (alive) setStoredToday(words);
      });
    };
    read();
    const timer = window.setInterval(read, 3_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [store, session]);
  const settingsNow = useSyncExternalStore(services.settings.subscribe, services.settings.current);
  const target = targetProgress(storedToday + session.sittingWords(), settingsNow.session.dailyTargetWords);
  // Focus mode hides the rails only when the writer's Writing setting says so (ui-modules §5.2). Off, focus mode leaves them shown.
  const hideRails = focusMode && settingsNow.editor.focusModeHideRails;
  const durability = session.durability();
  const pictureStorage = pictureStorageReport(state);
  const pictureFacts: EvictionFacts = {
    persisted: durability.persisted,
    folderAttached: session.assetsInFolder(),
    pictureCount: pictureStorage.recordCount,
    pictureBytes: pictureStorage.totalBytes,
  };
  // A project with pictures and no folder gets the picture-aware banner (PictureNotices) in place of the general one.
  const showStorageBanner = durability.persisted === false && !bannerDismissed && !evictionVariantApplies(pictureFacts);
  // A whole sentence used as a value in the banner's message; a name keeps it out of a positional `{0}`.
  const storageSentence = durabilitySentence(durability);
  const sample = settingsNow.sampleProjectIds.includes(session.projectId);

  const report = useCallback((next: StatusMessage) => setMessage(next), []);
  // The typing not yet saved cannot be kept in this browser's storage (pending-journal.ts): said once each time it starts, so the writer knows
  // that only the autosave and the leave prompt stand between a reload and the last words.
  useEffect(() => {
    let told: PendingFailure | null = null;
    return session.subscribe(() => {
      const failure = session.pendingFailure();
      if (failure !== null && failure !== told) {
        report({
          text:
            failure === 'too-large'
              ? t`The unsaved text is too large to keep a spare copy in this browser, so a reload in the next moment could lose it.`
              : t`This browser would not keep a spare copy of the unsaved text, so a reload in the next moment could lose it.`,
          tone: 'info',
        });
      }
      told = failure;
    });
  }, [session, report]);
  const clearFocus = useCallback(() => setFocusDocId(null), []);
  const clearReveal = useCallback(() => setReveal(null), []);
  /**
   * Focus mode on or off, from the Focus button or the chord. With the Writing setting off, focus mode keeps the rails, so
   * turning it on says so in the status line: otherwise the pressed Focus button is the only sign that nothing was hidden.
   */
  const toggleFocus = (): void => {
    const on = !focusMode;
    setFocusMode(on);
    if (on && !settingsNow.editor.focusModeHideRails) {
      // The wording, with the setting's place a link that opens it.
      report({
        text: t`Focus mode is on. The binder and inspector stay open, as set in `,
        tone: 'info',
        link: { label: t`Settings › Writing`, after: '.', onClick: () => setSettingsSection('writing') },
      });
    }
  };
  // The editor's quick-set saves the daily target as the app setting, not as a bus command (goals-progress §4). A refusal is said.
  const saveTarget = useCallback(
    (words: number): void => {
      void services.settings.update({ session: { dailyTargetWords: words } }).then((error) => {
        if (error !== null) report({ text: error, tone: 'error' });
      });
    },
    [services.settings, report],
  );

  // goals-progress §2.1: crossing today's target gives one status line, once a day, and never a nudge. The day is kept in
  // memory only, so a reload on the same day may give it again.
  const metRecord = useRef<{ readonly met: boolean; readonly day: string | null }>({ met: target.met, day: null });
  useEffect(() => {
    const day = localDayOfIso(new Date().toISOString()) ?? '';
    const previous = metRecord.current;
    const crossed = crossedTarget(previous, { met: target.met, day });
    metRecord.current = { met: target.met, day: crossed ? day : previous.day };
    if (crossed) report({ text: t`Today’s target is met.`, tone: 'info' });
  }, [target.met, report]);
  const selected = liveSelection(state, view.selection);
  const selectedNode = selected === null ? undefined : nodeById(state, selected);
  // A media document (a screenplay scene) has its own view in the centre, so the prose editor is given no document for it.
  const activeDocNode = view.activeDocId === null ? undefined : nodeById(state, view.activeDocId);
  const activeDoc = activeDocNode?.type === 'document' && mediaKindOf(activeDocNode) === null ? view.activeDocId : null;
  // A media node shows its own view in the centre (media/README.md): a screenplay scene or a dialogue container in place of
  // the editor, and a storyboard in place of the corkboard, because the storyboard's board is the corkboard variant in
  // shot mode (storyboard.md §3.1). The generic corkboard therefore draws only when no media view does.
  // A shot shows its storyboard: the board is where a shot is edited, so selecting a card keeps the board in the centre.
  const shotBoard =
    selectedNode?.type === 'shot' && selectedNode.parentId !== null ? nodeById(state, selectedNode.parentId) : undefined;
  const mediaNode =
    selectedNode !== undefined && mediaKindOf(selectedNode) !== null
      ? selectedNode
      : shotBoard !== undefined && mediaKindOf(shotBoard) === 'storyboard'
        ? shotBoard
        : undefined;
  const mediaView =
    mediaNode !== undefined && center !== 'timeline' && center !== 'pictures' && (center === 'editor' || mediaKindOf(mediaNode) === 'storyboard')
      ? mediaViewFor(mediaNode, {
          session,
          ports: mediaPortsFor(session),
          reveal,
          onRevealHandled: clearReveal,
          zoom,
          onZoom: setZoom,
          // The derive actions of the scene and the empty board open the agent drawer and send the request (storyboard.md §4). This is
          // written inline because `runAgentIntent` is declared below this view, and the view is built here.
          onAgentIntent: (intent) => {
            setAgentOpen(true);
            submitToAgent(intent);
          },
        })
      : null;
  const undoLabel = session.undoLabel();
  const saveState = session.saveState();
  // The export dialog compiles the item the binder has selected, unless that is a section (then it is the whole manuscript).
  const exportSelection: ExportSelection | null =
    selectedNode === undefined || selectedNode.id === 'manuscript' || selectedNode.id === 'research' || selectedNode.id === 'root'
      ? null
      : { id: selectedNode.id, title: selectedNode.title };

  /** A rename-mode setter for one surface: the binder, or a corkboard card. */
  const renameOn = (surface: Renaming['surface']) => (nodeId: string | null) =>
    setRenaming(nodeId === null ? null : { nodeId, surface });

  /** Create a node under `parentId` from the binder or the shell, select it, and put its title in rename mode. */
  const createAndEdit = (parentId: string, type: 'folder' | 'document'): void => {
    const refused = type === 'document' ? newDocumentRefusalText(parentId) : undefined;
    if (refused !== undefined) {
      report({ text: refused, tone: 'error' });
      return;
    }
    const outcome = createNode(session, parentId, type);
    const id = createdNodeId(outcome);
    if (!outcome.ok) {
      report({ text: explain(outcome.error), tone: 'error' });
      return;
    }
    if (id === undefined) return;
    selectNode(session, id);
    if (type === 'document') setCenter('editor');
    setRenaming({ nodeId: id, surface: 'binder' });
  };

  const undoNow = (): void => {
    void session.undoLast().then((done) => {
      if (done) return;
      const detail = session.undoErrorMessage();
      report(detail ? { text: detail, tone: 'error' } : { text: t`There is nothing to undo.`, tone: 'info' });
    });
  };

  const openSelected = (): void => {
    if (selectedNode?.type !== 'document') return;
    // A media document opens in its own view, so the centre switches to the editor's mode and the prose editor is not asked for it.
    if (mediaKindOf(selectedNode) !== null) {
      setCenter('editor');
      return;
    }
    session.dispatch('view.setActiveDoc', { docId: selectedNode.id });
    setCenter('editor');
    setFocusDocId(selectedNode.id);
  };

  /**
   * A document opened from somewhere other than the binder (the codex's appearance view): selected and shown, not focused.
   * With an offset, the editor also reveals that point, which is where the entry first appears (codex-panels §1).
   */
  const openDocument = useCallback(
    (docId: string, offset?: number): void => {
      selectNode(session, docId);
      setCenter('editor');
      if (offset !== undefined) setReveal({ docId, from: offset, to: offset });
    },
    [session, setCenter],
  );

  /** "Open in Findings" from the timeline: the Findings rail opens on the fact group, which the panel scrolls to and focuses. */
  const openInFindings = useCallback((factGroup: string): void => {
    setRail('findings');
    focusSerial.current += 1;
    setFindingsFocus({ factGroup, serial: focusSerial.current });
  }, []);

  /** "Show on timeline" from a finding: the timeline replaces the centre and moves to the scenes the finding cites. */
  const showOnTimeline = useCallback((docIds: readonly string[], findingId: string): void => {
    setCenter('timeline');
    focusSerial.current += 1;
    setTimelineFocus({ docIds, findingId, serial: focusSerial.current });
  }, [setCenter]);

  /** "Open on the board" from the Inspector's picture strip: the picture board replaces the centre with that picture's details open. */
  const openPictureBoard = useCallback((assetId: string): void => {
    setCenter('pictures');
    focusSerial.current += 1;
    setPictureFocus({ assetId, serial: focusSerial.current });
  }, [setCenter]);

  /** A placement's "Go to it" on the board: the binder item is selected, and a document opens in the editor. */
  const openPictureNode = useCallback(
    (nodeId: string): void => {
      selectNode(session, nodeId);
      setCenter(nodeById(session.state, nodeId)?.type === 'document' ? 'editor' : 'corkboard');
    },
    [session, setCenter],
  );

  /** An empty state's next step (ui-modules §0.3): the agent panel opens, and the controller runs the request through its usual path. */
  const runAgentIntent = useCallback(
    (intent: string): void => {
      setAgentOpen(true);
      submitToAgent(intent);
    },
    [submitToAgent],
  );

  /** A mention chip's click: the codex tab shows the entry (codex.md §8). */
  const openCodexEntry = useCallback((entryId: string): void => {
    setRail('codex');
    setCodexFocus((previous) => ({ entryId, serial: (previous?.serial ?? 0) + 1 }));
  }, []);

  /** A quoted passage of a finding: its document opens in the editor, and the passage is scrolled to and selected there. */
  const revealPassage = useCallback(
    (docId: string, from: number, to: number): void => {
      openDocument(docId);
      setReveal({ docId, from, to });
    },
    [openDocument],
  );

  // The app-wide chords. The handler is read through a ref, so one listener serves every render
  // and always sees the current selection, without re-subscribing on each change.
  const onKey = (event: KeyboardEvent): void => {
    const target = event.target;
    const inTextField =
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLInputElement ||
      (target instanceof HTMLElement && target.isContentEditable);
    const action = resolveKey(
      {
        key: event.key,
        code: event.code,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        shift: event.shiftKey,
        alt: event.altKey,
        altGraph: event.getModifierState('AltGraph'),
        composing: isImeEnter(event),
      },
      { inTextField, inBinder: false },
    );
    if (action === null) return;
    switch (action) {
      case 'undo':
        event.preventDefault();
        undoNow();
        return;
      case 'focus-mode':
        event.preventDefault();
        toggleFocus();
        return;
      case 'focus-filter':
        // The filter field lives in the binder rail, which focus mode hides and the other rails replace. The chord shows the
        // binder rail, and the effect below focuses the field once that rail has rendered.
        event.preventDefault();
        setFocusMode(false);
        setRail('binder');
        setFilterFocusRequest((count) => count + 1);
        return;
      case 'new-document':
        event.preventDefault();
        createAndEdit(newItemParent(state, selected), 'document');
        return;
      case 'open-in-editor':
        event.preventDefault();
        openSelected();
        return;
      default:
        return;
    }
  };

  // A filter chord focuses the field after the binder rail has rendered (see `filterFocusRequest`). The first render makes no request.
  useEffect(() => {
    if (filterFocusRequest > 0) focusBinderFilter();
  }, [filterFocusRequest]);

  // The rail's tabs and the centre's radio group: arrows (and Home and End) move the selection and its focus together.
  const onRailTabKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const next = keyStep(RAIL_TABS, rail, event.key);
    if (next === null) return;
    event.preventDefault();
    setRail(next);
    document.getElementById(railTabId(next))?.focus();
  };
  const onCenterKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const next = keyStep(CENTER_VIEWS, center, event.key);
    if (next === null) return;
    event.preventDefault();
    setCenter(next);
    document.getElementById(`center-${next}`)?.focus();
  };

  const keyHandler = useRef(onKey);
  useEffect(() => {
    keyHandler.current = onKey;
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => keyHandler.current(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  // A dirty session warns before the tab goes away (project-format §4: a flush is not guaranteed), and so does a background task that is
  // still being drafted: it runs only while the project is open in this tab.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent): void => {
      if (session.saveState() === 'saved' && !(agent?.tasksWorking() ?? false)) return;
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [session, agent]);

  const doomed = askingDelete === null ? undefined : summarizeSubtree(state, askingDelete);

  /**
   * A delete is asked from the binder or the corkboard. The dialog returns focus to what opened it, and that row or card is the one
   * the delete removes, so focus would fall to the page. The place to go is taken here, before the delete: the sibling that takes
   * the removed node's place, else its parent. The surface is the one the request came from.
   */
  const askDelete = (nodeId: string): void => {
    const surface: DeleteSurface = document.activeElement?.closest('.corkboard') ? 'corkboard' : 'binder';
    deletePlace.current = { surface, successor: successorOf(state, nodeId) };
    setAskingDelete(nodeId);
  };

  const confirmDelete = (): void => {
    if (askingDelete === null) return;
    const id = askingDelete;
    const title = doomed?.title ?? t`the item`;
    const place = deletePlace.current;
    deletePlace.current = null;
    const outcome = deleteNode(session, id);
    setAskingDelete(null);
    if (!outcome.ok) {
      report({ text: explain(outcome.error), tone: 'error' });
      return;
    }
    // A selection that pointed into the removed subtree is cleared rather than left dangling.
    if (selected !== null && nodeById(session.state, selected) === undefined) clearSelection(session);
    setRenaming(null);
    if (place !== null) focusAfterDelete(place);
    report({ text: t`Deleted “${{ title: isolate(title) }}”. Ctrl+Z restores it right after.`, tone: 'info' });
  };

  const exportWith = (before: string | null): void => {
    void (async () => {
      try {
        const bundle = await exportBundle(store, session);
        downloadBytes(bundle.bytes, bundle.filename);
        report({ text: [...(before === null ? [] : [before]), t`Exported ${{ file: bundle.filename }}.`, ...bundle.notices].join(' '), tone: 'info' });
      } catch (error) {
        report({ text: t`The bundle could not be made: ${{ error: errorText(error) }}`, tone: 'error' });
      }
    })();
  };
  const exportNow = (): void => exportWith(null);

  /**
   * *Export bundle* from the toolbar and the picture notices: the unused picture files are offered for a sweep first (pictures.md §6.5),
   * and the export goes straight ahead when there are none, or when the sweep cannot be checked. The save indicator's and the stale
   * tab's exports are rescues and never ask anything.
   */
  const exportBundleOffering = (): void => {
    void sweepOfferBeforeExport(session).then((candidates) => {
      if (candidates === null) exportNow();
      else setSweepOffer(candidates);
    });
  };
  const exportAfterSweep = (): void => {
    setSweepOffer(null);
    void sweepBeforeExport(session).then((swept) => {
      if (swept.proceed) exportWith(swept.text);
      else report({ text: swept.text, tone: 'error' });
    });
  };

  /** The activity log and the agent's turns as one Markdown file (agent-harness §5, command-bus §8). */
  const exportActivity = async (): Promise<void> => {
    const { activityMarkdown } = await import('../app/activity-model.js');
    const markdown = activityMarkdown({
      title: state.manifest.project.name,
      entries: session.log.entries(),
      turns: agent?.snapshot().turns ?? [],
    });
    const stem = state.manifest.project.name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
    const name = `${stem === '' ? 'project' : stem}${'-activity' + '.md'}`;
    downloadBytes(new TextEncoder().encode(markdown), name, 'text/markdown');
    report({ text: t`Exported the activity log as ${{ file: name }}.`, tone: 'info' });
  };

  /**
   * Writes the project into a folder with the answers the writer has given so far. A refusal is not written over: it becomes a
   * question, and the writer's answer is the next call (lifecycle `saveFolder`).
   */
  const writeFolder = (folder: DirectoryHandleLike, answers: FolderSaveAnswers): void => {
    void (async () => {
      try {
        const outcome = await saveFolder(session, folder, answers);
        if (outcome.kind === 'refused') {
          setFolderOffer({
            folder,
            reason: outcome.reason,
            files: outcome.files,
            partial: outcome.partial === true,
            after: outcome.after === true,
            removed: outcome.removed === true,
            answers,
          });
          return;
        }
        setFolderOffer(null);
        // From here on the session's exports are written into this folder too (exports.ts).
        await session.attachFolder(folder);
        report({
          text:
            outcome.backup === undefined
              ? t`Saved the project to the folder “${{ folder: isolate(folder.name) }}”. Exports go there from now on.`
              : t`Saved the project to the folder “${{ folder: isolate(folder.name) }}”. What it replaced is kept in ${{ backup: outcome.backup }}. Exports go there from now on.`,
          tone: 'info',
        });
      } catch (error) {
        report({ text: t`The folder could not be saved: ${{ error: errorText(error) }}`, tone: 'error' });
      }
    })();
  };

  // The save the writer asked for as the project opened ("Keep this browser's version and save it to the folder"), made once. The
  // handler is read through a ref, as the chords are, so the effect runs for the folder alone.
  const writeFolderNow = useRef(writeFolder);
  useEffect(() => {
    writeFolderNow.current = writeFolder;
  });
  const pendingSaved = useRef<DirectoryHandleLike | null>(null);
  useEffect(() => {
    if (pendingFolder === null || pendingSaved.current === pendingFolder) return;
    pendingSaved.current = pendingFolder;
    writeFolderNow.current(pendingFolder, {});
  }, [pendingFolder]);

  const saveToFolder = (): void => {
    void (async () => {
      try {
        const folder = await pickDirectory('readwrite');
        if (folder === null) return;
        writeFolder(folder, {});
      } catch (error) {
        report({ text: t`The folder could not be saved: ${{ error: errorText(error) }}`, tone: 'error' });
      }
    })();
  };

  /**
   * "Save as a new folder…": the writer picks a folder, which must be empty, and the project is saved there through the same folder save
   * (`writeFolder`, lifecycle `saveFolder`), after which the session's folder is the new one. A folder that holds anything is refused
   * with a sentence, and the writer can choose again or cancel. The picker opens from the click, which is the gesture it needs.
   */
  const saveAsNewFolder = (): void => {
    setFolderOffer(null);
    setNotEmptyFolder(null);
    void (async () => {
      try {
        const folder = await pickDirectory('readwrite');
        if (folder === null) return;
        if (!(await folderIsEmpty(folder))) {
          setNotEmptyFolder(folder.name);
          return;
        }
        writeFolder(folder, {});
      } catch (error) {
        report({ text: t`The folder could not be saved: ${{ error: errorText(error) }}`, tone: 'error' });
      }
    })();
  };

  /** The writer's yes to the question a folder save asked: the answer that question needs, and the save again. */
  const answerFolderQuestion = (): void => {
    if (folderOffer === null) return;
    const { folder, reason, answers } = folderOffer;
    setFolderOffer(null);
    writeFolder(folder, reason === 'locked' ? { ...answers, lockConfirmed: true } : { ...answers, overwriteConfirmed: true });
  };

  const toggleTheme = (): void => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    rememberTheme(next);
    setTheme(next);
  };

  const leaveNow = (): void => {
    void (async () => {
      await session.settle();
      if (session.saveState() === 'conflict') {
        report({
          text: t`This tab cannot save: another tab has newer text for this project. Export a backup to keep the words in this tab.`,
          tone: 'error',
        });
        return;
      }
      if (session.saveState() === 'failed') {
        report({
          text: t`Some changes have not reached browser storage yet, so the project stays open. Export a bundle to keep a copy, then leave.`,
          tone: 'error',
        });
        return;
      }
      // Leaving with changes the writer has no copy of is not held up: the projects screen suggests a bundle, once (project-format §8).
      if (session.changedSinceExport()) {
        noteLeaveSuggestion({ projectId: session.projectId, name: state.manifest.project.name });
      }
      onHome();
    })();
  };

  /** Leaving the project with proposed timeline changes asks first (timeline.md §4.4). */
  const leave = (): void => {
    if (pendingRows(session.projectId) > 0) setLeaving('home');
    else leaveNow();
  };
  const confirmLeaving = (): void => {
    const next = leaving;
    clearTray(session.projectId);
    setLeaving(null);
    if (next === 'home') leaveNow();
    else if (next !== null) setCenterNow(next);
  };

  return (
    <ReportContext.Provider value={report}>
      <div className={`workspace${hideRails ? ' is-focus' : ''}`}>
        <header className="toolbar">
          <div className="toolbar-start">
            <button type="button" className="button is-quiet" onClick={leave}>
              <Trans>Projects</Trans>
            </button>
            <h1 className="project-name">
              {/* The name opens the project panel, where the title, author, language, ISBN and cover are set. */}
              <button
                type="button"
                className="project-name-button"
                title={t`Project details: title, author, language, ISBN and cover`}
                onClick={() => openDialog({ kind: 'project' })}
              >
                {state.manifest.project.name}
              </button>
            </h1>
          </div>
          <div className="toolbar-end">
            <button
              type="button"
              className="button"
              disabled={undoLabel === null}
              title={undoLabel === null ? t`Nothing to undo` : t`Undo: ${{ label: undoLabel }}`}
              onClick={undoNow}
            >
              <Trans>Undo</Trans>
            </button>
            <button
              type="button"
              className="button"
              aria-pressed={focusMode}
              title={t`Focus mode (${{ shortcut: shortcutLabel('focus-mode', keyboardLayout) }})`}
              onClick={toggleFocus}
            >
              <Trans>Focus</Trans>
            </button>
            <button type="button" className="button" title={t`Reusable writing instructions for the agent`} onClick={() => openDialog({ kind: 'skills' })}>
              <Trans>Skills</Trans>
            </button>
            <button type="button" className="button" onClick={() => setExporting(true)}>
              <Trans>Compile…</Trans>
            </button>
            <button type="button" className="button" onClick={exportBundleOffering}>
              <Trans>Export bundle</Trans>
            </button>
            {folderAccessSupported() ? (
              <button type="button" className="button" onClick={saveToFolder}>
                <Trans>Save to folder</Trans>
              </button>
            ) : null}
            <button type="button" className="button" onClick={() => setSettingsSection('providers')} data-testid="open-settings">
              <Trans>Settings</Trans>
            </button>
            <button
              type="button"
              className="button"
              aria-label={theme === 'dark' ? t`Light theme` : t`Dark theme`}
              title={theme === 'dark' ? t`Use the light theme` : t`Use the dark theme`}
              onClick={toggleTheme}
            >
              {theme === 'dark' ? <Trans>Light theme</Trans> : <Trans>Dark theme</Trans>}
            </button>
            <SaveIndicator state={saveState} onExport={exportNow} />
          </div>
        </header>

        {hideRails ? null : (
          <nav className="rail" aria-label={t`Project panels`}>
            <div role="tablist" aria-label={t`Panels`} className="rail-tabs" onKeyDown={onRailTabKey}>
              <RailTabButton tab="binder" current={rail} label={t`Binder`} onSelect={setRail} />
              <RailTabButton tab="codex" current={rail} label={t`Codex`} onSelect={setRail} />
              <RailTabButton tab="activity" current={rail} label={t`Activity`} onSelect={setRail} />
              <RailTabButton
                tab="findings"
                current={rail}
                label={t`Findings`}
                badge={openFindingCount(session.coherenceFile())}
                onSelect={setRail}
              />
            </div>
            <div role="tabpanel" id="rail-panel" aria-labelledby={railTabId(rail)} className="rail-panel">
              {rail === 'binder' ? (
                <>
                  <Binder
                    session={session}
                    renaming={renaming?.surface === 'binder' ? renaming.nodeId : null}
                    onRename={renameOn('binder')}
                    onAskDelete={askDelete}
                    onShowCenter={setCenter}
                    onFocusSynopsis={() => focusSoon('#inspector-synopsis')}
                    onAgentIntent={runAgentIntent}
                  />
                  <BinderFooter session={session} runtime={store} target={target} />
                </>
              ) : rail === 'codex' ? (
                <CodexPanel session={session} onOpenDocument={openDocument} focus={codexFocus} onAgentIntent={runAgentIntent} />
              ) : rail === 'findings' ? (
                <LazyBoundary label={t`Findings`}>
                  <FindingsPanel
                    session={session}
                    onReveal={revealPassage}
                    settings={settingsNow.coherence}
                    providers={services.providers}
                    onOpenAgent={() => setAgentOpen(true)}
                    onOpenDocument={openDocument}
                    focusGroup={findingsFocus}
                    onGroupFocused={() => setFindingsFocus(null)}
                    onShowOnTimeline={showOnTimeline}
                  />
                </LazyBoundary>
              ) : (
                <LazyBoundary label={t`Activity`}>
                  <ActivityPanel
                    session={session}
                    onExport={() => void exportActivity()}
                  />
                </LazyBoundary>
              )}
            </div>
          </nav>
        )}

        <main className="center">
          <div role="radiogroup" aria-label={t`Centre view`} className="center-switch" onKeyDown={onCenterKey}>
            <button
              type="button"
              id="center-editor"
              role="radio"
              aria-checked={center === 'editor'}
              tabIndex={center === 'editor' ? 0 : -1}
              className="segmented-item"
              onClick={() => setCenter('editor')}
            >
              <Trans>Editor</Trans>
            </button>
            <button
              type="button"
              id="center-corkboard"
              role="radio"
              aria-checked={center === 'corkboard'}
              tabIndex={center === 'corkboard' ? 0 : -1}
              className="segmented-item"
              onClick={() => setCenter('corkboard')}
            >
              <Trans>Corkboard</Trans>
            </button>
            <button
              type="button"
              id="center-timeline"
              role="radio"
              aria-checked={center === 'timeline'}
              tabIndex={center === 'timeline' ? 0 : -1}
              className="segmented-item"
              onClick={() => setCenter('timeline')}
            >
              <Trans>Timeline</Trans>
            </button>
            <button
              type="button"
              id="center-pictures"
              role="radio"
              aria-checked={center === 'pictures'}
              tabIndex={center === 'pictures' ? 0 : -1}
              className="segmented-item"
              onClick={() => setCenter('pictures')}
            >
              <Trans>Pictures</Trans>
            </button>
          </div>
          {/* A status region is a div: ARIA does not allow the role on an aside. */}
          {showStorageBanner ? (
            <div className="storage-banner" role="status" aria-label={t`Browser storage`} data-testid="storage-banner">
              <div>
                <p>
                  <Trans>
                    Your words are kept in this browser, and the browser has not promised to keep them. Export a backup to keep a copy you
                    can open anywhere.
                  </Trans>
                </p>
                {explainStorage ? (
                  <p className="muted">
                    <Trans>
                      Browsers may remove stored data when a device runs short of space. Asking the browser to keep it lowers that risk, and
                      the browser has not granted it here. {storageSentence} A bundle is the copy that does not depend on the browser.
                    </Trans>
                  </p>
                ) : null}
              </div>
              <div className="storage-banner-actions">
                <button type="button" className="button" onClick={exportBundleOffering}>
                  <Trans>Export a backup</Trans>
                </button>
                <button type="button" className="button is-quiet" aria-expanded={explainStorage} onClick={() => setExplainStorage((on) => !on)}>
                  <Trans>Learn why</Trans>
                </button>
                <button
                  type="button"
                  className="button is-quiet"
                  onClick={() => {
                    dismissBannerForVisit();
                    setBannerDismissed(true);
                  }}
                >
                  <Trans>Dismiss</Trans>
                </button>
              </div>
            </div>
          ) : null}
          {showStorageBanner ? null : (
            <PictureNotices
              projectId={session.projectId}
              facts={pictureFacts}
              onExport={exportBundleOffering}
              {...(folderAccessSupported() ? { onSaveToFolder: saveToFolder } : {})}
            />
          )}
          {mediaView}
          {/* Kept mounted while the corkboard is shown, so the editor keeps its undo history and its place. */}
          <EditorPane
            session={session}
            docId={activeDoc}
            onNewDocument={() => createAndEdit(newItemParent(state, selected), 'document')}
            onNewChapter={
              newDocumentRefusalText(newItemParent(state, selected)) === undefined ? undefined : () => createAndEdit('manuscript', 'folder')
            }
            focusDocId={focusDocId}
            onFocusHandled={clearFocus}
            reveal={reveal}
            onRevealHandled={clearReveal}
            visible={center === 'editor' && mediaView === null}
            agent={agent}
            target={target}
            onSetTarget={saveTarget}
          />
          {center === 'corkboard' && mediaView === null ? (
            <Corkboard
              session={session}
              zoom={zoom}
              onZoom={setZoom}
              renaming={renaming?.surface === 'card' ? renaming.nodeId : null}
              onRename={renameOn('card')}
              onAskDelete={askDelete}
            />
          ) : null}
          {center === 'pictures' ? (
            <LazyBoundary label={t`the pictures`}>
              <PictureBoard
                session={session}
                focus={pictureFocus}
                onFocusHandled={() => setPictureFocus(null)}
                onOpenNode={openPictureNode}
              />
            </LazyBoundary>
          ) : null}
          {center === 'timeline' ? (
            <LazyBoundary label={t`the timeline`}>
              <TimelineView
                session={session}
                onOpenDocument={openDocument}
                onOpenFindings={openInFindings}
                focusRequest={timelineFocus}
                onFocusHandled={() => setTimelineFocus(null)}
              />
            </LazyBoundary>
          ) : null}
          {hideRails ? null : (
            <LazyBoundary label={t`the agent`}>
              {agent === null ? null : (
                <AgentPanel
                  session={session}
                  agent={agent}
                  startIntent={startIntent}
                  open={agentOpen}
                  onToggle={() => setAgentOpen((on) => !on)}
                  sample={sample}
                />
              )}
            </LazyBoundary>
          )}
        </main>

        {hideRails ? null : (
          <Inspector
            session={session}
            nodeId={selected}
            onOpenCodex={openCodexEntry}
            onAgentIntent={runAgentIntent}
            onOpenPicture={openPictureBoard}
          />
        )}

        {message ? (
          <div className={`status-line is-${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>
            <span>
              {message.text}
              {message.link ? (
                <>
                  <button type="button" className="status-link" onClick={message.link.onClick}>
                    {message.link.label}
                  </button>
                  {message.link.after}
                </>
              ) : null}
            </span>
            <button type="button" className="button is-quiet" onClick={() => setMessage(null)}>
              <Trans>Dismiss</Trans>
            </button>
          </div>
        ) : null}

        <ConfirmDialog
          open={doomed !== undefined}
          title={doomed ? t`Delete “${{ title: isolate(doomed.title) }}”?` : t`Delete?`}
          confirmLabel={t`Delete`}
          onCancel={() => setAskingDelete(null)}
          onConfirm={confirmDelete}
        >
          {doomed ? (
            <DeleteSummary descendants={doomed.descendants} documents={doomed.documents} words={doomed.words} />
          ) : null}
        </ConfirmDialog>

        <ConfirmDialog
          open={leaving !== null}
          title={t`Leave with proposed timeline changes?`}
          confirmLabel={t`Discard the changes and leave`}
          onCancel={() => setLeaving(null)}
          onConfirm={confirmLeaving}
        >
          <Trans>The timeline has proposed changes that are not applied. Nothing has been written to the project. Cancel keeps them in the tray; leaving discards them.</Trans>
        </ConfirmDialog>

        <ExportSweepOffer candidates={sweepOffer} onSweepThenExport={exportAfterSweep} onExport={() => { setSweepOffer(null); exportNow(); }} onCancel={() => setSweepOffer(null)} />

        {exporting ? (
          <LazyBoundary label={t`the export dialog`}>
            <ExportDialog session={session} selection={exportSelection} onClose={() => setExporting(false)} />
          </LazyBoundary>
        ) : null}
        <ProjectPanel session={session} />
        <SkillsPanel session={session} />
        <VocabularyEditor session={session} />


        <ConfirmDialog
          open={folderOffer !== null && !folderQuestion(folderOffer).newFolder}
          title={folderOffer ? folderQuestion(folderOffer).title : t`Save to the folder?`}
          confirmLabel={folderOffer ? folderQuestion(folderOffer).confirm : t`Save`}
          onCancel={() => setFolderOffer(null)}
          onConfirm={answerFolderQuestion}
        >
          {folderOffer && !folderQuestion(folderOffer).newFolder ? folderQuestion(folderOffer).body : null}
        </ConfirmDialog>
        {/* The questions that can be answered with a new folder: changed documents, another project, and an earlier save of this one. */}
        <ChoiceDialog
          open={folderOffer !== null && folderQuestion(folderOffer).newFolder}
          title={folderOffer ? folderQuestion(folderOffer).title : t`Save to the folder?`}
          choices={[
            { label: t`Save as a new folder…`, onChoose: saveAsNewFolder },
            { label: folderOffer ? folderQuestion(folderOffer).confirm : t`Save`, onChoose: answerFolderQuestion, danger: true },
          ]}
          onCancel={() => setFolderOffer(null)}
        >
          {folderOffer && folderQuestion(folderOffer).newFolder ? folderQuestion(folderOffer).body : null}
        </ChoiceDialog>
        <ChoiceDialog
          open={notEmptyFolder !== null}
          title={notEmptyQuestion(notEmptyFolder ?? '').title}
          choices={[{ label: t`Choose another folder…`, onChoose: saveAsNewFolder }]}
          onCancel={() => setNotEmptyFolder(null)}
        >
          {notEmptyQuestion(notEmptyFolder ?? '').body}
        </ChoiceDialog>

        {saveState === 'conflict' ? (
          <StaleTabNotice onExport={exportNow} onReload={() => window.location.reload()} />
        ) : null}

        {settingsSection !== null ? (
          <Settings
            services={services}
            session={session}
            store={store}
            initialSection={settingsSection}
            onClose={() => setSettingsSection(null)}
            onProvidersChanged={() => agent?.refresh()}
          />
        ) : null}
      </div>
    </ReportContext.Provider>
  );
}

function DeleteSummary({ descendants, documents, words }: { descendants: number; documents: number; words: number }): ReactNode {
  if (descendants === 0) {
    return (
      <p>
        {t`This removes the item and its ${plural(words, { one: '# word', other: '# words' })} from the project. You can undo it right after with Ctrl+Z.`}
      </p>
    );
  }
  return (
    <p>
      {documents > 0
        ? t`This removes the item, the ${plural(descendants, { one: '# item', other: '# items' })} inside it, and ${plural(words, { one: '# word', other: '# words' })} across ${plural(documents, { one: '# document', other: '# documents' })}. You can undo it right after with Ctrl+Z.`
        : t`This removes the item, the ${plural(descendants, { one: '# item', other: '# items' })} inside it. You can undo it right after with Ctrl+Z.`}
    </p>
  );
}

/**
 * One rail tab. Roving tabindex: the selected tab is the one Tab reaches, and the arrow keys (handled by the tab list) move
 * between the rest. The tabpanel names itself by this tab's id.
 */
function RailTabButton({
  tab,
  current,
  label,
  badge = 0,
  onSelect,
}: {
  tab: RailTab;
  current: RailTab;
  label: string;
  /** A count the tab shows beside its name (the open findings). Zero shows nothing. */
  badge?: number;
  onSelect: (tab: RailTab) => void;
}): ReactNode {
  return (
    <button
      type="button"
      role="tab"
      id={railTabId(tab)}
      aria-selected={current === tab}
      aria-controls="rail-panel"
      tabIndex={current === tab ? 0 : -1}
      className={`rail-tab${current === tab ? ' is-current' : ''}`}
      onClick={() => onSelect(tab)}
    >
      {label}
      {badge > 0 ? (
        <span className="rail-badge" aria-label={t`${plural(badge, { one: '# open', other: '# open' })}`} data-testid={`${tab}-badge`}>
          {badge}
        </span>
      ) : null}
    </button>
  );
}

/**
 * The save state in the toolbar. A failure says what is safe right now and the one thing to do about it (ui-modules §5.3, rule 4):
 * the words are in this tab and are written again on the next change, and a backup is the copy that does not depend on the browser.
 */
function SaveIndicator({ state, onExport }: { state: SaveState; onExport: () => void }): ReactNode {
  const words = saveStateWords(state);
  return (
    <span className={`save-state is-${state}`} role="status" data-testid="save-state" data-state={state}>
      {words.text}
      {words.offersBackup ? (
        <>
          {' '}
          <button type="button" className="button is-quiet" onClick={onExport}>
            <Trans>Export a backup</Trans>
          </button>
        </>
      ) : null}
    </span>
  );
}

/** A folder save the folder's state stopped: the reason, and the answers the writer had already given. */
interface FolderOffer {
  readonly folder: DirectoryHandleLike;
  readonly reason: 'locked' | 'changed' | 'unknown' | 'earlier' | 'files';
  /** The documents and codex entries another program changed, removed or added, named in words (lifecycle `folderChanges`). */
  readonly files: readonly FolderFileChange[];
  /** The change was found part way through the save, so the files before it and the pictures were written, and these were not. */
  readonly partial: boolean;
  /** The change was found after the save was written in full: the folder holds the other program's version of these files. */
  readonly after: boolean;
  /** The folder's caotang.json is gone rather than changed, so there is no newer copy to open. */
  readonly removed: boolean;
  readonly answers: FolderSaveAnswers;
}

/** The changed files, one line each, for a question that names them. Nothing renders for a save with none. */
function changedFilesList(files: readonly FolderFileChange[]): ReactNode {
  if (files.length === 0) return null;
  return (
    <ul>
      {files.map((file, index) => {
        const kind = file.change;
        return (
          <li key={index}>
            {t`${{ file: isolate(file.label) }}: ${select(kind, {
              changed: 'changed',
              removed: 'removed',
              added: 'added',
              other: 'changed',
            })}`}
          </li>
        );
      })}
    </ul>
  );
}

/** The question a stopped folder save asks, in the words the writer needs to answer it. */
function folderQuestion({
  reason,
  files,
  partial,
  after,
  removed,
}: Pick<FolderOffer, 'reason' | 'files' | 'partial' | 'after' | 'removed'>): {
  readonly title: string;
  readonly body: ReactNode;
  readonly confirm: string;
  /** Whether the question offers "Save as a new folder…" before its confirm. */
  readonly newFolder: boolean;
} {
  if (reason === 'files') {
    return {
      title: t`Some documents in this folder changed since Caotang last saved them`,
      body: (
        <>
          {partial ? (
            <p>
              <Trans>
                Another program changed these files in the folder while Caotang was saving, so the save stopped part way. The files before
                them were saved, and these were not:
              </Trans>
            </p>
          ) : null}
          {after ? (
            <p>
              <Trans>
                Another program changed these files in the folder while Caotang was saving. The save was written, and the folder now holds
                that program’s version of them:
              </Trans>
            </p>
          ) : null}
          {changedFilesList(files)}
          <p>
            <Trans>
              Saving writes this tab’s version over them. The folder’s version is kept first, in <code>.caotang-backup</code> in the folder,
              so if you need anything from it, copy it from there.
            </Trans>
          </p>
        </>
      ),
      confirm: t`Save over them`,
      newFolder: true,
    };
  }
  if (reason === 'locked') {
    return {
      title: t`Another program may be using this folder`,
      body: after ? (
        <p>
          <Trans>
            A lock file appeared in this folder while Caotang was saving, so another program, such as the Caotang MCP server, may have read
            the folder part way through the save. The save was written. Saving again now can overwrite what that program writes. Save again
            anyway?
          </Trans>
        </p>
      ) : (
        <p>
          <Trans>
            A lock file in this folder says that another program, such as the Caotang MCP server, may be using it. Saving now can overwrite
            what that program has written. If no such program is running, the lock was left behind when one closed. Save anyway?
          </Trans>
        </p>
      ),
      confirm: t`Save anyway`,
      newFolder: false,
    };
  }
  if (reason === 'changed' && removed) {
    return {
      title: t`This folder’s caotang.json was removed`,
      body: (
        <>
          <p>
            <Trans>
              Another program removed <code>caotang.json</code> from this folder after Caotang last loaded or saved it, so nothing was
              written.
            </Trans>
          </p>
          <p>
            <Trans>
              Saving here writes <code>caotang.json</code> back into the folder from this tab, with the project as this tab holds it.
            </Trans>
          </p>
          {changedFilesList(files)}
        </>
      ),
      confirm: t`Write it back`,
      newFolder: false,
    };
  }
  if (reason === 'changed') {
    return {
      title: t`This folder changed since Caotang last saved it`,
      body: (
        <>
          <p>
            {after ? (
              <Trans>
                <code>caotang.json</code> in this folder was changed by another program while Caotang was saving it, so the folder now holds
                that program’s version.
              </Trans>
            ) : (
              <Trans>
                <code>caotang.json</code> in this folder was changed by another program after Caotang last loaded or saved it, so nothing
                was written.
              </Trans>
            )}
          </p>
          <p>
            <Trans>
              To see the folder’s newer copy, go to Projects and open the folder again: it opens as a separate project. Saving here writes <code>caotang.json</code> from this tab, and an older one that is there is kept as a backup.
            </Trans>
          </p>
          {changedFilesList(files)}
        </>
      ),
      confirm: t`Save over it`,
      newFolder: false,
    };
  }
  if (reason === 'earlier') {
    return {
      title: t`This folder holds an earlier save of this project`,
      body: (
        <p>
          <Trans>
            Caotang has no record of what this folder held when this project was last saved there, so it can’t tell which documents changed
            since. Saving writes this tab’s version over the folder’s documents. The folder’s version of each one it replaces is kept in <code>.caotang-backup</code> in the folder, and an older <code>caotang.json</code> is kept as a backup of its own, so if you need anything from it, copy it from there.
          </Trans>
        </p>
      ),
      confirm: t`Save over it`,
      newFolder: true,
    };
  }
  return {
    title: t`This folder already holds another project`,
    body: (
      <p>
        <Trans>
          Saving here replaces that project’s <code>caotang.json</code> and any of its documents that share an id with this one. Caotang
          keeps a backup of that <code>caotang.json</code>, and copies each document it replaces to <code>.caotang-backup</code> in the
          folder.
        </Trans>
      </p>
    ),
    confirm: t`Save over it`,
    newFolder: true,
  };
}

/**
 * The question "Save as a new folder…" asks when the folder the writer picked is not empty: a new folder for this project must hold
 * nothing yet, so no file of another project or program is written over.
 */
function notEmptyQuestion(name: string): { readonly title: string; readonly body: ReactNode } {
  // Isolated once, and named, so the catalogue holds `{folderName}` rather than a positional `{0}`.
  const folderName = isolate(name);
  return {
    title: t`That folder is not empty`,
    body: (
      <p>
        <Trans>
          The folder “{folderName}” already has files in it, so nothing was saved there. A new folder for this project must be empty.
          Choose another folder, or make an empty one in the folder picker.
        </Trans>
      </p>
    ),
  };
}

/** Focus an element once the next frame has rendered it. */
function focusSoon(selector: string): void {
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(selector)?.focus();
  });
}

/** The surface a delete was asked from: the binder's rows, or the corkboard's cards. */
type DeleteSurface = 'binder' | 'corkboard';

/** Where focus goes after a delete: the surface, and the node that takes the removed node's place (null for none). */
interface DeletePlace {
  readonly surface: DeleteSurface;
  readonly successor: string | null;
}

/** The sibling that takes a node's place when it is deleted: the next sibling, else the previous one, else the parent. */
function successorOf(state: ProjectState, nodeId: string): string | null {
  const node = nodeById(state, nodeId);
  if (!node || node.parentId === null) return null;
  const siblings = childrenOf(state, node.parentId);
  const at = siblings.findIndex((sibling) => sibling.id === nodeId);
  return siblings[at + 1]?.id ?? siblings[at - 1]?.id ?? node.parentId;
}

/**
 * Focus the row or card that took the removed node's place. It waits one turn, after the dialog has closed and returned focus to
 * the removed row (the deferred focus `keyboardMove` uses). On the corkboard, a parent that is not a card gives the first card.
 */
function focusAfterDelete(place: DeletePlace): void {
  setTimeout(() => {
    const root = place.surface === 'binder' ? '.binder-tree' : '.corkboard';
    const item = place.surface === 'binder' ? '[data-node-id]' : 'article.card[data-node-id]';
    const successor = place.successor === null ? null : document.querySelector<HTMLElement>(`${root} [data-node-id="${CSS.escape(place.successor)}"]`);
    (successor ?? document.querySelector<HTMLElement>(`${root} ${item}`))?.focus();
  }, 0);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
