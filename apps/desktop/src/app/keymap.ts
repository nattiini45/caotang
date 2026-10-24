/**
 * The keyboard map — ui-modules §2.5, plus the two app-wide chords the shell needs.
 *
 * Pure on purpose: the React layer translates a DOM `KeyboardEvent` into the four
 * facts this function reads, and the table itself can be tested without a browser.
 *
 * The rule that matters most: **a key typed into a text field is never a shortcut**.
 * Ctrl+Z inside the editor is the editor's own undo (editor-engine §7's lane 1), so
 * the app-wide undo chord yields to any field, and so do the bare keys (F2, Delete,
 * arrows) that would otherwise eat a keystroke a writer meant as text.
 *
 * The same rule covers an input method's candidate window (ui-modules §2.5): the Enter that commits a candidate is the
 * writer's text, not an app action, so a composing Enter resolves to nothing at all.
 */

export type KeyAction =
  | 'new-document'
  | 'rename'
  | 'delete'
  | 'open-in-editor'
  | 'focus-mode'
  | 'focus-filter'
  | 'undo'
  | 'escape'
  | 'move-up'
  | 'move-down'
  | 'move-left'
  | 'move-right'
  | 'reorder-up'
  | 'reorder-down'
  | 'reparent-out'
  | 'reparent-in'
  | 'select-card'
  | 'open-menu'
  | 'agent-send'
  | 'agent-steer'
  | 'agent-stop';

export interface KeyFacts {
  /** `KeyboardEvent.key`, e.g. `'n'`, `'Enter'`, `'F2'`, `'ArrowUp'`. */
  readonly key: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  /**
   * True when the key event belongs to an IME composition (`KeyboardEvent.isComposing`, or the older Windows
   * `keyCode === 229`): its Enter commits a candidate, so it is never an app action.
   */
  readonly composing: boolean;
}

/** The parts of a key event that say whether it belongs to an IME composition. A DOM `KeyboardEvent` has both facts. */
export interface CompositionFacts {
  readonly isComposing?: boolean;
  readonly keyCode?: number;
}

/**
 * True when a key event belongs to an IME composition, and so is the candidate window's to act on rather than the app's.
 * `isComposing` is the standard fact; `keyCode === 229` is what older Windows paths send for a key the input method is
 * processing. A React handler passes `event.nativeEvent`, the DOM event both facts belong to.
 *
 * One guard for every Enter-handling site (ui-modules §2.5), so no site re-implements the test and a new one cannot forget it.
 */
export function isImeEnter(event: CompositionFacts): boolean {
  return event.isComposing === true || event.keyCode === 229;
}

export interface KeyContext {
  /** True when the focus is in a text field (textarea, input, contenteditable). */
  readonly inTextField: boolean;
  /** True when the focus is on the binder tree, where the tree keys apply. */
  readonly inBinder: boolean;
  /** True when the focus is on a corkboard card, where the Alt+arrow reorder keys apply (ui-modules §3.2). */
  readonly inCorkboard?: boolean;
  /** True when the focus is inside the agent panel, where Escape stops a running turn. */
  readonly inAgent?: boolean;
  /** True when the agent's Intent box has no text, so Escape is not a half-typed message's to lose. */
  readonly agentIntentEmpty?: boolean;
  /** True when the focus is in the agent's Intent box, where Enter sends or queues and Ctrl+Enter steers. */
  readonly inAgentIntent?: boolean;
}

/** Ctrl on Windows and Linux, Cmd on macOS — either counts as the command modifier. */
function command(facts: KeyFacts): boolean {
  return facts.ctrl || facts.meta;
}

/**
 * The action a keystroke asks for, or `null` when it means nothing to the app.
 *
 * Order matters in one place: the chords (which carry the command modifier) are
 * checked first, so Ctrl+Enter is "open" and not a bare Enter.
 */
