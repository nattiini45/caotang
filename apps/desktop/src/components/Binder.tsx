/**
 * The binder — ui-modules §2. A flat tree (ARIA `tree` with `aria-level` on each row)
 * over the three tiers: the two fixed sections, their folders, and their documents.
 *
 * Every change it makes is one dispatch (see `actions.ts`). What it owns is only what
 * the spec says it owns: the expansion overrides and selection (both bus view state),
 * and which row is being renamed, dragged or hovered (ephemeral UI state).
 */

import {
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import type { ProjectState, TreeNode } from '@caotang/store';

import {
  SECTION_IDS,
  childrenOf,
  dropRefusalText,
  isContainer,
  isMovable,
  newDocumentRefusalText,
  newFolderParent,
  newItemParent,
  nodeById,
  planDrop,
  planKeyboardMove,
  type KeyboardStep,
  resolveZone,
  synopsisPreview,
  visibleRows,
  wordCountOf,
  type BinderRow,
  type DropPlan,
  type DropRefusal,
  type DropZone,
} from '../app/binder-model.js';
import { EMPTY_STATE_INTENTS } from '../app/empty-intents.js';
import { filterResultFor, furnitureFor } from '../app/furniture-store.js';
import { keyFacts, resolveKey } from '../app/keymap.js';
import { isImeEnter } from '../app/ime.js';
import type { ProjectSession } from '../app/session.js';
import { BinderFilterBar } from './BinderFilters.js';
import { ACCESS_LABELS, ACCESS_MARKERS, accessOf, effectiveAccess } from '../app/agent-rules-model.js';
import { mediaCreateItems, type MediaCreateSpec } from '../media/create-menu.js';
import { openDialog } from './dialog-requests.js';
import { useNarrow } from './narrow.js';
import { EmptyState, InlineText, Menu, useReport, useSession, wordsLabel, type MenuAnchor, type MenuItem } from './shared.js';
import { ScriptImportActions } from './ScriptImport.js';
import {
  createNode,
  createdNodeId,
  explain,
  liveSelection,
  moveNode,
  renameNode,
  selectNode,
  setExpanded,
  setLabel,
  setStatus,
} from './actions.js';

export type CenterMode = 'editor' | 'corkboard';

export interface BinderProps {
  readonly session: ProjectSession;
  readonly renaming: string | null;
  readonly onRename: (nodeId: string | null) => void;
  readonly onAskDelete: (nodeId: string) => void;
  readonly onShowCenter: (mode: CenterMode) => void;
  /** A document was chosen to be written in, from a row or its menu (not made by "New document"). The narrow layout closes the drawer on it. */
  readonly onOpened?: () => void;
  readonly onFocusSynopsis: () => void;
  /** Sends a plain-language request to the agent: the empty states' next step (ui-modules §0.3). Opens the agent panel. */
  readonly onAgentIntent: (intent: string) => void;
}

interface Hover {
  readonly nodeId: string;
  readonly zone: DropZone;
  readonly refusal: DropRefusal | null;
}

type Picker =
  | { readonly kind: 'context'; readonly nodeId: string; readonly anchor: MenuAnchor }
  | { readonly kind: 'status'; readonly nodeId: string; readonly anchor: MenuAnchor }
  | { readonly kind: 'label'; readonly nodeId: string; readonly anchor: MenuAnchor };

export function Binder(props: BinderProps): ReactNode {
  const { session, renaming, onRename, onAskDelete, onShowCenter, onOpened, onFocusSynopsis, onAgentIntent } = props;
  useSession(session);
  const narrow = useNarrow();
  const report = useReport();
  const { state, view } = session;
  const furniture = furnitureFor(session);
  const applied = useSyncExternalStore(furniture.subscribe, furniture.snapshot).applied;
  // binder-filters §3: a filter shows its matches with their ancestors, and both roots. Every container is opened for it, so a
  // match inside a folder the writer had closed is not hidden. Without a filter the binder shows what the writer has opened.
  const filtered = applied === null ? null : filterResultFor(state, applied.criteria, new Date());
  const filteredIds = filtered === null ? null : new Set(filtered.visible);
  const rows =
    filteredIds === null
      ? visibleRows(state, view.expanded)
      : visibleRows(state, Object.fromEntries(state.manifest.tree.filter(isContainer).map((node) => [node.id, true]))).filter((row) =>
          filteredIds.has(row.node.id),
        );
  const selected = liveSelection(state, view.selection);
  const [dragging, setDragging] = useState<string | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  // Read only from event handlers: the row elements are found in the tree when focus moves.
  const focusRow = (nodeId: string): void => {
    const row = treeRef.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(nodeId)}"]`);
    row?.focus();
  };

  /**
   * A click: select the node, and show what it is — a document in the editor, a container on the corkboard. A dialogue
   * container is a document-like node with its own view in the editor (media/README.md), so it shows there too.
   */
  const choose = (nodeId: string): void => {
    selectNode(session, nodeId);
    const node = nodeById(state, nodeId);
    onShowCenter(node?.type === 'document' || node?.type === 'dialogue' ? 'editor' : 'corkboard');
  };

  /**
   * Create a node and put its title in rename mode, so the writer can type the name at
   * once. A named create (the empty state's "Chapter 1") skips the rename, because the
   * name is already the one it wants.
   */
  const create = (parentId: string, type: 'folder' | 'document', title = 'Untitled'): void => {
    const refused = type === 'document' ? newDocumentRefusalText(parentId) : undefined;
    if (refused !== undefined) {
      report({ text: refused, tone: 'error' });
      return;
    }
    const outcome = createNode(session, parentId, type, title);
    const id = createdNodeId(outcome);
    if (!outcome.ok) {
      report({ text: explain(outcome.error), tone: 'error' });
      return;
    }
    if (id === undefined) return;
    choose(id);
    if (title === 'Untitled') onRename(id);
  };

  /** A media node (screenplay, dialogue and storyboard; media-track.md): the bus checks the kind and the parent, and the new node is renamed like any other. */
  const createMedia = (parentId: string, spec: MediaCreateSpec): void => {
    const outcome = session.dispatch('binder.create', {
      parentId,
      type: spec.type,
      title: spec.title,
      ...(spec.kind === undefined ? {} : { kind: spec.kind }),
    });
    if (!outcome.ok) {
      report({ text: explain(outcome.error), tone: 'error' });
      return;
    }
    const id = createdNodeId(outcome);
    if (id === undefined) return;
    choose(id);
    onRename(id);
  };

  const commitRename = (nodeId: string, text: string): void => {
    onRename(null);
    const node = nodeById(state, nodeId);
    // An empty or unchanged title is not a rename, and the command would refuse the empty one.
    if (!node || text.length === 0 || text === node.title) return;
    const outcome = renameNode(session, nodeId, text);
    if (!outcome.ok) report({ text: explain(outcome.error), tone: 'error' });
  };

  /* ------------------------------------------------------------------ *
   * Drag and drop
   * ------------------------------------------------------------------ */

  const dropAt = (event: DragEvent<HTMLElement>, node: TreeNode): { zone: DropZone; plan: DropPlan } | null => {
    if (dragging === null) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = rect.height === 0 ? 0.5 : (event.clientY - rect.top) / rect.height;
    const zone = resolveZone(node, fraction);
    return { zone, plan: planDrop(state, dragging, { nodeId: node.id, zone }) };
  };

  const onDragOver = (event: DragEvent<HTMLElement>, node: TreeNode): void => {
    const hit = dropAt(event, node);
    if (!hit) return;
    // Only a valid target takes the drop. An invalid one gets no `preventDefault`, so the
    // browser shows its no-drop cursor, which is the whole refusal (ui-modules §2.3).
    if (hit.plan.ok) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    }
    const next: Hover = {
      nodeId: node.id,
      zone: hit.zone,
      refusal: hit.plan.ok ? null : hit.plan.reason,
    };
    setHover((previous) => (sameHover(previous, next) ? previous : next));
  };

  const onDrop = (event: DragEvent<HTMLElement>, node: TreeNode): void => {
    const hit = dropAt(event, node);
    const moving = dragging;
    setHover(null);
    setDragging(null);
    if (!hit || moving === null || !hit.plan.ok) return;
    event.preventDefault();
    const outcome = moveNode(session, moving, hit.plan);
    if (!outcome.ok) {
      report({ text: explain(outcome.error), tone: 'error' });
      return;
    }
    // The moved node stays the selection, so the next keystroke acts on what was dragged.
    session.dispatch('view.setSelection', { nodeIds: [moving] });
  };

  /* ------------------------------------------------------------------ *
   * Keyboard inside the tree (ui-modules §2.5). Chords belong to the shell.
   * ------------------------------------------------------------------ */

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target instanceof HTMLInputElement) return; // a rename field owns its keys
    if (event.ctrlKey || event.metaKey) return;
    const action = resolveKey(
      { ...keyFacts(event), ctrl: false, meta: false, composing: isImeEnter(event) },
      { inTextField: false, inBinder: true },
    );
    if (action === null) return;
    const index = rows.findIndex((row) => row.node.id === selected);
    const current = index === -1 ? undefined : rows[index];
    event.preventDefault();

    const step = (delta: number): void => {
      const next = rows[index + delta];
      if (index === -1) {
        const first = rows[0];
        if (first) {
          session.dispatch('view.setSelection', { nodeIds: [first.node.id] });
          focusRow(first.node.id);
        }
        return;
      }
      if (!next) return;
      session.dispatch('view.setSelection', { nodeIds: [next.node.id] });
      focusRow(next.node.id);
    };

    switch (action) {
      case 'move-down':
        step(1);
        return;
      case 'move-up':
        step(-1);
        return;
      case 'move-left': {
        if (!current) return;
        if (current.kind === 'node' && current.container && current.expanded) {
          setExpanded(session, current.node.id, false);
          return;
        }
        const parent = current.node.parentId === null ? undefined : nodeById(state, current.node.parentId);
        if (parent && parent.type !== 'root') {
          session.dispatch('view.setSelection', { nodeIds: [parent.id] });
          focusRow(parent.id);
        }
        return;
      }
      case 'move-right': {
        if (!current || current.kind !== 'node' || !current.container) return;
        if (!current.expanded) {
          setExpanded(session, current.node.id, true);
          return;
        }
        const first = childrenOf(state, current.node.id)[0];
        if (first) {
          session.dispatch('view.setSelection', { nodeIds: [first.id] });
          focusRow(first.id);
        }
        return;
      }
      case 'rename':
        if (current && isMovable(current.node)) onRename(current.node.id);
        return;
      case 'delete':
        if (current && isMovable(current.node)) onAskDelete(current.node.id);
        return;
      case 'reorder-up':
        if (current) keyboardMove(current.node.id, 'up');
        return;
      case 'reorder-down':
        if (current) keyboardMove(current.node.id, 'down');
        return;
      case 'reparent-out':
        if (current) keyboardMove(current.node.id, 'out');
        return;
      case 'reparent-in':
        if (current) keyboardMove(current.node.id, 'in');
        return;
      default:
        return;
    }
  };

  /**
   * A keyboard or menu move (ui-modules §2.5): the same plan a drop makes, dispatched as `binder.move`, with the moved row
   * kept in focus. A move with nowhere to go says why in the status line, and changes nothing.
   */
  const keyboardMove = (nodeId: string, step: KeyboardStep): void => {
    const plan = planKeyboardMove(state, nodeId, step);
    if (!plan.ok) {
      report({ text: dropRefusalText(plan.reason), tone: 'info' });
      return;
    }
    const outcome = session.dispatch('binder.move', { nodeId, newParentId: plan.newParentId, index: plan.index });
    if (!outcome.ok) {
      report({ text: explain(outcome.error), tone: 'error' });
      return;
    }
    // The row is re-rendered in its new place after this handler returns, so the focus moves once it is there. The row is
    // found in the document rather than through the tree's ref, which a menu item built during render must not read.
    setTimeout(() => {
      document.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(nodeId)}"]`)?.focus();
    }, 0);
  };

  /* ------------------------------------------------------------------ *
   * Pickers and the context menu
   * ------------------------------------------------------------------ */

  const pickerItems = (open: Picker): MenuItem[] => {
    const node = nodeById(state, open.nodeId);
    if (!node) return [];
    if (open.kind === 'status') {
      return [
        ...state.manifest.vocabulary.statuses.map((status) => ({
          key: `status-${status.id}`,
          label: status.name,
          checked: node.status === status.id,
          onSelect: () => apply(setStatus(session, node.id, status.id)),
        })),
        {
          key: 'status-none',
          label: 'No status',
          checked: node.status === null,
          separatorBefore: true,
          onSelect: () => apply(setStatus(session, node.id, null)),
        },
        // "+ Add" opens the vocabulary editor (ui-modules §2.2).
        { key: 'status-add', label: '+ Add status…', separatorBefore: true, onSelect: () => openDialog({ kind: 'vocabulary', term: 'status' }) },
      ];
    }
    if (open.kind === 'label') {
      const labels = state.manifest.vocabulary.labels;
      // "+ Add" opens the vocabulary editor (ui-modules §2.2). With no label yet, it is the only entry.
      const addLabel: MenuItem = {
        key: 'label-add',
        label: '+ Add label…',
        separatorBefore: labels.length > 0,
        onSelect: () => openDialog({ kind: 'vocabulary', term: 'label' }),
      };
      if (labels.length === 0) return [addLabel];
      return [
        ...labels.map((label) => ({
          key: `label-${label.id}`,
          label: label.name,
          checked: node.label === label.id,
          onSelect: () => apply(setLabel(session, node.id, label.id)),
        })),
        {
          key: 'label-none',
          label: 'No label',
          checked: node.label === null,
          separatorBefore: true,
          onSelect: () => apply(setLabel(session, node.id, null)),
        },
        addLabel,
      ];
    }
    return contextItems(node);
  };

  const apply = (outcome: ReturnType<typeof setStatus>): void => {
    if (!outcome.ok) report({ text: explain(outcome.error), tone: 'error' });
  };

  const contextItems = (node: TreeNode): MenuItem[] => {
    const items: MenuItem[] = [];
    const isSection = (SECTION_IDS as readonly string[]).includes(node.id);
    if (node.type === 'document') {
      items.push({
        key: 'open',
        label: 'Open in editor',
        onSelect: () => {
          session.dispatch('view.setActiveDoc', { docId: node.id });
          onShowCenter('editor');
          onOpened?.();
        },
      });
    }
    if (isContainer(node)) {
      // The manuscript takes chapters only, so a document there would be refused: the menu offers it on a chapter or research.
      if (node.id !== 'manuscript') {
        items.push({ key: 'new-document', label: 'New document here', onSelect: () => create(node.id, 'document') });
      }
      // A folder sits directly in a section and never in another folder (ARCHITECTURE §2.2), so only a section offers one.
      if (isSection) {
        items.push({ key: 'new-folder', label: 'New folder here', onSelect: () => create(node.id, 'folder') });
      }
    }
    // The media kinds a folder or a storyboard earns (media/create-menu.ts). A section gets the same entries as a folder.
    items.push(...mediaCreateItems(node, createMedia));
    if (!isSection) {
      items.push({
        key: 'synopsis',
        label: 'Edit synopsis',
        onSelect: () => {
          choose(node.id);
          onFocusSynopsis();
        },
      });
      items.push({ key: 'rename', label: 'Rename', onSelect: () => onRename(node.id) });
    }
    // How far the agent may go here (agent-harness §4, Rules): one project rule, kept in the project's file. A section is not a place the
    // writer restricts as a whole, but its folders are, so the manuscript and research roots offer it too.
    const held = effectiveAccess(session.agentRules(), state, node.id);
    if (held.inheritedFrom !== undefined) {
      items.push({
        key: 'agent-inherited',
        label: `${ACCESS_LABELS[held.access]} (set on ${held.inheritedFrom.title})`,
        onSelect: () => undefined,
        disabled: true,
        separatorBefore: true,
      });
    } else {
      for (const [index, access] of (['full', 'read-only', 'none'] as const).entries()) {
        items.push({
          key: `agent-${access}`,
          label: ACCESS_LABELS[access],
          checked: held.access === access,
          ...(index === 0 ? { separatorBefore: true } : {}),
          onSelect: () => session.setAgentAccess(node.id, access),
        });
      }
    }
    if (isMovable(node)) {
      // The keyboard's moves, as menu entries, so a writer who does not use Alt+arrow still reorders (ui-modules §0.4).
      items.push(
        { key: 'move-up', label: 'Move up', onSelect: () => keyboardMove(node.id, 'up') },
        { key: 'move-down', label: 'Move down', onSelect: () => keyboardMove(node.id, 'down') },
        { key: 'move-out', label: 'Move out of folder', onSelect: () => keyboardMove(node.id, 'out') },
        { key: 'move-in', label: 'Move into folder above', onSelect: () => keyboardMove(node.id, 'in') },
      );
      items.push({
        key: 'delete',
        label: 'Delete…',
        danger: true,
        separatorBefore: true,
        onSelect: () => onAskDelete(node.id),
      });
    }
    return items;
  };

  const openPicker = (event: ReactMouseEvent<HTMLElement>, kind: Picker['kind'], nodeId: string): void => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setPicker({ kind, nodeId, anchor: { x: rect.left, y: rect.bottom + 4 } });
  };

  /**
   * The row's Actions button, shown in the narrow layout: a touch screen has no right click, and a long press opens no menu on every
   * browser. It opens the row's own menu under the button.
   */
  const actionsAt = (event: ReactMouseEvent<HTMLElement>, nodeId: string): void => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    session.dispatch('view.setSelection', { nodeIds: [nodeId] });
    setPicker({ kind: 'context', nodeId, anchor: { x: Math.max(8, rect.right - 220), y: rect.bottom + 4 } });
  };

  const contextMenuAt = (event: ReactMouseEvent<HTMLElement>, nodeId: string): void => {
    event.preventDefault();
    event.stopPropagation();
    session.dispatch('view.setSelection', { nodeIds: [nodeId] });
    setPicker({ kind: 'context', nodeId, anchor: { x: event.clientX, y: event.clientY } });
  };

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */

  const agentRules = session.agentRules();
  const agentAccessOf = (nodeId: string): 'read-only' | 'none' | null => {
    const access = accessOf(agentRules, nodeId);
    return access === 'full' ? null : access;
  };
  const parentForNew = newItemParent(state, selected);
  const sectionForNewFolder = newFolderParent(state, selected);
  // Roving focus (ui-modules §2.5): one row is in the tab order, the selected one when it is showing, and
  // otherwise the first. Without that, a load with nothing selected leaves no row for Tab to reach.
  const tabStopId = rows.some((row) => row.node.id === selected) ? selected : (rows[0]?.node.id ?? null);
  const manuscriptEmpty = childrenOf(state, 'manuscript').length === 0;
  const researchEmpty = childrenOf(state, 'research').length === 0;
  const openPickerNode = picker ? nodeById(state, picker.nodeId) : undefined;
  // A refused drag says why, in words, beside the tree: the cursor alone is not enough.
  const refusalNote = hover?.refusal ? dropRefusalText(hover.refusal) : null;

  return (
    <div className="binder">
      <div className="binder-toolbar" role="toolbar" aria-label="Binder actions">
        <button type="button" className="button" onClick={() => create(parentForNew, 'document')} aria-keyshortcuts="Control+N">
          New document
        </button>
        <button type="button" className="button" onClick={() => create(sectionForNewFolder, 'folder')}>
          New folder
        </button>
      </div>
      <ScriptImportActions session={session} />
      <BinderFilterBar session={session} />
      {filtered !== null && filtered.matchCount === 0 ? (
        <EmptyState
          title="No scenes match"
          actions={
            <button type="button" className="button is-quiet" onClick={() => furniture.clearFilter()}>
              Clear filter
            </button>
          }
        >
          Nothing in the binder matches this filter. Clear it to see the whole binder.
        </EmptyState>
      ) : null}

      <div
        ref={treeRef}
        role="tree"
        aria-label="Binder"
        className="binder-tree"
        onKeyDown={onKeyDown}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHover(null);
        }}
      >
        {rows.map((row) => {
          const isSelected = row.node.id === selected;
          const isRenaming = renaming === row.node.id;
          const rowHover = hover?.nodeId === row.node.id ? hover : null;
          return (
            <BinderRowView
              key={row.node.id}
              row={row}
              state={state}
              selected={isSelected}
              focusable={row.node.id === tabStopId}
              renaming={isRenaming}
              hover={rowHover}
              onSelect={() => {
                choose(row.node.id);
                if (row.node.type === 'document' || row.node.type === 'dialogue') onOpened?.();
              }}
              onToggle={() => setExpanded(session, row.node.id, row.kind === 'node' ? !row.expanded : true)}
              onRenameStart={() => onRename(row.node.id)}
              onRenameCommit={(text) => commitRename(row.node.id, text)}
              onRenameCancel={() => onRename(null)}
              onStatusPicker={(event) => openPicker(event, 'status', row.node.id)}
              onLabelPicker={(event) => openPicker(event, 'label', row.node.id)}
              onContextMenu={(event) => contextMenuAt(event, row.node.id)}
              onActions={narrow ? (event) => actionsAt(event, row.node.id) : undefined}
              agentAccess={agentAccessOf(row.node.id)}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', row.node.id);
                setDragging(row.node.id);
              }}
              onDragEnd={() => {
                setDragging(null);
                setHover(null);
              }}
              onDragOver={(event) => onDragOver(event, row.node)}
              onDrop={(event) => onDrop(event, row.node)}
            />
          );
        })}
      </div>

      <p className="drop-note" role="status" aria-live="polite">
        {refusalNote ?? ''}
      </p>

      {manuscriptEmpty ? (
        <EmptyState
          title="The manuscript is empty"
          actions={
            <>
              <button type="button" className="button is-primary" onClick={() => create('manuscript', 'folder', 'Chapter 1')}>
                Create Chapter 1
              </button>
              <button type="button" className="button" onClick={() => onAgentIntent(EMPTY_STATE_INTENTS.restructure)}>
                Let the agent structure it
              </button>
            </>
          }
        >
          Chapters hold scenes. Start with one, then add scenes to it from the corkboard or here.
        </EmptyState>
      ) : null}

      {researchEmpty ? (
        <EmptyState
          title="Research is empty"
          actions={
            <button type="button" className="button" onClick={() => create('research', 'document')}>
              New research note
            </button>
          }
        >
          Research holds notes that stay out of the manuscript. Start with one note, written first.
        </EmptyState>
      ) : null}

      {picker && openPickerNode ? (
        <Menu
          label={
            picker.kind === 'status' ? 'Status' : picker.kind === 'label' ? 'Label' : `Actions for ${openPickerNode.title}`
          }
          anchor={picker.anchor}
          items={pickerItems(picker)}
          onClose={() => setPicker(null)}
        />
      ) : null}
    </div>
  );
}

