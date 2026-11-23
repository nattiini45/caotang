/**
 * **Import captions…** through the shared preview (import-captions.md §5, issue #287): an SRT or WebVTT file becomes one AV script
 * episode in a show folder, with every line's duration declared from the file's own timings. Nothing is written until Import, which
 * commits one `binder.importTree`.
 *
 * The decode and the parse run in the preview's `'self'` Worker host (reader-host.ts, #390), so a long transcript never blocks the
 * main thread. The bytes are handed over once; an encoding change re-reads the Worker's cached copy. The episode body is built on the
 * main thread from the cached cues, because the writer's choices (merge, the gap that starts a segment, what silence becomes, the show
 * folder) re-plan without reading the file again.
 *
 * Loaded on first use by the Import captions action (ManuscriptImport.tsx), so the first load carries neither the reader nor this.
 */
/* lingui-set comment="The captions import. Interpolated values: file (the file's name), limit, count, cues, lines, segments and seconds (numbers), sample (text from the file), encoding (an encoding's name)" */

import { plural, t } from '@lingui/core/macro';
import { buildEpisode, type BuiltEpisode, type CaptionsRead, type ImportCaptionsLoss } from '@caotang/import-captions';
import { MAX_TEXT_BYTES, MAX_TEXT_LINES } from '@caotang/import-read/text';
import type { DecodableEncoding } from '@caotang/store/encoding';

import { formatCount } from '../i18n/locale.js';
import type { ImportPreviewSource, PreviewBlock, PreviewChip, PreviewMarker, PreviewOption, PreviewPlan, PreviewReportList, PreviewSettings } from './model.js';
import { ReaderHost } from './reader-host.js';
import { encodingLabel } from './text-source.js';

export const CAPTIONS_CHIPS = { encoding: 'encoding', gap: 'captions-gap', silence: 'captions-silence' } as const;
export const CAPTIONS_OPTIONS = { merge: 'captions-merge', show: 'captions-show' } as const;

/** The gaps a segment can start at, in seconds. `0` keeps the whole file in one segment. */
const GAPS = [0, 1, 2, 3, 5, 10, 30] as const;

export type CaptionsImportOpening = { readonly ok: true; readonly source: ImportPreviewSource } | { readonly ok: false; readonly message: string };

const ENCODINGS: readonly DecodableEncoding[] = ['utf-8', 'utf-16le', 'utf-16be', 'windows-1252', 'iso-8859-15', 'gb18030', 'big5', 'shift_jis', 'euc-kr'];

function isEncoding(value: string | undefined): value is DecodableEncoding {
  return value !== undefined && (ENCODINGS as readonly string[]).includes(value);
}

/** Why a file of this size is not read at all, before its bytes are loaded; undefined when the reader takes it. */
export function captionsSizeRefusal(fileName: string, size: number): string | undefined {
  if (size <= MAX_TEXT_BYTES) return undefined;
  return t`${{ file: fileName }} is too large to import as captions: the import reads files up to ${{ limit: formatCount(MAX_TEXT_BYTES / (1024 * 1024)) }} MB.`;
}

/** The file's name without its extension, which names the show and the episode when the file names no title. */
export function captionsBaseName(fileName: string): string {
  const withoutPath = fileName.split(/[\\/]/).pop() ?? fileName;
  return withoutPath.replace(/\.(?:srt|vtt)$/i, '') || withoutPath;
}

/**
 * One loss as the writer reads it. The dialog writes the count before the message ("3 × …"), so each is a noun phrase and every code
 * the reader and the builder return has a sentence here: nothing is dropped silently.
 */
