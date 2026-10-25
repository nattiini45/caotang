# AV script — podcasts, radio drama and narrated video (media track)

> Status: 🧭 **specified, not built.** No `av-script` document kind, `show` folder kind, script parser, runtime total or AV export exists in the current build; the decisions in §10 bind the work when it is cut.
> Scope: one **linear timed script** for podcasts, radio and audio drama, and narrated video — a show folder and an episode document, segments and speaker turns parsed from Markdown, audio cues with their own offsets, per-line durations declared or estimated from a speech rate, episode runtime totals, and the compile targets a serial needs: a VO script, show notes, a transcript, a teleprompter, captions, chapters and a feed.
> Cross-refs: the media-track rule (new kinds, exporters and tools, never a fork) = [media-track.md](media-track.md) §0 · a parsed-text document kind = [screenplay.md](screenplay.md) §2 and [comics.md](comics.md) §3.1 · speakers, stable line ids and the recordable-unit table = [dialogue-narrative.md](dialogue-narrative.md) §2.1/§4/§6 · per-item `durationSec` and the totals shape = [storyboard.md](storyboard.md) §2.2 and `animaticTotals` · the audio cue vocabulary already in the tree = [video-prompt-pack.md](video-prompt-pack.md) §2 (`VideoAudio`) · the feed writers this rides = [web-publishing.md](web-publishing.md) §3 · the closed check registry = [coherence.md](coherence.md) §5.4 · the medium-adapter registry = [timeline.md](timeline.md) §9.3 · unknown-tolerant manifest fields = [project-format.md](project-format.md) §6 · the plain-text artifact rule = [../decisions.md](../decisions.md).

## 1. Fit with the media track

An AV script is a new *document kind + folder kind + exporters*, exactly like the comic script ([comics.md](comics.md) §1). It is **not** a third branching format and **not** a storyboard: Ink is a graph with choices, a storyboard is film time over a Fountain scene, and an AV script is a **linear spoken spine** — one thing after another, timed, with speakers.

The claim this spec rests on is that a podcast episode and a narrated video are the *same* document differing only in which cue track is populated: audio cues (music, effects, ambience, ad reads) for a podcast, visual cues for video — and the visual half already exists as the storyboard, whose shots carry `durationSec` and point at a script through `dialogue[]` coverage anchors. Audio description is independent evidence for the same shape: it is a timed narration track keyed to visual events, written into the gaps between dialogue (ACB Audio Description Project; ISO/IEC TS 20071-21).

### 1.1 Evidence