function sameHover(a: Hover | null, b: Hover): boolean {
  return a !== null && a.nodeId === b.nodeId && a.zone === b.zone && a.refusal === b.refusal;
}

/** "1 item" or "3 items" — the count a folder or section shows beside its name. */
function itemsLabel(count: number): string {
  return count === 1 ? '1 item' : `${count} items`;
}

interface RowViewProps {
  readonly row: BinderRow;
  readonly state: ProjectState;
  readonly selected: boolean;
  /** The row that is in the tab order (see `tabStopId` in `Binder`). */
  readonly focusable: boolean;
  readonly renaming: boolean;
  readonly hover: Hover | null;
  readonly onSelect: () => void;
  readonly onToggle: () => void;
  readonly onRenameStart: () => void;
  readonly onRenameCommit: (text: string) => void;
  readonly onRenameCancel: () => void;
  readonly onStatusPicker: (event: ReactMouseEvent<HTMLElement>) => void;
  readonly onLabelPicker: (event: ReactMouseEvent<HTMLElement>) => void;
  readonly onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  /** Opens the row's menu from a button, where the narrow layout has no right click. Absent on a wide window. */
  readonly onActions?: (event: ReactMouseEvent<HTMLElement>) => void;
  /** How far the agent may go here, when a rule limits it. */
  readonly agentAccess: 'read-only' | 'none' | null;
  readonly onDragStart: (event: DragEvent<HTMLElement>) => void;
  readonly onDragEnd: () => void;
  readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
  readonly onDrop: (event: DragEvent<HTMLElement>) => void;
}