function lossSentence(loss: ImportCaptionsLoss): string {
  const sample = loss.sample ?? '';
  switch (loss.kind) {
    case 'styling':
      return t`caption styling (bold, italic, colour) left out: a script line holds words, not styling. First: ${{ sample }}`;
    case 'inline-timestamp':
      return t`timestamps inside the words (karaoke timing) left out; the cue's own start and end are kept. First: ${{ sample }}`;
    case 'cue-settings':
      return t`cue positions and alignments left out: a script has no screen position. First: ${{ sample }}`;
    case 'coordinates':
      return t`SRT cue coordinates left out: a script has no screen position. First: ${{ sample }}`;
    case 'style-block':
      return t`STYLE blocks left out; they style captions on a screen.`;
    case 'region-block':
      return t`REGION blocks left out; they place captions on a screen.`;
    case 'cue-id':
      return t`cue identifiers left out; the script mints its own line ids on save. First: ${{ sample }}`;
    case 'empty-cue':
      return t`cues with no words left out. First: ${{ sample }}`;
    case 'bad-timing':
      return t`cues with a timing that cannot be read (minutes and seconds must be under 60) left out. First: ${{ sample }}`;
    case 'out-of-order':
      return t`cues that start before the cue before them, kept in the file's order. First: ${{ sample }}`;
    case 'overlap':
      return t`cues that overlap the cue before them, both kept, so the lines may add up to more than the recording. First: ${{ sample }}`;
    case 'short-cue':
      return t`cues that end when they start or earlier, so their line has no duration of its own. First: ${{ sample }}`;
    case 'two-speakers':
      return t`cues naming two speakers, kept as one line under the first. First: ${{ sample }}`;
    case 'stray-text':
      return t`stretches of text belonging to no cue, left out. First: ${{ sample }}`;
    case 'srt-period':
      return t`a period before the milliseconds, which WebVTT writes and SRT does not; read all the same. First: ${{ sample }}`;
    case 'speaker-renamed':
      return t`speaker names shortened to what a script label can hold. First: ${{ sample }}`;
    case 'speaker-cue-word':
      return t`speaker names that are also cue words (music, sfx, ambience, ad, pause, sting), given an underscore to stay speech. First: ${{ sample }}`;
    case 'untimed-line':
      return t`lines with no duration of their own, which the script estimates from the show's speech rate. First: ${{ sample }}`;
    case 'text-bracket':
      return t`lines ending with a bracket of numbers, which stays part of the words rather than a timing. First: ${{ sample }}`;
  }
}

/** What the first read found, for the encoding chip and the report. */
interface FirstRead {
  readonly suggested: DecodableEncoding;
  readonly guessed: boolean;
  readonly choices: readonly DecodableEncoding[];
}

/**
 * Opens a captions file for the preview. The first read happens in the Worker when the dialog loads; a file past the reader's caps,
 * in no encoding it can name, or with no timed cue fails the load with a message.
 */
