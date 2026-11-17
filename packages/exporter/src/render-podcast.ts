/**
 * The podcast feed (`podcast-rss`, av-script.md §5): RSS 2.0 over the same emitter discipline as the web feeds,
 * carrying the `itunes:` and `podcast:` namespaces.
 *
 * The channel's six Apple-required tags are the checklist: `title`, `description`, `language`, `itunes:image`,
 * `itunes:category`, `itunes:explicit`. Whatever the show's settings cannot supply is named in the compile log —
 * `itunes:image` always, because a feed needs the artwork's hosted https address and a project asset has none.
 *
 * An episode makes an item only when it is published (no `publishedAt` = a draft, skipped and named) and it
 * carries all three enclosure fields (`audioUrl`, `audioBytes`, `audioMime`); a missing field is named in the
 * log and nothing is invented (SD10: the audio lives elsewhere).
 */

import { escapeXml } from './render-epub.js';
import { instantMs } from './render-feed.js';
import { publishString, type PublishMeta } from './render-html.js';
import type { EpisodeMeta } from '@caotang/script';

/** The channel, resolved: the show's own values where it holds them, the folder's title or synopsis where it does not. */
export interface PodcastChannel {
  readonly title: string;
  readonly description?: string;
  readonly language?: string;
  readonly link?: string;
  readonly category?: string;
  readonly explicit?: boolean;
  readonly fundingUrl?: string;
  /** The show artwork's asset id when set. Never emitted: a feed needs its hosted https address, which no field holds. */
  readonly hasArtwork: boolean;
}

/** One episode document, resolved for the feed. */
export interface PodcastEpisode {
  readonly docId: string;
  readonly title: string;
  readonly publish?: PublishMeta;
  /** The episode's runtime in seconds (`ScriptTotals.seconds`), when the script computes one. */
  readonly durationSec?: number;
  readonly meta: EpisodeMeta;
}

export interface PodcastFeedInput {
  readonly channel: PodcastChannel;
  readonly episodes: readonly PodcastEpisode[];
}

/** The feed's text and the compile-log lines: every missing required tag and every skipped episode. */
export interface RenderedPodcastFeed {
  readonly xml: string;
  readonly notes: readonly string[];
}

/** The enclosure fields an item needs, in `episodeMeta`'s order (av-script.md §5). */
const ENCLOSURE_KEYS = ['audioUrl', 'audioBytes', 'audioMime'] as const;

/** RSS 2.0's `<pubDate>`: RFC 822. A leap second reads as the first millisecond of the next second. */
function rfc822(instant: string): string {
  return new Date(instantMs(instant) ?? Date.parse(instant)).toUTCString();
}

/** The transcript MIME types an episode's URL extension names (Podcasting 2.0's `type`, required on the tag). */
const TRANSCRIPT_TYPES: Readonly<Record<string, string>> = {
  '.vtt': 'text/vtt',
  '.srt': 'application/x-subrip',
  '.json': 'application/json',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
};

/** The transcript's `type` from its URL's extension, or `undefined` when the address names no known transcript file. */
function transcriptTypeOf(url: string): string | undefined {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const dot = path.lastIndexOf('.');
    return dot === -1 ? undefined : TRANSCRIPT_TYPES[path.slice(dot)];
  } catch {
    return undefined;
  }
}

/** The channel lines and the checklist notes for the six tags Apple requires (av-script.md §5). */
function channelLines(channel: PodcastChannel): { readonly lines: readonly string[]; readonly notes: readonly string[] } {
  const lines: string[] = [];
  const notes: string[] = [];
  const missing = (tag: string, why: string) => notes.push(`channel missing ${tag} — Apple requires it: ${why}`);
  if (channel.title.trim() === '') missing('title', 'the show needs a title');
  else lines.push(`<title>${escapeXml(channel.title)}</title>`);
  // RSS 2.0 needs the channel's <link>; podcastRssOutput refuses the compile when the show names none.
  if (channel.link !== undefined) lines.push(`<link>${escapeXml(channel.link)}</link>`);
  if (channel.description === undefined || channel.description.trim() === '') {
    missing('description', 'set the show description or the folder synopsis');
  } else lines.push(`<description>${escapeXml(channel.description)}</description>`);
  if (channel.language === undefined || channel.language.trim() === '') {
    missing('language', 'set the show language (script.setShowMeta), or the project language');
  } else lines.push(`<language>${escapeXml(channel.language)}</language>`);
  // itunes:image takes an https address; the show artwork is a project asset, which has none (§5, SD10).
  missing('itunes:image', channel.hasArtwork
    ? 'the show artwork is a project asset — a feed needs its hosted https address, which no field holds yet'
    : 'set the show artwork when it is hosted at an https address');
  if (channel.category === undefined) missing('itunes:category', 'set the show category (script.setShowMeta)');
  else lines.push(`<itunes:category text="${escapeXml(channel.category)}"/>`);
  if (channel.explicit === undefined) missing('itunes:explicit', 'set the show explicit flag (script.setShowMeta)');
  else lines.push(`<itunes:explicit>${channel.explicit ? 'true' : 'false'}</itunes:explicit>`);
  if (channel.fundingUrl !== undefined) {
    lines.push(`<podcast:funding url="${escapeXml(channel.fundingUrl)}">Support the show</podcast:funding>`);
  }
  return { lines, notes };
}

