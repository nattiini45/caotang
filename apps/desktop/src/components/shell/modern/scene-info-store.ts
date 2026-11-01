/**
 * Scene info's open API (modern-interface.md §6, §8.2): whether it is open, docked (**Keep open**), and which field it opens on, with
 * the calls an opener makes. The title capsule (#306) is Scene info's opener; it is built in parallel, so it reaches Scene info only
 * through this module:
 *
 * ```tsx
 * const sceneInfo = useSceneInfoOpener();
 * <button type="button" {...sceneInfo.buttonProps}>…</button>
 * ```
 *
 * `buttonProps` carries the ref that registers the capsule (focus returns to it and the popover anchors to it), `aria-haspopup`,
 * `aria-expanded`, `aria-controls` and the click that toggles. Until a capsule is registered, a route's Scene info opens at the top
 * centre and gives focus back to where the writer was (the text, for the synopsis chord), or to the page. Anything else (the
 * palette, #310) calls {@link openSceneInfo}. The routes outside the shell (**Edit synopsis**, the synopsis chord) reach it through
 * app/inspector-request.ts, which scene-info.tsx answers.
 */

import { useCallback, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from 'react';

import { SCENE_INFO_ID, readDocked, writeDocked } from './scene-info-model.js';

/** The field Scene info takes focus on as it opens: its first field (the synopsis, when there is a scene), or the synopsis. */
export type SceneInfoFocus = 'first' | 'synopsis';

export interface SceneInfoState {
  readonly open: boolean;
  /** **Keep open**: docked beside the page as a companion panel, not a popover (§6, Inspector). */
  readonly docked: boolean;
  readonly focus: SceneInfoFocus;
  /** Counts the open requests, so a second request while open (a route) moves focus again. */
  readonly request: number;
  /** Whether a title capsule is registered. */
  readonly hasCapsule: boolean;
}

let state: SceneInfoState = { open: false, docked: readDocked(), focus: 'first', request: 0, hasCapsule: false };
const listeners = new Set<() => void>();
/** The control that opened Scene info this time, when it was a control. */
let opener: HTMLElement | null = null;
/** The title capsule (#306), once it registers itself. */
let capsule: HTMLElement | null = null;
/** Where focus was when Scene info opened without an opener (a route): it goes back there. */
let previous: HTMLElement | null = null;

function set(next: Partial<SceneInfoState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function sceneInfoState(): SceneInfoState {
  return state;
}

export function subscribeSceneInfo(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function connected(element: HTMLElement | null): HTMLElement | null {
  return element !== null && element.isConnected ? element : null;
}

/** The control Scene info grows out of: the one that opened it, else the title capsule; `null` while neither is drawn. */
export function sceneInfoOpener(): HTMLElement | null {
  return connected(opener) ?? connected(capsule);
}

/** Where focus returns as Scene info closes: its opener, else where the writer was before a route opened it, else the page. */
export function sceneInfoReturnTarget(): HTMLElement | null {
  const page = typeof document === 'undefined' ? null : document.getElementById(PAGE_FALLBACK_ID);
  return sceneInfoOpener() ?? connected(previous) ?? page;
}

/** The page's id (modern-shell.tsx's PAGE_ID), the last place focus goes back to. Not imported, so this module stays a leaf. */
const PAGE_FALLBACK_ID = 'modern-page';

function focusedElement(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

/** Opens Scene info (or, when open, moves focus to the field asked for). `opener` is the control that asked, when one did. */
export function openSceneInfo(options: { opener?: HTMLElement | null; focus?: SceneInfoFocus } = {}): void {
  if (!state.open) previous = focusedElement();
  if (options.opener !== undefined) opener = options.opener;
  else if (!state.open) opener = null;
  set({ open: true, focus: options.focus ?? 'first', request: state.request + 1 });
}

/**
 * Closes Scene info. Focus returns to its opener (§8.2, decisions.md "Panels return focus to their opener") unless `returnFocus` is
 * false: a click outside has already put the writer somewhere else.
 */
export function closeSceneInfo(options: { returnFocus?: boolean } = {}): void {
  if (!state.open) return;
  const back = sceneInfoReturnTarget();
  set({ open: false });
  if (options.returnFocus !== false) back?.focus();
}

/** The opener's click: closes Scene info when open, otherwise opens it from `from`. */
export function toggleSceneInfo(from: HTMLElement | null): void {
  if (state.open) closeSceneInfo();
  else openSceneInfo({ opener: from });
}

/** **Keep open** on or off, kept in this browser. */
export function setSceneInfoDocked(on: boolean): void {
  writeDocked(on);
  set({ docked: on });
}

/** Registers the title capsule. Returns the function that unregisters it. */
export function registerSceneInfoOpener(element: HTMLElement): () => void {
  capsule = element;
  set({ hasCapsule: true });
  return () => {
    if (capsule !== element) return;
    capsule = null;
    set({ hasCapsule: false });
  };
}

/** Forgets the open state when the workspace leaves (back to Projects), so the next project does not open on Scene info. */
export function resetSceneInfo(): void {
  opener = null;
  previous = null;
  if (state.open) set({ open: false });
}

/** Scene info's state, for a component. */
export function useSceneInfo(): SceneInfoState {
  return useSyncExternalStore(subscribeSceneInfo, sceneInfoState, sceneInfoState);
}

/** What an opener button spreads: its ref, its popup semantics and its click. */
export interface SceneInfoButtonProps {
  readonly ref: (element: HTMLButtonElement | null) => void | (() => void);
  readonly 'aria-haspopup': 'dialog';
  readonly 'aria-expanded': boolean;
  readonly 'aria-controls': string | undefined;
  readonly onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

/** The title capsule's hook (#306): see the module comment. */
export function useSceneInfoOpener(): { open: boolean; buttonProps: SceneInfoButtonProps } {
  const { open } = useSceneInfo();
  const ref = useCallback((element: HTMLButtonElement | null) => {
    if (element === null) return;
    return registerSceneInfoOpener(element);
  }, []);
  const onClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => toggleSceneInfo(event.currentTarget), []);
  return {
    open,
    buttonProps: { ref, 'aria-haspopup': 'dialog', 'aria-expanded': open, 'aria-controls': open ? SCENE_INFO_ID : undefined, onClick },
  };
}
