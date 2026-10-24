/**
 * The corkboard — ui-modules §3. The children of one container, as cards in sibling
 * order. It has no commands of its own: every gesture here is a binder command
 * (`binder.move`, `binder.create`, `binder.rename`, `binder.setSynopsis`), and the
 * only things it owns are the scope it shows and the card size, both view state.
 */

import { useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { TreeNode } from '@caotang/store';

import {
  childrenOf,
  dropRefusalText,
  isMovable,
  planKeyboardMove,
  wordCountOf,
  type DropRefusal,
  type DropZone,
  type KeyboardStep,
} from '../app/binder-model.js';
import { isImeEnter, resolveKey } from '../app/keymap.js';
import {
  cardsOf,
  planCardDrop,
  resolveScope,
  scopePath,
  zoneForCard,
  type ZoomLevel,
} from '../app/corkboard-model.js';
import type { ProjectSession } from '../app/session.js';
import { SynopsisField } from './SynopsisField.js';
import { ZoomControl } from './ZoomControl.js';
import { createNode, createdNodeId, explain, moveNode, renameNode, selectNode } from './actions.js';
import {
  EmptyState,
  InlineText,
  Menu,
  formatCount,
  useReport,
  useSession,
  wordsLabel,
  type MenuAnchor,
  type MenuItem,
} from './shared.js';

export interface CorkboardProps {
  readonly session: ProjectSession;
  readonly zoom: ZoomLevel;
  readonly onZoom: (zoom: ZoomLevel) => void;
  readonly renaming: string | null;
  readonly onRename: (nodeId: string | null) => void;
  /**
   * Asks for a card's deletion through the binder's confirm (ui-modules §2.2). Delete on a card and its menu's Delete call it.
   * Required, so a board that is rendered without it fails the typecheck rather than silently ignoring Delete.
   */
  readonly onAskDelete: (nodeId: string) => void;
}

interface Hover {
  readonly cardId: string;
  readonly zone: DropZone;
  readonly refusal: DropRefusal | null;
}

export function Corkboard(props: CorkboardProps): ReactNode {
  const { session, zoom, onZoom, renaming, onRename, onAskDelete } = props;
  useSession(session);
  const report = useReport();
  const { state, view } = session;
  const scope = resolveScope(state, view.corkboardScope);
  const cards = cardsOf(state, scope);
  const [dragging, setDragging] = useState<string | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [menuAt, setMenuAt] = useState<MenuAnchor | null>(null);
  /** The menu Shift+F10 opened on a card: its name, where it sits, and its items as they were when it opened (ui-modules §2.5). */
  const [cardMenu, setCardMenu] = useState<{
    readonly label: string;
    readonly anchor: MenuAnchor;
    readonly items: readonly MenuItem[];
  } | null>(null);
  const boardRef = useRef<HTMLOListElement>(null);
  /** The card that holds the roving focus, so one card at a time is in the tab order (ui-modules §0.4). */
  const [focusId, setFocusId] = useState<string | null>(null);
  const rovingId = cards.some((card) => card.id === focusId) ? focusId : (cards[0]?.id ?? null);

  // The manuscript's children are chapters (ui-modules §2.4), so a card made on the manuscript board is a chapter. A scene
  // made there would sit directly under the manuscript, with no chapter for it to belong to.
  const create = (): void => {
    const outcome = createNode(session, scope.id, scope.id === 'manuscript' ? 'folder' : 'document');
    const id = createdNodeId(outcome);
    if (!outcome.ok) {
      report({ text: explain(outcome.error), tone: 'error' });
      return;
    }
    if (id !== undefined) {
      selectNode(session, id);
      onRename(id);
    }
  };

  const commitRename = (node: TreeNode, text: string): void => {
    onRename(null);
    if (text.length === 0 || text === node.title) return;
    const outcome = renameNode(session, node.id, text);
    if (!outcome.ok) report({ text: explain(outcome.error), tone: 'error' });
  };

  /**
   * Alt+arrow on a card moves it among its siblings, by the same plan the binder's keys make (ui-modules §3.2). The card keeps
   * focus, so a second press moves it again.
   */
  const keyboardReorder = (nodeId: string, step: KeyboardStep): void => {
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
    setTimeout(() => focusCard(nodeId), 0);
  };

  const focusCard = (nodeId: string): void => {
    const card = boardRef.current?.querySelector<HTMLElement>(`article[data-node-id="${CSS.escape(nodeId)}"]`);
    card?.focus();
  };

  /**
   * The card's menu, as the binder's row menu offers it for the same node (ui-modules §2.5): rename, the moves, and delete through the
   * binder's confirm. Nothing is offered for a reserved root, which a card never is.
   */
  const cardMenuItems = (node: TreeNode): MenuItem[] => {
    if (!isMovable(node)) return [];
    const items: MenuItem[] = [
      { key: 'rename', label: 'Rename', onSelect: () => onRename(node.id) },
      { key: 'move-up', label: 'Move up', onSelect: () => keyboardReorder(node.id, 'up') },
      { key: 'move-down', label: 'Move down', onSelect: () => keyboardReorder(node.id, 'down') },
    ];
    items.push({ key: 'delete', label: 'Delete…', danger: true, separatorBefore: true, onSelect: () => onAskDelete(node.id) });
    return items;
  };

  /**
   * Keys on a focused card (ui-modules §2.5, §3.2). Only a key pressed on the card itself is the card's: a key typed in its synopsis or
   * its rename field belongs to that field. Arrows move the focus along the board, Alt+arrow reorders the card, Enter or Space selects
   * it, F2 renames it, Delete asks for its deletion through the binder's confirm, and Shift+F10 opens its menu.
   */
  const onCardKey = (event: KeyboardEvent<HTMLElement>, nodeId: string): void => {
    if (event.target !== event.currentTarget) return;
    const action = resolveKey(
      {
        key: event.key,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        shift: event.shiftKey,
        alt: event.altKey,
        composing: isImeEnter(event.nativeEvent),
      },
      { inTextField: false, inBinder: false, inCorkboard: true },
    );
    if (action === 'reorder-up' || action === 'reorder-down') {
      event.preventDefault();
      keyboardReorder(nodeId, action === 'reorder-up' ? 'up' : 'down');
      return;
    }
    const node = cards.find((card) => card.id === nodeId);
    if (action === 'select-card') {
      event.preventDefault();
      selectNode(session, nodeId);
      return;
    }
    if (action === 'rename' && node !== undefined && isMovable(node)) {
      event.preventDefault();
      onRename(nodeId);
      return;
    }
    if (action === 'delete' && node !== undefined && isMovable(node)) {
      event.preventDefault();
      onAskDelete(nodeId);
      return;
    }
    if (action === 'open-menu') {
      event.preventDefault();
      if (node === undefined) return;
      const items = cardMenuItems(node);
      if (items.length === 0) return;
      const rect = event.currentTarget.getBoundingClientRect();
      setCardMenu({ label: `Actions for ${node.title}`, anchor: { x: rect.left + 24, y: rect.top + 24 }, items });
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const cardIds = cards.map((card) => card.id);
    const next = cardIds[cardIds.indexOf(nodeId) + step];
    if (next === undefined) return;
    setFocusId(next);
    focusCard(next);
  };

  /** The plan for a drag over a card (by horizontal half) or over the empty space (append). */
  const planFor = (
    event: DragEvent<HTMLElement>,
    target: { cardId: string } | 'board',
  ): { zone: DropZone; plan: ReturnType<typeof planCardDrop> } | null => {
    if (dragging === null) return null;
    if (target === 'board') {
      return { zone: 'into', plan: planCardDrop(state, dragging, { scopeId: scope.id }) };
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = rect.width === 0 ? 0.5 : (event.clientX - rect.left) / rect.width;
    const zone = zoneForCard(fraction);
    return { zone, plan: planCardDrop(state, dragging, { cardId: target.cardId, zone }) };
  };

  const onCardDragOver = (event: DragEvent<HTMLElement>, cardId: string): void => {
    const hit = planFor(event, { cardId });
    if (!hit) return;
    if (hit.plan.ok) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    }
    const next: Hover = { cardId, zone: hit.zone, refusal: hit.plan.ok ? null : hit.plan.reason };
    setHover((previous) => (sameHover(previous, next) ? previous : next));
  };

  const onDropPlan = (event: DragEvent<HTMLElement>, target: { cardId: string } | 'board'): void => {
    const hit = planFor(event, target);
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
    session.dispatch('view.setSelection', { nodeIds: [moving] });
  };

  const path = scopePath(state, scope);
  const refusalNote = hover?.refusal ? dropRefusalText(hover.refusal) : null;
  return (
    <div
      className="corkboard"
      onContextMenu={(event) => {
        // The empty board's own menu (ui-modules §3.2): a card, a button or a field keeps its own.
        const target = event.target as HTMLElement;
        if (target.closest('.card, button, textarea, input')) return;
        event.preventDefault();
        setMenuAt({ x: event.clientX, y: event.clientY });
      }}
    >
      <header className="corkboard-head">
        <nav aria-label="Corkboard scope">
          <ol className="crumbs">
            {path.map((name, index) => (
              <li key={`${index}-${name}`}>{name}</li>
            ))}
          </ol>
        </nav>
        <div className="corkboard-controls">
          <ZoomControl zoom={zoom} onZoom={onZoom} />
          <button type="button" className="button is-primary" onClick={create}>
            New card
          </button>
        </div>
      </header>

      {cards.length === 0 ? (
        <EmptyState
          title="No cards yet"
          actions={
            <button type="button" className="button is-primary" onClick={create}>
              New card
            </button>
          }
        >
          Drag scenes in from the binder, or create one. Each card holds a scene’s synopsis, and the order here is the
          order in the manuscript.
        </EmptyState>
      ) : (
        <ol
          ref={boardRef}
          className={`cards zoom-${zoom}`}
          aria-label={`Cards in ${scope.title}`}
          onDragOver={(event) => {
            // Empty space below the cards appends to the scope.
            if (event.target !== event.currentTarget) return;
            const hit = planFor(event, 'board');
            if (hit?.plan.ok) {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
            }
          }}
          onDrop={(event) => {
            if (event.target !== event.currentTarget) return;
            onDropPlan(event, 'board');
          }}
        >
          {cards.map((node) => {
            const cardHover = hover?.cardId === node.id ? hover : null;
            return (
              <li key={node.id} className="card-slot">
                <Card
                  session={session}
                  node={node}
                  zoom={zoom}
                  focusable={rovingId === node.id}
                  onFocusCard={() => setFocusId(node.id)}
                  onCardKey={(event) => onCardKey(event, node.id)}
                  selected={view.selection.includes(node.id)}
                  renaming={renaming === node.id && isMovable(node)}
                  dropZone={cardHover ? cardHover.zone : null}
                  dropRefused={cardHover !== null && cardHover.refusal !== null}
                  onRenameStart={() => onRename(node.id)}
                  onRenameCommit={(text) => commitRename(node, text)}
                  onRenameCancel={() => onRename(null)}
                  onGripStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', node.id);
                    const card = event.currentTarget.closest('.card');
                    if (card instanceof HTMLElement) event.dataTransfer.setDragImage(card, 16, 16);
                    setDragging(node.id);
                  }}
                  onGripEnd={() => {
                    setDragging(null);
                    setHover(null);
                  }}
                  onDragOver={(event) => onCardDragOver(event, node.id)}
                  onDrop={(event) => onDropPlan(event, { cardId: node.id })}
                />
              </li>
            );
          })}
        </ol>
      )}

      <p className="drop-note" role="status" aria-live="polite">
        {refusalNote ?? ''}
      </p>

      {menuAt ? (
        <Menu
          label={`Cards in ${scope.title}`}
          anchor={menuAt}
          items={[{ key: 'new-card', label: 'New card', onSelect: create }]}
          onClose={() => setMenuAt(null)}
        />
      ) : null}
      {cardMenu !== null ? (
        <Menu label={cardMenu.label} anchor={cardMenu.anchor} items={cardMenu.items} onClose={() => setCardMenu(null)} />
      ) : null}
    </div>
  );
}

