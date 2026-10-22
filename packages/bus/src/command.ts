/**
 * Command envelope & descriptors — [command-bus.md §2](docs/architecture/command-bus.md).
 *
 * The load-bearing invariant: `validate` is **pure and total**. A command that
 * passes validation cannot fail mid-apply for validation reasons. That is what
 * lets undo be compensation-based and lets the agent harness pre-validate a whole
 * plan before showing it.
 */

import type { CommandError, Result } from './result.js';
import type { ActivityReport } from './activity-log.js';
import type { CoherenceStatusName, ScenePatch, SceneMetaRecord } from './coherence.js';
import type {
  BinderDeleteFilterParams,
  BinderSaveFilterParams,
  ProjectDeleteGoalParams,
  ProjectSaveGoalParams,
} from './descriptors-furniture.js';
import type {
  DialogueImportInkParams,
  DialogueSetMetaParams,
  ScreenplayImportParams,
} from './descriptors-script.js';
import type { SceneNumbersOption } from './descriptors-project.js';

/**
 * §9's closed v0.1 registry, in the order the spec tabulates it.
 *
 * This is the **only** source of the name set. `CommandRegistry` is a mapped
 * type over `CommandName`, so adding a name here without writing its entry is a
 * **compile error** — the closed set is enforced by the type system, not by a
 * test that notices a week later. `test/registry.test.ts` reads §9's table out
 * of the spec and asserts the two agree, which is the other half.
 *
 * **What that test covers, stated exactly:** it compares the name set and **two** of §9's columns —
 * `agentRisk` and `undo` — plus, the **Params (essentials)** column
 * against the keys each `validate` emits, plus §9's one nested literal
 * (`binder.setMeta`'s `patch` fields) against `PATCH_KEYS`.
 *
 * **The word "emits" is the limit of it, and the limit is real.** A descriptor's
 * `ok({...})` payload is the only accepted-key list a `validate` can be observed
 * through, so an undeclared key a descriptor *accepts and drops* is still
 * invisible there — measured: `binder.rename {nodeId, title, order: 99}` comes
 * back `{nodeId, title}` and stays green. Refusing it is that change's
 * decision, and this comment claims nothing about it either way.
 *
 * **A second limit, measured.** The comparison's
 * payload is built from §9's own parse, so a key that *leaves* §9 is invisible
 * to it whenever the descriptor treats that key as optional — the two sides
 * shrink together. A key §9 *gains* reds it; a key §9 *loses* does not, unless
 * the descriptor happens to require that key. The `DECLARED_PARAMS` table is
 * what closes this, and it is compared to §9 in the same harness.
 *
 * `CodexUpsertOp` is **still** a code-side statement of codex.md §2's entry
 * fields, held by no spec-parity test. §9 does not expand `entries:
 * CodexUpsert[]`, so the gap sits outside the column the parity test reads. Both
 * obligations are logged in docs/decisions.md, where the first is closed.
 *
 * Reads are not commands (§9): modules read the store directly. `sessions.jsonl`
 * appends are session-tracker side-effects of doc writes, not commands.
 */
export const COMMAND_NAMES = [
  'binder.create',
  'binder.move',
  'binder.rename',
  'binder.setMeta',
  'binder.setSynopsis',
  'notes.set',
  'notes.append',
  'doc.write',
  'editor.insert',
  'editor.replaceRange',
  'codex.upsert',
  'codex.attach',
  'export.compile',
  'export.compileSelection',
  'project.deleteNode',
  'view.setSelection',
  'view.setActiveDoc',
  'view.setScroll',
  // The two view names ui-modules §1 and §3.1 require. §9 tabulates them with the other view rows.
  'view.setExpanded',
  'view.setCorkboardScope',
  // The coherence module's two mutations (coherence.md §7.1). §9 tabulates them, with coherence.md named in their notes.
  'coherence.setSceneMeta',
  'coherence.setFindingStatus',
  // The run history's one removal (coherence.md §7.1, §8). It joins the module's rows the same way the two above do.
  'coherence.discardRun',
  // The knowledge facts of coherence.json (coherence.md §4.4, §7.1). A removal takes the scene declarations that name the fact.
  'coherence.addKnowledgeFact',
  'coherence.editKnowledgeFact',
  'coherence.removeKnowledgeFact',
  // The one command an external tool call rides (extensibility.md §6). It is a v0.2 addition, and §9
  // tabulates it with its reason. Its descriptor is the one `@caotang/mcp-client` builds, and its apply reaches a server,
  // so the store registry takes both as an injected option (`ProjectCommandOptions.mcpInvoke`). Without that, the name is refused.
  'mcp.invoke',
  // The one read the writer asks for from a connected server (extensibility.md §6): a resource they picked. `agentRisk: 'never'` and
  // refused without `pickedBy: 'writer'`, so an agent cannot issue it. Injected like `mcp.invoke` (`ProjectCommandOptions.mcpReadResource`).
  'mcp.readResource',
  // The storyboard module's three shot commands (storyboard.md §3.1 and §4). They are the bus shape
  // `@caotang/storyboard`'s `commands.ts` was written against, and §9 tabulates them. Their applies come from the store
  // registry, injected (`ProjectCommandOptions.shots`), because the guards they run belong to the storyboard module.
  'storyboard.create',
  'shot.create',
  'shot.setMeta',
  // Project export: the project block (epub-metadata.md), the saved export recipes (exporter.md §2), the
  // vocabulary (project-format.md §2) and the cover import. §9 tabulates them.
  'project.rename',
  'project.setMetadata',
  'project.importAsset',
  'vocabulary.upsert',
  'vocabulary.remove',
  'recipe.save',
  'recipe.delete',
  // The saved-filter and project-goal commands (binder-filters §5, goals-progress §4). §9 tabulates them.
  // Their applies are the store's (`commands-furniture.ts`), because the lists they write are the manifest's `filters[]` and `goals[]`.
  'binder.saveFilter',
  'binder.deleteFilter',
  'project.saveGoal',
  'project.deleteGoal',
  // Storyboard: one shot's image, written from a staged file and set as its `image` in one undo group (storyboard.md
  // §3.1). Its apply is the store's (`commands-shot-image.ts`), and its descriptor is `descriptors-shot-image.ts`.
  'shot.importImage',
  // The whole-script Fountain and FDX import (screenplay.md §2.2), the whole-story Ink import (dialogue-narrative.md
  // §4) and a dialogue container's settings (dialogue-narrative.md §2.1). §9 tabulates them, after shot.importImage.
  // Their applies are the store's (`commands-script.ts`).
  'screenplay.import',
  'dialogue.importInk',
  'dialogue.setMeta',
  // The project's skills (extensibility.md §10): the writer's own instructions for the agent. All four are `issuedBy: 'user'` only
  // (`agentRisk: 'never'`), so an agent never installs, edits, enables or removes a skill. Their applies are the store's
  // (`commands-skills.ts`), and `skill.import` needs the staged files the host holds.
  'skill.import',
  'skill.write',
  'skill.delete',
  'skill.setEnabled',
] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

