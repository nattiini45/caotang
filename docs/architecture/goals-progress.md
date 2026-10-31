# Goals & progress — session targets, project goals, stats surfaces (v1)

> Status: built.
> Cross-refs: `sessions.jsonl` = [project-format.md](project-format.md) §1 and §9 · word-count pipeline = [editor-engine.md](editor-engine.md) §9 · settings = [ui-modules.md](ui-modules.md) §5 · bus registry = [command-bus.md](command-bus.md) §9 (addition).

## 1. Two goal kinds, deliberately separated

1. **Session target** (daily writing goal) — rolling per-day words-written, the Longform/NaNoWriMo habit loop. Lives in **app settings** (`session.dailyTargetWords` — already in the typed schema, ui-modules §5.1), progresses from `sessions.jsonl`, **resets daily**. Not project data: the habit follows the writer, not the book.
2. **Project goals** — deadline-shaped completion goals attached to the manuscript root or any folder (chapter/act): "finish Act 2 (≥ 12k words) by Oct 31". Stored in the **project manifest** (additive `goals[]`), computed from tree word counts. This is where Ulysses' attach-anywhere model and Caotang's Pacemaker-shaped upgrade live.

Both are **read-only derived state + tiny config**: no goal ever mutates manuscript content, and no goal needs a model call. One agent tool: the deferred, allowlisted `goal.save` (agent-harness §3) sets or changes a goal, with no delete tool; the model reads progress from `project.overview`, which already carries "session target progress" and which §5 extends with goal progress.

## 2. Data model

### 2.1 Session target (app settings — exists, semantics now specified)