function sameHover(a: Hover | null, b: Hover): boolean {
  return a !== null && a.cardId === b.cardId && a.zone === b.zone && a.refusal === b.refusal;
}

interface CardProps {
  readonly session: ProjectSession;
  readonly node: TreeNode;
  readonly zoom: ZoomLevel;
  /** The one card in the tab order: the board's roving focus (ui-modules §0.4). */
  readonly focusable: boolean;
  readonly onFocusCard: () => void;
  readonly onCardKey: (event: KeyboardEvent<HTMLElement>) => void;
  readonly selected: boolean;
  readonly renaming: boolean;
  readonly dropZone: DropZone | null;
  readonly dropRefused: boolean;
  readonly onRenameStart: () => void;
  readonly onRenameCommit: (text: string) => void;
  readonly onRenameCancel: () => void;
  readonly onGripStart: (event: DragEvent<HTMLElement>) => void;
  readonly onGripEnd: () => void;
  readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
  readonly onDrop: (event: DragEvent<HTMLElement>) => void;
}

function Card(props: CardProps): ReactNode {
  const { session, node, zoom, selected, renaming, dropZone } = props;
  const { state } = session;
  const status = node.status === null ? undefined : state.manifest.vocabulary.statuses.find((s) => s.id === node.status);
  const label = node.label === null ? undefined : state.manifest.vocabulary.labels.find((l) => l.id === node.label);
  const isContainerCard = node.type !== 'document';
  const childCount = isContainerCard ? childrenOf(state, node.id).length : 0;
  // Small cards are title only (ui-modules §3.2): no synopsis, no status and no footer count.
  const titleOnly = zoom === 'S';
  const dropClass = dropZone ? ` is-drop-${dropZone}${props.dropRefused ? ' is-refused' : ''}` : '';

  return (
    <article
      className={`card${selected ? ' is-selected' : ''}${dropClass}`}
      data-node-id={node.id}
      data-type={node.type}
      aria-label={node.title}
      tabIndex={props.focusable ? 0 : -1}
      onFocus={props.onFocusCard}
      onKeyDown={props.onCardKey}
      onClick={() => selectNode(session, node.id)}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
    >
      <header className="card-head">
        <span
          className="card-grip"
          draggable={isMovable(node) && !renaming}
          role="img"
          aria-label={`Drag ${node.title} to reorder`}
          onDragStart={props.onGripStart}
          onDragEnd={props.onGripEnd}
        >
          ⋮⋮
        </span>
        {renaming ? (
          <InlineText
            initial={node.title}
            label={`Rename ${node.title}`}
            className="card-rename"
            onCommit={props.onRenameCommit}
            onCancel={props.onRenameCancel}
          />
        ) : (
          <h3
            className="card-title"
            onDoubleClick={(event) => {
              if (!isMovable(node)) return;
              event.stopPropagation();
              props.onRenameStart();
            }}
          >
            {node.title}
          </h3>
        )}
        {titleOnly ? null : (
          // Every node carries a status, folders included (ui-modules §3.1).
          <span className="chip chip-status" title="Status">
            <span className="chip-dot" style={{ background: status?.color ?? 'var(--dot-empty)' }} aria-hidden="true" />
            {status?.name ?? (node.status === null ? 'No status' : 'Unknown status')}
          </span>
        )}
      </header>

      {titleOnly ? null : <SynopsisField session={session} nodeId={node.id} variant="card" />}

      {zoom === 'L' ? (
        <div className="card-labels">
          {label ? <span className="chip chip-label">{label.name}</span> : null}
          {node.keywords.map((keyword) => (
            <span key={keyword} className="chip chip-keyword">
              {keyword}
            </span>
          ))}
        </div>
      ) : null}

      {titleOnly ? null : (
        <footer className="card-foot">
          {isContainerCard ? (
            <span>{childCount === 1 ? '1 item' : `${formatCount(childCount)} items`}</span>
          ) : (
            <span>{wordsLabel(wordCountOf(state, node.id))}</span>
          )}
        </footer>
      )}
    </article>
  );
}