export interface Command<P = Record<string, unknown>> {
  /** "cmd_" + 10 chars Crockford base32 (same generator family as node ids) */
  id: string;
  name: CommandName;
  /** flat, enum-constrained, schema-validated */
  params: P;
  issuedBy: 'user' | 'agent';
  /** agent turn this command belongs to (agent-issued only) */
  turnId?: string;
  /** tool-call id; idempotency key within the turn (§6) */
  callId?: string;
  /** epoch ms; log/display only — never affects behavior */
  createdAt: number;
  /**
   * Set by the harness, never by a caller's params: the flow that gave this command its
   * provenance when the envelope's `issuedBy` cannot say it. `'import'` is codex.import's
   * (codex.md §2): the entries a `codex.upsert` creates from it are stamped `origin:
   * 'import'`. A param naming it would be refused by the op's closed key set, so the only
   * route to the field is the tool that built the command. See {@link CommandProvenance}.
   */
  provenance?: CommandProvenance;
}

/**
 * The provenance an envelope can carry beyond `issuedBy` (codex.md §2). A closed set:
 * `import` is the one a codex entry's `origin` is stamped from, and the rule that a
 * caller cannot name its own origin is why it travels on the envelope.
 */
export type CommandProvenance = 'import';

export interface Postcondition {
  /** human-readable check description, shown in evals and plan cards */
  describe: string;
  assert: (snapshot: unknown) => boolean;
}

/**
 * The read-only project view a `validate` is allowed to read.
 *
 * **Declared here rather than imported from `@caotang/store`**: the dependency
 * runs the other way (the bus never depends on the store; the store depends on
 * the bus). It is deliberately *structural* — `ProjectState`
 * satisfies it as-is, with no adapter, and
 * `packages/store/test/bus-snapshot.test.ts` pins that assignability so the
 * direction is checked rather than assumed.
 *
 * §2 leaves `snapshot` untyped in the signature. Typing it as `unknown`
 * would leave every validator free to guess a shape; this is the narrowing
 * that makes the §2 invariant ("a command that passes validation cannot fail
 * mid-apply for validation reasons") checkable — a validator that reads a
 * document body needs a documented way to read it.
 */
export interface ValidationNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: string;
  /** The media-track kind marker (screenplay, storyboard, branching). Absent on a plain node. */
  readonly kind?: string;
  readonly title: string;
  readonly status: string | null;
  readonly label: string | null;
  readonly keywords: readonly string[];
  readonly synopsis: string;
  readonly notes: string;
}

export interface ValidationCodexEntry {
  readonly id: string;
  readonly name: string;
  /** The entry's kind (`character`, `location`, …). The scene declarations of who learns and knows a fact take a character. */
  readonly type?: string;
  /**
   * codex.md §2's citations, held by the entry; an update's new ones are appended to
   * them. Only the count is read here, so only the document id is named.
   */
  readonly sources?: readonly { readonly docId: string }[];
}

export interface ValidationDocument {
  readonly body: string;
  /** per-doc optimistic-concurrency counter (project-format §4) */
  readonly revision: number;
}

/** One finding as a coherence validate reads it: its id and where it stands (coherence.md §3). */
export interface ValidationFinding {
  readonly id: string;
  readonly status: string;
}

/**
 * The coherence file's parts a validate can read (coherence.md §3, §7.1): the findings
 * a status command names, and the scene declarations a patch edits. Absent when no
 * coherence file is open, which the coherence commands refuse (see `coherenceSetSceneMeta`).
 */
