export const EDITOR_READY_EVENT = 'caotang-editor-ready';

export function publishEditorReady(host: HTMLElement): void {
  host.dispatchEvent(new Event(EDITOR_READY_EVENT, { bubbles: true }));
}

export function focusEditorWhenReady(page: HTMLElement, sidebar: HTMLElement | null): () => void {
  let waiting = true;
  const stop = (): void => {
    waiting = false;
    page.removeEventListener(EDITOR_READY_EVENT, focus);
    page.ownerDocument.removeEventListener('focusin', moved);
  };
  const free = (): boolean => {
    const active = page.ownerDocument.activeElement;
    return active === null || active === page.ownerDocument.body || active === page || sidebar?.contains(active) === true;
  };
  const focus = (): void => {
    if (!waiting) return;
    if (!free()) { stop(); return; }
    const surface = page.querySelector<HTMLElement>('[data-editor-state="ready"]:not([hidden]) [contenteditable="true"]');
    const media = page.querySelector('.media-view[data-editor-state="ready"]:not([hidden])');
    const failed = page.querySelector('[data-editor-state="failed"]:not([hidden])');
    if (surface === null && media === null && failed === null) return;
    stop();
    (surface ?? page).focus();
  };
  const moved = (): void => {
    if (!free()) stop();
  };
  page.addEventListener(EDITOR_READY_EVENT, focus);
  page.ownerDocument.addEventListener('focusin', moved);
  if (page.querySelector('.editor-pane.is-empty') !== null) {
    if (free()) page.focus();
    stop();
    return stop;
  }
  if (page.querySelector('[data-editor-state]') === null && free()) page.focus();
  focus();
  return stop;
}