| # | Convention or pain point (evidence) | How the design follows it |
|---|---|---|
| E1 | **There is no standard podcast script markup.** Vendor guides agree on a *shape* — intro or hook, content segments, sponsor read, outro — and describe scripts ranging from word-for-word to a loose outline, with "an hour-long fully scripted podcast" at 45–65 pages (Buzzsprout; Descript; Riverside; Lower Street — all vendor blogs, cited as practice, not standard) | The dialect is a Caotang choice (§3), the segment vocabulary is free text, and **an unknown cue label is kept as text, never dropped** (§3, SD7). The episode shape is not enforced: a writer who wants only an outro writes only an outro. |
| E2 | **Radio drama has produced-script evidence but no published rulebook.** The BBC Writersroom Script Library holds ~60 real produced radio scripts showing centred capitalised character names and parenthesised cues such as "(SOUND OF GLASS BREAKING)"; practitioner guidance numbers cues per page or scene, underlines music and effects cues and never underlines dialogue, and uses `MUSIC:` / `SOUND:` labels with `FADE UNDER` and `(STING)` (Tony Palermo, RuyaSonic). Radio layout is "simpler and less prescriptive than for film and TV" (Paul Green). **No BBC format rulebook exists on the open web, and no "1 page = 1 minute" rule for radio could be verified** | Speaker names in caps on their own line, cues as labelled lines, parenthetical modifiers kept (§3). Runtime comes from a **speech rate**, not a page count (§4, SD5) — the page-per-minute rule the screenplay uses is explicitly *not* carried over, because the figure found for radio is for double-spaced pages and is not citable. |
| E3 | **The speech rate is documented and it disagrees by use case.** The BBC's own news guide states "Most people speak at three words a second, so the script for a 30-second report contains about 90 words" (≈180 wpm); radio literature recommends 160–180 wpm and measured BBC bulletins average 168 wpm (Rodero 2012, *Text & Talk* 32(3)); audiobook narration runs ~150–160 wpm, with "9,300 words = 1 finished hour"; presentations 125–150 wpm | The rate is a **show setting** with two presets — 150 wpm narration, 170 wpm broadcast — and is never a hidden constant (§4, SD5). A declared duration always beats an estimate. |
| E4 | **No citable standard defines the cue label set.** `MUSIC:` / `SOUND:` and `(STING)`, `FADE UNDER` come from practitioner templates (RuyaSonic); a **bed** is "the music or sound effects behind or under a voice actor's voice" and an **out cue** is "the last few words of a recording… [which] tells the hosts and the show editor how a report ends" (Voices.com glossary; NPR Training glossary, 2025); `PAUSE` appears in produced scripts | The default vocabulary is `music`, `sfx`, `ambience`, `ad`, `pause`, `sting` — and it is a **show setting**, so a writer's own `BED:` or `O.C.` parses as a cue with their label intact (§3, SD7). `under` is a flag on a cue, from the bed definition (E4). |
| E5 | **The two-column A/V script is a real named convention with no formal specification.** Visuals in one column, audio (VO, dialogue, SFX, music) in the other, aligned per beat, often with a timing column; Final Draft AV has used the split-page two-column format since 2001 (StudioBinder; Canva — excerpt-level, no standards body) | The audio column is this spec's script. The visual column is the storyboard, joined by coverage anchors (§6, S9). A two-column compile is a **later phase**, not a plan item, because it needs S9 first. |
| E6 | **Timed multi-speaker interchange is standardised, and it is wall-clock.** WebVTT is a W3C Candidate Recommendation: a `WEBVTT` header, `hh:mm:ss.ttt` with a **period**, cues joined by ` --> `, an optional cue identifier, and a standardised voice span `<v Speaker>text</v>` for speaker attribution. SRT has **no official specification**: `HH:MM:SS,mmm` with a **comma**, a mandatory index, and no standard speaker markup. SMPTE timecode `HH:MM:SS:FF` is frame-rate-dependent, and drop-frame exists only to correct NTSC's 29.97-versus-30 offset | Durations are **seconds, never frames** (§4, SD4). Captions export as WebVTT first, using the voice span for speakers; SRT is a later phase and its lack of speaker markup is documented, not papered over (§5, SD9). |
| E7 | **Chapter rules differ per platform, and they are export gates.** YouTube: the first timestamp must be `00:00`, at least three timestamps in ascending order, minimum chapter length 10 s, typed into the description, and manual chapters override automatic ones. Spotify: at least three chapters, first at `00:00`, at least 30 s apart. Apple: at least three chapters, each at least 2 minutes, titles at most 45 characters, delivered as `podcast:chapters` | The **model stores segments and offsets only**; every gate lives in the exporter that must satisfy it (§5, SD6). A compile that cannot meet a platform's minimum says so in the compile log rather than emitting a chapter list the platform will reject. |
| E8 | **Retention formulas are folklore.** Hook-in-the-first-N-seconds, pattern interrupts every 60–90 s and CTA placement appear only in creator blogs and courses, with mutually inconsistent parameters; YouTube's own documentation *measures* retention and prescribes no script structure | **Not encoded.** No segment kind is privileged, no hook is required, and no lint fires on structure. A writer may name a segment "Hook"; that is free text (E1). |

## 2. Model

`packages/script`, pure, injected into the store like `@caotang/storyboard` and `@caotang/comic`:

```ts
tree[].kind: 'show'                 // folder = a podcast, a series or a channel; its children are episodes
tree[].showMeta: {
  feedTitle?: string;               // absent = the folder title
  author?: string;
  language?: string;                // an ISO 639 value; Apple fails a feed without one
  explicit?: boolean;               // Apple's channel-required tag, values true|false
  category?: string;                // Apple recognises only the first category and subcategory
  link?: string;                    // absolute https; the show's home
  imageAssetId?: string;            // a picture-registry record (pictures.md §2.1)
  targetRuntimeSec?: number;        // declared, so §4's overrun check has something to compare against
  speechRateWpm?: number;           // §4; absent = the 'narration' preset
  ratePreset?: 'narration' | 'broadcast';
  cueVocabulary?: string[];         // §3, SD7; absent = the default six
}

tree[].kind: 'av-script'            // document = one episode. Body stays docs/<id>.md
```

