import { isAbsolute } from 'node:path';

/**
 * What something outside the studio may ask it to open, decided before anything is granted (desktop.md §Deep links and folder
 * handoff). Pure, and imported only by the main process, so the rules can be read together and held by the shell's own suite.
 *
 * ## A link names a project, never a path
 *
 * `caotang://project/<id>` is the whole grammar. The id is a grant the shell already made (a project folder opened with the
 * picker, remembered in this profile), so a link can only reach a folder Caotang would open anyway: a link can neither carry a
 * path nor name one, and an id that this profile does not hold is refused. Anything else in the scheme — another route, a
 * query, a fragment, a user, a port — is refused rather than ignored, because a link that half-works teaches the writer
 * nothing about which half did.
 *
 * ## A folder is the operating system's own hand-off
 *
 * A file manager's "Open with", a desktop file, a command line: the operating system passes the folder as an argument, and the
 * shell accepts it only when it is an absolute path to a folder that holds a `caotang.json` — the same rule the picker applies
 * before it calls a folder an existing project. The path is never read from a link.
 */

export const LINK_SCHEME = 'caotang';
export const LINK_HOST = 'project';

/** What a `caotang://` address asks for. */
export type LinkDecision =
  /** Open the project folder this profile remembers under `id`. */
  | { readonly kind: 'project'; readonly id: string }
  /** A `caotang:` address this build will not act on. */
  | { readonly kind: 'refused' };

/** The grant ids `randomUUID` makes, which is the only shape a link's id can have. */
const GRANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Whether an argument is a `caotang:` link at all, whatever it says. Compared case-insensitively: a system may upper-case it. */
export function isLink(argument: string): boolean {
  return argument.slice(0, LINK_SCHEME.length + 1).toLowerCase() === `${LINK_SCHEME}:`;
}

/**
 * What a `caotang://` address asks for, or `null` when the argument is not a link. A link that names no project, or names
 * something this build cannot open, is `refused`: the page says so in its own words.
 */
export function parseLink(argument: string): LinkDecision | null {
  if (!isLink(argument)) return null;
  let url: URL;
  try {
    url = new URL(argument);
  } catch {
    return { kind: 'refused' };
  }
  if (url.protocol !== `${LINK_SCHEME}:` || url.username !== '' || url.password !== '' || url.port !== '') return { kind: 'refused' };
  if (url.host !== LINK_HOST || url.search !== '' || url.hash !== '') return { kind: 'refused' };
  const id = url.pathname.startsWith('/') ? url.pathname.slice(1) : '';
  return GRANT_ID.test(id) ? { kind: 'project', id } : { kind: 'refused' };
}

/**
 * The folder an argument names, or `null` when it is not one. This screens the shape only — a switch, a relative path (the
 * development launcher's `.`), or one of the app's own paths (its executable, and the directory a development launcher is given)
 * is not a folder anyone opened — and the caller then reads it, which is what decides whether it is a folder and a project.
 */
export function folderArgument(argument: string, own: readonly string[]): string | null {
  if (argument === '' || argument.startsWith('-') || !isAbsolute(argument)) return null;
  const same = (path: string): string => {
    const trimmed = path.length > 1 ? path.replace(/[\\/]+$/u, '') : path;
    return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
  };
  const target = same(argument);
  return own.some((path) => same(path) === target) ? null : argument;
}

/**
 * What a delivered argument asks for: a link's decision, or the folder's path. `null` when the argument is neither, so a
 * launcher's own switches (`--user-data-dir`, `--inspect`) pass through without an answer.
 */
export type Delivery = { readonly kind: 'link'; readonly decision: LinkDecision } | { readonly kind: 'folder'; readonly path: string };

export function describeDelivery(argument: string, own: readonly string[]): Delivery | null {
  const decision = parseLink(argument);
  if (decision !== null) return { kind: 'link', decision };
  const path = folderArgument(argument, own);
  return path === null ? null : { kind: 'folder', path };
}