export interface ValidationCoherence {
  readonly findings: readonly ValidationFinding[];
  readonly sceneMeta: Readonly<Record<string, SceneMetaRecord>>;
  /** The run history, by id (coherence.md §4.1). Absent reads as no runs, so a holder that predates it still validates. */
  readonly runs?: readonly ValidationRun[];
  /** The knowledge facts (coherence.md §4.4). Absent reads as none. */
  readonly knowledge?: readonly ValidationKnowledgeFact[];
  /** The world rules, by id, for a fact's `ruleId` link (coherence.md §4.3). Absent reads as none. */
  readonly worldRules?: readonly { readonly id: string }[];
}

/** One knowledge fact as a validate reads it: its id and its words, which a refusal quotes. */
export interface ValidationKnowledgeFact {
  readonly id: string;
  readonly text: string;
  readonly ruleId?: string;
  readonly entryId?: string;
}

/** One run as a discard validate reads it: its id, which is all the bus needs to name it (coherence.md §4.1). */
export interface ValidationRun {
  readonly id: string;
}

export interface ValidationSnapshot {
  readonly manifest: {
    readonly tree: readonly ValidationNode[];
    readonly vocabulary: {
      readonly statuses: readonly { readonly id: string; readonly name?: string }[];
      readonly labels: readonly { readonly id: string; readonly name?: string }[];
    };
    /** additive in v1 — absent = empty codex (project-format §2) */
    readonly codex?: readonly ValidationCodexEntry[];
    /**
     * The saved export recipes (exporter.md §2). Additive in v1, so absent means none. Only the name and the nodes a
     * recipe selects are read here, for the refusals `recipe.save` and `recipe.delete` make.
     */
    readonly recipes?: readonly { readonly name: string; readonly includeRootIds?: readonly string[] }[];
    /** The project title and identity, read by `project.setMetadata`'s refusals. Optional, like the rest of the block. */
    readonly project?: { readonly name?: string };
    /** The skills the writer turned off (extensibility.md §10), by name. Additive, so absent means every skill is on. */
    readonly disabledSkills?: readonly string[];
  };
  readonly documents: ReadonlyMap<string, ValidationDocument>;
  /** The coherence file, when one is open. Additive, like `codex` — absent means no file. */
  readonly coherence?: ValidationCoherence;
  /** The project's skills, by folder name (extensibility.md §10). Additive — absent means none. */
  readonly skills?: ReadonlyMap<string, readonly ValidationSkillFile[]>;
}

/** One file of a skill as a validate reads it: its path inside the skill folder and how long its bytes are. */
export interface ValidationSkillFile {
  readonly path: string;
  readonly bytes: { readonly length: number };
}

export interface CommandDescriptor<P = Record<string, unknown>> {
  /** view = ephemeral UI state (selection, scroll, active doc) — never persisted */
  mutates: 'project' | 'view' | 'none';
  /** gate for issuedBy='agent' (§4) */
  agentRisk: 'read' | 'write-auto' | 'write-confirm' | 'never';
  undo: 'inverse' | 'compensable' | 'none';
  /** pure, total — runs BEFORE any effect */
  validate: (params: unknown, snapshot: ValidationSnapshot) => Result<P, CommandError>;
  /** checked after apply; harness §7 reuses these */
  postconditions?: Postcondition[];
  /**
   * §6's optimistic concurrency: this command writes a document, so when the
   * caller sent an `expectedRevision` the pipeline compares it against that
   * document's `revision` and refuses a mismatch (§6: *"Mismatch →
   * `CommandError('conflict', 'doc was modified since plan (rev N → M)')`"*).
   *
   * **A flag, not something `validate` works out**, and that is the whole design
   * decision. `validate` is pure, total and reads a snapshot; a revision check
   * there would be a *second* place that knows which commands guard a document,
   * and the comparison is deliberately left out of it (`descriptors.ts`'s
   * `expectedRevision()` parses it and does not compare it) so there would be one.
   * `mutates: 'view'` is the existing precedent for a descriptor field switching
   * pipeline behaviour; this is the same shape for §6.
   *
   * **The document is named `docId`** in the validated params, and the check runs
   * against the same snapshot `validate` was given — the bus is synchronous (A2),
   * so nothing can move a revision between the two, and a second read would change
   * a count the ordering tests assert.
   *
   * Rejections for a command that sets this but carries no `expectedRevision` or no
   * `docId` are `internal`, never a silent pass: see `revisionConflict` in
   * `pipeline.ts`.
   */
  guardsRevision?: true;
  /**
   * The activity source every row this command writes carries, whatever source the caller passed to the
   * pipeline. Set only where the command is an external call by definition (`mcp.invoke`, command-bus §8,
   * extensibility §6), so a caller cannot file an external call as a native one.
   */
  activitySource?: 'mcp';
  /**
   * The gate's risk for one validated call, for a command whose risk depends on what it was asked to do
   * (`mcp.invoke`: the external tool's effective risk, extensibility §6). It reads the **normalized** params
   * `validate` returned, and its answer replaces `agentRisk` for that call only. Absent, `agentRisk` stands.
   */
  agentRiskOf?: (normalized: unknown) => 'read' | 'write-auto' | 'write-confirm' | 'never';
  /**
   * The command's apply returns a promise, because its effect reaches outside the process (`mcp.invoke`, extensibility
   * §6). Such a command runs only through `executeAsync()`, which awaits the apply. `execute()` refuses it before
   * anything runs: an apply that starts its effect and is only then found to be asynchronous would have changed the
   * world with no row, no undo entry and no record. Absent, the apply is synchronous, as A2 requires.
   */
  asyncApply?: true;
}