`bodyExtensionOf` already falls through to `.md` for any document that is not `kind: 'screenplay'`, so **`packages/store/src/paths.ts` is untouched** and no new body extension is added. Segments are **not** binder nodes: the binder holds the show folder and the episode document only, following the rule the dialogue container sets ("the binder holds the container only, never per-beat nodes", [dialogue-narrative.md](dialogue-narrative.md) §2.1) and the way a Fountain document holds many scenes as text.

What the parser derives, never stored as a second copy of the text:

```ts
interface ScriptEpisode { segments: ScriptSegment[]; totals: ScriptTotals }
interface ScriptSegment { id; title; lines: ScriptLine[]; cues: ScriptCue[]; startSec?: number; durationSec?: number }
interface ScriptLine    { id; kind: 'speech' | 'narration' | 'text'; speaker?: string; text: string;
                          durationSec?: number; declared: boolean }
interface ScriptCue     { id; kind: string; text: string; atSec?: number; forSec?: number; under?: boolean }
interface ScriptTotals  { seconds: number; timedCount: number; untimed: readonly string[] }
```

`ScriptTotals` is deliberately the `AnimaticTotals` shape — `{ seconds, timedCount, untimed }`, rounded to two places, over binder order — so the timeline, the coverage check and the episode view all read the same arithmetic that `packages/storyboard/src/animatic.ts` already established, including its rule that an item with no duration is excluded from the sum and reported as untimed rather than counted as zero.

`ScriptLine.id` follows the dialogue package's stable-line-id pattern, and `speaker` resolves against the codex the way `resolveSpeakerId` does: the codex id when it resolves, else the typed name, else the show's default speaker, else empty. Cues carry `kind` as an **open string**, not an enum (SD7).

## 3. Script and markup

The body is Markdown a writer can read without Caotang, parsed as text the way Fountain and the comic script are ([screenplay.md](screenplay.md) §2, [comics.md](comics.md) §3.1). **No new storage format, and codex mention detection works on it unchanged.**

```markdown
# Episode 12 — The Long Way Round

## Cold open

MUSIC: Theme, in and under [0:12]
NARRATION: Previously, on the show. [0:08]

## Segment 1 — The interview

HOST_A: Welcome back. (over the theme) [0:15]
SFX: Door slam, at 0:04
HOST_B: Did we record that?
AD: Midroll, reads live [0:30]

## Outro

HOST_A: See you next week.
MUSIC: Theme out, fade under
```

- `## Heading` is a **segment**. The heading text is free; nothing is privileged (E1, E8).
- `SPEAKER: text` is a **speech line**; an all-caps or title-case name before the colon resolves against the codex (§2). `NARRATION:` is a speech line whose speaker is the narrator, kept distinct so a transcript can render it differently.
- A **cue line** is a label from the show's vocabulary followed by a colon (E4). An unrecognised label stays a cue with the writer's own label; a line with no recognised speaker and no colon is plain `text`, never dropped.
- `[0:15]` or `[15s]` at the end of a line or cue **declares** its duration. A declared duration always wins over an estimate (§4).
- `(over)`, `(under)`, `(OFF)` and other parentheticals are kept as modifiers on the line, following the screenplay's parenthetical and the comic script's modifiers; `under` on a cue sets its `under` flag (E4).
- A cue's `atSec` is declared, or derived as the sum of the durations before it in the segment. **Cues belong to the segment, not to a line**, because a music bed, a B-roll shot and an effect do not align one-to-one with speech (SD6).
- Unknown markup loads tolerantly and round-trips as the text it was ([project-format.md](project-format.md) §6).

## 4. Timing

Durations are **seconds** (SD4). Frames are never stored: SMPTE `HH:MM:SS:FF` is frame-rate-dependent, drop-frame arithmetic is meaningless without a declared rate, and every target this track exports to — WebVTT, SRT, YouTube and Spotify chapters, `podcast:soundbite` — is wall-clock (E6).

A line's duration is its **declared** `[0:15]` when it has one, else an **estimate**: its word count divided by the show's speech rate, using the project's existing word-counting rule (unspaced scripts counted by `Intl.Segmenter`, as `coherence-words` already does). The rate is a show setting with two presets — **150 wpm** for narration and **170 wpm** for broadcast — because the measured sources disagree by use case and a single hidden constant would be wrong for half of them (E3, SD5). An estimate is marked `declared: false`, so the view can show estimated timings differently and the overrun check can say which numbers are soft.

