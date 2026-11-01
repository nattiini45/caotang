/**
 * A route's request to show the inspector (modern-interface.md §7.2, §7.5): the binder's **Edit synopsis** and the Source tab's
 * synopsis chord (Ctrl+Shift+Y, Cmd+Alt+Y) focus `#inspector-synopsis`. Classic always shows the inspector, so nobody answers there
 * and the field is already in the page. Modern keeps it in Scene info, a popover; Scene info answers the request by opening on the
 * synopsis before the route focuses it, so the same id keeps working in both shells.
 *
 * The request is a DOM event on `window`, so the routes never read the shell (§4.3 rule 1) and this module stays in the first load
 * without pulling Modern's chunk in. An answer is synchronous: the listener mounts the field before `dispatchEvent` returns.
 */

/** The event's name. */
export const INSPECTOR_REQUEST = 'caotang-inspector-request';

/** The field a request asks for. */
export type InspectorField = 'synopsis';

export interface InspectorRequestDetail {
  readonly field: InspectorField;
}

/**
 * Asks the shell to show the inspector on a field. Returns whether a shell answered (cancelled the event): `false` in Classic, where
 * the inspector is always shown, and outside a browser.
 */
export function requestInspector(field: InspectorField): boolean {
  if (typeof window === 'undefined') return false;
  const event = new CustomEvent<InspectorRequestDetail>(INSPECTOR_REQUEST, { detail: { field }, cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

/** Listens for requests; the listener cancels the event to say it answered. Returns the function that stops listening. */
export function onInspectorRequest(listener: (detail: InspectorRequestDetail, event: Event) => void): () => void {
  const handle = (event: Event): void => {
    const detail = (event as CustomEvent<InspectorRequestDetail>).detail;
    if (detail?.field === undefined) return;
    listener(detail, event);
  };
  window.addEventListener(INSPECTOR_REQUEST, handle);
  return () => window.removeEventListener(INSPECTOR_REQUEST, handle);
}