export function captionsPreviewSource(fileName: string, bytes: Uint8Array): CaptionsImportOpening {
  if (bytes.length > MAX_TEXT_BYTES) return { ok: false, message: captionsSizeRefusal(fileName, bytes.length) ?? '' };

  const host = new ReaderHost();
  const cache = new Map<string, CaptionsRead>();
  let first: FirstRead | null = null;
  let shownEncoding: DecodableEncoding = 'utf-8';
  let last: PreviewSettings = { chips: {}, options: {} };
  const fallbackTitle = captionsBaseName(fileName);

  const encodingOf = (settings: PreviewSettings): DecodableEncoding => {
    const chosen = settings.chips[CAPTIONS_CHIPS.encoding];
    return isEncoding(chosen) ? chosen : (first?.suggested ?? 'utf-8');
  };
  const gapOf = (settings: PreviewSettings): number => {
    const chosen = Number(settings.chips[CAPTIONS_CHIPS.gap]);
    return (GAPS as readonly number[]).includes(chosen) ? chosen : 3;
  };
  const silenceOf = (settings: PreviewSettings): 'fold' | 'leave' => (settings.chips[CAPTIONS_CHIPS.silence] === 'leave' ? 'leave' : 'fold');
  const mergeOf = (settings: PreviewSettings): boolean => settings.options[CAPTIONS_OPTIONS.merge] ?? true;
  const showOf = (settings: PreviewSettings): boolean => settings.options[CAPTIONS_OPTIONS.show] ?? true;

  const refusal = (code: 'no-cues' | 'too-many-cues'): string =>
    code === 'no-cues'
      ? t`${{ file: fileName }} holds no timed cue, so there is nothing to import. A captions file needs lines like "00:00:01,000 --> 00:00:04,000".`
      : t`${{ file: fileName }} has more cues than one import reads. Split the recording and import it in parts.`;

  const episodeFor = (settings: PreviewSettings): BuiltEpisode | null => {
    const read = cache.get(encodingOf(settings));
    if (read === undefined) return null;
    return buildEpisode(read, {
      mergeSameSpeaker: mergeOf(settings),
      gapSegmentSec: gapOf(settings),
      silence: silenceOf(settings),
      title: read.title ?? fallbackTitle,
    });
  };

  const load = async (progress: (text: string) => void, signal: AbortSignal): Promise<void> => {
    progress(t`Reading ${{ file: fileName }}…`);
    await host.open({ kind: 'open', reader: 'captions', bytes }, signal);
    const reply = await host.read({ kind: 'read', reader: 'captions' }, signal);
    if (reply.kind !== 'captions') throw new Error(t`The file could not be read as captions.`);
    if (reply.result.status === 'undecoded') {
      const decode = reply.result.decode;
      if (decode.status === 'too-large') throw new Error(captionsSizeRefusal(fileName, decode.bytes) ?? '');
      if (decode.status === 'too-many-lines') {
        throw new Error(t`${{ file: fileName }} has more lines than a captions import reads: at most ${{ limit: formatCount(MAX_TEXT_LINES) }}.`);
      }
      const suggested = decode.suggested;
      if (suggested === undefined) throw new Error(t`Caotang cannot tell which encoding ${{ file: fileName }} is in, so it cannot import it.`);
      const second = await host.read({ kind: 'read', reader: 'captions', encoding: suggested }, signal);
      if (second.kind !== 'captions' || second.result.status !== 'read') {
        throw new Error(t`The file cannot be read as ${{ encoding: encodingLabel(suggested) }}. Choose another encoding.`);
      }
      if (!second.result.parse.ok) throw new Error(refusal(second.result.parse.error.code));
      first = { suggested, guessed: true, choices: [...new Set([suggested, ...decode.detection.candidates.map((candidate) => candidate.encoding)])] };
      shownEncoding = suggested;
      cache.set(suggested, second.result.parse.value);
      return;
    }
    const result = reply.result;
    if (!result.parse.ok) throw new Error(refusal(result.parse.error.code));
    first = {
      suggested: result.encoding,
      guessed: result.guessed,
      choices: result.guessed ? [...new Set([result.encoding, ...result.candidates.map((candidate) => candidate.encoding)])] : [],
    };
    shownEncoding = result.encoding;
    cache.set(result.encoding, result.parse.value);
  };

  const prepare = async (settings: PreviewSettings, signal: AbortSignal): Promise<void> => {
    const encoding = encodingOf(settings);
    // The report names the encoding the text is actually decoded as, including when the writer chooses one already read: going
    // back to the first guess must not leave the report naming the encoding they just left.
    shownEncoding = encoding;
    if (cache.has(encoding)) return;
    const reply = await host.read({ kind: 'read', reader: 'captions', encoding }, signal);
    // A chosen encoding that cannot be read is a failure the dialog must show: returning quietly would leave it on Reading for
    // ever, with no plan and no way back but Cancel.
    if (reply.kind !== 'captions') throw new Error(t`The file could not be read as captions.`);
    if (reply.result.status !== 'read') throw new Error(t`The file cannot be read as ${{ encoding: encodingLabel(encoding) }}. Choose another encoding.`);
    if (!reply.result.parse.ok) throw new Error(refusal(reply.result.parse.error.code));
    cache.set(encoding, reply.result.parse.value);
  };

  const chips = (): PreviewChip[] => [
    ...(first === null || first.choices.length === 0
      ? []
      : [{ id: CAPTIONS_CHIPS.encoding, label: t`Encoding`, value: first.suggested, options: first.choices.map((encoding) => ({ value: encoding, label: encodingLabel(encoding) })) }]),
    {
      id: CAPTIONS_CHIPS.gap,
      label: t`New segment at a gap of`,
      value: '3',
      options: GAPS.map((gap) => ({
        value: String(gap),
        label: gap === 0 ? t`Never: one segment` : t`${{ seconds: formatCount(gap) }} s`,
      })),
    },
    {
      id: CAPTIONS_CHIPS.silence,
      label: t`Silence between lines`,
      value: 'fold',
      options: [
        { value: 'fold', label: t`Add it to the line before` },
        { value: 'leave', label: t`Leave it out` },
      ],
    },
  ];

  const options = (): PreviewOption[] => [
    { id: CAPTIONS_OPTIONS.merge, label: t`Merge consecutive cues of one speaker`, checked: true },
    { id: CAPTIONS_OPTIONS.show, label: t`Put the episode in a show folder`, checked: true, detail: t`A show holds the speech rate and the cue words its episodes share.` },
  ];

  const plan = (settings: PreviewSettings): PreviewPlan => {
    last = settings;
    const built = episodeFor(settings);
    if (built === null) return { blocks: [], markers: [], tree: [], counts: { words: 0, parts: 0, chapters: 0, scenes: 0, images: 0, comments: 0, footnotes: 0 }, losses: [], flags: [] };
    const blocks: PreviewBlock[] = [];
    const markers: PreviewMarker[] = [];
    for (const line of built.body.split('\n')) {
      if (line === '') continue;
      if (line.startsWith('## ')) {
        markers.push({ blockIndex: blocks.length, kind: 'scene', reason: t`a segment of the episode` });
        blocks.push({ kind: 'heading', text: line.slice(3) });
      } else if (line.startsWith('# ')) blocks.push({ kind: 'heading', text: line.slice(2) });
      else blocks.push({ kind: 'para', text: line });
    }
    const end = Math.max(0, blocks.length - 1);
    const episode = { id: 'episode', role: 'text' as const, title: built.title, startBlock: 0, endBlock: end, words: built.words, body: built.body, kind: 'av-script' as const };
    const tree = showOf(settings)
      ? [{ id: 'show', role: 'part' as const, title: built.title, startBlock: 0, endBlock: end, words: built.words, kind: 'show' as const, children: [episode] }]
      : [episode];
    return {
      blocks,
      markers,
      tree,
      counts: { words: built.words, parts: showOf(settings) ? 1 : 0, chapters: 0, scenes: 1, images: 0, comments: 0, footnotes: 0 },
      losses: built.losses.map((loss) => ({ message: lossSentence(loss), count: loss.count })),
      flags: [],
    };
  };

  const report = (): PreviewReportList[] => {
    const lists: PreviewReportList[] = [];
    if (first !== null && first.guessed) {
      const label = t`Encoding`;
      lists.push({ heading: label, label, lines: [t`The file is read as ${{ encoding: encodingLabel(shownEncoding) }}, a guess. If letters look wrong in the text, choose another encoding.`] });
    }
    const built = episodeFor(last);
    if (built !== null) {
      const cues = built.cues;
      const lines = built.lines;
      const segments = built.segments.length;
      const merged = built.merged;
      const what = t`What the import does`;
      const said = [
        t`${{ cues: formatCount(cues) }} ${plural(cues, { one: 'cue', other: 'cues' })} become ${{ lines: formatCount(lines) }} ${plural(lines, { one: 'speech line', other: 'speech lines' })} in ${{ segments: formatCount(segments) }} ${plural(segments, { one: 'segment', other: 'segments' })}. Every duration comes from the file's own timings.`,
        t`The episode runs ${{ seconds: formatCount(built.seconds) }} s as imported.`,
      ];
      if (merged > 0) said.push(t`${{ count: formatCount(merged) }} ${plural(merged, { one: 'cue', other: 'cues' })} joined an earlier line, because one speaker continued.`);
      if (built.foldedSec > 0) said.push(t`${{ seconds: formatCount(built.foldedSec) }} s of silence is added to the line before it, so those lines are longer than they were spoken. Choose "Leave it out" to keep each line exact.`);
      if (built.leftOutSec > 0) said.push(t`${{ seconds: formatCount(built.leftOutSec) }} s of silence between lines is left out, so the episode is shorter than the recording.`);
      if (built.gapSec > 0) said.push(t`${{ seconds: formatCount(built.gapSec) }} s of silence at the segment breaks is outside the episode's runtime.`);
      if (built.leadingSec > 0) said.push(t`The recording's first ${{ seconds: formatCount(built.leadingSec) }} s before the first cue are not kept: a script line holds a duration, not a start time.`);
      // A cue that starts and ends at the same time gives its line no duration, and the episode's own parser estimates one from
      // the show's speech rate when it is opened. The runtime above is the timed part, so the report says what is not in it.
      const untimed = built.losses.find((loss) => loss.kind === 'untimed-line')?.count ?? 0;
      if (untimed > 0) {
        said.push(t`${{ count: formatCount(untimed) }} ${plural(untimed, { one: 'line', other: 'lines' })} carry no duration, because their cues start and end at the same time. The show's speech rate estimates them when you open the episode, so the runtime above is the timed part only.`);
      }
      lists.push({ heading: what, label: what, lines: said });
    }
    return lists;
  };

  return {
    ok: true,
    source: {
      fileName,
      title: t`Import captions?`,
      intro: t`${{ file: fileName }} becomes one AV script episode. Read what the import changes first; rename the show and the episode here if you like.`,
      load,
      prepare,
      prepared: (settings) => cache.has(encodingOf(settings)),
      dispose: () => host.dispose(),
      chips,
      options,
      plan: (settings) => plan(settings),
      importLabel: () => t`Import the episode`,
      report,
    },
  };
}