/**
 * The effect half of a registration — §3's apply step.
 *
 * **Deliberately not in the descriptor** (docs/decisions.md
 * 1): §2's descriptor is what the harness pre-validates a plan against, and
 * §2's load-bearing invariant is that `validate` is pure. A stateful effect on
 * the same record is an invitation to break that with nothing complaining.
 *
 * `S` is the state an apply mutates. For the fifteen project-mutating names it
 * is `unknown` **because the bus does not own project state** (§1: "no module
 * mutates project state except by executing a command"), and a store-side
 * implementation narrows it at its own definition site. For the three `view.*`
 * names it is `ViewState`, which the bus *does* own — see `CommandStateFor`.
 *
 * The third argument is §3's pipeline context, which is
 * what lets an apply hand §5's compensation back to the pipeline instead of
 * promising it in a comment. It is `unknown`-free by design — a struct of four
 * fields, three of them the command's own identity.
 */
export type CommandApply<P = Record<string, unknown>, S = unknown> = (
  state: S,
  params: P,
  context: ApplyContext,
) => unknown;

/**
 * §2: `mutates: 'view'` is *"ephemeral UI state (selection, scroll, active doc)
 * — never persisted"*, and it is the **only** value of `mutates` that names a
 * different state from the one every other command mutates. So it is the only
 * value that changes what `execute()` hands an apply, and the only one the bus
 * can type without owning project state.
 *
 * Declared here, in the same file and for the same reason as
 * `ValidationSnapshot`: the dependency runs store → bus, and the alternative
 * would be a type the app cannot satisfy.
 */
export interface ViewState {
  /** `view.setSelection` — the binder's current selection, which may name a deleted node. */
  selection: readonly string[];
  /** `view.setActiveDoc` — the document the editor is focused on. */
  activeDocId: string | null;
  /** `view.setScroll` — last scroll offset per node id. */
  scroll: Readonly<Record<string, number>>;
  /**
   * `view.setExpanded` — the binder's explicit expansion overrides, per node id.
   * **Overrides only**: an absent key means "the binder's default for that row"
   * (ui-modules §2.1), so a fresh view state carries no expansion at all.
   */
  expanded: Readonly<Record<string, boolean>>;
  /**
   * `view.setCorkboardScope` — the container the corkboard shows. `null` is "the
   * manuscript", which is the corkboard's default (ui-modules §3.1). A stale id
   * is not cleared here: like `selection`, it is resolved at render time.
   */
  corkboardScope: string | null;
}

/**
 * The names whose apply mutates `ViewState`.
 *
 * **Hand-written, and derived the other way round by a test.** It has to be a
 * type, and a type cannot be computed from a runtime table — so
 * `test/pipeline.test.ts` reads `mutates` off every descriptor in the registry
 * and asserts this list is exactly the `view` set. A view command that is not in
 * this list fails that test rather than being handed a project state.
 *
 * `view.setExpanded` and `view.setCorkboardScope` are the two view names ui-modules §1 and §3.1 require, and command-bus §9 tabulates
 * them with the other view rows; `test/registry.test.ts` checks that against this list.
 */
export type ViewCommandName =
  | 'view.setSelection'
  | 'view.setActiveDoc'
  | 'view.setScroll'
  | 'view.setExpanded'
  | 'view.setCorkboardScope';

export const VIEW_COMMAND_NAMES: readonly ViewCommandName[] = [
  'view.setSelection',
  'view.setActiveDoc',
  'view.setScroll',
  'view.setExpanded',
  'view.setCorkboardScope',
];

/** What the apply for `K` mutates. See `ViewCommandName` for why this is hand-written. */
export type CommandStateFor<K extends CommandName> = K extends ViewCommandName ? ViewState : unknown;

/**
 * §5's two compensation shapes, as the apply hands them over.
 *
 * A discriminated union rather than two optional fields, so the pipeline can
 * check the capture against the descriptor's declared `undo` by equality
 * instead of by "which field is set" — a `compensable` command that hands over
 * an inverse command is a defect, and a union is what makes that a comparison
 * rather than a guess.
 *
 * The label asymmetry is §5's own: an `inverse` command **names itself** (it is
 * a `Command` with a `name`), while a restore artifact is an opaque body
 * snapshot or a filename and needs a human label for the checkpoint row.
 */
export type UndoKind = 'inverse' | 'compensable';

export type UndoPayload =
  | { readonly kind: 'inverse'; readonly inverse: Command }
  | { readonly kind: 'compensable'; readonly label: string; readonly restore: () => void };

/**
 * §3's undo-registration surface, handed to an apply for the duration of one
 * dispatch.
 *
 * **The reason this exists rather than a comment asking nicely:** §5 makes
 * registration a *pipeline* step, and a pipeline that trusts an apply to
 * remember produces a command that reports success and cannot be undone. The
 * pipeline reads `captured()` after apply and **refuses** a project command
 * whose descriptor says `inverse`/`compensable` and whose apply handed over
 * nothing — so forgetting is loud, not silent.
 */
