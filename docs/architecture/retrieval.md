# Lexical retrieval

`@caotang/retrieval` is a pure in-memory lexical index shared by the browser agent and Node callers. It makes no model call, network request or persistent write. This is phase 1 of #68: no embeddings, automatic prompt retrieval, new setting or binder UI. Keyed prompt assembly remains unchanged.

## Units and coordinates

`createLexicalIndex().search(state, query, options)` reads the store's body projections, never raw front matter. Body passages group paragraphs towards 800 UTF-16 code units; paragraphs up to 1,600 are never split. Longer paragraphs split near whitespace at 800, without splitting a surrogate pair. Each node's synopsis and notes form one unit each, including folders. A codex unit joins its name, aliases and description with newlines. Offsets are half-open in that field's original text, not normalized text. Body units can supply a rewrite_selection anchor directly.

Units carry id, nodeId, field, from, to, text and revision. Document revision comes from the store. Codex text has a deterministic content revision rather than an index-lifetime counter, so rebuilding cannot change returned values. Titles, binder position and policies are read from the current state, not cached in passages. Body, synopsis and notes changes invalidate only that node's cached units. Codex changes invalidate its entry; bumpCodexRevision explicitly clears that cache as well. Deleted or excluded entries are forgotten. Changing locale clears all tokenization caches.

## Matching and ranking

Use Intl.Segmenter with the project's language and word granularity, retaining only isWordLike segments. Invalid language tags fall back to the platform default. Each segment uses the codex's canonical NFC/apostrophe normalization and simple Unicode case fold. There is no stemming, accent stripping or special expansion of ß into ss. Fountain and Ink punctuation is not a word and receives no artificial cue weight. Quoted phrases require adjacent folded tokens; unquoted terms use lexical OR ranking. An empty or punctuation-only query returns no hits.

BM25 uses k1=1.2 and b=0.75, with IDF `ln(1 + (N - df + 0.5) / (df + 0.5))` over current eligible units and average token length over that same corpus. Scores round to six decimal places before sorting. Ties use binder traversal (sibling order, then id), then body/synopsis/notes/codex, then source offset; codex ties use id order. Same state and options produce identical results. Editing a nonmatching unit may change corpus statistics and scores. After every edit an incremental index must agree with a freshly rebuilt index of the new state; random-sequence property tests enforce this decision.

Scope expands node ids through descendants; fields narrow the corpus. A supplied excluded-id set is applied before indexing and scoring, so denied text cannot affect IDF, snippets or statistics. Codex entries marked never are always excluded; their attachments do not implicitly put them in a binder scope. excludeAfter excludes later manuscript nodes, never research. focus labels hits before-focus, focus or after-focus; otherwise manuscript hits are labelled manuscript. Research and codex keep those explicit labels. Invalid focus/scope ids are refused by the tool, not expanded into a whole-project query.

Results default to 8, at most 25. Each has a stable source unit, current title, rank, rounded score, matched folded terms, a roughly 300-character snippet with field offsets, and position. The tool returns source ranges and snippets rather than full unit text, clips whole hit rows to its 4,000-token response cap, and reports truncation. Empty results suggest fewer words or codex.read. Search is a read extension, usable through app, SDK and MCP under existing read policy. It does not mutate manuscript or conversation state.

## Verification and performance

Unit seams cover paragraph coordinates, multilingual tokenization, a hand-computed BM25 fixture, deterministic ties, policies, incremental edits and random edit sequences. A Vitest benchmark measures a 200,000-word corpus's first build/query and a query after one document edit. It uses 100 scenes, a varied lexical vocabulary and both cold (20 samples) and incremental (50 samples) measurements. Run it alone with `pnpm exec vitest bench packages/retrieval/test/performance.bench.ts --run --maxWorkers=1`; concurrent builds distort the result. Its measured ceiling is agreed separately; no guessed latency target is a release claim.
