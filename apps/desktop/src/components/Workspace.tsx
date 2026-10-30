/**
 * The writing shell — ui-modules §1. A toolbar on top; a left rail with the binder, codex, activity and findings
 * tab slots; the centre (the editor, or the corkboard for a container); the inspector on the right. Focus mode
 * hides both rails and keeps the centre exactly as it was.
 *
 * This file owns only ephemeral UI state (which tab, which centre, focus mode, card size, the row being renamed,
 * the delete being confirmed, the export dialog, the theme, the status line). Project and view state live in the
 * session, and every change to them is a dispatch.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import type { ProjectState, RuntimeStore } from '@caotang/store';

import { activityMarkdown } from '../app/activity-model.js';
import { AgentController, type SubmitOptions } from '../app/agent.js';
import { childrenOf, enclosingFolders, newDocumentRefusalText, newItemParent, nodeById, summarizeSubtree } from '../app/binder-model.js';
import { downloadBytes } from '../app/download.js';
import { folderAccessSupported, folderIsEmpty, pickDirectory, type DirectoryHandleLike } from '../app/fs-access.js';
import { keyFacts, resolveKey } from '../app/keymap.js';
import { isImeEnter } from '../app/ime.js';
import { narrowMediaFeature, togglePanel, type NarrowPanel } from '../app/narrow-model.js';
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
import { saveStateWords } from '../app/integrity-model.js';
import { activeTheme, applyTheme, rememberTheme, type Theme } from '../app/theme.js';
import type { StartIntent } from '../App.js';
import { AgentPanel } from './AgentPanel.js';
import { RecurringTasks } from '../app/recurring-tasks.js';
import { Binder, type CenterMode } from './Binder.js';
import { CodexPanel } from './CodexPanel.js';
import { ActivityPanel } from './ActivityPanel.js';
import { TracePanel } from './TracePanel.js';
import { mediaKindOf, mediaPortsFor, mediaViewFor } from '../media/index.js';
import type { SourceRoute } from '../media/element-menu.js';

import { Corkboard } from './Corkboard.js';
import { EditorPane, type RevealRequest } from './EditorPane.js';
import { FindingsPanel } from './FindingsPanel.js';
import { BinderFooter } from './BinderFooter.js';
import { openFindingCount } from '../app/findings-model.js';
import { ExportDialog, type ExportSelection } from './ExportDialog.js';
import { openDialog } from './dialog-requests.js';
import { ProjectPanel } from './ProjectPanel.js';
import { AgentInstructionsPanel } from './AgentInstructionsPanel.js';
import { SkillsPanel } from './SkillsPanel.js';
import { VocabularyEditor } from './VocabularyEditor.js';
import { Inspector } from './Inspector.js';
import { Settings, type SettingsSection } from './LazySettings.js';
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
import {
  ChoiceDialog,
  ConfirmDialog,
  Menu,
  ReportContext,
  formatCount,
  useSession,
  wordsLabel,
  type MenuAnchor,
  type MenuItem,
  type StatusMessage,
} from './shared.js';
import { OpenOnDesktop, useNarrow } from './narrow.js';

type RailTab = 'binder' | 'codex' | 'activity' | 'trace' | 'findings';

/** The rail's tabs in the order the arrow keys walk them (WAI-ARIA tabs). */
const RAIL_TABS: readonly RailTab[] = ['binder', 'codex', 'activity', 'trace', 'findings'];
/** The centre views, in the order the arrow keys walk the radio group. */
const CENTER_VIEWS: readonly CenterMode[] = ['editor', 'corkboard'];

/** The id of a rail tab, which its tabpanel names itself by (`aria-labelledby`). */
function railTabId(tab: RailTab): string {
  return `rail-tab-${tab}`;
}

/**
 * The item an arrow, Home or End key moves to from `current`, or `null` for any other key. Arrows wrap at both ends, as the
 * WAI-ARIA tab and radio patterns have them, and Home and End go to the first and last item.
 */