A segment's duration is the sum of its lines plus the cues that extend past them; an episode's is `ScriptTotals.seconds`. `targetRuntimeSec` on the show makes overrun a checkable claim rather than a guess.

## 5. Export

| Format | Behaviour |
|---|---|
| `vo-script-csv`, `vo-script-xlsx` | The recordable unit: one row per speakable line in order, columns `lineId, segment, speaker, text, durationSec, declared`. CSV is RFC 4180 like the dialogue table — UTF-8, CRLF records, quoted fields holding a comma, quote or line break — and the XLSX goes through the spreadsheet writer the dialogue table and shot list already share. This is the audition and record sheet, the surface [dialogue-narrative.md](dialogue-narrative.md) §6 calls "the auditionable/recordable unit". |
| `show-notes` | Markdown: the episode's segments as a timestamped list, plus the description the show metadata supplies. When a platform's chapter gate can be met it also emits the chapter lines in that platform's own shape — YouTube's description timestamps (`00:00 Intro`, first at `00:00`, at least three, at least 10 s apart) — and when it cannot, the compile log says which gate failed instead of emitting a list the platform will reject (E7). |
| `transcript-md` | A speaker-attributed transcript: the speaker's display name, then the text, segment by segment. Narration is rendered apart from speech. No cues, no timings — a transcript is for reading. |
| `vtt` | WebVTT: the `WEBVTT` header, `hh:mm:ss.ttt` with a **period**, cues joined by ` --> `, and each speaker carried in the standardised voice span `<v Speaker>text</v>` (E6). One cue per speech line, timed from the durations §4 resolved. |
| `chapters-json` | The Podcasting 2.0 chapters document, MIME `application/json+chapters`: `startTime`, `title`, and `endTime` per segment. Referenced from a feed by `podcast:chapters`, and the format Apple and Podcast Index both read. |
| `teleprompter` | Plain text: speech lines only, cues and headings stripped, one line per breath, in reading order. **No cited line-length or syllable-pacing standard exists** — the only figures available are print-typography heuristics — so the wrap width is a recipe option and the spec claims no authority for it (E6's gap, stated plainly). |
| `podcast-rss` | RSS 2.0 over [web-publishing.md](web-publishing.md) §3's feed writer, adding `xmlns:itunes` and `xmlns:podcast` (`https://podcastindex.org/namespace/1.0`; every hyper-text URL in that namespace must be `https`). Channel: `title`, `description`, `language`, `itunes:image`, `itunes:category`, `itunes:explicit` — the six Apple treats as required. Item: `title`, `enclosure`, `guid`, `pubDate` as RFC 822, `itunes:duration` **in seconds** (Apple's current guidance recommends seconds and no longer enumerates a clock format), `itunes:episode`, `itunes:season`, `itunes:episodeType`, `podcast:transcript`, `podcast:chapters`, `podcast:person` (with `role` and `group`) and `podcast:funding`. |
| *(later phase)* `srt`, `av-two-column` | SRT with its comma separator, its mandatory index and **no speaker markup** — a documented limitation, not a silent one (SD9). The two-column A/V compile (E5) needs S9's coverage widening first. |

All join `EXPORT_FORMATS`, appended so the frozen order holds, and `MEDIA_FORMATS`, since they compile through `media.ts` rather than the prose pipeline ([exporter.md](exporter.md) §3). **None is binary** — every one is text — so `BINARY_FORMATS` is untouched and `ArtifactFs` can hold them all.

**A feed references audio; it never contains it.** `enclosure` carries a `url`, a `length` in bytes and a `type` from the set Apple accepts (`audio/mpeg`, `audio/x-m4a`, `video/mp4`, `video/x-m4v`, `video/quicktime`, `application/pdf`), and the URL is one the writer publishes elsewhere. Caotang stores no audio and no video: project files are plain text (SD10). The feed is a valid static XML file — Apple needs the *enclosure and artwork hosts* to answer HTTP HEAD and byte-range requests, not the feed's host to run anything — but a writer who has no audio host yet has a feed with no episodes in it, and the compile log says so.

## 6. Timeline and storyboard