/**
 * One row. A section is a header (no chevron, not draggable, not renameable). A node
 * row carries its status chip, label chip, word count, and the synopsis tooltip.
 */
function BinderRowView(props: RowViewProps): ReactNode {
  const { row, state, selected, renaming, hover } = props;
  const node = row.node;
  const vocabStatus = node.status === null ? undefined : state.manifest.vocabulary.statuses.find((s) => s.id === node.status);
  const vocabLabel = node.label === null ? undefined : state.manifest.vocabulary.labels.find((l) => l.id === node.label);
  const tooltip = synopsisPreview(node.synopsis);
  const dropClass = hover ? ` is-drop-${hover.zone}${hover.refusal ? ' is-refused' : ''}` : '';

  if (row.kind === 'section') {
    return (
      <div
        role="treeitem"
        aria-level={1}
        aria-expanded={true}
        aria-selected={selected}
        aria-label={node.title}
        tabIndex={props.focusable ? 0 : -1}
        className={`row is-section${selected ? ' is-selected' : ''}${dropClass}`}
        data-node-id={node.id}
        onClick={props.onSelect}
        onContextMenu={props.onContextMenu}
        onDragOver={props.onDragOver}
        onDrop={props.onDrop}
      >
        <span className="row-title">{node.title}</span>
        <span className="row-meta">
          {props.agentAccess === null ? null : (
            <span className="row-agent" data-agent-access={props.agentAccess}>
              <span aria-hidden="true">{props.agentAccess === 'none' ? '◌' : '▭'}</span> {ACCESS_MARKERS[props.agentAccess]}
            </span>
          )}
          {itemsLabel(childrenOf(state, node.id).length)}
        </span>
        <RowActions title={node.title} onActions={props.onActions} />
      </div>
    );
  }

  const movable = isMovable(node);
  const container = row.container;
  const count = container ? childrenOf(state, node.id).length : 0;
  const indent = 8 + row.depth * 18;

  return (
    <div
      role="treeitem"
      aria-level={row.depth + 2}
      aria-expanded={container ? row.expanded : undefined}
      aria-selected={selected}
      tabIndex={props.focusable ? 0 : -1}
      draggable={movable && !renaming}
      title={tooltip}
      className={`row${selected ? ' is-selected' : ''}${dropClass}`}
      data-node-id={node.id}
      data-type={node.type}
      style={{ paddingInlineStart: `${indent}px` }}
      onClick={props.onSelect}
      onDoubleClick={(event) => {
        if (movable) {
          event.stopPropagation();
          props.onRenameStart();
        }
      }}
      onContextMenu={props.onContextMenu}
      onDragStart={props.onDragStart}
      onDragEnd={props.onDragEnd}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
    >
      {container ? (
        <button
          type="button"
          tabIndex={-1}
          className="row-toggle"
          aria-label={`${row.expanded ? 'Collapse' : 'Expand'} ${node.title}`}
          onClick={(event) => {
            event.stopPropagation();
            props.onToggle();
          }}
        >
          <span aria-hidden="true">{row.expanded ? '▾' : '▸'}</span>
        </button>
      ) : (
        <span className="row-toggle-gap" aria-hidden="true" />
      )}

      {renaming && movable ? (
        <InlineText
          initial={node.title}
          label={`Rename ${node.title}`}
          className="row-rename"
          onCommit={props.onRenameCommit}
          onCancel={props.onRenameCancel}
        />
      ) : (
        <span className="row-title">{node.title}</span>
      )}

      <span className="row-meta">
        {/* Every node carries a status, folders included (ui-modules §2.1, §4.2). An unset one is a bare dot, so the row keeps its room for the title. */}
        <button
          type="button"
          tabIndex={-1}
          className={`chip chip-status${vocabStatus ? '' : ' is-bare'}`}
          aria-haspopup="menu"
          aria-label={`Status of ${node.title}: ${vocabStatus?.name ?? (node.status ?? 'none')}. Change status`}
          title={vocabStatus?.name ?? (node.status === null ? 'No status' : 'Unknown status')}
          onClick={props.onStatusPicker}
        >
          <span className="chip-dot" style={{ background: vocabStatus?.color ?? 'var(--dot-empty)' }} aria-hidden="true" />
          {vocabStatus ? vocabStatus.name : node.status === null ? null : 'Unknown status'}
        </button>
        {node.label !== null ? (
          <button
            type="button"
            tabIndex={-1}
            className="chip chip-label"
            aria-haspopup="menu"
            aria-label={`Label of ${node.title}: ${vocabLabel?.name ?? node.label}. Change label`}
            onClick={props.onLabelPicker}
          >
            {vocabLabel?.name ?? 'Unknown label'}
          </button>
        ) : null}
        {props.agentAccess === null ? null : (
          <span className="row-agent" data-agent-access={props.agentAccess}>
            <span aria-hidden="true">{props.agentAccess === 'none' ? '◌' : '▭'}</span> {ACCESS_MARKERS[props.agentAccess]}
          </span>
        )}
        {node.type === 'document' ? <span className="row-count">{wordsLabel(wordCountOf(state, node.id))}</span> : null}
        {container ? <span className="row-count">{itemsLabel(count)}</span> : null}
      </span>
      <RowActions title={node.title} onActions={props.onActions} />
    </div>
  );
}

/** The Actions button of a row in the narrow layout. It is not a tab stop: the row's own menu key opens the same menu. */
function RowActions({ title, onActions }: { title: string; onActions: ((event: ReactMouseEvent<HTMLElement>) => void) | undefined }): ReactNode {
  if (onActions === undefined) return null;
  return (
    <button type="button" tabIndex={-1} className="row-actions" aria-haspopup="menu" aria-label={`Actions for ${title}`} onClick={onActions}>
      <span aria-hidden="true">⋯</span>
    </button>
  );
}