function keyStep<T>(items: readonly T[], current: T, key: string): T | null {
  const at = items.indexOf(current);
  if (at === -1) return null;
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
  const [rail, setRail] = useState<RailTab>('binder');
  const [center, setCenter] = useState<CenterMode>('editor');
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
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(() => isBannerDismissedForVisit());
  const [explainStorage, setExplainStorage] = useState(false);
  const [storedToday, setStoredToday] = useState(0);
  /** A save to the folder that the folder's state stopped, with the reason, until the writer has answered the question it asks. */
  const [folderOffer, setFolderOffer] = useState<FolderOffer | null>(null);
  /** The name of a folder "Save as a new folder…" refused because it is not empty, until the writer chooses again or cancels. */
  const [notEmptyFolder, setNotEmptyFolder] = useState<string | null>(null);
  // One agent controller per open project: its turns, its pending decision and its ghost belong to this session.
  // The budgets are read at each turn, so a change in Settings › Context applies to the next one (context-assembly §3).
  const agent = useMemo(
    () =>
      new AgentController(
        session,
        services.providers,
        () => contextConfigOf(services.settings.current().context),
        () => services.settings.current().agent.loadEveryTool,
        {},
        () => services.settings.current().agent,
      ),
    [session, services.providers, services.settings],
  );
  useEffect(() => {
    agent.attach();
    return () => agent.detach();
  }, [agent]);
  // The project's recurring tasks (agent-harness.md §12): looked at as the project opens and every minute while the tab is visible.
  const recurring = useMemo(
    () => new RecurringTasks({ session, agent, enabledChecks: () => services.settings.current().coherence.enabledChecks }),
    [session, agent, services.settings],
  );
  useEffect(() => {
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
  const showStorageBanner = durability.persisted === false && !bannerDismissed;
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
              ? 'The unsaved text is too large to keep a spare copy in this browser, so a reload in the next moment could lose it.'
              : 'This browser would not keep a spare copy of the unsaved text, so a reload in the next moment could lose it.',
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
        text: 'Focus mode is on. The binder and inspector stay open, as set in ',
        tone: 'info',
        link: { label: 'Settings › Writing', after: '.', onClick: () => setSettingsSection('writing') },
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
    if (crossed) report({ text: 'Today’s target is met.', tone: 'info' });
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
      report({ text: 'This scene is in no folder, so it has no section. Make a folder in the binder and move the scene into it.', tone: 'info' });
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
      else if (nodeById(session.state, section.id) === undefined) report({ text: `"${section.title}" is no longer in the binder.`, tone: 'info' });
      else report({ text: `The binder filter hides "${section.title}". Clear the filter to see it.`, tone: 'info' });
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
    // Unlike the binder's Edit synopsis, a miss is said: the chord was pressed in the text, and nothing else would show it failed.
    requestAnimationFrame(() => {
      const field = document.querySelector<HTMLElement>('#inspector-synopsis');
      if (field !== null) field.focus();
      else report({ text: 'The scene’s synopsis is not showing, so the chord could not open it.', tone: 'info' });
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
    mediaNode !== undefined && (center === 'editor' || mediaKindOf(mediaNode) === 'storyboard') ? (
      desktopOnly !== null ? (
        <OpenOnDesktop
          feature={desktopOnly}
          actions={
            <button type="button" className="button" onClick={() => setPanel('rail')}>
              Open the binder
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
            void agent.submit(intent);
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
      report(detail ? { text: detail, tone: 'error' } : { text: 'There is nothing to undo.', tone: 'info' });
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
    [session],
  );

  /** An empty state's next step (ui-modules §0.3): the agent panel opens, and the controller runs the request through its usual path. */
  const runAgentIntent = useCallback(
    (intent: string, options?: SubmitOptions): void => {
      setAgentOpen(true);
      setPanel(null);
      void agent.submit(intent, options);
    },
    [agent],
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
  const onPanelKey = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    setPanel(null);
  };
  const openOverflow = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    const box = event.currentTarget.getBoundingClientRect();
    setOverflow({ x: Math.max(8, box.right - 240), y: box.bottom + 4 });
  };

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
      if (session.saveState() === 'saved' && !agent.tasksWorking()) return;
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
    const title = doomed?.title ?? 'the item';
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
    report({ text: `Deleted “${title}”. Ctrl+Z restores it right after.`, tone: 'info' });
  };

  const exportNow = (): void => {
    void (async () => {
      try {
        const bundle = await exportBundle(store, session);
        downloadBytes(bundle.bytes, bundle.filename);
        report({ text: [`Exported ${bundle.filename}.`, ...bundle.notices].join(' '), tone: 'info' });
      } catch (error) {
        report({ text: `The bundle could not be made: ${errorText(error)}`, tone: 'error' });
      }
    })();
  };

  /** The activity log and the agent's turns as one Markdown file (agent-harness §5, command-bus §8). */
  const exportActivity = (): void => {
    const markdown = activityMarkdown({
      title: state.manifest.project.name,
      entries: session.log.entries(),
      turns: agent.snapshot().turns,
    });
    const name = `${state.manifest.project.name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'project'}-activity.md`;
    downloadBytes(new TextEncoder().encode(markdown), name, 'text/markdown');
    report({ text: `Exported the activity log as ${name}.`, tone: 'info' });
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
        const kept = outcome.backup === undefined ? '' : ` What it replaced is kept in ${outcome.backup}.`;
        report({ text: `Saved the project to the folder “${folder.name}”.${kept} Exports go there from now on.`, tone: 'info' });
      } catch (error) {
        report({ text: `The folder could not be saved: ${errorText(error)}`, tone: 'error' });
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
        report({ text: `The folder could not be saved: ${errorText(error)}`, tone: 'error' });
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
        report({ text: `The folder could not be saved: ${errorText(error)}`, tone: 'error' });
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

  const leave = (): void => {
    void (async () => {
      await session.settle();
      if (session.saveState() === 'conflict') {
        report({
          text: 'This tab cannot save: another tab has newer text for this project. Export a backup to keep the words in this tab.',
          tone: 'error',
        });
        return;
      }
      if (session.saveState() === 'failed') {
        report({
          text: 'Some changes have not reached browser storage yet, so the project stays open. Export a bundle to keep a copy, then leave.',
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

  // The toolbar's controls beyond the two panels, in the narrow layout. They are the wide toolbar's buttons, with the same handlers.
  const overflowItems: readonly MenuItem[] = [
    { key: 'projects', label: 'Projects', onSelect: leave },
    { key: 'details', label: 'Project details', onSelect: () => openDialog({ kind: 'project' }) },
    { key: 'undo', label: 'Undo', disabled: undoLabel === null, onSelect: undoNow },
    { key: 'focus', label: focusMode ? 'Leave focus mode' : 'Focus mode', onSelect: toggleFocus },
    { key: 'skills', label: 'Skills', separatorBefore: true, onSelect: () => openDialog({ kind: 'skills' }) },
    { key: 'instructions', label: 'Instructions', onSelect: () => openDialog({ kind: 'agent-instructions' }) },
    { key: 'compile', label: 'Compile…', separatorBefore: true, onSelect: () => setExporting(true) },
    { key: 'bundle', label: 'Export bundle', onSelect: exportNow },
    ...(folderAccessSupported() ? [{ key: 'folder', label: 'Save to folder', onSelect: saveToFolder }] : []),
    { key: 'settings', label: 'Settings', separatorBefore: true, onSelect: () => setSettingsSection('providers') },
    { key: 'theme', label: theme === 'dark' ? 'Light theme' : 'Dark theme', onSelect: toggleTheme },
  ];

  return (
    <ReportContext.Provider value={report}>
      <div className={`workspace${hideRails ? ' is-focus' : ''}`}>
        <header className="toolbar" inert={openPanel !== null}>
          <div className="toolbar-start">
            {narrow ? (
              hideRails ? null : (
                <button
                  type="button"
                  id="narrow-toggle-rail"
                  className="button"
                  aria-expanded={openPanel === 'rail'}
                  aria-controls="narrow-rail"
                  onClick={() => setPanel(togglePanel(openPanel, 'rail'))}
                >
                  Binder
                </button>
              )
            ) : (
              <button type="button" className="button is-quiet" onClick={leave}>
                Projects
              </button>
            )}
            {narrow ? (
              // The save state sits under the name: a toolbar of three buttons has no room for a sentence beside them.
              <div className="toolbar-title">
                <h1 className="project-name">{state.manifest.project.name}</h1>
                <SaveIndicator state={saveState} onExport={exportNow} />
              </div>
            ) : (
              <h1 className="project-name">
                {/* The name opens the project panel, where the title, author, language, ISBN and cover are set. */}
                <button
                  type="button"
                  className="project-name-button"
                  title="Project details: title, author, language, ISBN and cover"
                  onClick={() => openDialog({ kind: 'project' })}
                >
                  {state.manifest.project.name}
                </button>
              </h1>
            )}
          </div>
          {narrow ? (
            // Narrow: the rail and the inspector open from here, and every other control is in the overflow menu (ui-modules §1).
            <div className="toolbar-end">
              {hideRails ? null : (
                <button
                  type="button"
                  id="narrow-toggle-inspector"
                  className="button"
                  aria-expanded={openPanel === 'inspector'}
                  aria-controls="narrow-sheet"
                  onClick={() => setPanel(togglePanel(openPanel, 'inspector'))}
                >
                  Inspector
                </button>
              )}
              <button type="button" className="button" aria-haspopup="menu" aria-expanded={overflow !== null} onClick={openOverflow}>
                More
              </button>
            </div>
          ) : (
            <div className="toolbar-end">
              <button
                type="button"
                className="button"
                disabled={undoLabel === null}
                title={undoLabel === null ? 'Nothing to undo' : `Undo: ${undoLabel}`}
                onClick={undoNow}
              >
                Undo
              </button>
              <button
                type="button"
                className="button"
                aria-pressed={focusMode}
                title="Focus mode (Ctrl+Shift+F)"
                onClick={toggleFocus}
              >
                Focus
              </button>
              <button type="button" className="button" title="Reusable writing instructions for the agent" onClick={() => openDialog({ kind: 'skills' })}>
                Skills
              </button>
              <button
                type="button"
                className="button"
                title="CAOTANG.md, your standing instructions, and the notes the agent keeps"
                onClick={() => openDialog({ kind: 'agent-instructions' })}
              >
                Instructions
              </button>
              <button type="button" className="button" onClick={() => setExporting(true)}>
                Compile…
              </button>
              <button type="button" className="button" onClick={exportNow}>
                Export bundle
              </button>
              {folderAccessSupported() ? (
                <button type="button" className="button" onClick={saveToFolder}>
                  Save to folder
                </button>
              ) : null}
              <button type="button" className="button" onClick={() => setSettingsSection('providers')}>
                Settings
              </button>
              <button
                type="button"
                className="button"
                aria-label={theme === 'dark' ? 'Light theme' : 'Dark theme'}
                title={theme === 'dark' ? 'Use the light theme' : 'Use the dark theme'}
                onClick={toggleTheme}
              >
                {theme === 'dark' ? 'Light theme' : 'Dark theme'}
              </button>
              <SaveIndicator state={saveState} onExport={exportNow} />
            </div>
          )}
        </header>

        {hideRails ? null : (
          <nav
            id="narrow-rail"
            className={`rail${narrow ? ' is-drawer' : ''}${openPanel === 'rail' ? ' is-open' : ''}`}
            aria-label="Project panels"
            onKeyDown={narrow ? onPanelKey : undefined}
          >
            {narrow ? (
              <div className="panel-head">
                <span className="panel-title">Project panels</span>
                <button type="button" className="button" aria-label="Close panels" onClick={() => setPanel(null)}>
                  Close
                </button>
              </div>
            ) : null}
            <div role="tablist" aria-label="Panels" className="rail-tabs" onKeyDown={onRailTabKey}>
              <RailTabButton tab="binder" current={rail} label="Binder" onSelect={setRail} />
              <RailTabButton tab="codex" current={rail} label="Codex" onSelect={setRail} />
              <RailTabButton tab="activity" current={rail} label="Activity" onSelect={setRail} />
              <RailTabButton tab="trace" current={rail} label="Trace" onSelect={setRail} />
              <RailTabButton
                tab="findings"
                current={rail}
                label="Findings"
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
                    onShowCenter={showCenter}
                    onOpened={() => setPanel(null)}
                    onFocusSynopsis={() => {
                      if (narrow) setPanel('inspector');
                      focusSoon('#inspector-synopsis');
                    }}
                    onAgentIntent={runAgentIntent}
                  />
                  <BinderFooter session={session} runtime={store} target={target} />
                </>
              ) : rail === 'codex' ? (
                <CodexPanel session={session} onOpenDocument={openDocument} focus={codexFocus} onAgentIntent={runAgentIntent} />
              ) : rail === 'findings' ? (
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
                />
              ) : rail === 'trace' ? (
                <TracePanel services={services} projectName={state.manifest.project.name} />
              ) : (
                <ActivityPanel
                  session={session}
                  onExport={() => exportActivity()}
                />
              )}
            </div>
          </nav>
        )}

        <main className="center" inert={openPanel !== null}>
          <div role="radiogroup" aria-label="Centre view" className="center-switch" onKeyDown={onCenterKey}>
            <button
              type="button"
              id="center-editor"
              role="radio"
              aria-checked={center === 'editor'}
              tabIndex={center === 'editor' ? 0 : -1}
              className="segmented-item"
              onClick={() => setCenter('editor')}
            >
              Editor
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
              Corkboard
            </button>
          </div>
          {/* A status region is a div: ARIA does not allow the role on an aside. */}
          {showStorageBanner ? (
            <div className="storage-banner" role="status" aria-label="Browser storage" data-testid="storage-banner">
              <div>
                {narrow ? (
                  <p>
                    Your words are kept in this browser, and the browser has not promised to keep them. A phone or tablet clears browser
                    storage sooner than a computer when space runs short, and nothing syncs yet, so this copy is not your book&rsquo;s only
                    home. Export a backup often and keep it somewhere else.
                  </p>
                ) : (
                  <p>
                    Your words are kept in this browser, and the browser has not promised to keep them. Export a backup to keep a copy you
                    can open anywhere.
                  </p>
                )}
                {explainStorage ? (
                  <p className="muted">
                    Browsers may remove stored data when a device runs short of space. Asking the browser to keep it lowers that risk, and
                    the browser has not granted it here. {durabilitySentence(durability)} A bundle is the copy that does not depend on the
                    browser.
                  </p>
                ) : null}
              </div>
              <div className="storage-banner-actions">
                <button type="button" className="button" onClick={exportNow}>
                  Export a backup
                </button>
                <button type="button" className="button is-quiet" aria-expanded={explainStorage} onClick={() => setExplainStorage((on) => !on)}>
                  Learn why
                </button>
                <button
                  type="button"
                  className="button is-quiet"
                  onClick={() => {
                    dismissBannerForVisit();
                    setBannerDismissed(true);
                  }}
                >
                  Dismiss
                </button>
              </div>
            </div>
          ) : null}
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
            agentEditMode={settingsNow.editor.agentEditMode}
          />
          {center === 'corkboard' && mediaView === null && narrow ? (
            <OpenOnDesktop
              feature="corkboard"
              actions={
                <button type="button" className="button" onClick={() => setCenter('editor')}>
                  Back to the editor
                </button>
              }
            />
          ) : null}
          {center === 'corkboard' && mediaView === null && !narrow ? (
            <Corkboard
              session={session}
              zoom={zoom}
              onZoom={setZoom}
              renaming={renaming?.surface === 'card' ? renaming.nodeId : null}
              onRename={renameOn('card')}
              onAskDelete={askDelete}
            />
          ) : null}
          {hideRails ? null : (
            <AgentPanel
              session={session}
              agent={agent}
              recurring={recurring}
              startIntent={startIntent}
              open={agentOpen}
              onToggle={() => setAgentOpen((on) => !on)}
              sample={sample}
            />
          )}
        </main>

        {hideRails ? null : narrow ? (
          <div id="narrow-sheet" className={`sheet${openPanel === 'inspector' ? ' is-open' : ''}`} onKeyDown={onPanelKey}>
            <div className="panel-head">
              <span className="panel-title">Inspector</span>
              <button type="button" id="narrow-close-inspector" className="button" aria-label="Close inspector" onClick={() => setPanel(null)}>
                Close
              </button>
            </div>
            <Inspector session={session} nodeId={selected} onOpenCodex={openCodexEntry} onAgentIntent={runAgentIntent} />
          </div>
        ) : (
          <Inspector session={session} nodeId={selected} onOpenCodex={openCodexEntry} onAgentIntent={runAgentIntent} />
        )}
        {openPanel === null ? null : <div className="scrim" data-testid="panel-scrim" aria-hidden="true" onClick={() => setPanel(null)} />}
        {overflow === null ? null : <Menu label="More" anchor={overflow} items={overflowItems} onClose={() => setOverflow(null)} />}

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
              Dismiss
            </button>
          </div>
        ) : null}

        <ConfirmDialog
          open={doomed !== undefined}
          title={doomed ? `Delete “${doomed.title}”?` : 'Delete?'}
          confirmLabel="Delete"
          onCancel={() => setAskingDelete(null)}
          onConfirm={confirmDelete}
        >
          {doomed ? (
            <DeleteSummary descendants={doomed.descendants} documents={doomed.documents} words={doomed.words} />
          ) : null}
        </ConfirmDialog>

        {exporting ? (
          <ExportDialog session={session} selection={exportSelection} onClose={() => setExporting(false)} />
        ) : null}
        <ProjectPanel session={session} />
        <SkillsPanel session={session} />
        <AgentInstructionsPanel session={session} services={services} onAgentIntent={runAgentIntent} />
        <VocabularyEditor session={session} />


        <ConfirmDialog
          open={folderOffer !== null && !folderQuestion(folderOffer).newFolder}
          title={folderOffer ? folderQuestion(folderOffer).title : 'Save to the folder?'}
          confirmLabel={folderOffer ? folderQuestion(folderOffer).confirm : 'Save'}
          onCancel={() => setFolderOffer(null)}
          onConfirm={answerFolderQuestion}
        >
          {folderOffer && !folderQuestion(folderOffer).newFolder ? folderQuestion(folderOffer).body : null}
        </ConfirmDialog>
        {/* The questions that can be answered with a new folder: changed documents, another project, and an earlier save of this one. */}
        <ChoiceDialog
          open={folderOffer !== null && folderQuestion(folderOffer).newFolder}
          title={folderOffer ? folderQuestion(folderOffer).title : 'Save to the folder?'}
          choices={[
            { label: 'Save as a new folder…', onChoose: saveAsNewFolder },
            { label: folderOffer ? folderQuestion(folderOffer).confirm : 'Save', onChoose: answerFolderQuestion, danger: true },
          ]}
          onCancel={() => setFolderOffer(null)}
        >
          {folderOffer && folderQuestion(folderOffer).newFolder ? folderQuestion(folderOffer).body : null}
        </ChoiceDialog>
        <ChoiceDialog
          open={notEmptyFolder !== null}
          title={notEmptyQuestion(notEmptyFolder ?? '').title}
          choices={[{ label: 'Choose another folder…', onChoose: saveAsNewFolder }]}
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
            onProvidersChanged={() => agent.refresh()}
          />
        ) : null}
      </div>
    </ReportContext.Provider>
  );
}

function DeleteSummary({ descendants, documents, words }: { descendants: number; documents: number; words: number }): ReactNode {
  if (descendants === 0) {
    return <p>This removes the item and its {wordsLabel(words)} from the project. You can undo it right after with Ctrl+Z.</p>;
  }
  const docs = documents > 0 ? `, and ${wordsLabel(words)} across ${documents} ${documents === 1 ? 'document' : 'documents'}` : '';
  return (
    <p>
      This removes the item, the {formatCount(descendants)} {descendants === 1 ? 'item' : 'items'} inside it{docs}. You can
      undo it right after with Ctrl+Z.
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
        <span className="rail-badge" aria-label={`${badge} open`} data-testid={`${tab}-badge`}>
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
            Export a backup
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
  const change = { changed: 'changed', removed: 'removed', added: 'added' } as const;
  return (
    <ul>
      {files.slice(0, MAX_VISIBLE_FOLDER_FILE_LABELS).map((file, index) => {
        const filePreviews = previews.filter((item) => item.label === file.label && item.change === file.change);
        return (
          <li key={index}>
            <div>{file.label}: {change[file.change]}</div>
            {filePreviews.map((preview, previewIndex) => (
              <section
                className="folder-file-preview"
                key={preview.path}
                role="region"
                aria-label={`Changes for ${file.label}${filePreviews.length > 1 ? `, file ${previewIndex + 1} of ${filePreviews.length}` : ''}`}
              >
                <p className="field-note">{filePreviews.length > 1 ? `File ${previewIndex + 1} of ${filePreviews.length} · ` : ''}− In the folder · + In this tab</p>
                <pre className="folder-diff">
                  {preview.lines.map((line, lineIndex) => {
                    const marker = line.kind === 'folder' ? '− ' : line.kind === 'tab' ? '+ ' : line.kind === 'context' ? '  ' : '… ';
                    return <span className={`folder-diff-line is-${line.kind}`} key={lineIndex}>{marker}{line.text || ' '}{'\n'}</span>;
                  })}
                </pre>
              </section>
            ))}
          </li>
        );
      })}
      {files.length > MAX_VISIBLE_FOLDER_FILE_LABELS ? (
        <li className="field-note">{files.length - MAX_VISIBLE_FOLDER_FILE_LABELS} more changed file labels are not shown.</li>
      ) : null}
      {omittedPreviews > 0 ? (
        <li className="field-note">Detailed comparisons for {omittedPreviews} more file{omittedPreviews === 1 ? '' : 's'} are not shown to keep the question manageable.</li>
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
      title: 'Some documents in this folder changed since Caotang last saved them',
      body: (
        <>
          {partial ? (
            <p>
              Another program changed these files in the folder while Caotang was saving, so the save stopped part way. The files before
              them were saved, and these were not:
            </p>
          ) : null}
          {after ? (
            <p>
              Another program changed these files in the folder while Caotang was saving. The save was written, and the folder now holds
              that program&rsquo;s version of them:
            </p>
          ) : null}
          {changedFilesList(files, previews, omittedPreviews)}
          <p>
            Saving writes this tab&rsquo;s version over them. The folder&rsquo;s version is kept first, in <code>.caotang-backup</code> in
            the folder, so if you need anything from it, copy it from there.
          </p>
        </>
      ),
      confirm: 'Save over them',
      newFolder: true,
    };
  }
  if (reason === 'locked') {
    return {
      title: 'Another program may be using this folder',
      body: after ? (
        <p>
          A lock file appeared in this folder while Caotang was saving, so another program, such as the Caotang MCP server, may have read
          the folder part way through the save. The save was written. Saving again now can overwrite what that program writes. Save again
          anyway?
        </p>
      ) : (
        <p>
          A lock file in this folder says that another program, such as the Caotang MCP server, may be using it. Saving now can overwrite
          what that program has written. If no such program is running, the lock was left behind when one closed. Save anyway?
        </p>
      ),
      confirm: 'Save anyway',
      newFolder: false,
    };
  }
  if (reason === 'changed' && removed) {
    return {
      title: 'This folder’s caotang.json was removed',
      body: (
        <>
          <p>
            Another program removed <code>caotang.json</code> from this folder after Caotang last loaded or saved it, so nothing was written.
          </p>
          <p>
            Saving here writes <code>caotang.json</code> back into the folder from this tab, with the project as this tab holds it.
          </p>
          {changedFilesList(files, previews, omittedPreviews)}
        </>
      ),
      confirm: 'Write it back',
      newFolder: false,
    };
  }
  if (reason === 'changed') {
    return {
      title: 'This folder changed since Caotang last saved it',
      body: (
        <>
          <p>
            <code>caotang.json</code> in this folder was changed by another program{' '}
            {after ? 'while Caotang was saving it, so the folder now holds that program’s version.' : 'after Caotang last loaded or saved it, so nothing was written.'}
          </p>
          <p>
            To see the folder&rsquo;s newer copy, go to Projects and open the folder again: it opens as a separate project. Saving here
            writes <code>caotang.json</code> from this tab, and an older one that is there is kept as a backup.
          </p>
          {changedFilesList(files, previews, omittedPreviews)}
        </>
      ),
      confirm: 'Save over it',
      newFolder: false,
    };
  }
  if (reason === 'earlier') {
    return {
      title: 'This folder holds an earlier save of this project',
      body: (
        <p>
          Caotang has no record of what this folder held when this project was last saved there, so it can&rsquo;t tell which documents
          changed since. Saving writes this tab&rsquo;s version over the folder&rsquo;s documents. The folder&rsquo;s version of each
          one it replaces is kept in <code>.caotang-backup</code> in the folder, and an older <code>caotang.json</code> is kept as a backup
          of its own, so if you need anything from it, copy it from there.
        </p>
      ),
      confirm: 'Save over it',
      newFolder: true,
    };
  }
  return {
    title: 'This folder already holds another project',
    body: (
      <p>
        Saving here replaces that project&rsquo;s <code>caotang.json</code> and any of its documents that share an id with this one.
        Caotang keeps a backup of that <code>caotang.json</code>, and copies each document it replaces to <code>.caotang-backup</code> in the
        folder.
      </p>
    ),
    confirm: 'Save over it',
    newFolder: true,
  };
}

/**
 * The question "Save as a new folder…" asks when the folder the writer picked is not empty: a new folder for this project must hold
 * nothing yet, so no file of another project or program is written over.
 */
function notEmptyQuestion(name: string): { readonly title: string; readonly body: ReactNode } {
  return {
    title: 'That folder is not empty',
    body: (
      <p>
        The folder &ldquo;{name}&rdquo; already has files in it, so nothing was saved there. A new folder for this project must be empty.
        Choose another folder, or make an empty one in the folder picker.
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
