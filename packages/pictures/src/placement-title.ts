/**
 * The placement title codec, pictures.md §2.2.1 (v1).
 *
 * An inline picture keeps its caption in the Markdown title slot, and a decoration flag or a size hint in a versioned suffix after it:
 * `"The lighthouse [caotang-image v1;size=half;decorative]"`. This module is pure and is the one place that reads and writes that
 * suffix, so the editor, the exporter and the body scan agree on what the caption is. It never touches the alt slot.
 */

export const PLACEMENT_SIZES = ['full', 'half', 'inline'] as const;
export type PlacementSize = (typeof PLACEMENT_SIZES)[number];

const MARKER = '[caotang-image ';
const KNOWN_VERSION = '1';

export type PlacementNote =
  /** An escape that is none of the three the format writes, or a suffix that is not well formed: the title is kept whole as the caption. */
  | { readonly kind: 'unbalanced' }
  /** A value outside its key's domain: kept verbatim, shown as the default. */
  | { readonly kind: 'out-of-domain'; readonly entry: string };

export type PlacementTitle =
  | {
      readonly kind: 'placement';
      readonly caption: string;
      readonly size: PlacementSize;
      readonly decorative: boolean;
      /** Entries this build does not interpret, verbatim and in their original relative order. */
      readonly extras: readonly string[];
      readonly notes: readonly PlacementNote[];
    }
  | {
      /** A suffix version this build does not decode: the title keeps every byte and is the caption for every format. */
      readonly kind: 'opaque-version';
      readonly raw: string;
      readonly version: string;
    };

/** The three escapes, applied to a caption and to a value. */
const escape = (text: string): string =>
  text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll(MARKER, `\\${MARKER}`);

/** The inverse of {@link escape}, or `null` when a backslash starts none of the three escapes. */
const unescape = (text: string): string | null => {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = text[i + 1];
    if (next === '\\' || next === '"') {
      out += next;
      i += 1;
    } else if (text.startsWith(MARKER, i + 1)) {
      out += MARKER;
      i += MARKER.length;
    } else {
      return null;
    }
  }
  return out;
};

/** Whether the space at `index` is unescaped: preceded by an even number of backslashes. */
const spaceIsUnescaped = (title: string, index: number): boolean => {
  let slashes = 0;
  while (index - 1 - slashes >= 0 && title[index - 1 - slashes] === '\\') slashes += 1;
  return slashes % 2 === 0;
};

/** Where the unescaped suffix opens (the space, or 0 for an empty caption), or -1. The last candidate decides. */
const suffixStart = (title: string): number => {
  if (!title.endsWith(']')) return -1;
  for (let at = title.lastIndexOf(MARKER); at >= 0; at = title.lastIndexOf(MARKER, at - 1)) {
    if (at === 0) return 0;
    if (title[at - 1] === ' ' && spaceIsUnescaped(title, at - 1)) return at - 1;
    if (at === 1) break;
  }
  return -1;
};

const whole = (title: string, note: PlacementNote): PlacementTitle => ({
  kind: 'placement',
  caption: title,
  size: 'full',
  decorative: false,
  extras: [],
  notes: [note],
});

/** Reads a title slot. An absent or empty title is an empty caption with the defaults. */
export function decodePlacementTitle(title: string | null | undefined): PlacementTitle {
  const text = title ?? '';
  const start = suffixStart(text);
  if (start < 0) {
    const caption = unescape(text);
    return caption === null
      ? whole(text, { kind: 'unbalanced' })
      : { kind: 'placement', caption, size: 'full', decorative: false, extras: [], notes: [] };
  }
  const markerAt = text.startsWith(MARKER, start) ? start : start + 1;
  const inner = text.slice(markerAt + MARKER.length, -1);
  const header = /^v([0-9]+)(;|$)/.exec(inner);
  if (header === null || header[2] !== ';') return whole(text, { kind: 'unbalanced' });
  if (header[1] !== KNOWN_VERSION) return { kind: 'opaque-version', raw: text, version: `v${header[1]}` };

  const caption = unescape(text.slice(0, start));
  if (caption === null) return whole(text, { kind: 'unbalanced' });
  const rest = inner.slice(header[0].length);
  const entries = rest === '' ? [] : rest.split(';');
  let size: PlacementSize = 'full';
  let decorative = false;
  let sawSize = false;
  let sawDecorative = false;
  const extras: string[] = [];
  const notes: PlacementNote[] = [];
  for (const entry of entries) {
    const equals = entry.indexOf('=');
    if (entry === 'decorative' && !sawDecorative) {
      decorative = true;
      sawDecorative = true;
    } else if (entry.startsWith('size=') && !sawSize && (PLACEMENT_SIZES as readonly string[]).includes(entry.slice(5))) {
      size = entry.slice(5) as PlacementSize;
      sawSize = true;
    } else if (equals > 0 || entry === 'decorative') {
      const key = equals > 0 ? entry.slice(0, equals) : entry;
      const inDomain = entry === 'decorative' || (PLACEMENT_SIZES as readonly string[]).includes(entry.slice(equals + 1));
      if ((key === 'size' || key === 'decorative') && !inDomain) notes.push({ kind: 'out-of-domain', entry });
      extras.push(entry);
    } else {
      return whole(text, { kind: 'unbalanced' });
    }
  }
  return { kind: 'placement', caption, size, decorative, extras, notes };
}

export interface PlacementTitleInput {
  readonly caption: string;
  readonly size?: PlacementSize;
  readonly decorative?: boolean;
  readonly extras?: readonly string[];
}

/**
 * Writes a title slot, or `null` when there is nothing to write. The default placement (a caption only) is the caption alone,
 * escaped; metadata is the suffix, in canonical order: `size` when not `full`, `decorative` when true, then the preserved extras.
 */
export function encodePlacementTitle(input: PlacementTitleInput | Extract<PlacementTitle, { kind: 'opaque-version' }>): string | null {
  if ('raw' in input) return input.raw;
  const entries: string[] = [];
  if (input.size !== undefined && input.size !== 'full') entries.push(`size=${input.size}`);
  if (input.decorative === true) entries.push('decorative');
  entries.push(...(input.extras ?? []));
  const caption = escape(input.caption);
  if (entries.length === 0) return caption === '' ? null : caption;
  const suffix = `${MARKER}v${KNOWN_VERSION};${entries.join(';')}]`;
  return caption === '' ? suffix : `${caption} ${suffix}`;
}

/** The caption every format prints: the decoded caption, or the whole title for a suffix version this build cannot decode. */
export function placementCaptionOf(title: string | null | undefined): string {
  const decoded = decodePlacementTitle(title);
  return decoded.kind === 'opaque-version' ? decoded.raw : decoded.caption;
}