The `av-script` document is the timeline's episode unit, and it carries `SceneMeta` like any document: an audio drama uses day offsets, a talk show leaves them empty. Segments appear as strips under the episode through a `MediumAdapter` in `packages/timeline/src/media.ts` ([timeline.md](timeline.md) §9.3) with `label` = the segment title and `measure` = **seconds**, joining the prose (words), screenplay (pages) and comic (pages) adapters. That adapter belongs with timeline's T11, which adds the storyboard, dialogue and comic adapters.

For narrated video the visual half is the storyboard, and the join already exists in shape: a shot's `dialogue[]` holds `DialogueCoverage` anchors into a script. **`DialogueCoverage.kind` is today the closed literal `'fountain-element'`, and `packages/storyboard/src/shot-meta.ts` returns `undefined` for anything else — it silently drops it.** S9 widens that literal to a small union naming the AV script line, and the widening must keep every existing anchor: a loaded coverage entry whose kind is not recognised is kept and reported, never dropped, which is the project-format's unknown-tolerance rule applied to a field that currently violates it.

## 7. Agent, context and coherence

**Zero new agent tools** (SD8). The script is the source of truth and nothing is derived from it that a model must compute — unlike comic pages from a comic script, or shots from a scene — so the workflow rides `doc.read`, `scene.draft` and `export.compile` enum values, exactly as the screenplay does ([agent-harness.md](agent-harness.md) §10: "Screenplay adds zero tools"). Runtime totals are pure computation shown in the view, not agent work.

Context assembly needs no new layer: the episode is a document, so L5's focus text carries it, and a show's metadata joins L1's project summary. A drafting profile row is added only if `scene.draft` turns out to need AV-specific role text; the spec does not assume one.

Three deterministic checks join the closed registry, appended so the existing order holds, each with its plain-words label because `DETERMINISTIC_CHECK_LABELS` is a total `Record` and a check cannot ship without one ([coherence.md](coherence.md) §5.4 — the registry goes from 18 to 21):

| Check | Fires when | Severity |
|---|---|---|
| `av.untimed-segment` | A segment has no declared duration on any line and no estimated one, so it is excluded from the episode total — the shot-coverage rule for untimed shots, applied to segments | info |
| `av.speaker-unknown` | A speaker name resolves to no codex entry, mirroring `dialogue.speaker-unknown` | warning |
| `av.runtime-overrun` | The episode's total exceeds the show's declared `targetRuntimeSec`, naming which timings are estimates | warning |

## 8. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| The markup dialect is a Caotang invention, so no importer reads a writer's existing scripts | Certain | There is no standard to import from (E1). The dialect is plain Markdown that reads correctly without Caotang, unknown labels are kept (§3), and an importer for a specific tool is a later, evidence-driven addition. |
| Estimated runtimes are wrong enough to mislead | High | Estimates are marked as estimates in the model, the view and the VO script's `declared` column; the rate is a visible show setting; a declared duration always wins (§4). |
| A feed is emitted that Apple rejects | Medium | The six channel-required tags and the three item-required ones are the compile's own checklist, and the compile log names what is missing — a feed with no enclosure host is reported, not silently written (§5). |
| Widening `DialogueCoverage.kind` drops an existing anchor | Low, but costly | S9's done-when is a fixture proving an unrecognised kind is kept and reported; the current `return undefined` behaviour is the defect being fixed (§6). |
| Scope creep into hosting, publishing and analytics | Medium | §5 says plainly that Caotang writes files. No deploy, no platform API, no analytics — the posture the video prompt pack already set. |

## 9. Phased plan

Milestone **Podcasts and video scripts**, epic filed with this spec; its nine sub-issues are S1–S9 in the table below. Every feature issue updates `docs/USER-GUIDE.md`, `CHANGELOG.md` and `docs/ROADMAP.md` in the same pull request and flips this spec's status line for what it builds.