export interface UndoScope {
  /** the descriptor's declared `undo`, so an apply can see what the pipeline will check. */
  readonly kind: CommandDescriptor['undo'];
  /** §5 `inverse`: the exact inverse command to dispatch when the group is undone. */
  inverse(command: Command): void;
  /** §5 `compensable`: the restore artifact captured at apply time. */
  compensate(label: string, restore: () => void): void;
  /** What the apply handed over — `undefined` if it handed over nothing. */
  readonly captured: () => UndoPayload | undefined;
}

/** §3's pipeline context, as an apply sees it. Five fields, three of them the command's identity. */
export interface ApplyContext {
  readonly commandId: string;
  readonly name: CommandName;
  /** the agent turn this dispatch belongs to (§2, `turnId?`) */
  readonly turnId?: string;
  /**
   * Who dispatched it (§2's `issuedBy`). **The command's identity, not a permission
   * detail** — which is why it is here and not left to an apply to be told.
   *
   * It is here because `codex.upsert` cannot do its job without it.
   * codex.md §2 types `CodexEntry.origin` as required, and requires an
   * agent-created entry to carry `origin: 'agent'` — but §9's closed `codex.upsert`
   * params carry no `origin` field, and `codex.write` (§9: "Backs `codex.write`")
   * reaches the manifest only *through* this command, so the command is the only
   * writer of that field. Left out of the context, `origin: 'agent'` is unreachable
   * in v0.1 and every agent entry is written as hand-authored — which silently
   * inverts codex.md's canon rule, where a coherence finding names a hand-authored
   * entry and an agent-inferred one, and the *manual* entry is canon. A wrong
   * `origin` is therefore not a cosmetic default; it changes which entry wins.
   *
   * `issuedBy` is the one fact that already distinguishes the two cases, and §4's
   * permission gate reads the same field to decide whether an agent needs a grant.
   */
  readonly issuedBy: 'user' | 'agent';
  /**
   * The envelope's provenance (codex.md §2), handed over unchanged: `'import'` when
   * the tool that built the command is codex.import. `codex.upsert` reads it to stamp an
   * entry's `origin`, and `issuedBy` alone cannot say that. Absent for every other command.
   */
  readonly provenance?: CommandProvenance;
  /** §5's registration surface. The only reason the context exists. */
  readonly undo: UndoScope;
  /**
   * §8's `affected` and `summary`, handed over once per dispatch.
   *
   * **The apply, not the pipeline, and not the params.** §8 wants *"human titles,
   * not bare ids"*, and a title is only knowable on both sides of an effect by
   * the thing that performed it: a rename's row has to name the **new** title and
   * a delete's row has to name a title for a node that no longer resolves. The
   * bus cannot read it either — it does not own project state (§1) and its
   * snapshot is read *before* the apply.
   *
   * **Call it last, after `undo`.** A second call throws (`createActivityScope`),
   * and a throw here lands in the pipeline's apply-threw path — which is the one
   * place that still registers a capture. Reporting before capturing would throw
   * with nothing to hand back.
   */
  readonly report: (report: ActivityReport) => void;
}

export interface CommandRegistration<P = Record<string, unknown>, S = unknown> {
  readonly descriptor: CommandDescriptor<P>;
  /**
   * **Optional on purpose.** §9's closed set contains `export.compile` and
   * `export.compileSelection`, whose effects come from the exporter, and a
   * registry without one would otherwise hold a half-built entry. Optional is what makes it representable;
   * `resolveCommand` is what makes it safe.
   */
  readonly apply?: CommandApply<P, S>;
}

/** The param shape each name validates to — §9's "Params (essentials)" column. */
export interface CommandParams {
  'binder.create': BinderCreateParams;
  'binder.move': BinderMoveParams;
  'binder.rename': BinderRenameParams;
  'binder.setMeta': BinderSetMetaParams;
  'binder.setSynopsis': BinderSetSynopsisParams;
  'notes.set': NotesSetParams;
  'notes.append': NotesAppendParams;
  'doc.write': DocWriteParams;
  'editor.insert': EditorInsertParams;
  'editor.replaceRange': EditorReplaceRangeParams;
  'codex.upsert': CodexUpsertParams;
  'codex.attach': CodexAttachParams;
  'export.compile': ExportCompileParams;
  'export.compileSelection': ExportCompileSelectionParams;
  'project.deleteNode': ProjectDeleteNodeParams;
  'view.setSelection': ViewSetSelectionParams;
  'view.setActiveDoc': ViewSetActiveDocParams;
  'view.setScroll': ViewSetScrollParams;
  'view.setExpanded': ViewSetExpandedParams;
  'view.setCorkboardScope': ViewSetCorkboardScopeParams;
  'coherence.setSceneMeta': CoherenceSetSceneMetaParams;
  'coherence.setFindingStatus': CoherenceSetFindingStatusParams;
  'coherence.discardRun': CoherenceDiscardRunParams;
  'coherence.addKnowledgeFact': CoherenceAddKnowledgeFactParams;
  'coherence.editKnowledgeFact': CoherenceEditKnowledgeFactParams;
  'coherence.removeKnowledgeFact': CoherenceRemoveKnowledgeFactParams;
  'mcp.invoke': McpInvokeParams;
  'mcp.readResource': McpReadResourceParams;
  'storyboard.create': StoryboardCreateCommandParams;
  'shot.create': ShotCreateCommandParams;
  'shot.setMeta': ShotSetMetaCommandParams;
  'project.rename': ProjectRenameParams;
  'project.setMetadata': ProjectSetMetadataParams;
  'project.importAsset': ProjectImportAssetParams;
  'vocabulary.upsert': VocabularyUpsertParams;
  'vocabulary.remove': VocabularyRemoveParams;
  'recipe.save': RecipeSaveParams;
  'recipe.delete': RecipeDeleteParams;
  'binder.saveFilter': BinderSaveFilterParams;
  'binder.deleteFilter': BinderDeleteFilterParams;
  'project.saveGoal': ProjectSaveGoalParams;
  'project.deleteGoal': ProjectDeleteGoalParams;
  'shot.importImage': ShotImportImageParams;
  'screenplay.import': ScreenplayImportParams;
  'dialogue.importInk': DialogueImportInkParams;
  'dialogue.setMeta': DialogueSetMetaParams;
  'skill.import': SkillImportParams;
  'skill.write': SkillWriteParams;
  'skill.delete': SkillDeleteParams;
  'skill.setEnabled': SkillSetEnabledParams;
}

