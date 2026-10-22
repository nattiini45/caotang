/**
 * The thin styling layer — [exporter.md §2 (Render) and §3](../../../docs/architecture/exporter.md).
 *
 * A template says what a chapter heading reads, what a scene break looks like, and
 * whether the title page and contents list are on by default. It does not change
 * the structure of the output; the flatten stage decided that. v0.1 ships one
 * template, `default`, with the spec's defaults. An unknown template id falls back
 * to it and says so in the compile log, rather than refusing the compile.
 */

export interface ExportTemplate {
  readonly id: string;
  readonly titlePage: boolean;
  readonly toc: boolean;
  /** `{chapterNumber}` and `{chapterTitle}` are filled in; the spec's default is `{chapterNumber}. {chapterTitle}`. */
  readonly chapterLabel: string;
  /** exporter.md E4: `***` for Markdown (it is the CommonMark thematic break), `* * *` for the plain-text family. */
  readonly separator: { readonly md: string; readonly plain: string };
}

export const DEFAULT_TEMPLATE_ID = 'default';

export const DEFAULT_TEMPLATE: ExportTemplate = {
  id: DEFAULT_TEMPLATE_ID,
  titlePage: true,
  toc: true,
  chapterLabel: '{chapterNumber}. {chapterTitle}',
  separator: { md: '***', plain: '* * *' },
};

const TEMPLATES: readonly ExportTemplate[] = [DEFAULT_TEMPLATE];

export interface ResolvedTemplate {
  readonly template: ExportTemplate;
  /** Set when the requested id was not known, so the compile log can say the default was used. */
  readonly note?: string;
}

export function resolveTemplate(id: string | undefined): ResolvedTemplate {
  if (id === undefined || id === DEFAULT_TEMPLATE_ID) return { template: DEFAULT_TEMPLATE };
  const found = TEMPLATES.find((template) => template.id === id);
  if (found !== undefined) return { template: found };
  return {
    template: DEFAULT_TEMPLATE,
    note: `template "${id}" is not known in this build, so the ${DEFAULT_TEMPLATE_ID} template was used`,
  };
}

/** Fills `{name}` placeholders. A name with no value is left as written, so a typo shows up in the output. */
export function fill(pattern: string, values: Readonly<Record<string, string | number>>): string {
  return pattern.replace(/\{([A-Za-z]+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole,
  );
}

export function chapterLabel(template: ExportTemplate, number: number, title: string): string {
  return fill(template.chapterLabel, { chapterNumber: number, chapterTitle: title });
}

/**
 * The anchor a Markdown renderer's contents list links to. GitHub's rule, which is
 * what a Markdown reader generates for a heading: lower-case, punctuation dropped,
 * spaces as hyphens. `1. The Landing` → `1-the-landing`.
 */
export function anchorOf(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .trim()
    .replace(/ /g, '-');
}

const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const FORBIDDEN_IN_FILENAME = '<>:"/\\|?*';

/** `text` without its trailing run of dots and spaces: a scan from the end, not a `[. ]+$` regex, which backtracks quadratically on `. . . . x`. */
function trimEndDotsAndSpaces(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === '.' || text[end - 1] === ' ')) end--;
  return text.slice(0, end);
}

/**
 * A title made safe to use as a file name in `exports/` on every platform the
 * artifact folder may be synced to. Reserved characters and control characters
 * become spaces; trailing dots and spaces go (Windows drops them); the stem is
 * capped; and the three-letter device names get a leading underscore.
 */
export function fileStem(title: string): string {
  const collapsed = [...title]
    .map((ch) => (ch.charCodeAt(0) < 32 || FORBIDDEN_IN_FILENAME.includes(ch) ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  const cleaned = trimEndDotsAndSpaces(collapsed)
    .slice(0, 120)
    .trim();
  if (cleaned.length === 0) return 'Untitled';
  return RESERVED_WINDOWS_NAME.test(cleaned) ? `_${cleaned}` : cleaned;
}

/**
 * A file name with `-n` put before its extension, the auto-versioning rule of exporter.md §2:
 * `Book.md` at 2 is `Book-2.md`, and `Book.ink.json` at 2 is `Book.ink-2.json`. The extension is the
 * last dot, so a name with a dot in its stem keeps it.
 */
export function suffixName(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
}
