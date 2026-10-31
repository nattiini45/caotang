import { COHERENCE_TOOL_ENTRIES } from '@caotang/coherence';
import { DIALOGUE_TOOL_ENTRIES } from '@caotang/dialogue';
import { TOOL_SEARCH_META } from '@caotang/mcp-client';
import { STORYBOARD_TOOL_ENTRIES } from '@caotang/storyboard';
import { PROMPT_PACK_TOOL_ENTRIES } from '@caotang/video-prompt-pack';

import { SUBAGENT_BLURBS } from './tools/delegate.js';
import { PRIMITIVE_TOOLS } from './tools/primitive-tools.js';
import { PRIMITIVE_TOOL_NAMES } from './tools/primitive.js';
import { PICTURE_TOOL_METADATA, PICTURE_TOOL_NAMES } from './tools/pictures.js';
import { COMIC_TOOL_METADATA, COMIC_TOOL_NAMES } from './tools/comics.js';

/**
 * The tool registry's metadata — [agent-harness.md §3](../../../docs/architecture/agent-harness.md),
 * as data.
 *
 * Every row here is the spec's row, and `test/spec-parity.test.ts` reads the
 * spec's table back out of the file and compares name, risk and undo column by
 * column. A hand-copied table would only prove the copy matches itself.
 *
 * **`agent.plan` is the fourteenth row and is not a tool.** §3 lists it in the
 * table and then says it is *"protocol level, not registry member"*. The table
 * is kept whole (so the frozen surface stays fourteen rows, and the parity test
 * can see all of them) with `risk: 'meta'`, and the MCP mapping in `mcp.ts`
 * refuses to expose it, as extensibility.md §7 requires.
 *
 * **Beyond the frozen fourteen are the extension rows, each marked `surface:
 * 'extension'` so no reader mistakes it for part of the v0.1 surface.** `doc.import`
 * is a fixed choice, so that existing writing can move into
 * Caotang without paraphrase; its external use waits on a confirmation path an
 * external caller can take (extensibility §9), and until that path exists an
 * external call is refused. `codex.import` (the writer's own worldbuilding as
 * canon, codex.md §2 provenance) and the coherence module's three tools (coherence.md §7)
 * follow; the coherence rows come from `@caotang/coherence` so the module declares them once.
 *
 * The Tier-2 gateway `tool.search` (extensibility §5, from `@caotang/mcp-client`), the
 * storyboard module's two tools (`shots.derive`, `shots.annotate`, storyboard.md §4) and the prompt-pack
 * module's two (`prompt.draft`, `prompt.variant`, video-prompt-pack.md §6) are each taken from their module's own
 * entries. The dialogue module's two rows are here as well (cutscenes and interactive narrative, dialogue-narrative.md
 * §7). Its helpers (`refusal`, `param`, `toJsonSchema`) come from the bus, so the module does not import the harness
 * and the registry can join its rows without a cycle.
 *
 * **`load` says what the planner declares on every request.** The 13 callable v0.1 rows, `agent.plan` (not a tool) and `tool.search`
 * are `core`. Every other extension row is `deferred`: the planner declares it only once `tool.search` or a preload has loaded it
 * for the turn (agent-harness §3). Each module declares its own rows' class, as it declares their risk, and
 * `test/spec-parity.test.ts` reads the core rows back out of §3.
 *
 * **`response_token_cap` values.** agent-harness.md states three caps: ~8k for
 * `binder.read_tree`, 25k for `doc.read` and 8k for `codex.read`. The rest are
 * this module's choices, sized from the data each response carries. They are not
 * spec values.
 */