/**
 * `storyboard.create` (storyboard.md §3.1): the `<Scene Title> — Shots` folder. `scene` is the scene facts the plan
 * was made against, which the apply checks, so a scene that moved or changed after the card was shown is refused.
 */
export type StoryboardCreateCommandParams = {
  readonly id: string;
  readonly parentId: string;
  readonly title: string;
  readonly scene: { readonly id: string; readonly parentId: string; readonly revision: number };
};

/** `shot.create` (storyboard.md §3.1): one shot card, carrying its stored metadata. */
export type ShotCreateCommandParams = {
  readonly id: string;
  readonly parentId: string;
  readonly title: string;
  readonly stored: Readonly<Record<string, unknown>>;
};

/**
 * `shot.setMeta` (storyboard.md §3.1): a whole stored `shot` value written over a shot's stored one. `expect` is the
 * value the plan read (`null` when the shot had none), and the apply refuses when it no longer holds, so an undo
 * is simply the same command with the two values swapped.
 */
export type ShotSetMetaCommandParams = {
  readonly nodeId: string;
  readonly stored: Readonly<Record<string, unknown>> | null;
  readonly expect: unknown;
};

/**
 * `shot.importImage` (storyboard.md §3.1): a staged image written into `assets/` and set as the shot's `image`. The
 * bytes are not params (they would travel as JSON and be copied into the undo group), so the host stages them and names
 * the staging id. The shot is named by its node id, and an apply on a node that is not a shot is refused before any write.
 */
export type ShotImportImageParams = { nodeId: string; stagingId: string };

/**
 * `mcp.invoke`'s params (extensibility.md §6). The bus holds the shape only: the validated call, and the
 * normalized one the external client returns, are the client's to build (`@caotang/mcp-client`).
 */
export type McpInvokeParams = {
  readonly serverKey: string;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly expectedPins?: readonly string[];
};

/**
 * `mcp.readResource`'s params (extensibility.md §6). `pickedBy` is the literal `'writer'`: the command is refused without it, and
 * only the writer's own picker sends it. `viaTemplate` names the listed resource template the URI comes through, when the URI is
 * not one the server lists itself.
 */
export type McpReadResourceParams = {
  readonly serverKey: string;
  readonly uri: string;
  readonly pickedBy: 'writer';
  readonly viaTemplate?: string;
};

/**
 * A mapped type over the closed set, so `registry['binder.move']` is precisely
 * typed and a missing entry is a compile error at construction.
 *
 * **`S` comes from `CommandStateFor`, not from the default.** The three
 * `view.*` entries carry a `ViewState` apply and the other fifteen carry
 * `unknown`; a lookup therefore returns the state type the entry's own apply
 * takes, which is what lets `view.ts`'s applies be written without a cast and
 * what keeps a project apply from being handed a view state.
 */
export type CommandRegistry = {
  [K in CommandName]: CommandRegistration<CommandParams[K], CommandStateFor<K>>;
};

/**
 * §9's `binder.setMeta` patch, with `status` and `label` as `string | null`
 *
 *
 * **Why `null` and not `string`, which is what §9's column reads.** project-format
 * §2 types both node fields as *"vocabulary id **or `null`**"*, so "this node has
 * no status" is a real, serialised value — and §5 gives this command
 * `undo: 'inverse'`, whose whole promise is *"the descriptor generates the **exact**
 * inverse command"*. With `status?: string`, the first `setMeta` on an unstatused
 * node has **no exact inverse at all**: the prior value is `null` and the patch
 * vocabulary cannot write it, so the undo group would restore a value the command
 * family cannot express. `status?` is presence-optional, so `null` reads
 * unambiguously as *present, and its value is null* = clear it, while absence stays
 * "leave this field alone".
 *
 * The alternative — refusing to set a field whose prior value is `null` — was
 * rejected because it refuses the first status a node is ever given. Logged with
 * the ambiguity.
 */
export type MetaPatch = {
  status?: string | null;
  label?: string | null;
  keywords_add?: string[];
  keywords_remove?: string[];
  /** The scene's export style (exporter.md §2): one of `SCENE_STYLES`, or `null` to clear it. `normal` and `null` both read as no style. */
  style?: string | null;
};

/** The scene styles (exporter.md §2, Per-scene styling). A closed vocabulary that grows by spec change; `normal` is the default and the same as absent. */
export const SCENE_STYLES = ['normal', 'section'] as const;
export type SceneStyle = (typeof SCENE_STYLES)[number];