| # | Title | Scope | Done when | Needs |
|---|---|---|---|---|
| S1 | `docs(architecture): specify the AV script track` | This spec; the ARCHITECTURE §2.21 and §6 rows; the decisions.md lines | Spec merged | — |
| S2 | `feat(script): the linear script model, parser and runtime totals` | `packages/script`; the `show` and `av-script` kind markers widened into `BinderCreateParams` and `BINDER_CREATE_TYPES`; `showMeta`; the parser (segments, speakers, cues, declared durations, modifiers); `ScriptTotals`; the speech-rate presets | An episode parses to segments, lines and cues; unknown cue labels survive a round trip; totals match `animaticTotals`' shape and exclude untimed segments; a fixture per markup rule in §3 | S1 |
| S3 | `feat(desktop): an episode view with segments, timings and totals` | `ScriptView.tsx` under `apps/desktop/src/media/`, a new `MediaKind`, a `mediaKindOf` case, a create-menu entry, the runtime total and the estimated-versus-declared distinction shown | A writer reads an episode's segments with their timings and the episode total, and can see which numbers are estimates | S2 |
| S4 | `feat(export): the VO script as CSV and XLSX` | `vo-script-csv`, `vo-script-xlsx`; format registration | The CSV is RFC 4180 and round-trips through the shared spreadsheet writer; the `declared` column distinguishes an estimate | S2 |
| S5 | `feat(export): show notes, transcript and teleprompter` | `show-notes`, `transcript-md`, `teleprompter`; the YouTube chapter gate and its compile-log refusal | Show notes carry timestamps; chapters are emitted only when YouTube's three gates hold, and the log names the gate that failed otherwise | S2 |
| S6 | `feat(export): WebVTT captions and JSON chapters` | `vtt`, `chapters-json` | A VTT file opens in a browser with the right speaker per cue and a **period** millisecond separator; a chapters document is `application/json+chapters` | S5 |
| S7 | `feat(export): a podcast feed` | `podcast-rss` over web-publishing's feed writer; the `itunes:` and `podcast:` namespaces; the required-tag checklist | A feed validates against the W3C feed validator; a missing channel-required tag is named in the compile log; no enclosure is invented | S5, Web publishing W4 |
| S8 | `feat(coherence): untimed segments, unknown speakers and runtime overrun` | The three §7 checks, their labels, and fixtures | The registry count and its arithmetic comment are updated; a fixture per check, over and under each threshold | S2 |
| S9 | `feat(storyboard): let a shot cover an AV script line` | Widen `DialogueCoverage.kind` past `'fountain-element'`; the loader keeps and reports an unrecognised kind instead of returning `undefined` | A shot can cover a script line; **an existing `fountain-element` anchor still loads**; a fixture proves an unrecognised kind is kept, not dropped | S2 |

## 10. Decisions

Numbered with an `SD` prefix, so a reference is never ambiguous between §9's plan items (S) and these decisions (SD). One-line versions are in [decisions.md](../decisions.md).

| # | Decision | Rejected alternative and why |
|---|---|---|
| SD1 | **One linear script model serves podcasts, radio drama and narrated video; they differ in which cue track is populated, not in structure.** | A podcast-only model: the two-column AV script, the radio script and every timed interchange format converge on the same shape — a linear spine of segments carrying speaker turns plus timed non-dialogue cues — and audio description is a fourth discipline over the same timeline. |
| SD2 | **The body is Markdown (`docs/<id>.md`, `kind: 'av-script'`) parsed as text; segments are `##` headings, never binder nodes.** | A node type per segment: the binder holds the container only, the rule the dialogue container already sets, and a 40-segment episode would flood the binder. A new body extension: `bodyExtensionOf` already falls through to `.md`, so `paths.ts` needs no change and the file stays readable in any editor. |
| SD3 | **A new pure `packages/script`; the Ink machinery in `packages/dialogue` is not extended.** Its line-id and speaker-resolution *patterns* are reused, not its parser. | A `linear` container kind beside `branching`: it would pull the Ink compiler, knots and diverts into a format with no branching, and `DIALOGUE_KIND` is a single constant that would have to become a union. A wholly new node kind with its own extension: it costs binder node types and agent tools a text document does not need. |
| SD4 | **Timings are seconds; frames are never stored.** | SMPTE `HH:MM:SS:FF`: drop-frame arithmetic is meaningless without a declared frame rate, and every export target is wall-clock. A frame rate would be a second setting every writer has to get right to gain nothing. |
| SD5 | **A duration is declared or estimated, and the speech rate is a show setting with two presets (150 wpm narration, 170 wpm broadcast).** | One fixed rate: the measured sources disagree by use case — the BBC's 3 words a second for news, 160–180 wpm in the radio literature, ~150–160 for audiobook narration — so any single constant is wrong for half the writers, and a hidden one cannot be corrected. The screenplay's page-per-minute rule is not carried over: the radio figure found is for double-spaced pages and is not citable. |
| SD6 | **Cues belong to the segment and carry their own offsets; platform chapter gates live in the exporter.** | A cue field on each speech line: a music bed, a B-roll shot and an effect do not align one-to-one with dialogue. Gates in the model: YouTube wants at least three chapters 10 s apart, Spotify 30 s apart and Apple 2 minutes apart, so a model-level rule would have to pick one platform and be wrong for the others. |
| SD7 | **The cue vocabulary is a show setting with a default of six labels; an unknown label is kept as text.** | A closed enum: no citable standard defines the label set, and a closed list would drop a writer's own `BED:` or `O.C.` on load — the one thing the project-format's unknown-tolerance rule forbids, since a dropped cue is irreplaceable content. |
| SD8 | **Zero new agent tools.** | A `script.draft` and `script.derive` pair: there is no derived structure for a model to compute, so the tools would wrap work `doc.read`, `scene.draft` and `export.compile` already do. The tool registry is the most expensive surface in the app, and the screenplay precedent shows a parsed-text kind needs none of it. |
| SD9 | **WebVTT before SRT.** | SRT first, because more tools read it: SRT has no official specification and no standard speaker markup, while WebVTT is a W3C Candidate Recommendation with a standardised voice span and Apple prefers it. SRT stays a later phase with its limitation documented rather than hidden. |
| SD10 | **A feed references audio by URL and never contains it; the project stores no audio.** | Storing recordings in `assets/`: project files are plain text, so a folder stays diffable, portable and small, and an audio file would make a `.caotang` bundle a media archive. Caotang writes the feed; the writer hosts the audio, the same split as the video prompt pack. |

