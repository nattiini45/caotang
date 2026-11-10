import { useCallback, useEffect, useSyncExternalStore, type ComponentPropsWithRef, type ReactNode, type RefObject, type SetStateAction } from 'react';
import { createPortal } from 'react-dom';

import { modalStack, type ModalPriority } from './modal-stack.js';

export function useModalValue<T>(slot: string): [T | null, (value: SetStateAction<T | null>) => void] {
  const read = useCallback(() => modalStack.read<T>(slot), [slot]);
  const value = useSyncExternalStore(modalStack.subscribe, read);
  const set = useCallback((next: SetStateAction<T | null>) => {
    modalStack.write(slot, typeof next === 'function' ? (next as (old: T | null) => T | null)(read()) : next);
  }, [slot, read]);
  useEffect(() => () => modalStack.write(slot, null), [slot]);
  return [value, set];
}

interface Surface {
  readonly id: number;
  readonly dialog: HTMLDialogElement;
  readonly opener: HTMLElement | null;
  focused: HTMLElement | null;
}
const surfaces = new Map<HTMLDialogElement, Surface>();
export function topModal(): HTMLDialogElement | null {
  const id = modalStack.getSnapshot().entries.at(-1)?.id;
  return [...surfaces.values()].find((surface) => surface.id === id)?.dialog ?? null;
}

export function modalOpenedFrom(root: HTMLElement | null): boolean {
  return root !== null && [...surfaces.values()].some(({ opener }) => opener !== null && root.contains(opener));
}

export function ModalStackState(): ReactNode {
  const state = useSyncExternalStore(modalStack.subscribe, modalStack.getSnapshot);
  return <span hidden data-testid="modal-stack" data-state={state.kind} data-depth={state.entries.length} />;
}
let serial = 0;
let observer: MutationObserver | null = null;
let focusTrail: HTMLElement[] = [];
let reconciling = false;
const raising = new WeakMap<HTMLDialogElement, number>();

function focusSurface(surface: Surface): void {
  if (surface.focused?.isConnected === true) {
    surface.focused.focus();
    if (document.activeElement === surface.focused) return;
  }
  const target = surface.dialog.querySelector<HTMLElement>('[autofocus]:not(:disabled)')
    ?? [...surface.dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')]
      .find((element) => element.getClientRects().length > 0);
  (target ?? surface.dialog).focus();
}

function reconcile(): void {
  if (reconciling) return;
  reconciling = true;
  const previous = modalStack.getSnapshot().entries.at(-1);
  const removed = [...surfaces.values()].filter(({ dialog }) => !dialog.isConnected || !dialog.open);
  for (const surface of removed) {
    surfaces.delete(surface.dialog);
    modalStack.send({ type: 'close', id: surface.id });
    delete surface.dialog.dataset['modalState'];
  }
  const topId = modalStack.getSnapshot().entries.at(-1)?.id;
  const top = [...surfaces.values()].find((surface) => surface.id === topId);
  for (const surface of surfaces.values()) surface.dialog.dataset['modalState'] = surface === top ? 'top' : 'covered';
  document.documentElement.dataset['modalState'] = modalStack.getSnapshot().kind;
  if (top !== undefined) {
    const nativeTop = [...surfaces.values()].at(-1);
    if (nativeTop !== top) {
      const focused = top.focused;
      raising.set(top.dialog, (raising.get(top.dialog) ?? 0) + 1);
      top.dialog.close();
      top.dialog.showModal();
      top.focused = focused;
      surfaces.delete(top.dialog);
      surfaces.set(top.dialog, top);
      focusSurface(top);
    } else if (previous?.id !== top.id || !top.dialog.contains(document.activeElement)) {
      focusSurface(top);
    }
  } else if (removed.some((surface) => surface.id === previous?.id)) {
    const opener = removed.find((surface) => surface.id === previous?.id)?.opener;
    if (opener?.isConnected === true) opener.focus();
  }
  reconciling = false;
}

function register(dialog: HTMLDialogElement, priority: ModalPriority, opener = focusTrail.findLast((element) => element.isConnected && !dialog.contains(element)) ?? null): void {
  if (surfaces.has(dialog)) return;
  const active = document.activeElement;
  const surface: Surface = { id: ++serial, dialog, opener, focused: active instanceof HTMLElement && dialog.contains(active) ? active : null };
  surfaces.set(dialog, surface);
  modalStack.send({ type: 'open', entry: { id: surface.id, priority } });
  reconcile();
}

function install(): void {
  if (observer !== null) return;
  document.addEventListener('close', (event) => {
    if (!(event.target instanceof HTMLDialogElement)) return;
    const pending = raising.get(event.target) ?? 0;
    if (pending === 0) return;
    raising.set(event.target, pending - 1);
    event.stopImmediatePropagation();
  }, true);
  document.addEventListener('focusin', (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    const surface = [...surfaces.values()].find(({ dialog }) => dialog.contains(event.target as Node));
    if (surface !== undefined) surface.focused = event.target;
    focusTrail = [...focusTrail.filter((element) => element !== event.target && element.isConnected), event.target].slice(-16);
  });
  observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.target instanceof HTMLDialogElement && record.target.open && record.target.isConnected) {
        register(record.target, record.target.dataset['modalPriority'] === 'notice' ? 'notice' : record.target.classList.contains('confirm') ? 'confirm' : 'dialog');
      }
    }
    reconcile();
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'disabled'] });
}

export function useModalDialog(ref: RefObject<HTMLDialogElement | null>, open = true, priority: ModalPriority = 'dialog', focus?: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    install();
    const dialog = ref.current;
    if (dialog === null || !open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    focus?.current?.focus();
    register(dialog, priority, opener);
    return () => {
      if (dialog.open) dialog.close();
      reconcile();
    };
  }, [ref, open, priority, focus]);
}

export function Modal(props: ComponentPropsWithRef<'dialog'>): ReactNode {
  const dialog = <dialog {...props} />;
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}