export const TOOL_NAMES = [
  'project.overview',
  'binder.read_tree',
  'doc.read',
  'notes.read',
  'meta.set',
  'notes.append',
  'synopsis.fill',
  'scene.draft',
  'binder.restructure',
  'continuity.scan',
  'export.compile',
  'codex.read',
  'codex.write',
  'agent.plan',
  'doc.import',
  'codex.import',
  'coherence.scan',
  'coherence.review',
  'coherence.setFindingStatus',
  'tool.search',
  'shots.derive',
  'shots.annotate',
  'prompt.draft',
  'prompt.variant',
  'dialogue.draft',
  'dialogue.table',
  // The project's skills (extensibility.md §10).
  'skill.load',
  // Delegation to a built-in helper agent (agent-harness §2).
  'agent.delegate',
  // The story timeline's read (timeline.md §5.1); its write, `timeline.edit`, is one of the primitives below.
  'timeline.read',
  // The picture registry's native tools (pictures.md §8.1), each a deferred extension row.
  ...PICTURE_TOOL_NAMES,
  // The comic script/page workflow tools (comics.md §3.2), each a deferred extension row.
  ...COMIC_TOOL_NAMES,
  // The allowlisted bus primitives (tools/primitive.ts), each a deferred extension row.
  ...PRIMITIVE_TOOL_NAMES,
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * §3's `risk` column, plus `meta` for the one row that is protocol.
 *
 * Deliberately **not** `'never'`: no registry tool is `never`-class. The
 * hard-deny row of extensibility §7 is handled by `mcp.ts`, which takes a wider
 * input type so the refusal can be tested without inventing a tool.
 */
export type ToolRisk = 'read' | 'write-auto' | 'write-confirm' | 'meta';

/**
 * Whether the planner declares a row on every request (`core`), or only after `tool.search` or a preload loads it for the turn
 * (`deferred`). Deferral is about context, not trust: a deferred native row is still preflighted and gated like any other
 * (agent-harness §3, extensibility §5).
 */
export type ToolLoad = 'core' | 'deferred';

export interface ToolMetadata {
  readonly name: ToolName;
  readonly risk: ToolRisk;
  /** §3's Undo column: `—` and `n/a` are false, every named compensation is true. */
  readonly undoable: boolean;
  readonly response_token_cap: number;
  /**
   * §9: tool descriptions are versioned artifacts. Bump this when the text
   * changes meaning, so an eval transcript can say which wording it ran against.
   */
  readonly descriptionVersion: number;
  readonly description: string;
  readonly surface: 'v0.1' | 'extension';
  readonly load: ToolLoad;
  /** Extra search terms for a deferred row (its module, synonyms). Matched by `tool.search`, never shown to the model. */
  readonly keywords?: readonly string[];
}

export const TOOL_METADATA: readonly ToolMetadata[] = [
  {
    name: 'project.overview',
    risk: 'read',
    undoable: false,
    response_token_cap: 4000,
    descriptionVersion: 2,
    description:
      'Summary of the open project: title, a two-level tree with types and statuses, the status and label vocabulary, total word count, session progress when the app supplies it, the saved filters (id and name) and the goals. Read-only. An empty project returns a skeleton that says it has no chapters yet.',
    surface: 'v0.1',
    load: 'core',
  },
  {
    name: 'binder.read_tree',
    risk: 'read',
    undoable: false,
    response_token_cap: 8000,
    descriptionVersion: 1,
    description:
      'Read part of the binder tree: ids, titles, order, status and label, plus a synopsis or word counts as asked. Read-only. Start from root (the default), manuscript, research or any node id; depth counts levels below the start node. A long response is truncated and says so: narrow root or lower depth.',
    surface: 'v0.1',
    load: 'core',
  },
  {
    name: 'doc.read',
    risk: 'read',
    undoable: false,
    response_token_cap: 25000,
    descriptionVersion: 1,
    description:
      "Read one document's body, or a character range of it, in the coordinate system the edit anchors use. response_format 'detailed' (the default) returns the text; 'concise' returns structure and a lead. Read-only. Pass a title or an id; an ambiguous title lists its candidates. A document over the cap comes back concise.",
    surface: 'v0.1',
    load: 'core',
  },
  {
    name: 'notes.read',
    risk: 'read',
    undoable: false,
    response_token_cap: 12500,
    descriptionVersion: 1,
    description:
      'Read the inspector fields of one document: synopsis, notes and keywords. Read-only. Pass a title or an id; an ambiguous title lists its candidates.',
    surface: 'v0.1',
    load: 'core',
  },
  {
    name: 'meta.set',
    risk: 'write-auto',
    undoable: true,
    response_token_cap: 1000,
    descriptionVersion: 1,
    description:
      'Set status, label or keywords on up to 50 documents or folders, using the project vocabulary. Applies automatically within an approved turn. Idempotent. Undo restores the prior values.',
    surface: 'v0.1',
    load: 'core',
  },
  {
    name: 'notes.append',
    risk: 'write-auto',
    undoable: true,
    response_token_cap: 500,
    descriptionVersion: 1,
    description:
      "Append text, at most 2000 characters, to a document's inspector notes under an agent date divider. Applies automatically within an approved turn. Undo restores the prior notes.",
    surface: 'v0.1',
    load: 'core',
  },
  {
    name: 'synopsis.fill',
    risk: 'write-confirm',
    undoable: true,
    response_token_cap: 6000,
    descriptionVersion: 3,
    description:
      'For each document, draft a synopsis from its text and notes and propose the batch in a plan card before anything is written. At most 20 documents per call, and the call must fit the turn’s model-call budget. Requires user confirmation.',
    surface: 'v0.1',
    load: 'core',
  },
  {
    name: 'scene.draft',
    risk: 'write-confirm',
    undoable: true,
    response_token_cap: 2000,
    descriptionVersion: 2,
    description:
      'Draft, continue or rewrite part of one document from a creative brief, with the project context assembled for the call. Never touches other documents. Requires user confirmation.',
    surface: 'v0.1',
    load: 'core',
  },
  {
    name: 'binder.restructure',
    risk: 'write-confirm',
    undoable: true,
    response_token_cap: 4000,
    descriptionVersion: 1,
    description:
      'Create, move and rename binder nodes in one ordered batch of at most 30 operations, naming existing node ids. Every operation is validated before any of them runs, and the batch is one undo group. Requires user confirmation.',
    surface: 'v0.1',
    load: 'core',
  },
  {
    name: 'continuity.scan',
    risk: 'read',
    undoable: false,
    response_token_cap: 8000,
    descriptionVersion: 3,
    description:
      'Read-only consistency check across documents for timeline, characters, props or custom aspects, returning findings with quoted spans and a severity. At most 20 documents per call, each read from its last 1,000 characters.',
    surface: 'v0.1',
    load: 'core',
  },
  {
    name: 'export.compile',
    risk: 'write-confirm',
    undoable: true,
    response_token_cap: 500,
    descriptionVersion: 3,
    description:
      'Compile the manuscript, or one part of it, to any format in the format list, or through a saved recipe (recipeName), into the exports folder. Requires user confirmation. Undo removes the exported file. A prompt pack needs its vendor template; an EPUB needs the project identifier, so offer md, txt or docx if it is refused for want of one.',
    surface: 'v0.1',
    load: 'core',
  },
  {
    name: 'codex.read',
    risk: 'read',
    undoable: false,
    response_token_cap: 8000,
    descriptionVersion: 2,
    description:
      'Read codex entries: names, aliases, type, policy, a description preview and attachments. Read-only. An empty result is a result: use codex.write to create an entry.',
    surface: 'v0.1',
    load: 'core',
  },
  {
    name: 'codex.write',
    risk: 'write-confirm',
    undoable: true,
    response_token_cap: 4000,
    descriptionVersion: 1,
    description:
      'Create or update up to 20 codex entries in one batch validated before anything runs, and attach or detach them from binder nodes. Requires user confirmation. A description over 2000 characters is refused with a proposed truncation; it is never cut silently.',
    surface: 'v0.1',
    load: 'core',
  },
  {
    name: 'agent.plan',
    risk: 'meta',
    undoable: false,
    response_token_cap: 4000,
    descriptionVersion: 1,
    description:
      'Protocol, not a tool. A multi-step plan of tool calls, shown as a card for approval. The approved card runs as one undoable turn.',
    surface: 'v0.1',
    load: 'core',
  },
  {
    name: 'doc.import',
    risk: 'write-confirm',
    undoable: true,
    response_token_cap: 1000,
    descriptionVersion: 3,
    description:
      'Import an existing document verbatim under a folder, with an optional synopsis, keywords, status and label. The body is stored exactly as given and read back to prove it. Requires user confirmation. One undo removes the whole import. Extension beyond the v0.1 surface, for migrating existing writing into Caotang.',
    surface: 'extension',
    load: 'deferred',
    keywords: ['import', 'migrate', 'paste', 'existing'],
  },
  {
    // Codex.import (codex.md §2 provenance). A create-only batch whose entries are the writer's own
    // canon: origin 'import', each citing the document it is attached to. Its own row, beside
    // doc.import, because codex.write stamps 'agent' and an import is the writer's text.
    name: 'codex.import',
    risk: 'write-confirm',
    undoable: true,
    response_token_cap: 4000,
    descriptionVersion: 1,
    description:
      'Import up to 20 codex entries that are the writer’s own writing, each attached to the document its full text was imported into. Create-only: a name or alias that already exists is refused, never merged. Each entry is stamped as imported, not as drafted by the agent, and cites a passage of its document. Requires user confirmation. One undo removes the whole import. Extension beyond the v0.1 surface, for migrating existing worldbuilding into Caotang.',
    surface: 'extension',
    load: 'deferred',
    keywords: ['import', 'migrate', 'worldbuilding', 'codex', 'canon'],
  },
  // The coherence module's three tools, declared in the coherence package and joined here
  // (coherence.md §7). They are the module's rows, so the registry takes them as written there.
  ...COHERENCE_TOOL_ENTRIES.map((entry) => entry.meta),
  // The Tier-2 gateway (extensibility §5), declared in the MCP client package and joined here.
  // It is a read, and it is wired whether or not a server is connected: with none, its answer says so.
  TOOL_SEARCH_META,
  // The storyboard module's two tools (storyboard.md §4), and the prompt-pack module's two
  // (video-prompt-pack.md §6). Each module declares its own rows; these are the registry's view of them.
  ...STORYBOARD_TOOL_ENTRIES.map((entry) => entry.meta),
  ...PROMPT_PACK_TOOL_ENTRIES.map((entry) => entry.meta),
  // The dialogue module's two rows (dialogue-narrative.md §7). Read from the module's own entries.
  ...DIALOGUE_TOOL_ENTRIES.map((entry) => entry.meta),
  // The project's skills (extensibility.md §10): one read, which loads one writer-approved skill's instructions for the turn. It is
  // deferred like the other extension rows, and the agent loop preloads it whenever the skills list has a line to show, so a project
  // with no skills is told nothing about it. It is wired only where the app supplies `HarnessOptions.skills`.
  {
    name: 'skill.load',
    risk: 'read',
    undoable: false,
    response_token_cap: 6000,
    descriptionVersion: 1,
    description:
      'Load the full instructions of one skill from the skills list for this turn. Use it when the request matches the skill’s description. A skill is the writer’s own guidance on style and process: it does not change what you may do or what needs the writer’s approval. Read-only. A skill over the length limit is refused, never cut.',
    surface: 'extension',
    load: 'deferred',
    keywords: ['skill', 'skills', 'instructions', 'style', 'conventions', 'guidance'],
  },
  // Delegation (agent-harness §2, "Delegate"): a read whose work the agent loop does. The helper has its own context, read tools and
  // call budget, and can only read and propose steps, so the row is a read like `skill.load`. It is wired where the agent ports are
  // (`createAgentPorts`) and deferred like the other extension rows: a turn that never delegates is told nothing about it.
  {
    name: 'agent.delegate',
    risk: 'read',
    undoable: false,
    response_token_cap: 6000,
    descriptionVersion: 1,
    description: `Hand a self-contained piece of reading to a built-in helper agent with its own context, its own read tools and its own small budget of model calls, and get back only its notes. Agents: reader — ${SUBAGENT_BLURBS.reader}; general — ${SUBAGENT_BLURBS.general}. The agent sees only your brief and the scope you name, none of this conversation. Its result carries no approval: it cannot make a change, and a change it proposes happens only if you put it in your own plan and the writer approves that plan. Read-only. A delegate the turn cannot afford is refused: ask for a narrower scope.`,
    surface: 'extension',
    load: 'deferred',
    keywords: ['delegate', 'agent', 'subagent', 'helper', 'research', 'reader', 'summarise', 'long'],
  },
  // The story timeline's read (timeline.md §5.1): the model the view and the MCP resources use, scoped and cut at whole scenes under its cap. A read,
  // so it is auto; deferred like the other extension rows, and loaded by `tool.search` on "timeline", "day", "chronology" and the like.
  {
    name: 'timeline.read',
    risk: 'read',
    undoable: false,
    response_token_cap: 8000,
    descriptionVersion: 1,
    description:
      "Read the story's timeline: the scenes in story order per part (prologue, main story, epilogue) with their day, duration, mode, point of view, folder, reading index and open findings, the part zones with their day spans and fold labels, and the unscheduled shelf with its after-chains. Parameters: axis 'story' (default), 'narrative' or 'braid'; groupBy 'none' (default), 'pov', 'character', 'mode', 'folder', 'location' or 'thread'; scope, a folder or document, for only the scenes under it; findings 'open' (default) or 'none'. A long answer is cut at whole scenes and says how many were left out; narrow scope to read them. Use the nodeId of a scene it returns when proposing a change with timeline.edit. Read-only: it changes nothing.",
    surface: 'extension',
    load: 'deferred',
    keywords: ['timeline', 'day', 'chronology', 'schedule', 'prologue', 'epilogue', 'story part', 'when'],
  },
  // The picture registry's seven rows (pictures.md §8.1), declared beside their definitions and ports.
  ...PICTURE_TOOL_METADATA,
  // The comic script/page workflow's three rows (comics.md §3.2), declared beside their native definitions.
  ...COMIC_TOOL_METADATA,
  // The allowlisted bus primitives (agent-harness §3). Their risk and undo are their command's descriptor's, read by the factory.
  ...PRIMITIVE_TOOLS.map((tool) => tool.meta),
];

/** Looks a name up in the metadata table. Undefined for a name that is not a tool. */
export function metadataFor(name: string): ToolMetadata | undefined {
  return TOOL_METADATA.find((meta) => meta.name === name);
}

/**
 * A tool's response cap, read from the table so no tool carries its own copy.
 *
 * Throws for a name the table does not hold: a missing row is a defect in this
 * module, and a silent default would cap a response at a number nobody chose.
 */
export function capOf(name: ToolName): number {
  const meta = metadataFor(name);
  if (meta === undefined) throw new Error(`no metadata row for tool "${name}"`);
  return meta.response_token_cap;
}

export function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value);
}