## 11. Sources

**Fetched and relied on:** w3.org/TR/webvtt1 (WebVTT: header, `hh:mm:ss.ttt`, ` --> `, cue settings, the `<v Speaker>` voice span) · support.google.com/youtube/answer/9884579 (chapters: first at `00:00`, at least three, 10 s minimum, manual overrides automatic) · news.bbc.co.uk/2/hi/school_report/6180944.stm (three words a second) · ruyasonic.com/wrt_cues.htm and /wrt_template.htm (radio cue labels, numbered cues, underlined music and effects, `FADE UNDER`, `(STING)`) · bbc.co.uk/writers/scripts/radio-drama (produced radio scripts: centred capitalised names, parenthesised cues) · npr.org/sections/npr-training/2025-05-29/g-s1-65734 (out cue) · en.wikipedia.org/wiki/SMPTE_timecode (drop-frame, the semicolon delimiter) · fountain.io/syntax (dual dialogue) · podcasters.apple.com/support/823-podcast-requirements and help.apple.com/itc/podcasts_connect (required channel and item tags, enclosure types, artwork, HEAD and byte-range, seconds for `itunes:duration`) · github.com/Podcastindex-org/podcast-namespace (`podcast:transcript`, `podcast:chapters` as `application/json+chapters`, `podcast:soundbite`, `podcast:person`, `podcast:funding`; https-only URLs) · podcasters.apple.com/support/5482 (Apple chapters: at least three, 2 minutes each, titles at most 45 characters) · datatracker.ietf.org/doc/html/rfc4287.

**Excerpt-level, cited as practice and not relied on for specifics:** the two-column AV script (StudioBinder, Canva; Final Draft AV's split-page format since 2001) · podcast script shape and the 45–65-page hour (Buzzsprout, Descript, Riverside, Lower Street — vendor blogs) · the bed and cue glossary entries (Voices.com) · speech rates outside the BBC figure (Rodero 2012 *Text & Talk* 32(3):391–411 via its abstract; the audiobook "9,300 words = 1 finished hour"; presentation rates) · Spotify's 30-second chapter gap · audio-description standards (ACB Audio Description Project, Joel Snyder; ITC 2000; ISO/IEC TS 20071-21:2015 and ITU-T T.701.21; DCMP; Ofcom 2024) · SRT's syntax, for which no official specification exists · Jefferson transcription notation, which is a conversation-analysis convention and not a script format.

**Verified gaps — stated so no one invents a fix:** there is no published BBC radio-script rulebook; no "1 page = 1 minute" rule could be verified for radio; there is no standard podcast script markup; there is no audio equivalent of Fountain's `^` dual-dialogue marker; there is no teleprompter line-length or syllable-pacing standard; retention-scripting formulas are folklore with mutually inconsistent parameters and are not encoded; and no canonical audio-description *script file format* could be verified from a primary source.