/**
 * One provenance citation (codex.md §2, `EntrySource`): a verbatim slice of a
 * manuscript document that an entry's content was extracted from.
 *
 * `sources` is the one provenance field an op may carry. `origin` is not: it is
 * harness-owned from who issued the command (codex.md §2), and an op naming it is refused.
 * The citations are the extraction's own record, so the harness supplies them, and
 * the command checks their shape and that each names a real document.
 */
export type CodexSourceCitation = {
  docId: string;
  quote: string;
  from: number;
  to: number;
  extractedAt: string;
};

export type CodexUpsertOp = {
  action: 'create' | 'update';
  id?: string;
  name?: string;
  aliases?: string[];
  type?: string;
  description?: string;
  includePolicy?: string;
  caseSensitive?: boolean;
  exclude?: string[];
  attachTo?: string[];
  detachFrom?: string[];
  keywords?: string[];
  sources?: CodexSourceCitation[];
  /** video-prompt-pack.md §3: the asset ids of the entry's visual references. An update replaces the list. */
  visualRefs?: string[];
};

/*
 * Declared as `type` aliases, not interfaces, on purpose: TypeScript gives an
 * object *type alias* an implicit index signature and an `interface` none, and
 * these have to land in `Record<string, unknown>`-shaped positions as params.
 */

/**
 * `binder.create`'s params. The media track (storyboard.md §2.1, dialogue-narrative.md §2.1, screenplay.md §2.1)
 * widens `type` with the two media node types and adds `kind`, the marker a node carries. The validator pairs
 * them: a folder is plain or `storyboard`, a document is plain or `screenplay`, a dialogue container is `branching`,
 * and a shot takes no kind, because its kind is its type.
 */
export type BinderCreateParams = {
  parentId: string;
  type: 'folder' | 'document' | 'shot' | 'dialogue';
  title: string;
  kind?: 'screenplay' | 'storyboard' | 'branching';
};

export type BinderMoveParams = { nodeId: string; newParentId: string; index: number };

export type BinderRenameParams = { nodeId: string; title: string };

export type BinderSetMetaParams = { nodeId: string; patch: MetaPatch };

export type BinderSetSynopsisParams = { nodeId: string; synopsis: string };

export type NotesSetParams = { nodeId: string; notes: string };

export type NotesAppendParams = { nodeId: string; text: string; divider?: boolean };

export type DocWriteParams = { docId: string; body: string; expectedRevision?: number };

export type EditorInsertParams = {
  docId: string;
  offset: number;
  text: string;
  expectedRevision?: number;
};

export type EditorReplaceRangeParams = {
  docId: string;
  range: { from: number; to: number };
  text: string;
  expectedRevision?: number;
};

export type CodexUpsertParams = { entries: CodexUpsertOp[] };

export type CodexAttachParams = { entryId: string; attachTo: string[]; detachFrom: string[] };

/**
 * `format` is a bare string here on purpose. exporter.md §2's format enum joins
 * the media track post-v0.1, so the enum is the exporter's to define. Validating
 * against a fixed list in this type would either freeze it or refuse formats
 * the exporter will accept.
 *
 * **No `selection` field.** A single command carrying a scope would need one
 * shape for it, and the specs settle it differently: **one tool for the whole
 * manuscript, one for a part.** So
 * this is the whole manuscript and carries no scope at all, and
 * `export.compileSelection` below is the part.
 */
export type ExportCompileParams = { format: string; recipeName?: string; templateId?: string };

/**
 * A part: the nodes named, and nothing inferred. `includeRootIds` is a list of
 * node ids, **not** §2's `ExportSelection` object — that object carries
 * `docFilter?: (doc) => boolean`, a *function*, and a command's params are JSON
 * (they travel over MCP and are written to the activity log), so a callable
 * filter cannot be one. A caller that wants a filter resolves it to a node-id
 * list before sending. exporter.md §5 states this at the same level.
 *
 * `recipeName` names a saved recipe whose **options** apply to the part: the title page, the contents, the author and the
 * dialogue table's character limit. The recipe's own `includeRootIds` does not, because the part names its nodes itself.
 */
export type ExportCompileSelectionParams = { includeRootIds: string[]; format: string; templateId?: string; recipeName?: string };

export type ProjectDeleteNodeParams = { nodeId: string };

export type ViewSetSelectionParams = { nodeIds: string[] };

export type ViewSetActiveDocParams = { docId: string };

export type ViewSetScrollParams = { nodeId: string; offset: number };

export type ViewSetExpandedParams = { nodeId: string; expanded: boolean };

/** `null` clears the scope back to the manuscript default. */
export type ViewSetCorkboardScopeParams = { nodeId: string | null };

/**
 * coherence.md §7.1: one document's scene declarations, changed by a patch. The patch is
 * the closed set `SCENE_PATCH_KEYS` (coherence.ts), and the rule that applies it is shared
 * with the store, so this type is the shape a caller sends and the rule is what checks it.
 */
export type CoherenceSetSceneMetaParams = { docId: string; patch: ScenePatch };

/**
 * coherence.md §7.1: one finding's status. `dismissed` needs a `reason` from the picker and
 * is the writer's (the agent path is refused at the gate); `open` re-opens; `fixed` is the
 * writer's or, through the coherence tool after its postcondition, the agent's.
 */