- `AppSettings.session.dailyTargetWords?: number` (clamp 0–100_000; absent = no target set).
- **Progress** = words written **today** (**the device's local calendar day** — a browser app has no other honest timezone; assumption A3), summed from `sessions.jsonl` entries whose `endedAt` falls on today. `wordsWritten` per the `sessions.jsonl` schema (project-format §9) is the counted quantity.
- **Display (editor status bar + binder footer):** progress ring (Ulysses' validated affordance) + "412 / 800 words today". Crossing the target flips the ring to the success color + one-shot notification (Longform's model — a gentle completion, never a nudge to keep going; no streaks, no shame mechanics in v0.1, assumption A4).
- Mid-session target edits apply to today's display immediately (settings clamp; no history recompute).

### 2.2 Project goals (manifest `goals[]`, additive)

```ts
interface ProjectGoal {
  id: string;                    // "g_" + 10 chars Crockford base32 (same generator family)
  nodeId: string;                // manuscript root or any folder, a part included (folders/root only — a per-scene goal is noise; Ulysses allows sheets, we restrict to folder+ for v0.1, assumption A2)
  metric: 'words' | 'chars';     // words, or characters counted as non-whitespace code points (§9.2); pages and reading time stay out (exporter-domain, §7)
  kind?: 'project' | 'weekly' | 'monthly';   // absent = project; weekly and monthly are session windows on the manuscript (§9.3)
  resetDay?: number | 'last';    // weekly: 0 (Sunday)–6 (Saturday); monthly: 1–28 or 'last'; absent = locale's first weekday / the 1st (§9.3)
  comparator: 'at-least' | 'at-most' | 'about';   // Ulysses' validated comparator triple, adopted verbatim
  target: number;                // > 0
  deadline?: string;             // ISO-8601 date (local); absent = open-ended
  archived?: boolean;            // completed/abandoned goals hide from the rail, stay in the manifest
  createdAt: string; updatedAt: string;
}
```

Field contracts:

| Field | Contract |
|---|---|
| `nodeId` | Must resolve to a folder or the `manuscript` root at save time (validated like `binder.setMeta` vocabulary ids). Dangling on load (folder deleted) → goal kept but flagged "target missing" in the UI, matches nothing (same posture as unknown vocabulary ids; never blocks load). |
| `comparator` | `at-least`: progress ≥ target (drafting goals). `at-most`: progress ≤ target (length caps — "keep the prologue under 2k"). `about`: \|progress − target\| ≤ 10% of target (Ulysses' tolerance; documented constant). |
| `target` | Positive integer: words, or characters for the `chars` metric. |
| `kind` | `project` (the default) counts the subtree of the node the goal attaches to. `weekly` or `monthly` is a writing-pace goal: it counts the words written in the device-local week or month that starts on its reset day, read from `sessions.jsonl`, attaches to the manuscript root, is `at-least`, counts words, and takes no deadline (§9.3). |
| `resetDay` | Weekly and monthly goals only (a project goal carrying one is refused at save and dropped on load). Weekly: a whole weekday, `0` (Sunday) to `6` (Saturday). Monthly: a whole day `1`–`28`, or `'last'` for each month's last day. Absent means the default: the locale's first day of the week for a weekly goal, the 1st for a monthly one. Written only when set, so a goal saved before the field existed loads and saves unchanged. The window rule is §9.3. |
| `deadline` | Date only (no time-of-day — writing goals don't need hours); past-deadline + unmet = overdue state, never a failure state. |
| Limits | ≤ 20 goals per project (save-time clamp). |

**Progress computation (pure function):**

```ts
goalProgress(goal: ProjectGoal, wordsOf(nodeId: string): number): {
  current: number;        // subtree word sum for goal.nodeId (same accessor as binder-filters — folders = descendant sum)
  met: boolean;           // comparator applied
  pace?: { perDay: number; daysLeft: number };   // iff deadline set and not met
}
```

- **Pace** (the Pacemaker-shaped upgrade): `perDay = ceil(max(0, target − current) / max(1, daysLeft))` where `daysLeft = deadline − today` (local calendar days). Rendered as "≈ 850 words/day to finish by Oct 31". Pace recomputes on view; never stored (derived, eval-stable from fixed inputs).
- Determinism: pure function of (goal, word counts, today) — headless-testable; `today` is injected, never wall-clocked inside the function.

## 3. Storage

- **Project goals:** top-level `goals[]` in `caotang.json` — **additive in format v1** (same no-wild-artifacts argument as `codex[]`/`recipes[]`/`filters[]`; loaders tolerate absence). Load-time tolerance: unknown comparator/metric → goal dropped with load warning; dangling nodeId → kept + flagged (§2.2).
- **Session target:** app settings only (already in the typed schema — ui-modules §5.1). Never in `caotang.json` (it is writer-level, not project-level, and the no-secrets/no-cross-project-leak discipline keeps app state out of artifacts).
- **History:** `sessions.jsonl` is the only history surface (append-only, the project-format §9 schema). No per-goal progress snapshots in v0.1 — pace is computed live. Assumption A5's resolution is **jsonl reconstruction, zero new artifacts** — "was I on track last month" is a v0.2 UI over `sessions.jsonl` (§9); no snapshot regime is ever needed for goal history.

## 4. Commands & UI

**Command-bus §9 registry rows for the goals (two project commands; `project.saveGoal` is also the deferred agent tool `goal.save`, agent-harness §3; `project.deleteGoal` is not an agent tool):**

| Command | Params | agentRisk | undo | Notes |
|---|---|---|---|---|
| `project.saveGoal` | `{goal: {id?, nodeId, metric?, kind?, resetDay?, comparator, target, deadline?, archived?}}` | write-auto | inverse | Create (an id is minted when none is given) or update by id. The bus checks the id shapes, the field types, the comparator, the per-value limits, the node the goal attaches to, and for a weekly or monthly goal the §9.3 rules and the shape of its reset day (refused at `goal.resetDay`; `null` reads as absent); the store checks the count of goals and whether the id exists, and refuses both before it writes (`packages/bus/src/descriptors-furniture.ts`). Kept in the manifest's `goals[]`. |
| `project.deleteGoal` | `{goalId}` | write-auto | inverse | Removes a goal — metadata, not content. |

**The session target is not a bus command.** The daily target is an app setting (`session.dailyTargetWords`, ui-modules §5.1), written by the settings store and read by the status bar. No agent can change it, because it is app-level state (command-bus §9).

**UI surfaces:**

- **Editor status bar** (exists for word counts — editor-engine §9): adds today's session ring + "412 / 800 today"; click → session-target quick-set (writes the app setting `session.dailyTargetWords`, not a command).
- **Inspector (folder/manuscript nodes):** "Goals" section — goal rows (comparator sentence: "at least 12,000 words by Oct 31"), progress bar + pace line, Add/Edit/Remove (→ `project.saveGoal`/`project.deleteGoal`). Editing mirrors inspector edit semantics (debounced where freeform, discrete pickers for comparator/deadline).
- **Binder footer:** active project-level goal summary (nearest deadline first) — one line, click-through to inspector.
- **Stats surfaces (read-only, v0.1 minimum):** per-node word/char counts already rendered (binder rows, editor status bar); **project total** + today's total in the binder footer. Ulysses' six-metric statistics panel = polish backlog; pages/reading-time estimates deliberately out (metric conversions are exporter-domain).

## 5. Agent integration (read-only, zero new tools)

- `project.overview` response **extends** with `goals: [{nodeTitle, comparator, target, current, met, pace?}]` and `session: {todayWords, target?}` — the model can report on progress ("am I on pace?") without any new surface. Cap: goals array ≤ 20 (the manifest clamp).
- The agent can save or change a goal through the deferred `goal.save` (write-auto, one undo group, so the writer can take it back) but cannot delete one: a goal is writer intent, and `project.deleteGoal` is not exposed.

## 6. Evals (headless)

- **Pace fixtures:** fixed word counts + fixed injected "today" → exact `perDay`/`daysLeft`; deadline-today edge (daysLeft = 1); deadline passed (overdue, pace omitted); already met (pace omitted, `met: true`); `about` tolerance boundaries (±10% inclusive).
- **Persistence fixtures:** `goals[]` absent → none; unknown comparator → dropped with warning; dangling nodeId → flagged not blocking; clamps (>20 goals, target ≤ 0 rejected at save).
- **Trace fixtures:** set session target → status bar ring reflects it; create folder goal → binder footer line appears; `project.overview` response shape carries the new fields (response-shape assertion per agent-harness §9).

## 7. Rejected alternatives

- **Six Ulysses metrics in v0.1** — characters/sentences/paragraphs/pages/reading-time are cheap *conversions* but each adds surface (per-goal metric pickers, unit tests, UI labels) for marginal validated value; words is the writing-loop currency (sessions.jsonl counts words; targets read words). v0.2 menu = chars-first widening (§9); pages/reading-time stay exporter-domain.
- **Per-scene goals** — Ulysses allows sheet-level goals; for Caotang's binder a per-scene goal duplicates the inspector's synopsis/word-count row and clutters the §4 inspector. Folder+ only.
- **Streaks / gamified history** — NaNoWriMo-style streak mechanics contradict the "no meter on your writing" posture the coherence module adopted (never background-shame); completion notification only.
- **Agent-managed goals beyond `goal.save`** — no delete tool; goals are writer intent, and an agent "helpfully" lowering a deadline is the exact automation class the 0-to-1 rule exists for, so `goal.save` is the one reach, undoable.

## 8. Assumptions

| # | Assumption | Status |
|---|---|---|
| A1 | Words-only metric covers v0.1 | Explicit; validated (the surveyed tools' goals are all word-shaped); other metrics = v0.2 menu, **resolved (§9)**: chars-first widening + weekly/monthly kinds. |
| A2 | Folder/root attachment (no per-scene goals) suffices | Explicit; the Ulysses sheet-goal use case maps to Caotang folder goals for all but micro-scheduling. |
| A3 | Device-local calendar day for "today" | Explicit; a browser app cannot honestly know a preferred timezone; a native desktop wrap (Tauri) could expose a timezone setting without schema change. |
| A4 | No streaks/shame mechanics in v0.1 | Explicit posture; completion notification only. |
| A5 | Live-computed pace (no snapshots) answers v0.1 | **Resolved** — the historical "was I on track" surface is a v0.2 UI over `sessions.jsonl` (jsonl reconstruction; §9); snapshots are never needed. Zero new artifacts. |

## 9. History, metrics and goal kinds

History, a second goal metric and the recurring goal kinds are furniture over the existing session log.

1. **History = a UI over `sessions.jsonl` (the binder footer's Show the history).** No new storage: the appender already captures `(startedAt, endedAt, wordsWritten, docIds[])` per session (§2.1). The **History panel** groups sessions by device-local calendar day (same A3 convention as the target reset) and renders today / daily average / daily best / last-10-days bars, each bar green on target-hit days, plus **CSV export**. Zero snapshots, zero schema change — pure derived read.
   **Today includes the open sitting.** The panel's today is the status line's figure: the sessions that ended today plus the sitting open now (`historyReading`'s `todayWords`), so the Today figure, today's bar, the average and the best agree with the status line while a sitting is open.
2. **Metric enum widening (additive):** `metric: 'words' | 'chars'`. **Chars came first**, because whitespace-split "words" misled for CJK manuscripts; `words` now segments those scripts (§10), and `chars` remains the exact count. `chars` counts non-whitespace code points, as recorded in [decisions.md](../decisions.md). The footer's goal picker sets it. `sentences` and `paragraphs` are not built. `pages`/`reading-time` stay parked as exporter-domain conversions (print-pipeline constants, not editor counts).
3. **Goal-kind menu:** `kind: 'project' | 'weekly' | 'monthly'` and the optional `resetDay` ride the existing `ProjectGoal` shape; both are additive, written only when set. Both kinds stay. A **project** goal is a total over a node's subtree with an optional deadline. A **weekly** or **monthly** goal is a writing-pace window like the daily target: it attaches to the manuscript root, is `at-least`, counts words, takes no deadline, and counts the words written in the sessions that ended inside its window (plus the open sitting). The windows are read from every project's `sessions.jsonl`, and the footer reads them on a one-second window rather than on every change of the project. The bus enforces its four rules and the reset day's shape (`descriptors-furniture.ts`, `sessionGoalProblem`, `resetDayProblem`), and the furniture package states the same rules (`sessionGoalProblems`).
   **Each recurring goal picks its own reset day**, and the window is fixed by it (`goalWindowOf`, both ends included, device-local days):
   - **Weekly**, reset weekday W (0 Sunday … 6 Saturday): the seven days starting on the latest W on or before today.
   - **Monthly**, reset day N (1–28): from the latest N-th on or before today to the day before the next N-th. N = 1 is the calendar month. 28 is the cap because every month has a 28th, so no month skips a reset.
   - **Monthly, `'last'`**: the same rule with each month's own last day as its reset day. The window starts on the last day of a month and ends the day before the last day of the next month: on 15 October it is 30 September – 30 October; on 31 October, 31 October – 29 November; in February 2027, 31 January – 27 February, then from 28 February; in the leap year 2028, 31 January – 28 February, then from 29 February.
   - **Defaults** when `resetDay` is absent: a weekly goal starts on the first day of the week in the writer's locale — `new Intl.Locale(locale).getWeekInfo?.().firstDay ?? new Intl.Locale(locale).weekInfo?.firstDay` (ISO 1 Monday … 7 Sunday, read as `firstDay % 7`), falling back to Monday when the engine reports neither or the locale is unreadable (`localeFirstWeekday`). The app passes `navigator.language`; the window function takes the weekday as an argument, so it never reads the machine. A monthly goal starts on the 1st. A goal stored before `resetDay` existed has none and keeps the default.
   The inspector's goal form offers the choice as a select ("Week starts on" / "Month starts on"), with the default first, and each weekly or monthly goal row says when its window starts.
4. **Untouched:** the daily session target, live pace, and the sessions.jsonl appender all stand. The items above are furniture with **zero architecture impact**, the same class as the sprint timer.

## 10. Counting note

Word counts split on whitespace, and a token in an unspaced script (Han, kana, Thai, Lao, Khmer, Myanmar) is counted by `Intl.Segmenter` (editor-engine §9), so a `words` goal and the daily target work for CJK and Thai manuscripts too. That count is approximate and can differ between browsers; the `chars` metric (§9.2) stays the exact, engine-independent alternative. `sessions.jsonl` is not versioned: a session's words are the difference of two counts taken in one process, so history written before this rule keeps its old, lower numbers for CJK and Thai text, and weekly and monthly totals across the change mix the two. Latin-script counts did not change.
