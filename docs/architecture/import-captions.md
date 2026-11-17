# The captions reader 🧭

> Status: the package `packages/import-captions` (`@caotang/import-captions`) is **built** (#287) and tested in Node against the AV script's own parser. **Import captions…** in the binder, which calls it through the shared preview (#267) in the `'self'` Worker host (#390), is §5. Epic: #263.

## 1. Purpose

Every captioning and transcription tool writes SRT or WebVTT: Descript, YouTube, Premiere, Riverside, Whisper, and the subtitle editor a podcast's editor uses. The AV script model already holds speakers, speech lines and durations ([av-script.md](av-script.md) §2–§4), so a timed-text file is a way into it: cues in, one episode's Markdown out, with the duration of every line **declared** from the file's own timings rather than estimated from a speech rate.

The reader is own code (MIT), pure and DOM-free, so the same module runs on the main thread, in the preview's `'self'` Worker and in Node. It has no third-party dependency, no `eval`, no `new Function` and no WebAssembly. Its two workspace dependencies are the contracts it must not copy: `@caotang/bus` for `SCRIPT_LABEL_PATTERN` (what the grammar reads as a speaker label) and `@caotang/script` for `DEFAULT_CUE_VOCABULARY` and `NARRATION_LABEL`. It takes **decoded text**, not bytes: the preview decodes with `@caotang/import-read/text`, which owns the encodings, their detection and their caps.

WebVTT is a W3C Candidate Recommendation and was read as the specification: the `WEBVTT` header, `hh:mm:ss.ttt` with a **period**, cues joined by ` --> `, cue settings, the `<v Speaker>` voice span, `NOTE`, `STYLE` and `REGION` blocks, and the five character entities. **SRT has no official specification** (av-script.md E6, SD9); its comma milliseconds, its index line, its optional coordinates and the `Name:` and `- Name:` speaker prefixes are read as the documented practice of the tools that write them, not as a standard. No caption tool's code was read or ported.

## 2. Reading

- **The format is the header.** A first non-blank line starting `WEBVTT` makes it WebVTT; anything else is read as SRT. Text after `WEBVTT` on that line is the file's own title and becomes the episode's title when the writer names none. Header metadata (`Kind: captions`, `Language: en`) runs to the first blank line and is not a cue.
- **One pass, block by block.** A line holding ` --> ` is a timing line; the line before it, when it holds no arrow, is the cue's identifier (WebVTT) or index (SRT). The cue's words are every line up to the next blank one. `NOTE`, `STYLE` and `REGION` blocks are read whole to their blank line.
- **Timestamps** are `hh:mm:ss.ttt` or `mm:ss.ttt`, with a period or a comma, hours optional. Minutes and seconds fields are 00–59; a field that is not is a bad timing, and the cue is dropped and named. **Frames are never read** (SD4): `HH:MM:SS:FF` is frame-rate-dependent and nothing here stores it.
- **Speakers**, in order: a `<v Speaker>` voice span (classes allowed, `<v.loud Ada>`); else a `Name:` or `- Name:` prefix on the cue's first line whose label the grammar reads as a name. A label starting with a digit is never a speaker, so `00:01 something happened` stays words, and a colon followed by anything but a space or the line's end is never a label, so `https://…` stays whole. A cue naming nobody has no speaker, and the builder makes it narration.
- **A cue with two voice spans** keeps the first as its speaker and both spans' words as one line, and is named in the losses: splitting it would invent a boundary the file does not give.
- **Words** are the cue's lines with the inline markup removed, the five entities unescaped, and the wrapped lines joined with one space. A caption file wraps at about 42 characters; the wrap is not a sentence break.
- **Limits:** `MAX_CUES` 20,000, past which the read is refused (`too-many-cues`) rather than building an unbounded body. A file with no timing line at all is refused (`no-cues`). Errors are returned, never thrown.
- **Tolerant, and it says so:** a period separator in an SRT file, a missing index, minutes-only timestamps, CRLF endings and a missing `WEBVTT` header are all read. Every cue is kept, including one out of order, overlapping, or with a zero or backwards span; the builder decides what to do with it and the report names it.

## 3. What is counted, never dropped quietly

`CaptionsLoss` is a code and a count with the first sample, so the app names each in the writer's own language: `styling` (a `<b>`, `<i>`, `<u>`, `<c.class>`, `<lang>`, ruby span; a closing tag is the same run, and a voice span is kept as the speaker, so neither is counted), `inline-timestamp`, `cue-settings`, `coordinates` (SRT's `X1:…`), `style-block`, `region-block`, `cue-id` (a WebVTT identifier; SRT's own index is the format's numbering, not the writer's text, and is not counted), `empty-cue`, `bad-timing`, `out-of-order`, `overlap`, `short-cue`, `two-speakers`, `stray-text` (words belonging to no cue) and `srt-period`.

## 4. Cues to an episode

`buildEpisode` writes `# Title`, `## Segment n (m:ss)` and one `SPEAKER: words [Ns]` line per cue or merged run. The duration bracket is seconds with at most milliseconds (`[12.5s]`), which the grammar reads as a **declared** duration (av-script.md §3), so no speech-rate estimate is involved and a caption import never guesses how fast somebody talks.

The script stores durations, not offsets (§4, SD4), so the wall clock a caption file carries has to go somewhere. Three choices, each the writer's and each reported:

| Choice | Default | What it does | What it costs, reported |
|---|---|---|---|
| A gap of at least N seconds | 3 s | starts a **new segment** | the gap is outside the episode's runtime; `gapSec` names the total |
| A smaller gap | **fold** into the line before it | keeps the episode's total equal to the file's wall clock | `foldedSec`: the line is longer than it was spoken |
| | *leave out* | keeps every line's spoken length exact | `leftOutSec`: the episode is shorter than the file |
| Consecutive cues of one speaker inside a segment | **merge** | one line, because a caption file breaks a sentence every 42 characters | `merged`: how many cues joined the line before them |

- **A `NOTE` becomes a quoted text line** (`> …`). The grammar reads a line whose label is not a name as text (§3), so a note holding `Host: check this` stays a note instead of becoming a speaker called Host. A note before a cue stands before that cue's line; a note after the last cue ends the last segment.
- **A speaker label the grammar cannot hold** is changed as little as possible and both spellings are named (`speaker-renamed`): characters outside the label set become spaces, a leading non-letter is dropped, and the label is cut to 40. A name that collides with one of the show's cue words gets a trailing `_` (`speaker-cue-word`), because `Music:` would be a cue and not speech. A cue naming nobody is `NARRATION`.
- **A cue with no span** writes no bracket, so the line is untimed rather than given an invented duration (`untimed-line`).
- **A timing-looking bracket inside the cue's own words** (`It said [12s]`) is counted (`text-bracket`): the grammar reads brackets right to left, takes the declared duration first and keeps that one as words.
- **The leading offset** (`leadingSec`) is named, not stored: the first segment starts at the script's zero, and a file whose first cue is at 0:12 loses those 12 seconds of silence, which the report says.
- Words are counted the way the script counts them: a parenthetical is a modifier, not speech.

## 5. The import command

Not built yet in this commit; the preview source, the binder action and their tests are the next change on #287.

## 6. Evidence

**Fetched and relied on:** w3.org/TR/webvtt1 (the header, `hh:mm:ss.ttt`, ` --> `, cue settings, the `<v Speaker>` voice span, `NOTE`/`STYLE`/`REGION`, the five entities) · the AV script's own contract in this repo, [av-script.md](av-script.md) §3–§5 (E6, SD4, SD9) and `packages/script`'s parser, which the unit tests read the built body back with · `packages/exporter`'s `vtt` compile, for the round trip.

**Practice, cited and not relied on for specifics:** SRT's syntax, for which no official specification exists; Descript's "show speakers" labels and the `- Name:` convention other subtitle editors write; Whisper's unlabelled output.