export function resolveKey(facts: KeyFacts, context: KeyContext): KeyAction | null {
  const cmd = command(facts);
  const key = facts.key.length === 1 ? facts.key.toLowerCase() : facts.key;

  // ui-modules §2.5: the Enter that commits an IME candidate is the input method's, never the app's. It is refused here,
  // before any Enter chord is looked at, so agent-send, agent-steer and open-in-editor all yield — and so does any Enter
  // action added later. Other keys keep their meaning: a composition is not a reason to silence the whole keyboard.
  if (facts.composing && key === 'Enter') return null;

  if (cmd && !facts.alt && key === 'n' && !facts.shift) return 'new-document';
  if (cmd && !facts.alt && key === 'z' && !facts.shift) return context.inTextField ? null : 'undo';
  if (cmd && !facts.alt && key === 'f' && facts.shift) return 'focus-mode';
  // binder-filters §5: Ctrl+Alt+F focuses the filter field. Ctrl+Shift+F stays focus mode, which the toolbar and the user
  // guide name, so the filter chord is the one that moves (the decision is recorded in docs/decisions.md).
  if (cmd && facts.alt && !facts.shift && key === 'f') return 'focus-filter';
  // The agent's Intent box (agent-harness §8): Enter sends, or queues while a turn runs, and Ctrl+Enter steers the running turn.
  if (context.inAgentIntent === true && !facts.alt && key === 'Enter') {
    if (cmd) return 'agent-steer';
    if (!facts.shift) return 'agent-send';
  }
  // Ctrl+Enter inside a field is a line break the writer may mean, so it yields.
  if (cmd && !facts.alt && key === 'Enter') return context.inTextField ? null : 'open-in-editor';
  // Escape in the agent panel stops the turn, but only with the Intent box empty: a message half typed is never lost to it.
  if (key === 'Escape') return context.inAgent === true && context.agentIntentEmpty === true ? 'agent-stop' : 'escape';

  // Everything below is a bare key, so it is meaningless while the user is typing.
  if (context.inTextField) return null;
  // ui-modules §2.5 and §3.2: Alt+arrow moves the focused node. Up and Down change its place among its siblings, and Left
  // and Right take it out of its folder or into the folder before it. A corkboard card has one parent, so only the order applies.
  if (facts.alt && !command(facts) && !facts.shift && (context.inBinder || context.inCorkboard === true)) {
    switch (key) {
      case 'ArrowUp':
        return 'reorder-up';
      case 'ArrowDown':
        return 'reorder-down';
      case 'ArrowLeft':
        return context.inBinder ? 'reparent-out' : 'reorder-up';
      case 'ArrowRight':
        return context.inBinder ? 'reparent-in' : 'reorder-down';
      default:
        return null;
    }
  }
  if (facts.ctrl || facts.meta || facts.alt) return null;

  // ui-modules §2.5 and §3.2: on a corkboard card, Enter or Space selects it, and Shift+F10 opens its menu. F2 renames and Delete asks
  // for a delete in the binder and on a card alike; the arrow keys (bar Alt) belong to the binder's tree.
  if (context.inCorkboard === true) {
    if (key === 'Enter' || key === ' ') return facts.shift ? null : 'select-card';
    if (key === 'F10' && facts.shift) return 'open-menu';
  }
  if (key === 'F2') return context.inBinder || context.inCorkboard === true ? 'rename' : null;
  if (key === 'Delete') return context.inBinder || context.inCorkboard === true ? 'delete' : null;
  if (!context.inBinder) return null;

  switch (key) {
    case 'ArrowUp':
      return 'move-up';
    case 'ArrowDown':
      return 'move-down';
    case 'ArrowLeft':
      return 'move-left';
    case 'ArrowRight':
      return 'move-right';
    default:
      return null;
  }
}

/** The shortcut labels a control shows, in the platform's own modifier name. */
export function shortcutLabel(action: KeyAction): string {
  switch (action) {
    case 'new-document':
      return 'Ctrl+N';
    case 'rename':
      return 'F2';
    case 'delete':
      return 'Delete';
    case 'open-in-editor':
      return 'Ctrl+Enter';
    case 'focus-mode':
      return 'Ctrl+Shift+F';
    case 'focus-filter':
      return 'Ctrl+Alt+F';
    case 'reorder-up':
      return 'Alt+Up';
    case 'reorder-down':
      return 'Alt+Down';
    case 'reparent-out':
      return 'Alt+Left';
    case 'reparent-in':
      return 'Alt+Right';
    case 'select-card':
      return 'Enter or Space';
    case 'open-menu':
      return 'Shift+F10';
    case 'agent-send':
      return 'Enter';
    case 'agent-steer':
      return 'Ctrl+Enter';
    case 'agent-stop':
      return 'Esc';
    case 'undo':
      return 'Ctrl+Z';
    case 'escape':
      return 'Esc';
    case 'move-up':
    case 'move-down':
    case 'move-left':
    case 'move-right':
      return 'Arrow keys';
  }
}
