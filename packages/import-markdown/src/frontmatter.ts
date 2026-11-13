/**
 * Front matter for the Markdown import (#280, epic #263).
 *
 * Splits a `---` (YAML) or `+++` (TOML) fence from the body, reads it with the
 * store's own codec (YAML) or a small TOML reader, and maps the keys the import
 * understands. Every other key is kept verbatim as a YAML block in `notes`, so
 * nothing is silently lost (the keep-everything rule). The mapping itself is the
 * preview source's job; this module only reads and sorts the fields.
 */

import { parseFrontMatterFields, type FrontMatterField } from '@caotang/store/frontmatter';
import type { ImportMetadata } from '@caotang/import-core';

export type FrontMatterFormat = 'yaml' | 'toml';

export interface SplitFrontMatter {
  /** The raw front matter text without its fences, or null when there is none. */
  front: string | null;
  format: FrontMatterFormat | null;
  body: string;
}

/** The scene-level facts the import maps, before the preview turns them into SceneMeta. */
export interface MarkdownSceneFacts {
  synopsis?: string;
  keywords?: string[];
  status?: string;
  label?: string;
  pov?: string;
  dayOffset?: number;
  storyPart?: 'prologue' | 'epilogue';
}

export interface MappedFrontMatter {
  metadata: ImportMetadata;
  scene: MarkdownSceneFacts;
  /** Every unmapped key, re-emitted as a YAML block for the scene's notes. */
  notes: string;
}

const YAML_FENCE = /^---[ \t]*\r?\n/;
const TOML_FENCE = /^\+\+\+[ \t]*\r?\n/;

/** Split a leading front-matter fence from the body. Only a fence at byte 0 counts. */
export function splitFrontMatter(text: string): SplitFrontMatter {
  const normalised = text.replace(/^\uFEFF/, '');
  for (const [regex, format, fence] of [
    [YAML_FENCE, 'yaml', '---'],
    [TOML_FENCE, 'toml', '+++'],
  ] as const) {
    if (!regex.test(normalised)) continue;
    const rest = normalised.replace(regex, '');
    // Find a closing fence on its own line.
    const lines = rest.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = (lines[i] as string).replace(/\r$/, '').trim();
      if (line === fence) {
        const front = lines.slice(0, i).join('\n');
        const body = lines.slice(i + 1).join('\n').replace(/^\r?\n/, '');
        return { front, format, body };
      }
    }
    // An opener with no closer is not front matter; the body keeps it.
    return { front: null, format: null, body: text };
  }
  return { front: null, format: null, body: text };
}

/** A scalar field's string value, or undefined when it is a block/sequence. */
const scalarOf = (field: FrontMatterField | undefined): string | undefined => {
  if (!field) return undefined;
  if (field.inline) return field.inline.join(', ');
  return field.scalar ?? undefined;
};

const listOf = (field: FrontMatterField | undefined): string[] | undefined => {
  if (!field) return undefined;
  if (field.inline) return [...field.inline];
  if (field.scalar !== undefined && field.scalar !== null && field.scalar !== '') return [field.scalar];
  return undefined;
};

/** Read TOML's common subset: `key = value` with strings, numbers, bools and arrays of scalars. */
function parseTomlFields(front: string): Map<string, FrontMatterField> {
  const fields = new Map<string, FrontMatterField>();
  for (const raw of front.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (line === '' || line.startsWith('#') || line.startsWith('[')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip a trailing comment outside quotes.
    if (!/^["']/.test(value)) {
      const hash = value.indexOf('#');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      const items = value.slice(1, -1).split(',').map((v) => unquoteToml(v.trim())).filter((v) => v !== '');
      fields.set(key, { inline: items });
    } else if (/^["']/.test(value)) {
      fields.set(key, { scalar: unquoteToml(value) });
    } else if (value === 'true' || value === 'false') {
      fields.set(key, { scalar: value });
    } else {
      fields.set(key, { scalar: value });
    }
  }
  return fields;
}

function unquoteToml(value: string): string {
  if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

const KNOWN_SCENE = new Set(['synopsis', 'summary', 'description', 'tags', 'keywords', 'status', 'label', 'pov', 'day', 'storyday', 'prologue', 'epilogue']);
const KNOWN_META = new Set(['title', 'author', 'language']);

/** Map the front-matter fields to metadata, scene facts and a notes block. */
export function mapFrontMatter(front: string, format: FrontMatterFormat): MappedFrontMatter {
  const fields = format === 'toml' ? parseTomlFields(front) : parseFrontMatterFields(front);
  const metadata: ImportMetadata = {};
  const scene: MarkdownSceneFacts = {};
  const notesLines: string[] = [];

  const title = scalarOf(fields.get('title'));
  if (title !== undefined && title !== '') metadata.title = title;
  const author = scalarOf(fields.get('author'));
  if (author !== undefined && author !== '') metadata.author = author;
  const language = scalarOf(fields.get('language'));
  if (language !== undefined && language !== '') metadata.language = language;

  const synopsis = scalarOf(fields.get('synopsis')) ?? scalarOf(fields.get('summary')) ?? scalarOf(fields.get('description'));
  if (synopsis !== undefined && synopsis !== '') scene.synopsis = synopsis;
  const keywords = listOf(fields.get('tags')) ?? listOf(fields.get('keywords'));
  if (keywords && keywords.length > 0) scene.keywords = keywords;
  const status = scalarOf(fields.get('status'));
  if (status !== undefined && status !== '') scene.status = status;
  const label = scalarOf(fields.get('label'));
  if (label !== undefined && label !== '') scene.label = label;
  const pov = scalarOf(fields.get('pov'));
  if (pov !== undefined && pov !== '') scene.pov = pov;
  const day = scalarOf(fields.get('day')) ?? scalarOf(fields.get('storyDay'));
  if (day !== undefined && day !== '') {
    const n = Number(day);
    if (Number.isFinite(n)) scene.dayOffset = n;
  }
  if (scalarOf(fields.get('prologue')) === 'true') scene.storyPart = 'prologue';
  else if (scalarOf(fields.get('epilogue')) === 'true') scene.storyPart = 'epilogue';

  // Every other key is kept verbatim as a YAML block in notes.
  for (const [key, field] of fields) {
    const lower = key.toLowerCase();
    if (KNOWN_META.has(lower) || KNOWN_SCENE.has(lower)) continue;
    if (field.inline) {
      notesLines.push(`${key}: [${field.inline.join(', ')}]`);
    } else if (field.block === 'literal' && field.scalar) {
      notesLines.push(`${key}: |`);
      for (const ln of field.scalar.split('\n')) notesLines.push(`  ${ln}`);
    } else if (field.scalar !== undefined && field.scalar !== null) {
      notesLines.push(`${key}: ${field.scalar}`);
    } else {
      notesLines.push(`${key}:`);
    }
  }

  return { metadata, scene, notes: notesLines.join('\n') };
}
