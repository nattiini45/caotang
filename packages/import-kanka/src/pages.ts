/**
 * An entity's Research page (#293): its own text, in the order the spec names — the name, what it is, its picture and
 * entry, its details, its connections, its posts and its lifespan. The entry HTML goes through the shared walker, so
 * scripts never run; the mentions become plain names. Pure: no DOM, no dependency.
 */

import type { ImportAsset, ImportBlock, LossWarning } from '@caotang/import-core';
import { htmlToBlocks, type HtmlDropped } from '@caotang/import-html';

import type { KankaEntity, KankaReminder } from './entity.js';
import { rewriteMentions } from './mentions.js';

export interface KankaPage {
  entityId: number;
  title: string;
  body: string;
  /** The first lines of the entity's own text, for the codex description. */
  description: string;
}

export interface PageParts {
  page: KankaPage;
  assets: ImportAsset[];
  /** The picture bytes, keyed by the ref the page's Markdown uses. */
  assetData: Map<string, Uint8Array>;
  remoteImages: string[];
  dropped: HtmlDropped;
  losses: LossWarning[];
  unresolvedMentions: number;
  /** The pictures the walker found in the entry, by ref, for the reader to resolve inside the zip. */
  images: Map<string, string>;
}

const EMPTY_DROPPED: HtmlDropped = { scripts: 0, styles: 0, iframes: 0, forms: 0, eventAttrs: 0, unsafeLinks: 0, media: 0 };

const addDropped = (into: HtmlDropped, from: HtmlDropped): void => {
  into.scripts += from.scripts;
  into.styles += from.styles;
  into.iframes += from.iframes;
  into.eventAttrs += from.eventAttrs;
  into.unsafeLinks += from.unsafeLinks;
  into.media += from.media;
};

/**
 * A Kanka entry is an HTML fragment, not a page: the walker reads one root, so the fragment is wrapped. A fragment
 * that already carries `<html>` or `<body>` is left as it is.
 */
function asPage(html: string): string {
  return /<\s*(html|body)[\s>]/i.test(html) ? html : `<html><body>${html}</body></html>`;
}

/** A link back to Kanka points at nothing the writer has offline: the text stays, the anchor goes. */
function withoutKankaLinks(md: string): string {
  return md.replace(/\[([^\]]*)\]\((?:https?:)?\/\/(?:[a-z0-9-]+\.)*kanka\.io[^)]*\)/gi, '$1');
}

/**
 * The last resort when an entry is not readable HTML: its text, with script and style content gone, never just its
 * tags stripped. Both steps repeat to a fixed point so a marker one removal uncovers (``<<script>``) goes too.
 */
function textOnly(html: string): string {
  let text = html;
  let previous = '';
  while (text !== previous) {
    previous = text;
    text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?(<\/\1[^>]*>|$)/gi, '');
  }
  previous = '';
  while (text !== previous) {
    previous = text;
    text = text.replace(/<[^>]*>/g, '');
  }
  return text.replace(/\s+/g, ' ').trim();
}

/** Blocks as Markdown, one blank line between them. */
export function blocksToMarkdown(blocks: readonly ImportBlock[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'pagebreak') continue;
    if (block.kind === 'break') {
      lines.push('---');
      continue;
    }
    if (block.kind === 'image') {
      lines.push(`![${block.alt}](${block.assetRef})`);
      continue;
    }
    lines.push(block.md);
  }
  return lines.join('\n\n').trim();
}