/**
 * The episodes that make items: a published episode with all three enclosure fields. Every other episode is
 * skipped with a line naming it and what it lacks — the draft rule (web-publishing.md §3) for a missing or
 * unreadable publish date, the enclosure checklist (av-script.md §5) for the audio fields.
 */
function keptEpisodes(episodes: readonly PodcastEpisode[]): { readonly kept: readonly { ep: PodcastEpisode; instant: string }[]; readonly notes: readonly string[] } {
  const kept: { ep: PodcastEpisode; instant: string }[] = [];
  const notes: string[] = [];
  for (const ep of episodes) {
    const instant = publishString(ep.publish, 'publishedAt');
    if (instant === undefined || instantMs(instant) === undefined) {
      notes.push(`skipped: ${ep.title} — a draft (no publish date), omitted from the feed`);
      continue;
    }
    const missing = ENCLOSURE_KEYS.filter((key) => ep.meta[key] === undefined);
    if (missing.length > 0) {
      notes.push(`skipped: ${ep.title} — no enclosure: ${missing.join(', ')} not set on the episode (script.setEpisodeMeta)`);
      continue;
    }
    kept.push({ ep, instant });
  }
  return { kept, notes };
}

/** One `<item>`: title, enclosure, guid, pubDate, then the itunes and podcast tags the episode holds. */
function itemLines(ep: PodcastEpisode, instant: string, channel: PodcastChannel, notes: string[]): string[] {
  const m = ep.meta;
  const lines: string[] = [
    `<item>`,
    `<title>${escapeXml(ep.title)}</title>`,
    `<enclosure url="${escapeXml(m.audioUrl as string)}" length="${m.audioBytes}" type="${escapeXml(m.audioMime as string)}"/>`,
    `<guid isPermaLink="false">${escapeXml(ep.docId)}</guid>`,
    `<pubDate>${rfc822(instant)}</pubDate>`,
  ];
  if (ep.durationSec !== undefined && ep.durationSec > 0) {
    lines.push(`<itunes:duration>${Math.round(ep.durationSec)}</itunes:duration>`);
  }
  if (m.episode !== undefined) lines.push(`<itunes:episode>${m.episode}</itunes:episode>`);
  if (m.season !== undefined) lines.push(`<itunes:season>${m.season}</itunes:season>`);
  if (m.episodeType !== undefined) lines.push(`<itunes:episodeType>${m.episodeType}</itunes:episodeType>`);
  const transcriptType = m.transcriptUrl === undefined ? undefined : transcriptTypeOf(m.transcriptUrl);
  if (transcriptType !== undefined) {
    const language = channel.language === undefined ? '' : ` language="${escapeXml(channel.language)}"`;
    lines.push(`<podcast:transcript url="${escapeXml(m.transcriptUrl as string)}"${language} type="${transcriptType}"/>`);
  } else if (m.transcriptUrl !== undefined) {
    notes.push(`skipped podcast:transcript on "${ep.title}" — its address names no transcript type the feed can declare (a .vtt, .srt, .json, .html, .txt, .md or .pdf path)`);
  }
  if (m.chaptersUrl !== undefined) {
    lines.push(`<podcast:chapters url="${escapeXml(m.chaptersUrl)}" type="application/json+chapters"/>`);
  }
  if (channel.fundingUrl !== undefined) {
    lines.push(`<podcast:funding url="${escapeXml(channel.fundingUrl)}">Support the show</podcast:funding>`);
  }
  lines.push(`</item>`);
  return lines;
}

/**
 * RSS 2.0 with the itunes and podcastindex namespaces (av-script.md §5). The `<link>` is the show's home
 * (`showMeta.link`) — the feed names no site of its own.
 */
export function renderPodcastRss(input: PodcastFeedInput): RenderedPodcastFeed {
  const channel = channelLines(input.channel);
  const { kept, notes: skipNotes } = keptEpisodes(input.episodes);
  const itemNotes: string[] = [];
  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0">`,
    `<channel>`,
    ...channel.lines,
  ];
  for (const { ep, instant } of kept) lines.push(...itemLines(ep, instant, input.channel, itemNotes));
  lines.push(`</channel>`, `</rss>`, '');
  return { xml: lines.join('\n'), notes: [...channel.notes, ...skipNotes, ...itemNotes] };
}
