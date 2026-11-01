/**
 * The writing workspace — ui-modules §1, modern-interface.md §4.1. It holds the state and the handlers of the writing studio and
 * builds the regions a shell arranges: the feature elements, the shell actions (app/shell-actions.ts) and the view state. Shell
 * (shell/Shell.tsx) puts them in the chosen shell: Modern (shell/modern/, a lazy chunk) or Classic. The Classic shell
 * (shell/ClassicShell.tsx) lays them out: a toolbar on top; a left rail with the binder, codex, activity and findings tab
 * slots; the centre (the editor, or the corkboard for a container); the inspector on the right. Focus mode hides both rails and
 * keeps the centre exactly as it was.
 *
 * This file owns only ephemeral UI state (which tab, which centre, focus mode, card size, the row being renamed,
 * the delete being confirmed, the export dialog, the theme, the status line). Project and view state live in the
 * session, and every change to them is a dispatch.
 */
/* lingui-set comment="Interpolated values: backup, badge, count, descendants, documents, error, file, folder, folderName, kind, label, position, shortcut, storageSentence, title, words" */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { plural, select, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { isolate } from '@caotang/i18n';
import { pictureStorageReport, type ProjectState, type RuntimeStore, type SweepCandidate } from '@caotang/store';

import type { AgentController, SubmitOptions } from '../app/agent.js';
import { childrenOf, enclosingFolders, newDocumentRefusalText, newItemParent, nodeById, summarizeSubtree } from '../app/binder-model.js';
import { downloadBytes } from '../app/download.js';
import { folderAccessSupported, folderIsEmpty, pickDirectory, type DirectoryHandleLike } from '../app/fs-access.js';
import { isImeEnter, keyFacts, keyboardLayoutStore, resolveKey } from '../app/keymap.js';
import { shellActions } from '../app/shell-actions.js';
import { narrowMediaFeature, type NarrowPanel } from '../app/narrow-model.js';
import {
  exportBundle,
  folderOverwriteSnapshotFor,
  noteLeaveSuggestion,
  previewFolderChanges,
  saveFolder,
  type FolderFileChange,
  type FolderFilePreview,
  type FolderOverwriteSnapshot,
  type FolderSaveAnswers,
} from '../app/lifecycle.js';
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
import { requestInspector } from '../app/inspector-request.js';
import { activeTheme, applyTheme, rememberTheme, type Theme } from '../app/theme.js';
import type { StartIntent } from '../App.js';
import { RecurringTasks } from '../app/recurring-tasks.js';
import { Binder, type CenterMode } from './Binder.js';
import { CodexPanel } from './CodexPanel.js';
import { mediaKindOf, mediaPortsFor, mediaViewFor } from '../media/index.js';
import type { PictureFocusRequest } from '../media/picture-board-model.js';
import type { SourceRoute } from '../media/element-menu.js';

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
import { AgentInstructionsPanel } from './AgentInstructionsPanel.js';
import { SkillsPanel } from './SkillsPanel.js';
import { VocabularyEditor } from './VocabularyEditor.js';
import { ImportPreviewHost } from '../import-preview/ImportPreviewHost.js';
import { Inspector } from './Inspector.js';
import { Settings, type SettingsSection } from './LazySettings.js';
import { accessibleText } from '../i18n/accessible-text.js';
import { StaleTabNotice } from './StaleTabNotice.js';
import {
  clearSelection,
  createNode,
  createdNodeId,
  deleteNode,
  explain,
  liveSelection,
  selectNode,
  setExpanded,
} from './actions.js';
import { ChoiceDialog, ConfirmDialog, ReportContext, useSession, type MenuAnchor, type StatusMessage } from './shared.js';
import { OpenOnDesktop, useNarrow } from './narrow.js';
import { railTabId } from './shell/ClassicShell.js';
import type { RailTab, ShellRegions } from './shell/regions.js';
import { Shell } from './shell/Shell.js';

/** The timeline is its own chunk: the view and its package are fetched when the writer first opens it. */
const PictureBoard = lazyView(() => import('../media/PictureBoard.js').then((module) => ({ default: module.PictureBoard })));
const TimelineView = lazyView(() => import('./timeline/TimelineView.js').then((module) => ({ default: module.TimelineView })));
const AgentPanel = lazyView(() => import('./AgentPanel.js').then((module) => ({ default: module.AgentPanel })));
const ExportDialog = lazyView(() => import('./ExportDialog.js').then((module) => ({ default: module.ExportDialog })));
// The Findings and Activity tabs carry the coherence review and the agent's turn reports, which the first screen does not read.
const FindingsPanel = lazyView(() => import('./FindingsPanel.js').then((module) => ({ default: module.FindingsPanel })));
const ActivityPanel = lazyView(() => import('./ActivityPanel.js').then((module) => ({ default: module.ActivityPanel })));
const TracePanel = lazyView(() => import('./TracePanel.js').then((module) => ({ default: module.TracePanel })));

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
  // Reads `center` itself (not a ref), so the setter can be passed to a view built during render (react-hooks/refs).
  const setCenter = useCallback(
    (next: CenterMode): void => {
      if (center === 'timeline' && next !== 'timeline' && pendingRows(session.projectId) > 0) setLeaving(next);
      else setCenterNow(next);
    },
    [session, center],
  );
  const [timelineFocus, setTimelineFocus] = useState<TimelineFocusRequest | null>(null);
  const [pictureFocus, setPictureFocus] = useState<PictureFocusRequest | null>(null);
  const [findingsFocus, setFindingsFocus] = useState<{ readonly factGroup: string; readonly serial: number } | null>(null);
  const focusSerial = useRef(0);
  // The narrow layout (ui-modules §1): which panel is open over the centre, and the toolbar's overflow menu. View state only; a wide
  // window never reads it.
  const narrow = useNarrow();
  const [panel, setPanel] = useState<NarrowPanel | null>(null);
  const [overflow, setOverflow] = useState<MenuAnchor | null>(null);
  if (!narrow && (panel !== null || overflow !== null)) {
    setPanel(null);
    setOverflow(null);
  }
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
  /** Text the palette put in the agent's Intent box, unsent (modern-interface.md §8.9); the serial makes a repeat count. */
  const [agentDraft, setAgentDraft] = useState<{ readonly text: string; readonly serial: number } | null>(null);
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
  const submitToAgent = useCallback(
    (intent: string, options?: SubmitOptions): void => {
      void whenAgent(session).then((controller) => controller.submit(intent, options));
    },
    [session],
  );
  // The project's recurring tasks (agent-harness.md §12): looked at as the project opens and every minute while the tab is visible.
  // They run through the agent, so they start once its controller has loaded.
  const recurring = useMemo(
    () => (agent === null ? null : new RecurringTasks({ session, agent, enabledChecks: () => services.settings.current().coherence.enabledChecks })),
    [session, agent, services.settings],
  );
  useEffect(() => {
    if (recurring === null) return;
    void recurring.attach();
    return () => recurring.detach();
  }, [recurring]);
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
  const openPanel = narrow && !hideRails ? panel : null;
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
  /**
   * The screenplay Source tab's section route (screenplay.md §3): the binder selects the folder the scene is in, its Fountain section,
   * and focuses its row, as Left does in the tree. The folders above it are opened so the row is on screen, and the rails come back
   * if focus mode hid them. A scene directly under the manuscript has no section, and the status line says so.
   */
  const showSceneSection = (sceneId: string): void => {
    const [section, ...above] = enclosingFolders(state, sceneId);
    if (section === undefined) {
      report({ text: t`This scene is in no folder, so it has no section. Make a folder in the binder and move the scene into it.`, tone: 'info' });
      return;
    }
    if (hideRails) setFocusMode(false);
    setRail('binder');
    if (narrow) setPanel('rail');
    for (const folder of above) setExpanded(session, folder.id, true);
    selectNode(session, section.id);
    if (!narrow) setCenter('corkboard');
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`.binder-tree [data-node-id="${CSS.escape(section.id)}"]`);
      if (row !== null) row.focus();
      // A missing row is a filter that hides it, unless the folder went in the frame since the key (an agent's delete).
      else {
        const title = section.title;
        if (nodeById(session.state, section.id) === undefined) report({ text: t`"${title}" is no longer in the binder.`, tone: 'info' });
        else report({ text: t`The binder filter hides "${title}". Clear the filter to see it.`, tone: 'info' });
      }
    });
  };

  /**
   * The Source tab's synopsis route (screenplay.md §3): the scene's synopsis field in the inspector takes the focus, as the binder's
   * Edit synopsis does. The field edits the manifest's synopsis, which is the one truth (§2.2), never a `=` line in the text.
   */
  const focusSceneSynopsis = (sceneId: string): void => {
    if (hideRails) setFocusMode(false);
    if (selected !== sceneId) selectNode(session, sceneId);
    if (narrow) setPanel('inspector');
    requestInspector('synopsis');
    // Unlike the binder's Edit synopsis, a miss is said: the chord was pressed in the text, and nothing else would show it failed.
    requestAnimationFrame(() => {
      const field = document.querySelector<HTMLElement>('#inspector-synopsis');
      if (field !== null) field.focus();
      else report({ text: t`The scene’s synopsis is not showing, so the chord could not open it.`, tone: 'info' });
    });
  };

  /** The Source tab's routes, one handler each, so a route added to `SourceRoute` without a handler does not compile. */
  const sceneRoutes: Readonly<Record<SourceRoute, (sceneId: string) => void>> = {
    section: showSceneSection,
    synopsis: focusSceneSynopsis,
  };

  // In the narrow layout a storyboard and a dialogue container say "Open on desktop" in place of their view (ui-modules §1).
  const desktopOnly = narrow && mediaNode !== undefined ? narrowMediaFeature(mediaKindOf(mediaNode)) : null;
  const mediaView =
    mediaNode !== undefined && center !== 'timeline' && center !== 'pictures' && (center === 'editor' || mediaKindOf(mediaNode) === 'storyboard') ? (
      desktopOnly !== null ? (
        <OpenOnDesktop
          feature={desktopOnly}
          actions={
            <button type="button" className="button" onClick={() => setPanel('rail')}>
              <Trans>Open the binder</Trans>
            </button>
          }
        />
      ) : (
        mediaViewFor(mediaNode, {
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
          onSourceRoute: (route, scene) => sceneRoutes[route](scene.id),
        })
      )
    ) : null;
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
      setPanel(null);
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
    (intent: string, options?: SubmitOptions): void => {
      setAgentOpen(true);
      setPanel(null);
      submitToAgent(intent, options);
    },
    [submitToAgent],
  );

  /** A mention chip's click: the codex tab shows the entry (codex.md §8). */
  const openCodexEntry = useCallback((entryId: string): void => {
    setRail('codex');
    setPanel('rail');
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
      { ...keyFacts(event), composing: isImeEnter(event) },
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
        if (narrow) setPanel('rail');
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

  /**
   * The binder asks for a centre view as a row is chosen. In the narrow layout a folder leaves the centre alone: the corkboard is one
   * switch away and says "Open on desktop", and a chapter chosen to add a scene under it should not swap the writer's page for that notice.
   */
  const showCenter = (mode: CenterMode): void => {
    if (narrow && mode === 'corkboard') return;
    setCenter(mode);
  };

  // Focus goes into a panel as it opens and back to its button as it closes, unless the writer's focus has already gone somewhere else
  // (the editor, after a document was chosen). The toolbar and the centre are inert while a panel is open, so focus cannot wander behind it.
  const shownPanel = useRef<NarrowPanel | null>(null);
  useEffect(() => {
    const before = shownPanel.current;
    shownPanel.current = openPanel;
    if (openPanel === 'rail') document.getElementById(railTabId(rail))?.focus();
    else if (openPanel === 'inspector') document.getElementById('narrow-close-inspector')?.focus();
    else if (before !== null) {
      const active = document.activeElement;
      const left = document.getElementById(before === 'rail' ? 'narrow-rail' : 'narrow-sheet');
      if (active === null || active === document.body || left?.contains(active)) document.getElementById(`narrow-toggle-${before}`)?.focus();
    }
  }, [openPanel, rail]);
  const openOverflow = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    const box = event.currentTarget.getBoundingClientRect();
    setOverflow({ x: Math.max(8, box.right - 240), y: box.bottom + 4 });
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
          const overwriteSnapshot = folderOverwriteSnapshotFor(outcome);
          if (overwriteSnapshot === undefined) throw new Error('The folder save question no longer matches the folder state. Save again to review it.');
          const previewBatch = await previewFolderChanges(session, folder, outcome.previewFiles ?? [], outcome.omittedPreviewFiles ?? 0);
          setFolderOffer({
            folder,
            reason: outcome.reason,
            overwriteSnapshot,
            files: outcome.files,
            previews: previewBatch.previews,
            omittedPreviews: previewBatch.omitted,
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
    const { folder, reason, answers, overwriteSnapshot } = folderOffer;
    setFolderOffer(null);
    writeFolder(folder, reason === 'locked'
      ? { ...answers, lockConfirmed: true }
      : { ...answers, overwriteConfirmed: true, overwriteSnapshot });
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
  // The shell actions (modern-interface.md §4.2): Classic's toolbar and its narrow More menu both render from this one list.
  const actions = shellActions(
    { undoLabel, focusMode, theme, folderPicker: folderAccessSupported(), keyboardLayout },
    {
      projects: leave,
      details: () => openDialog({ kind: 'project' }),
      undo: undoNow,
      focus: toggleFocus,
      skills: () => openDialog({ kind: 'skills' }),
      instructions: () => openDialog({ kind: 'agent-instructions' }),
      compile: () => setExporting(true),
      bundle: exportBundleOffering,
      folder: saveToFolder,
      settings: () => setSettingsSection('providers'),
      theme: toggleTheme,
    },
  );

  // The regions a shell arranges (modern-interface.md §4.1): the feature elements, built once here, and the view state.
  const regions: ShellRegions = {
    projectName: state.manifest.project.name,
    actions,
    view: {
      rail,
      setRail,
      center,
      setCenter,
      focusMode,
      hideRails,
      narrow,
      agentOpen,
      openPanel,
      setPanel,
      overflow,
      openOverflow,
      closeOverflow: () => setOverflow(null),
    },
    binder: (
      <>
        <Binder
          session={session}
          renaming={renaming?.surface === 'binder' ? renaming.nodeId : null}
          onRename={renameOn('binder')}
          onAskDelete={askDelete}
          onShowCenter={showCenter}
          onOpened={() => setPanel(null)}
          onFocusSynopsis={() => {
            if (narrow) setPanel('inspector');
            requestInspector('synopsis');
            focusSoon('#inspector-synopsis');
          }}
          onAgentIntent={runAgentIntent}
        />
        <BinderFooter session={session} runtime={store} target={target} />
      </>
    ),
    codex: <CodexPanel session={session} onOpenDocument={openDocument} focus={codexFocus} onAgentIntent={runAgentIntent} />,
    findings: (
      <FindingsPanel
        session={session}
        onReveal={revealPassage}
        settings={settingsNow.coherence}
        providers={services.providers}
        onOpenAgent={() => {
          setAgentOpen(true);
          setPanel(null);
        }}
        onOpenDocument={openDocument}
        focusGroup={findingsFocus}
        onGroupFocused={() => setFindingsFocus(null)}
        onShowOnTimeline={showOnTimeline}
      />
    ),
    findingsBadge: openFindingCount(session.coherenceFile()),
    activity: <ActivityPanel session={session} onExport={() => void exportActivity()} />,
    trace: <TracePanel services={services} projectName={state.manifest.project.name} />,
    inspector: (
      <Inspector session={session} nodeId={selected} onOpenCodex={openCodexEntry} onAgentIntent={runAgentIntent} onOpenPicture={openPictureBoard} />
    ),
    editor: (
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
        agentEditMode={settingsNow.editor.agentEditMode}
      />
    ),
    corkboard: (
      <Corkboard
        session={session}
        zoom={zoom}
        onZoom={setZoom}
        renaming={renaming?.surface === 'card' ? renaming.nodeId : null}
        onRename={renameOn('card')}
        onAskDelete={askDelete}
      />
    ),
    timeline: (
      <TimelineView
        session={session}
        onOpenDocument={openDocument}
        onOpenFindings={openInFindings}
        focusRequest={timelineFocus}
        onFocusHandled={() => setTimelineFocus(null)}
      />
    ),
    pictures: (
      <PictureBoard session={session} focus={pictureFocus} onFocusHandled={() => setPictureFocus(null)} onOpenNode={openPictureNode} />
    ),
    media: mediaView,
    // The agent arrives with its lazy chunk; until it exists the boundary shows nothing.
    agent:
      agent === null || recurring === null ? null : (
        <AgentPanel
          session={session}
          agent={agent}
          recurring={recurring}
          startIntent={startIntent}
          draft={agentDraft}
          open={agentOpen}
          onToggle={() => setAgentOpen((on) => !on)}
          sample={sample}
        />
      ),
    // A status region is a div: ARIA does not allow the role on an aside.
    storageBanner: showStorageBanner ? (
      <div className="storage-banner" role="status" aria-label={t`Browser storage`} data-testid="storage-banner">
        <div>
          {narrow ? (
            <p>
              <Trans>
                Your words are kept in this browser, and the browser has not promised to keep them. A phone or tablet clears browser
                storage sooner than a computer when space runs short, and nothing syncs yet, so this copy is not your book’s only home.
                Export a backup often and keep it somewhere else.
              </Trans>
            </p>
          ) : (
            <p>
              <Trans>
                Your words are kept in this browser, and the browser has not promised to keep them. Export a backup to keep a copy you
                can open anywhere.
              </Trans>
            </p>
          )}
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
    ) : null,
    pictureNotices: (
      <PictureNotices
        projectId={session.projectId}
        facts={pictureFacts}
        onExport={exportBundleOffering}
        {...(folderAccessSupported() ? { onSaveToFolder: saveToFolder } : {})}
      />
    ),
    status: message ? (
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
    ) : null,
    saveState: <SaveIndicator state={saveState} onExport={exportNow} />,
    progress: { target, setTarget: saveTarget, saveState, exportBackup: exportNow },
    search: {
      state,
      activeDocId: view.activeDocId,
      openNode: (nodeId) => {
        const node = nodeById(state, nodeId);
        if (node === undefined) return;
        selectNode(session, nodeId);
        setPanel(null);
        if (node.type !== 'document') {
          showCenter('corkboard');
          return;
        }
        setCenter('editor');
        if (mediaKindOf(node) === null) setFocusDocId(nodeId);
      },
      openCodexEntry,
      showCodex: () => {
        setRail('codex');
        if (narrow) setPanel('rail');
      },
      openSettings: setSettingsSection,
      openAgent: (text) => {
        setAgentOpen(true);
        setPanel(null);
        if (text !== null) setAgentDraft((previous) => ({ text, serial: (previous?.serial ?? 0) + 1 }));
      },
      openSceneInfo: () => {
        if (narrow) setPanel('inspector');
        requestInspector('synopsis');
        focusSoon('#inspector-synopsis');
      },
    },
  };

  return (
    <ReportContext.Provider value={report}>
      {/* The dialogs are the shell's children, so they sit at the end of the workspace as they always have, in either shell. */}
      <Shell regions={regions}>
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
        <AgentInstructionsPanel session={session} services={services} onAgentIntent={runAgentIntent} />
        <VocabularyEditor session={session} />
        <ImportPreviewHost session={session} />


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
            onOpenAgent={() => setAgentOpen(true)}
            onProvidersChanged={() => agent?.refresh()}
          />
        ) : null}
      </Shell>
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
  readonly overwriteSnapshot: FolderOverwriteSnapshot;
  /** The documents and codex entries another program changed, removed or added, named in words (lifecycle `folderChanges`). */
  readonly files: readonly FolderFileChange[];
  /** A read-only comparison of each named file's folder text and this tab's text. */
  readonly previews: readonly FolderFilePreview[];
  /** Number of exact file comparisons omitted by the preview-size limits. */
  readonly omittedPreviews: number;
  /** The change was found part way through the save, so the files before it and the pictures were written, and these were not. */
  readonly partial: boolean;
  /** The change was found after the save was written in full: the folder holds the other program's version of these files. */
  readonly after: boolean;
  /** The folder's caotang.json is gone rather than changed, so there is no newer copy to open. */
  readonly removed: boolean;
  readonly answers: FolderSaveAnswers;
}

/** The changed files, one line each, for a question that names them. Nothing renders for a save with none. */
function changedFilesList(files: readonly FolderFileChange[], previews: readonly FolderFilePreview[], omittedPreviews: number): ReactNode {
  if (files.length === 0) return null;
  const MAX_VISIBLE_FOLDER_FILE_LABELS = 12;
  const hiddenLabels = files.length - MAX_VISIBLE_FOLDER_FILE_LABELS;
  return (
    <ul>
      {files.slice(0, MAX_VISIBLE_FOLDER_FILE_LABELS).map((file, index) => {
        const kind = file.change;
        const filePreviews = previews.filter((item) => item.label === file.label && item.change === file.change);
        const count = filePreviews.length;
        return (
          <li key={index}>
            <div>
              {t`${{ file: isolate(file.label) }}: ${select(kind, {
                changed: 'changed',
                removed: 'removed',
                added: 'added',
                other: 'changed',
              })}`}
            </div>
            {filePreviews.map((preview, previewIndex) => {
              const position = previewIndex + 1;
              return (
                <section
                  className="folder-file-preview"
                  key={preview.path}
                  role="region"
                  aria-label={accessibleText(
                    count > 1
                      ? t`Changes for ${{ file: isolate(file.label) }}, file ${{ position }} of ${{ count }}`
                      : t`Changes for ${{ file: isolate(file.label) }}`,
                  )}
                >
                  <p className="field-note">
                    {count > 1 ? t`File ${{ position }} of ${{ count }} · − In the folder · + In this tab` : t`− In the folder · + In this tab`}
                  </p>
                  <pre className="folder-diff">
                    {preview.lines.map((line, lineIndex) => {
                      const marker = line.kind === 'folder' ? '− ' : line.kind === 'tab' ? '+ ' : line.kind === 'context' ? '  ' : '… ';
                      return <span className={`folder-diff-line is-${line.kind}`} key={lineIndex}>{marker}{line.text || ' '}{'\n'}</span>;
                    })}
                  </pre>
                </section>
              );
            })}
          </li>
        );
      })}
      {files.length > MAX_VISIBLE_FOLDER_FILE_LABELS ? (
        <li className="field-note">
          {plural(hiddenLabels, { one: '# more changed file label is not shown.', other: '# more changed file labels are not shown.' })}
        </li>
      ) : null}
      {omittedPreviews > 0 ? (
        <li className="field-note">
          {plural(omittedPreviews, {
            one: 'Detailed comparisons for # more file are not shown to keep the question manageable.',
            other: 'Detailed comparisons for # more files are not shown to keep the question manageable.',
          })}
        </li>
      ) : null}
    </ul>
  );
}

/** The question a stopped folder save asks, in the words the writer needs to answer it. */
function folderQuestion({
  reason,
  files,
  previews,
  omittedPreviews,
  partial,
  after,
  removed,
}: Pick<FolderOffer, 'reason' | 'files' | 'previews' | 'omittedPreviews' | 'partial' | 'after' | 'removed'>): {
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
          {changedFilesList(files, previews, omittedPreviews)}
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
          {changedFilesList(files, previews, omittedPreviews)}
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
          {changedFilesList(files, previews, omittedPreviews)}
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