/** The plain text of blocks, for a description. */
function plainOf(blocks: readonly ImportBlock[]): string {
  return blocks
    .map((block) => (block.kind === 'heading' || block.kind === 'para' ? block.text : block.kind === 'other' ? block.md : ''))
    .filter((line) => line.trim() !== '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A reminder as a calendar date, as the export wrote it: `year 1204, month 3, day 2`. */
export function reminderDate(reminder: KankaReminder, labels: KankaLabels = DEFAULT_KANKA_LABELS): string {
  const parts: string[] = [];
  if (reminder.year !== null) parts.push(`${labels.year} ${reminder.year}`);
  if (reminder.month !== null) parts.push(`${labels.month} ${reminder.month}`);
  if (reminder.day !== null) parts.push(`${labels.day} ${reminder.day}`);
  return parts.join(', ');
}

const LIFE: Readonly<Record<number, 'born' | 'died'>> = { 2: 'born', 3: 'died' };

/** The words the page's own structure uses. The app passes them in the writer's language, as the splitter takes its labels. */
export interface KankaLabels {
  details: string;
  connections: string;
  posts: string;
  post: string;
  life: string;
  born: string;
  died: string;
  noDate: string;
  attitude: string;
  twoWay: string;
  year: string;
  month: string;
  day: string;
}

export const DEFAULT_KANKA_LABELS: KankaLabels = {
  details: 'Details',
  connections: 'Connections',
  posts: 'Posts',
  post: 'Post',
  life: 'Life',
  born: 'Born',
  died: 'Died',
  noDate: 'a date the export did not carry',
  attitude: 'attitude',
  twoWay: 'two-way',
  year: 'year',
  month: 'month',
  day: 'day',
};

export interface PageOptions {
  /** The campaign's word for the module, else the folder's own name. */
  moduleLabel: string;
  names: ReadonlyMap<number, string>;
  /** The entity's picture, already read from the zip: its ref and bytes. */
  picture?: { ref: string; name: string; data: Uint8Array };
  /** The ref namespace for pictures found inside the entry. */
  refPrefix: string;
  /** The page's own headings, in the writer's language. */
  labels?: KankaLabels;
}

/** Build one entity's page. */
export function entityPage(entity: KankaEntity, options: PageOptions): PageParts {
  const labels = options.labels ?? DEFAULT_KANKA_LABELS;
  const dropped: HtmlDropped = { ...EMPTY_DROPPED };
  const losses: LossWarning[] = [];
  const remoteImages: string[] = [];
  const images = new Map<string, string>();
  const assets: ImportAsset[] = [];
  const assetData = new Map<string, Uint8Array>();
  let unresolvedMentions = 0;

  // Every walk gets its own ref namespace: the walker's index restarts at zero each call, so the entry's and each
  // post's pictures would otherwise share one ref and overwrite each other in `images`.
  let walkIndex = 0;
  const walk = (html: string): { md: string; plain: string } => {
    if (html.trim() === '') return { md: '', plain: '' };
    const mentioned = rewriteMentions(html, options.names);
    unresolvedMentions += mentioned.unresolved;
    const walked = htmlToBlocks(asPage(mentioned.text), { unit: `kanka:${entity.id}`, refPrefix: `${options.refPrefix}${walkIndex}-` });
    walkIndex += 1;
    if (!walked.ok) {
      losses.push({ code: 'unsupported', message: `The text of “${entity.name}” is not readable HTML.` });
      const plain = textOnly(mentioned.text);
      return { md: withoutKankaLinks(plain), plain };
    }
    addDropped(dropped, walked.value.dropped);
    losses.push(...walked.value.losses);
    for (const target of walked.value.remoteImages) if (!remoteImages.includes(target)) remoteImages.push(target);
    for (const [ref, target] of walked.value.images) images.set(ref, target);
    return { md: withoutKankaLinks(blocksToMarkdown(walked.value.blocks)), plain: plainOf(walked.value.blocks) };
  };

  const sections: string[] = [];
  const what = [options.moduleLabel, entity.type].filter((part) => part !== '').join(' · ');
  sections.push(`# ${entity.name}`);
  if (what !== '') sections.push(what);

  if (options.picture !== undefined) {
    assets.push({ ref: options.picture.ref, name: options.picture.name, bytes: options.picture.data.length });
    assetData.set(options.picture.ref, options.picture.data);
    sections.push(`![${entity.name}](${options.picture.ref})`);
  }

  const entry = walk(entity.entry);
  if (entry.md !== '') sections.push(entry.md);

  if (entity.attributes.length > 0) {
    const lines = entity.attributes.map((attribute) => {
      const value = rewriteMentions(attribute.value, options.names);
      unresolvedMentions += value.unresolved;
      const name = rewriteMentions(attribute.name, options.names).text;
      return value.text === '' ? `### ${name}` : `- ${name}: ${value.text}`;
    });
    sections.push([`## ${labels.details}`, ...lines].join('\n'));
  }

  if (entity.relations.length > 0) {
    const lines = entity.relations.map((relation) => {
      const target = options.names.get(relation.targetId) ?? `#${relation.targetId}`;
      const label = rewriteMentions(relation.relation, options.names).text;
      const extras = [relation.attitude === 0 ? '' : `${labels.attitude} ${relation.attitude}`, relation.mirrored ? labels.twoWay : ''].filter((part) => part !== '');
      const suffix = extras.length === 0 ? '' : ` (${extras.join(', ')})`;
      return `- ${target}${label === '' ? '' : ` — ${label}`}${suffix}`;
    });
    sections.push([`## ${labels.connections}`, ...lines].join('\n'));
  }

  for (const [index, post] of entity.posts.entries()) {
    const body = walk(post.entry);
    const title = post.name === '' ? labels.post : post.name;
    const section = [`### ${title}`, body.md].filter((part) => part !== '').join('\n\n');
    sections.push(index === 0 ? `## ${labels.posts}\n\n${section}` : section);
  }

  const life = entity.reminders.filter((reminder) => LIFE[reminder.typeId] !== undefined);
  if (life.length > 0) {
    const lines = life.map((reminder) => {
      const date = reminderDate(reminder, labels);
      const word = LIFE[reminder.typeId] === 'born' ? labels.born : labels.died;
      return `- ${word}: ${date === '' ? labels.noDate : date}${reminder.comment === '' ? '' : ` (${reminder.comment})`}`;
    });
    sections.push([`## ${labels.life}`, ...lines].join('\n'));
  }

  const description = entry.plain.slice(0, 300);
  return {
    page: { entityId: entity.id, title: entity.name, body: sections.join('\n\n'), description },
    assets,
    assetData,
    remoteImages,
    dropped,
    losses,
    unresolvedMentions,
    images,
  };
}