export type CoherenceSetFindingStatusParams = {
  findingId: string;
  status: CoherenceStatusName;
  reason?: string;
  note?: string;
};

/**
 * coherence.md §7.1 and §8: one run removed from the run history, with the findings it created that nobody has touched.
 * Touched findings stay. Undo puts the run and those findings back.
 */
export type CoherenceDiscardRunParams = { runId: string };

/**
 * coherence.md §4.4 and §7.1: a knowledge fact added. The text is one sentence; `ruleId` and `entryId` link the world rule it
 * restates and the codex entry it is about. The `k_` id is minted by the apply.
 */
export type CoherenceAddKnowledgeFactParams = { text: string; ruleId?: string; entryId?: string };

/** coherence.md §7.1: the fields of a fact the call names change. `null` clears a link. */
export type CoherenceEditKnowledgeFactParams = { factId: string; text?: string; ruleId?: string | null; entryId?: string | null };

/** coherence.md §7.1: a fact removed, with every `learns` and `knows` pair that names it. */
export type CoherenceRemoveKnowledgeFactParams = { factId: string };

/**
 * The three reserved tree ids — project-format §2: *"Reserved ids: `root`,
 * `manuscript`, `research` (fixed roots, not deletable)"*.
 *
 * **Duplicated deliberately.** The canonical copy is `packages/store`'s
 * `FIXED_ROOT_IDS`, and the bus cannot import it: the dependency runs store →
 * bus. The list could move here and have the store re-export it; until then
 * the two copies are kept equal by hand.
 */
export const FIXED_ROOT_IDS = ['root', 'manuscript', 'research'] as const;

export function isFixedRootId(id: string): boolean {
  return (FIXED_ROOT_IDS as readonly string[]).includes(id);
}

/*
 * Project export param shapes. Each is the closed key set its descriptor in `descriptors-project.ts` accepts.
 */

/** `project.rename`: the project's title. The root node carries the same title, and the apply keeps them equal. */
export type ProjectRenameParams = { title: string };

/**
 * `project.setMetadata`: the EPUB and byline fields (epub-metadata.md). A key left out is left alone; `null` clears
 * the field. The cover is named by an asset id: `project.importAsset` mints one for a file it writes, and an undo of a
 * cover change restores the id it replaced, so the reference can always name a file that was written. `null` removes it.
 */
export type ProjectSetMetadataParams = {
  patch: {
    author?: string | null;
    language?: string;
    isbn?: string | null;
    coverAssetId?: string | null;
  };
};

/**
 * `project.importAsset`: write a staged image into `assets/` and set it as the target. The bytes are not params (they
 * would travel as JSON and be copied into the undo group), so the host stages them and names the staging id here.
 */
export type ProjectImportAssetParams = { stagingId: string; target: 'cover' };

/**
 * `skill.import` (extensibility.md §10): take one skill folder the writer chose into the project. The files are not params. The host
 * stages them and names the staging id, as it does an image, and the apply refuses a name that is taken or a folder over a cap.
 */
export type SkillImportParams = { stagingId: string };

/** `skill.write`: one text file of a skill, created or replaced. A new skill starts with its `SKILL.md`. */
export type SkillWriteParams = { name: string; path: string; text: string };

/** `skill.delete`: the whole skill, every file of it. */
export type SkillDeleteParams = { name: string };

/** `skill.setEnabled`: whether the agent may be told about the skill. The skill's files are not touched. */
export type SkillSetEnabledParams = { name: string; enabled: boolean };

/** The two vocabularies (project-format.md §2). */
export type VocabularyKind = 'status' | 'label';

/**
 * `vocabulary.upsert`: create a term, or update one by `id`. A created term's id is the apply's to mint from its name,
 * so a caller that names no id is told the one it got in the activity row.
 */
export type VocabularyUpsertParams = { kind: VocabularyKind; id?: string; name: string; color: string };

/** `vocabulary.remove`: drop a term. Nodes that hold it are detached (set to no status or label), and the undo restores them. */
export type VocabularyRemoveParams = { kind: VocabularyKind; id: string };

/** exporter.md §2 recipe options, in the shape the manifest stores them. */
export type RecipeOptionsParams = {
  titlePage?: boolean;
  toc?: boolean;
  author?: string;
  charLimit?: number;
  /** The screenplay PDF's scene numbers (screenplay.md §5.3). */
  sceneNumbers?: SceneNumbersOption;
  /** `(MORE)` and `(CONT'D)` across a page break in the screenplay PDF (screenplay.md §5.3). */
  continued?: boolean;
  /** The contact sheet's paper (storyboard.md §6). */
  pageSize?: RecipePageSize;
};

/**
 * Where the screenplay PDF prints scene numbers (screenplay.md §5.3): off by default.
 * Declared beside the runtime list in `descriptors-project.ts` and re-exported here,
 * where the recipe options (and their consumers) already read the bus's types.
 */
export type { SceneNumbersOption };

/** The contact sheet's paper (storyboard.md §6), a recipe option. */
export type RecipePageSize = 'A4' | 'Letter';

/** `recipe.save`: a named export configuration. Saving a name that exists replaces it. */
export type RecipeSaveParams = {
  name: string;
  includeRootIds: string[];
  format: string;
  templateId?: string;
  options?: RecipeOptionsParams;
};

/** `recipe.delete`: remove a saved recipe by name. */
export type RecipeDeleteParams = { name: string };
