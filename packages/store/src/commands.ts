/**
 * The `undo: 'inverse'` applies — [command-bus.md §5](docs/architecture/command-bus.md).
 *
 * §5, verbatim: *"`inverse` — the descriptor generates the **exact inverse
 * command** (meta sets, renames, moves, attach/detach)."* This file is that
 * generation, for all six of §9's `inverse` names. Five of them closed; the
 * sixth, `binder.create`, could not, and why is the section below.
 *
 * ## The other half of §5 is here too, 
 *
 * §5 names two kinds of compensation, and the five applies — `notes.set`,
 * `notes.append`, `doc.write`, `editor.insert`, `editor.replaceRange` — are the
 * `compensable` half: *"the command captured a restore artifact at apply time:
 * doc **body snapshot** before any text mutation."* They sit in this file rather
 * than a second one for the reason in the next section: a project apply belongs
 * next to the state it mutates, and splitting the family across two files would
 * mean a reader looking for "how does a text write get undone" has to know which
 * half of §5 to open.
 *
 * ## Why these are here and not in `packages/bus`
 *
 * The bus owns no project state — §1 (*"no module mutates project state except by
 * executing a command"*) and the rule the whole package is built on: **the bus
 * never depends on the store; the store depends on the bus**. That
 * direction is why `ValidationSnapshot` and `ViewState` are *declared* in the bus
 * structurally rather than imported: a read-only view needs nothing the bus does
 * not have, and the three `view.*` applies sit there because §2 makes their state
 * the bus's own ephemeral view state.
 *
 * A project apply is the third shape, and neither precedent licenses it. Writing
 * one in the bus means either handing project state to a package that must not
 * know it exists, or declaring a **mutable** window on state the bus does not own
 * — a duck-typed view the store happens to satisfy. And the alternative to a
 * duplicate: a bus-side `binder.move` would have to re-derive §2's gap-encoding,
 * which `siblingOrderAt` above already states once, and a bus-side `binder.create`
 * would have to re-derive `addDocument`'s id generation, sibling order and
 * document record. **Two implementations of one format rule is how a format
 * drifts**, so the applies live next to the state they mutate and the store hands
 * the bus a registry — `createProjectCommandRegistry()` — which `execute()`
 * takes as its third parameter.
 *
 * The bus's own `COMMAND_REGISTRY` therefore still refuses these thirteen, and that
 * is now the *correct* answer rather than a gap: it has no project state to apply
 * them to. `resolveCommand`'s refusal ("registered but has no implementation in
 * this build") is what an app that forgets to substitute sees, and
 * `test/commands.test.ts` pins both halves so neither can drift.
 *
 * ## Why `binder.create` waited for `project.deleteNode`
 *
 * Five of §9's six `inverse` names could ship before the sixth.
 * `binder.create`'s exact inverse is `project.deleteNode` — the only command that
 * removes a node, and §5 asks for the *exact* one — and at that point
 * `project.deleteNode` had no apply at all (`state.ts` had no `removeNode`
 * primitive), so a `binder.create` shipped then would have registered an undo group
 * whose compensation is a command the bus refuses to resolve: **a write-auto
 * command that reports success and cannot be undone**, which is the one outcome §5's
 * `inverse` exists to prevent. So the pair ships together.
 *
 * That cut was not free of a second problem, and it is the reason the inverses here
 * carry `issuedBy: 'user'` — which is why the delete's own `never` risk class makes
 * the choice load-bearing rather than tidy. See the next section, and the delete's
 * apply below.
 *
 * ## Every inverse is issued as a user gesture, and that is load-bearing
 *
 * §5 makes the undo a *click* — *"One click = undo the group"* — so the inverse
 * command is that click, and §4's gate is evaluated on `issuedBy`:
 * `issuedBy: 'user'` is *"its own confirmation"* and is never refused. Copying the
 * original command's `issuedBy: 'agent'` instead would make the reversal of an
 * agent's own `write-confirm` command refusable — no approved plan is in context
 * during an undo — and would make the reversal of a `never`-class command
 * un-approvable by *any* flow, which is precisely what a create's delete is. The
 * one thing a user-issued hard-deny command still owes is the confirm dialog, and
 * §4 already reports it: `grant.requiresUserConfirm` is `true`, and showing it is
 * the UI's job.
 *
 * A compensable apply has no such decision to make, and that is not an oversight.
 * §4's gate is evaluated **before** the apply and `compensate` is a *capture*,
 * not a dispatch, so a `restore` closure is never gated by anything: it is a
 * function the bus calls directly, and §5's "one click = undo the group" is the
 * user's own gesture by construction. The `never`-class `editor.*` names are the
 * case that would be un-approvable if they were inverses; as compensations they
 * are restorable by a click, which is what the two-lane undo (command-bus §5) needs.
 *
 * ## The one thing an exact inverse cannot restore
 *
 * A `binder.setMeta` patch that **both removes and re-adds the same keyword**
 * leaves that keyword in the set, at the end of the list rather than where it
 * was. `MetaPatch` has no field for a position, so the undo restores the set and
 * not the order. Every other accepted patch restores exactly — the apply computes
 * each inverse from the values it observed, not from the values it was handed, so
 * an idempotent instruction (attaching a node that is already attached) inverts
 * to an equally inert command instead of to a detach that would destroy a
 * pre-existing attachment. That distinction is the reason this file reads state
 * before it writes any.
 *
 * ## A compensable restore has no equivalent gap
 *
 * A body snapshot is the whole prior body, so it restores the *text* exactly —
 * there is no ordering-within-a-set problem, because the artifact is the value
 * rather than a description of how to rebuild it. That is the property §5 gets
 * from "doc **body snapshot**", and it is why the family is called `compensable`
 * rather than `inverse`: the apply captures, the bus does not reconstruct.
 */

import { newId } from '@caotang/ids';
import type { CoherenceFindingState, CoherenceState } from './coherence-state.js';
import { applyCoherenceDiscardRun } from './commands-coherence.js';
import { declarationChangeWords, dismissalWordsOf } from './coherence-words.js';
import {
  applySceneMetaPatch,
  buildRegistry,
  coherenceDiscardRun as coherenceDiscardRunDescriptor,
  commands,
  inverseScenePatch,
  isEmptySceneMeta,
  trimCoherenceNote,
  ApplyRefusal,
  type ApplyContext,
  type CommandError,
  type Result,
  type ShotCreateCommandParams,
  type ShotSetMetaCommandParams,
  type StoryboardCreateCommandParams,
  type BinderCreateParams,
  type CoherenceSetFindingStatusParams,
  type CoherenceSetSceneMetaParams,
  type CoherenceStatusName,
  type BinderMoveParams,
  type BinderRenameParams,
  type BinderSetMetaParams,
  type BinderSetSynopsisParams,
  type CodexAttachParams,
  type CodexUpsertParams,
  type Command,
  type CommandApply,
  type CommandDescriptor,
  type CommandName,
  type CommandRegistry,
  type DocWriteParams,
  type EditorInsertParams,
  type EditorReplaceRangeParams,
  type ExportCompileParams,
  type ExportCompileSelectionParams,
  type MetaPatch,
  type NotesAppendParams,
  type NotesSetParams,
  type ProjectDeleteNodeParams,
} from '@caotang/bus';
import { createBinderNode } from './commands-media.js';
import {
  getBody,
  getRevision,
  moveNode,
  nodeById,
  removeNode,
  setBody,
  siblingIndex,
  siblingOrderAt,
  type ProjectState,
} from './state.js';
import type { CodexEntry, CodexIncludePolicy, TreeNode } from './manifest.js';
import { projectCommandRegistrations, type ProjectAssetPort } from './commands-project.js';
import { shotImageCommandRegistrations } from './commands-shot-image.js';
import { furnitureApplies } from './commands-furniture.js';
import { scriptApplies } from './commands-script.js';

/** A project command's state, as the bus types it: the store's, narrowed here. */
type ProjectApply<P> = CommandApply<P, ProjectState>;

/**
 * The clock seam, for §2's `createdAt` and nothing else.
 *
 * §2: *"epoch ms; log/display only — never affects behavior"*, so this is not a
 * behavioural dependency — but an activity-log row for an undo that carries the
 * timestamp of the command being undone would put the reversal before the
 * command, and a reader of the log cannot tell. A parameter rather than
 * `Date.now()` in each apply, for the reason `AutosaveClock` is: a clock read
 * from a global is a clock no test can control.
 */
export interface CommandClock {
  now(): number;
}

export const systemCommandClock: CommandClock = { now: () => Date.now() };

export interface ProjectCommandOptions {
  readonly clock?: CommandClock;
  /**
   * §5.1 rule 7: the snapshot lives in the IndexedDB runtime store, never the
   * artifact. Defaults to `synchronousSnapshotSink`, so a caller with no store
   * still gets a fully reversible group — the in-memory artifact is what §5
   * requires, and the durable row is a retention concern.
   */
  readonly snapshots?: SnapshotSink;
  /**
   * The exporter, for the two export names. **Injected, not imported** — the
   * exporter reads this store, so the store importing it would be a cycle. With no
   * exporter the two names stay descriptor-only and the registry refuses them
   * loudly.
   */
  readonly exporter?: ExportCommandPort;
  /**
   * The external-call command, `mcp.invoke` (extensibility.md §6). **Injected, not imported**: its descriptor
   * validates against the live MCP client and its apply awaits a server, and that client lives in
   * `@caotang/mcp-client`, which this package does not depend on. Without it the name stays descriptor-only and
   * the registry refuses it as not wired, so an external call is never reachable by accident.
   */
  readonly mcpInvoke?: McpInvokeCommandPort;
  /**
   * The storyboard module's shot commands (storyboard.md §3.1): `storyboard.create`, `shot.create` and
   * `shot.setMeta`. **Injected, not imported**: the guards and the write belong to `@caotang/storyboard`, which
   * depends on this package. Without it the three names stay descriptor-only and are refused as not wired.
   */
  readonly shots?: ShotCommandPort;
  /**
   * The project's asset port, for `project.importAsset` (the cover image). **Injected, not imported**, for the reason the
   * other ports are: the host owns where the bytes are written. Without it the name stays descriptor-only and is refused as not wired.
   */
  readonly assets?: ProjectAssetPort;
}

/** A shot command's report for the activity row (command-bus §8): the nodes it touched, and what it did. */
export interface ShotCommandReport {
  readonly affected: readonly { readonly nodeId: string; readonly title: string }[];
  readonly summary: string;
}

/**
 * The storyboard module's apply for one shot command, as the store sees it. It runs the module's guards and
 * writes, and refuses with the bus error it built, before any write. The store owns what the bus owns around it:
 * the undo inverse, the activity row, and the refusal's place in the pipeline.
 */
export interface ShotCommandPort {
  apply(
    state: ProjectState,
    name: 'storyboard.create' | 'shot.create' | 'shot.setMeta',
    params: unknown,
    now: Date,
  ): Result<ShotCommandReport, CommandError>;
}

/**
 * What `mcp.invoke` needs from the MCP client, as the store sees it. `@caotang/mcp-client`'s
 * `mcpInvokeRegistration` builds both halves, and nothing here reads a server: the descriptor is the one that
 * validates a call against the live client, and the apply awaits its result (the bus's `executeAsync`).
 */
export interface McpInvokeCommandPort {
  readonly descriptor: CommandDescriptor<unknown>;
  readonly apply: CommandApply<unknown, unknown>;
}

/**
 * What `export.compile` and `export.compileSelection` ask the exporter for. Declared
 * here, as a structural port: the exporter (`@caotang/exporter`) implements it, and the
 * store only ever calls it, so neither package imports the other.
 */
export interface ExportCommandRequest {
  /** `export.compile` is the whole manuscript; `export.compileSelection` names nodes. */
  readonly selection: { readonly kind: 'manuscript' } | { readonly kind: 'nodes'; readonly includeRootIds: readonly string[] };
  readonly format: string;
  readonly recipeName?: string;
  readonly templateId?: string;
  /** The dispatch's clock reading, for the log row's `at`. */
  readonly at: number;
}

/** What the bus reports and returns for one compile — the facts, not the blob (exporter.md §5). */
export interface ExportCommandDigest {
  readonly format: string;
  /** The `exports/` path reserved for the artifact. */
  readonly output: string;
  readonly chapterCount: number;
  readonly sceneCount: number;
  readonly blockCount: number;
  readonly wordCount: number;
  /** Labels of the empty documents left out, e.g. `Chapter 3 → The Call`. */
  readonly skippedDocs: readonly string[];
  readonly tocIncluded: boolean;
  readonly notes: readonly string[];
}

export interface ExportCommandOutcome {
  readonly digest: ExportCommandDigest;
  /** The §8 checkpoint label for the compensation, e.g. `delete exports/Book.md`. */
  readonly restoreLabel: string;
  /**
   * §5's compensation: removes what this compile wrote. The exporter queues it behind
   * the write it undoes, so it is safe to call before that write has landed.
   */
  readonly restore: () => void;
}

/**
 * The exporter, as the store sees it.
 *
 * **Synchronous, and that is the contract (command-bus.md A2).** `compile` runs the
 * synchronous half — flatten, the digest, the output name — and returns. The render
 * and the write are the exporter's to queue, because DOCX and EPUB are loaded
 * lazily and an apply cannot await. Throwing before anything is reserved is how the
 * port refuses a request it cannot run; the bus reports that as `internal` with no
 * undo group and no log row.
 */
export interface ExportCommandPort {
  compile(state: ProjectState, request: ExportCommandRequest): ExportCommandOutcome;
}

/** `moveNode`'s own failure mode, so a missing node reads the same everywhere. */
function requireNode(state: ProjectState, id: string): TreeNode {
  const node = nodeById(state, id);
  if (!node) throw new Error(`no node "${id}"`);
  return node;
}

function requireCodexEntry(state: ProjectState, id: string): CodexEntry {
  const entry = (state.manifest.codex ?? []).find((e) => e.id === id);
  if (!entry) throw new Error(`no codex entry "${id}"`);
  return entry;
}

/**
 * The coherence file an apply changes. `validate` refuses a project with none (coherence.md §3),
 * so reaching here without one is a defect in the caller, and it is loud rather than a new file.
 */
function requireCoherenceFile(state: ProjectState): CoherenceState {
  if (state.coherence === undefined) throw new Error('no coherence file is open for this project');
  return state.coherence;
}

/**
 * What a scene-declaration patch is checked against: the codex entries by id and name, and the
 * documents a dependency may name. The same two lists `coherenceSetSceneMeta`'s validate reads.
 */
function sceneMetaContextOf(state: ProjectState): { entries: { id: string; name: string }[]; documentIds: Set<string> } {
  return {
    entries: (state.manifest.codex ?? []).map((entry) => ({ id: entry.id, name: entry.name })),
    documentIds: new Set(state.manifest.tree.filter((node) => node.type === 'document').map((node) => node.id)),
  };
}

/**
 * The document record a body-writing command addresses, or a throw naming it.
 *
 * `getBody` answers `''` for a document it cannot find, which is the right answer
 * for a *read* and the wrong one here: §5's artifact is "the body **before** any
 * text mutation", and a snapshot of `''` for a document that does not exist is a
 * restore artifact that restores an empty document over a real one. Validate
 * already refused this case (`requireDocumentNode` plus `requireLoadedBody`),
 * so reaching it is a defect — and the defect has to be loud.
 */
function requireDocument(state: ProjectState, id: string): { body: string; revision: number } {
  const record = state.documents.get(id);
  if (!record) throw new Error(`no document record for "${id}"`);
  return { body: record.body, revision: record.revision };
}

/**
 * The §5.1 checkpoint snapshot a body write is about to invalidate.
 *
 * Returned rather than written, because §3's bus is synchronous (A2) and an
 * IndexedDB transaction is not — see the note on `captureBody` at the call site.
 * What the applies do with it is the shape; what §5.1's retention ladder does
 * with the rows it becomes is that change's.
 */
export interface BodySnapshot {
  readonly projectId: string;
  readonly docId: string;
  readonly body: string;
  readonly revision: number;
  readonly capturedAt: number;
  readonly command: string;
}

/**
 * Where a captured snapshot goes.
 *
 * A function rather than a direct `writeBodySnapshot` call because of A2: the
 * applies are synchronous, so they cannot await a transaction, and §5.1 rule 7
 * puts the snapshot in IndexedDB. A seam is the only shape that satisfies both,
 * and it is the same seam `Autosave`'s `DocumentWriter` is — the caller that owns
 * the runtime store supplies the binding.
 *
 * The return value is the write's promise, and the apply **ignores it on
 * purpose**: the in-memory restore artifact is what makes the group reversible
 * (§5), and it is already captured by the time this is called. A caller that
 * needs durability before continuing awaits it. `synchronousSnapshotSink` is the
 * binding for a caller with no runtime store, and it exists so the "no store"
 * case is a stated choice rather than an accident.
 */
export type SnapshotSink = (snapshot: BodySnapshot) => Promise<void> | void;

/** The no-store binding: the snapshot is captured and the group is still reversible. */
export const synchronousSnapshotSink: SnapshotSink = () => {};

/**
 * `notes.append`'s divider line — agent-harness §3 row 6, verbatim
 * (`— agent, <date>`), and ui-modules §2's rule that it *"renders as a visual
 * separator, not literal text"*.
 *
 * The date is the `YYYY-MM-DD` of the capture instant. That is display-only
 * formatting of a value the clock seam already produced (§2's own rule for
 * `createdAt`: *"log/display only — never affects behavior"*), and it is read
 * from the seam rather than from `Date.now()` so a test can assert the line.
 */
function dividerLine(at: number): string {
  return `— agent, ${new Date(at).toISOString().slice(0, 10)}`;
}

/**
 * Stamps a node's `updatedAt` for a change to what the node holds (binder-filters §2.1, item 1): a rename, its synopsis,
 * its status, label or keywords, its notes, and its document's body. Structure ops (`binder.move`) do not call it, so
 * "what I was working on" does not light up every scene an agent moved. Read from the same clock seam as `createdAt`.
 */
function stampContent(node: TreeNode, clock: CommandClock): void {
  node.updatedAt = new Date(clock.now()).toISOString();
}

/**
 * What an inverse command must put back that its parameters cannot carry: a node's `updatedAt`, a record's timestamps.
 * An absent value is a real value here (a legacy node has no stamp), so the fields are optional rather than the entry.
 */
export interface RestoredStamps {
  readonly createdAt?: string | undefined;
  readonly updatedAt?: string | undefined;
}

/**
 * The restore table. A forward apply records, under the id of the inverse it mints, the stamps that inverse must restore,
 * and the inverse's own apply reads them back by its `commandId` (which is the id it was minted with). A forward command's
 * id is new, so it never finds an entry and takes the clock.
 *
 * Why a table and not the parameters: the bus's descriptors for `binder.rename`, `binder.setSynopsis` and `binder.setMeta`
 * close their param lists (`DECLARED_PARAMS`), and an undo scope holds one payload, either an inverse command or a
 * compensation, so an inverse cannot also carry a second restore step. In memory and bounded, like the undo store it serves:
 * a reload empties both, and an inverse with no entry takes the clock, which is the one case where undo re-stamps.
 */
export interface RestoreTable {
  remember(inverseId: string, stamps: RestoredStamps): void;
  recall(inverseId: string): RestoredStamps | undefined;
}

/** The table's capacity: one entry per undoable command, oldest evicted first. */
const RESTORE_CAPACITY = 2048;

export function createRestoreTable(): RestoreTable {
  const entries = new Map<string, RestoredStamps>();
  return {
    remember(inverseId, stamps) {
      entries.set(inverseId, stamps);
      while (entries.size > RESTORE_CAPACITY) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    recall(inverseId) {
      const found = entries.get(inverseId);
      entries.delete(inverseId);
      return found;
    },
  };
}

/** An inverse command, minted with its restore values remembered under its own id. */
function inverseWith<P>(
  name: CommandName,
  params: P,
  clock: CommandClock,
  restore: RestoreTable,
  stamps: RestoredStamps,
): Command<P> {
  const command = inverseCommand(name, params, clock);
  restore.remember(command.id, stamps);
  return command;
}

/**
 * The stamp a dispatch leaves on the node: the one its inverse was minted to restore, when this apply is an inverse, and the
 * clock otherwise. Used by the three inverse-based content commands (`binder.rename`, `binder.setSynopsis`, `binder.setMeta`).
 *
 * **An inverse restores its stamp even when it changed nothing**, so `wrote` says what the dispatch did, not what it is: a
 * dispatch that wrote no value and is no inverse leaves the node's stamp alone (there is nothing to put back and nothing to
 * stamp), while a dispatch that wrote no value and *is* an inverse still restores the stamp its forward left, because the
 * forward stamped and the undo has to say so.
 */
function stampFor(node: TreeNode, commandId: string, clock: CommandClock, restore: RestoreTable, wrote: boolean): void {
  const recalled = restore.recall(commandId);
  if (recalled !== undefined) {
    node.updatedAt = recalled.updatedAt;
    return;
  }
  if (wrote) node.updatedAt = new Date(clock.now()).toISOString();
}

/** A document's body write is a content change of its node, so the node is stamped (the same rule as `stampContent`). */
function stampBodyOf(state: ProjectState, docId: string, clock: CommandClock): void {
  const node = nodeById(state, docId);
  if (node !== undefined) stampContent(node, clock);
}

/**
 * The inverse command, minted.
 *
 * `newId('cmd')` is §2's *"cmd_ + 10 chars Crockford base32"* from the same
 * generator family as node and codex ids, and it is the **only** id here that
 * takes no `taken` set: a command id lives in the in-memory undo store and the
 * activity log for the length of a session (`undo.ts`'s own statement), unlike a
 * node id, which the tree references and which therefore has to be collision
 * checked at generation (project-format A4).
 *
 * `turnId` and `callId` are deliberately absent — §6's dedupe cache is per turn
 * and cleared at turn end, and an inverse replayed long after its turn must not
 * answer to that turn's call ids.
 */
function inverseCommand<P>(
  name: CommandName,
  params: P,
  clock: CommandClock,
): Command<P> {
  return { id: newId('cmd'), name, params, issuedBy: 'user', createdAt: clock.now() };
}

/**
 * The one cast this file needs, and `command.ts` books it in advance: *"For the
 * fifteen project-mutating names it is `unknown` because the bus does not own
 * project state … and a store-side implementation narrows it at its own
 * definition site."* This is that definition site. It is the same single cast
 * `pipeline.ts` documents for the mirrored reason, and it is the narrow that makes
 * the bus's choice of `unknown` cost the store nothing at the call site: the
 * caller's own `BusContext<ProjectState>` is what typechecks at `execute()`.
 */
function narrow<P>(apply: ProjectApply<P>): CommandApply<P, unknown> {
  return apply as CommandApply<P, unknown>;
}

/**
 * The summary a write reports. The Undo button and the activity log both show it, so a write an agent made is named in the writer's
 * words (`agentWords`), and a write the writer made keeps the bus's own (`ownWords`). Used by the body writes, and by the codex, notes,
 * binder and synopsis writes an agent can make (agent-harness §8, L9).
 */
function agentWriteSummary(context: ApplyContext, agentWords: string, ownWords: string): string {
  return context.issuedBy === 'agent' ? agentWords : ownWords;
}

/**
 * The fields an agent's metadata write changed, named as the writer knows them: status, label, keywords. A write that touched
 * only keywords, or that changed nothing, is about the keywords.
 */
function agentMetaFields(status: boolean, label: boolean, keywords: boolean): string {
  const fields = [...(status ? ['status'] : []), ...(label ? ['label'] : []), ...(keywords ? ['keywords'] : [])];
  const last = fields.pop();
  if (last === undefined) return 'keywords';
  return fields.length === 0 ? last : `${fields.join(', ')} and ${last}`;
}

/**
 * What the agent did to a finding, in the writer's words: the scenes it quotes by title, and no finding id, which the writer never
 * sees. An agent cannot dismiss (the gate hard-refuses it), so the dismissal wording is only for completeness.
 */
function agentFindingWords(status: string, titles: readonly string[]): string {
  const where = titles.length > 0 ? ` in ${titles.map((title) => `“${title}”`).join(' and ')}` : '';
  if (status === 'open') return `the agent reopened a finding${where}`;
  if (status === 'dismissed') return `the agent dismissed a finding${where}`;
  return `the agent marked a finding${where} ${status}`;
}

/**
 * The writer's own change to a finding, in words (coherence.md §8): the finding's message, and for a dismissal the reason
 * in the picker's words. A finding with no message is named by the scenes it quotes, as the agent's wording names it.
 */
function findingChangeWords(finding: CoherenceFindingState, status: string, reason: string | undefined, titles: readonly string[]): string {
  const message = finding.message?.trim() ?? '';
  const what =
    message !== ''
      ? `the finding “${message}”`
      : titles.length > 0
        ? `a finding in ${titles.map((title) => `“${title}”`).join(' and ')}`
        : 'a finding';
  if (status === 'dismissed') return `dismissed ${what} as ${dismissalWordsOf(reason ?? 'unspecified')}`;
  if (status === 'open') return `reopened ${what}`;
  return `marked ${what} ${status}`;
}

/**
 * The store's registry: §9's closed set with the five `inverse` implementations
 * attached. Pass it to `execute()` as its third parameter.
 */
export function createProjectCommandRegistry(
  options: ProjectCommandOptions = {},
): CommandRegistry {
  const clock = options.clock ?? systemCommandClock;
  const sink = options.snapshots ?? synchronousSnapshotSink;
  // The stamps an inverse restores, shared by every inverse this registry mints (see `RestoreTable`).
  const restore = createRestoreTable();

  const binderMove: ProjectApply<BinderMoveParams> = (state, params, context: ApplyContext) => {
    const node = requireNode(state, params.nodeId);
    if (node.parentId === null) {
      throw new Error(
        `node "${node.id}" has no parent, so the position to restore it to cannot be read`,
      );
    }
    // Both titles are read before the move, because §8's row is about what the
    // command did and a title is only a title of the tree as it was.
    const title = node.title;
    const parentTitle = nodeTitle(state, params.newParentId);
    // Captured before the move, and as a *position* rather than an order:
    // §2's gap-encoding means no arithmetic on `order` survives a move.
    const from = { parentId: node.parentId, index: siblingIndex(state, node.parentId, node.id) };
    moveNode(state, params.nodeId, {
      parentId: params.newParentId,
      order: siblingOrderAt(state, params.newParentId, params.index, params.nodeId),
    });
    context.undo.inverse(
      inverseCommand(
        'binder.move',
        { nodeId: params.nodeId, newParentId: from.parentId, index: from.index },
        clock,
      ),
    );
    // §8. Reported last, after the capture: see `applyContext`.
    context.report({
      affected: [{ nodeId: params.nodeId, title }],
      summary: agentWriteSummary(context, `the agent’s move of “${title}”`, `moved "${title}" to position ${params.index} under "${parentTitle}"`),
    });
    return {
      nodeId: params.nodeId,
      from: { parentId: from.parentId, index: from.index },
      to: { parentId: params.newParentId, index: params.index },
    };
  };

  const binderRename: ProjectApply<BinderRenameParams> = (state, params, context: ApplyContext) => {
    const node = requireNode(state, params.nodeId);
    const previousTitle = node.title;
    const previousStamp = node.updatedAt;
    node.title = params.title;
    stampFor(node, context.commandId, clock, restore, true);
    context.undo.inverse(
      inverseWith('binder.rename', { nodeId: params.nodeId, title: previousTitle }, clock, restore, {
        updatedAt: previousStamp,
      }),
    );
    // §8's *"human titles, not bare ids"*, and the **new** one: the row records
    // what this command did, so a row naming the title the node used to have
    // describes a different command.
    context.report({
      affected: [{ nodeId: params.nodeId, title: params.title }],
      summary: agentWriteSummary(context, `the agent’s rename of “${previousTitle}” to “${params.title}”`, `renamed "${previousTitle}" to "${params.title}"`),
    });
    return { nodeId: params.nodeId, title: params.title, previousTitle };
  };

  const binderSetSynopsis: ProjectApply<BinderSetSynopsisParams> = (
    state,
    params,
    context: ApplyContext,
  ) => {
    const node = requireNode(state, params.nodeId);
    const previousSynopsis = node.synopsis;
    const previousStamp = node.updatedAt;
    node.synopsis = params.synopsis;
    stampFor(node, context.commandId, clock, restore, true);
    context.undo.inverse(
      inverseWith(
        'binder.setSynopsis',
        { nodeId: params.nodeId, synopsis: previousSynopsis },
        clock,
        restore,
        { updatedAt: previousStamp },
      ),
    );
    context.report({
      affected: [{ nodeId: params.nodeId, title: node.title }],
      summary: agentWriteSummary(context, `the agent’s synopsis for “${node.title}”`, `set the synopsis of "${node.title}"`),
    });
    return { nodeId: params.nodeId, synopsis: params.synopsis, previousSynopsis };
  };

  const binderSetMeta: ProjectApply<BinderSetMetaParams> = (state, params, context: ApplyContext) => {
    const node = requireNode(state, params.nodeId);
    const previousStamp = node.updatedAt;
    const previousStatus = node.status;
    const previousLabel = node.label;
    const previousKeywords = node.keywords;
    const patch = params.patch;
    const inverse: MetaPatch = {};

    // `undefined` is "leave it alone" and only a present field is written, so an
    // inverse patch carries exactly the fields this dispatch **wrote** — each
    // with the value it held before. A field the dispatch named but did not
    // change carries nothing: there is nothing to put back.
    //
    // **A previous value of `null` is how "no status" is restored.** `null` is
    // MetaPatch's "clear it" and `undefined` is "leave it alone", so an inverse
    // carrying `undefined` normalizes to an empty patch — and an empty patch is
    // what the bus refuses as a changes-nothing request, which would report a
    // successful undo while leaving the stamp this dispatch wrote unrestored. A
    // node that held no status at all (a hand-edited or legacy manifest, which
    // the loader tolerates and never defaults) therefore inverts to `null`,
    // which is the same "no status" the manifest's field type states.
    //
    // **The prior is compared in that same normalized form**, because absent and
    // `null` are the same value: a node that holds no status holds `null`,
    // whatever the manifest row says. Comparing against the raw prior instead
    // would count `undefined → null` as a write — the forward would stamp and
    // mint a `{ status: null }` inverse, and the undo of that inverse would find
    // `previousStatus` already `null`, write nothing, and leave the forward's
    // stamp unrestored while reporting success. The same holds for the label.
    const wroteStatus = patch.status !== undefined && patch.status !== (previousStatus ?? null);
    const wroteLabel = patch.label !== undefined && patch.label !== (previousLabel ?? null);
    const status = patch.status;
    const label = patch.label;
    // A field that did not change is not written: the node keeps the value it
    // holds, and the digest below can honestly say the dispatch left it alone.
    if (status !== undefined && wroteStatus) {
      inverse.status = previousStatus ?? null;
      node.status = status;
    }
    if (label !== undefined && wroteLabel) {
      inverse.label = previousLabel ?? null;
      node.label = label;
    }

    // `resultingKeywords` in `descriptors.ts` is the shipped definition of what
    // this patch produces — it computes the post-patch list to check the keyword
    // limit — and it removes first, case-insensitively, then adds what is still
    // missing. The apply has to agree with it exactly, because §2's invariant is
    // that a command which passed validation cannot fail mid-apply, and the only
    // reason that can hold for keywords is that the two implementations are the
    // same rule. The inverse is built from what the produced list actually
    // changed, so adding a keyword that was already present inverts to a remove
    // that skips it rather than to a remove that would delete it.
    const removed = new Set((patch.keywords_remove ?? []).map((k) => k.toLowerCase()));
    const kept = node.keywords.filter((k) => !removed.has(k.toLowerCase()));
    const dropped = node.keywords.filter((k) => removed.has(k.toLowerCase()));
    const seen = new Set(kept.map((k) => k.toLowerCase()));
    const added: string[] = [];
    for (const keyword of patch.keywords_add ?? []) {
      const key = keyword.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        kept.push(keyword);
        added.push(keyword);
      }
    }
    if (patch.keywords_add !== undefined || patch.keywords_remove !== undefined) {
      node.keywords = kept;
    }

    // **The list this dispatch produced, not the two halves of the patch.** A
    // remove and an add of the same keyword leave the list byte-identical, so
    // counting both halves would stamp a node and report a change that did not
    // happen — and would mint an inverse for a difference that is not there.
    const keywordsChanged =
      node.keywords.length !== previousKeywords.length ||
      node.keywords.some((keyword, index) => keyword !== previousKeywords[index]);
    if (keywordsChanged) {
      if (dropped.length > 0) inverse.keywords_add = dropped;
      if (added.length > 0) inverse.keywords_remove = added;
    }

    // The fields this dispatch **wrote**, as opposed to the keys it was handed:
    // a status equal to the one the node holds, a label equal to the current
    // one and a keyword re-added in another spelling each write no value
    // (agent-harness §3 keeps meta.set idempotent by design, and the bus's
    // validate accepts such a patch). project-format §2 bumps `updatedAt` for
    // content-touching mutations, and a dispatch that wrote no value touched no
    // content — so it stamps nothing, and it mints no restore-table entry:
    // there is nothing for the inverse to recall. The inverse it registers is
    // field-less — nothing was written, so nothing is to be put back — and the
    // bus refuses to dispatch it as a changes-nothing request, and its undo
    // reports that as the honest no-op it now is.
    //
    // **The stamp is restored even when the replay changed nothing.** The
    // restore table is what says which dispatch is an inverse of a forward that
    // stamped: an entry under this dispatch's id exists only for one. The undo
    // of a keyword reorder is such an inverse whose replay produces the list it
    // found — the inverse cannot put the order back, which is the append-only
    // design's own limit — and it still has to put the stamp back, or the
    // forward's stamp survives the undo while the undo reports success.
    const wroteSomething = wroteStatus || wroteLabel || keywordsChanged;
    stampFor(node, context.commandId, clock, restore, wroteSomething);
    if (wroteSomething) {
      context.undo.inverse(
        inverseWith('binder.setMeta', { nodeId: params.nodeId, patch: inverse }, clock, restore, {
          updatedAt: previousStamp,
        }),
      );
    } else {
      context.undo.inverse(inverseCommand('binder.setMeta', { nodeId: params.nodeId, patch: inverse }, clock));
    }

    // §8's digest, built from the fields this dispatch **wrote** rather than the
    // keys it was handed — the two differ, and the difference is the interesting
    // case: `keywords_add: ['sea']` on a node that already carries `'sea'` writes
    // nothing, and a digest that said "set 1 keyword added" would be a claim
    // about a change that did not happen. The empty branch is therefore reachable
    // on a valid command, not only a defective one.
    const written: string[] = [];
    if (wroteStatus) written.push('status');
    if (wroteLabel) written.push('label');
    if (keywordsChanged) {
      if (added.length > 0) written.push(countOf(added.length, 'keyword') + ' added');
      if (dropped.length > 0) written.push(countOf(dropped.length, 'keyword') + ' removed');
    }
    context.report({
      affected: [{ nodeId: params.nodeId, title: node.title }],
      summary: agentWriteSummary(
        context,
        `the agent’s ${agentMetaFields(patch.status !== undefined, patch.label !== undefined, keywordsChanged)} for “${node.title}”`,
        // The empty branch names no field: a patch can change nothing in any of
        // them, and "the keywords" would be a claim about a field the patch
        // never mentioned.
        written.length > 0 ? `set ${written.join(', ')} on "${node.title}"` : `left "${node.title}" unchanged`,
      ),
    });

    return { nodeId: params.nodeId, patch, inversePatch: inverse };
  };

  const codexAttach: ProjectApply<CodexAttachParams> = (state, params, context: ApplyContext) => {
    const entry = requireCodexEntry(state, params.entryId);
    // `applyAttachmentDelta` (below) is the shared implementation, and it returns
    // the delta because an inverse must undo only what this dispatch did: an id
    // that was already attached is not attached by this command, so the inverse
    // must not detach it.
    const { attached, detached } = applyAttachmentDelta(entry, params.attachTo, params.detachFrom);

    context.undo.inverse(
      inverseCommand(
        'codex.attach',
        { entryId: params.entryId, attachTo: detached, detachFrom: attached },
        clock,
      ),
    );

    // §8's `affected` is the **nodes whose codex panel changed**, which is the
    // delta and not the request: an id the dispatch found already attached is not
    // affected by it, and listing it would tell a subscriber to re-render for
    // nothing. The same `attached`/`detached` the inverse is built from, so the
    // log and the undo cannot disagree about what moved.
    const parts: string[] = [];
    if (attached.length > 0) parts.push(`attached "${entry.name}" to ${countOf(attached.length, 'node')}`);
    if (detached.length > 0) parts.push(`detached it from ${countOf(detached.length, 'node')}`);
    context.report({
      affected: affectedOf(state, attached),
      summary: agentWriteSummary(
        context,
        `the agent’s codex links for “${entry.name}”`,
        parts.length > 0 ? parts.join(' and ') : `left "${entry.name}" attached exactly as it was`,
      ),
    });

    return {
      entryId: params.entryId,
      attached,
      detached,
      attachments: [...entry.attachments],
    };
  };

  /**
   * `project.deleteNode` — the one command that removes a node, and the reason
   * `binder.create` had to wait for it.
   *
   * **`compensable`, not `inverse`, and §5's own table forces that.** The exact
   * inverse of a delete would be a create carrying the *removed subtree*, and §9's
   * closed set has no such command — so there is nothing to dispatch, and the
   * artifact is the removed set itself, captured whole (§5: "the command captured a
   * restore artifact at apply time"). The capture is the artifact, which is why the
   * node objects are pushed back rather than re-derived.
   *
   * **The attachment repair rides in the same artifact.** `read.ts` already drops
   * dangling attachment ids at load, and states why: an id that does not resolve now
   * will not resolve later, so keeping it "would only make the next manifest carry a
   * lie forward". This command knows the id is gone, so it repairs at the point of
   * knowledge rather than leaving the manifest to be repaired by the next open —
   * and the prior list travels in the artifact, so the undo restores the attachment
   * instead of losing it. An undo that removed a codex entry's attachment without
   * being able to put it back would be a *second* irreversible effect inside a
   * reversible command.
   */
  const projectDeleteNode: ProjectApply<ProjectDeleteNodeParams> = (state, params, context) => {
    const title = nodeTitle(state, params.nodeId);
    // `removeNode` drops the removed ids' counts along with their records, so the
    // restore artifact has to hold them — captured **before** the call, because
    // afterwards they are gone. Without this the undo would bring a subtree back
    // with bodies and no counts, and §5.1's "snapshotOf(state) === before" would
    // fail on the very command whose job is to be reversible.
    const countsBefore = { ...state.manifest.derived.wordCounts };
    const removed = removeNode(state, params.nodeId);
    const doomed = new Set(removed.map((entry) => entry.node.id));

    const attachments: { readonly entry: CodexEntry; readonly before: readonly string[] }[] = [];
    for (const entry of state.manifest.codex ?? []) {
      // **An optimization, not a guard** — measured, not assumed: removing this
      // `continue` fails zero tests, because filtering a list that names no removed
      // id returns the same list. It is here to avoid copying an unrelated entry's
      // attachments into the restore artifact, and it is recorded here so that no
      // future reader tries to hold a guarantee with it.
      if (!entry.attachments.some((id) => doomed.has(id))) continue;
      attachments.push({ entry, before: [...entry.attachments] });
      entry.attachments = entry.attachments.filter((id) => !doomed.has(id));
    }

    context.undo.compensate(
      `restore "${title}"${removed.length > 1 ? ` and the ${removed.length - 1} nodes under it` : ''}`,
      () => {
        // Ascending original index, so the removed set's *relative* order comes
        // back. Appended rather than spliced at a captured index: nothing reads a
        // node's position in the serialized array (the binder's order is
        // `parentId` + `order`), and a later command in the same group may have
        // added nodes, which would make a captured index point at the wrong slot.
        //
        // **The `.sort()` is a no-op, and the order comes from somewhere else.**
        // Measured: removing it fails zero tests, because `removeNode` builds
        // `removed` by walking the tree in index order and pushing `{node, index}`,
        // so the list is ascending by construction and sorting an ascending list by
        // an ascending key is the identity. The guarantee is real; the line that
        // appears to hold it cannot fail — which is the same shape as the
        // `some(doomed)` optimization below, and it is recorded here for the same
        // reason. **The actual guarantee is `removeNode`'s construction order, three
        // files away**, and that is the thing a future edit to `removeNode` would
        // break. If that order ever stops being guaranteed, the sort stops being
        // decorative and becomes load-bearing; until then it is belt to braces
        // whose braces are elsewhere.
        for (const entry of [...removed].sort((a, b) => a.index - b.index)) {
          state.manifest.tree.push(entry.node);
          if (entry.record !== undefined) state.documents.set(entry.node.id, { ...entry.record });
          // The count `removeNode` dropped, back. Keyed off the captured map
          // rather than recomputed from the restored body, so the undo restores
          // the value that was there rather than today's reading of it — the
          // same distinction the body restore above makes.
          const count = countsBefore[entry.node.id];
          if (count !== undefined) state.manifest.derived.wordCounts[entry.node.id] = count;
        }
        for (const { entry, before } of attachments) entry.attachments = [...before];
      },
    );

    // §8's `affected`, built from the captured node objects rather than by looking
    // the ids up: they are gone from the tree by now, and a title resolved after
    // the delete would be the id itself — §8's one thing it says not to do. The
    // whole removed set is listed, not just the node the command named, because a
    // subtree delete changes every node under it and every one of them is a node
    // a subscriber has to re-read.
    context.report({
      affected: removed.map((entry) => ({ nodeId: entry.node.id, title: entry.node.title })),
      summary: agentWriteSummary(
        context,
        `the agent’s deletion of “${title}”${removed.length > 1 ? ` and the ${removed.length - 1} nodes under it` : ''}`,
        `deleted "${title}"${removed.length > 1 ? ` and the ${removed.length - 1} nodes under it` : ''}`,
      ),
    });

    return {
      nodeId: params.nodeId,
      title,
      removedNodeIds: removed.map((entry) => entry.node.id),
      removedCount: removed.length,
      detachedCodexEntryIds: attachments.map(({ entry }) => entry.id),
    };
  };

  /**
   * `binder.create` — the other half, and the reason it was cut out.
   *
   * The inverse is `project.deleteNode` naming the node *this dispatch* created, and
   * that is what makes the pair exact: `addDocument` also creates the body record
   * and `addFolder` does not, and the delete removes whichever of the two it finds.
   * `issuedBy: 'user'` on the inverse is the rule every inverse in this file already
   * follows (see the header) — `project.deleteNode` is `agentRisk: 'never'`, so an
   * inverse carrying the original `issuedBy: 'agent'` would be refusable by any
   * flow, and §5's undo is a click, which is its own confirmation.
   *
   * The created node's children are the one thing this inverse does not cover, and
   * it does not need to: a child added by another command in the same group carries
   * its own entry, and §5 executes a group's entries in reverse order, so the child
   * goes before its parent.
   */
  const binderCreate: ProjectApply<BinderCreateParams> = (state, params, context) => {
    const now = new Date(clock.now());
    // The media types (a shot, a dialogue container, a kind on either) are made in commands-media.ts (storyboard.md
    // §2.1, dialogue-narrative.md §2.1); a prose folder or document is the same node it always was.
    const created = createBinderNode(state, params, now);
    context.undo.inverse(
      inverseCommand('project.deleteNode', { nodeId: created.id }, clock),
    );
    // §8: the node this dispatch created, with the title it was created under.
    // The parent is named from `params` rather than from `created.parentId`,
    // which is typed `string | null` for a root and cannot be here.
    context.report({
      affected: [{ nodeId: created.id, title: created.title }],
      summary: agentWriteSummary(
        context,
        `the agent’s new ${created.type} “${created.title}”`,
        `created the ${created.type} "${created.title}" under "${nodeTitle(state, params.parentId)}"`,
      ),
    });
    return {
      nodeId: created.id,
      parentId: created.parentId,
      type: created.type,
      title: created.title,
      order: created.order,
    };
  };

  /**
   * codex.md §2's `type` enum has no default, but `CodexEntry.type` is a **required**
   * field, and `validateCodexOp` requires nothing of a `create` — not a name, not a
   * type (§2's own invariant is that a validated command cannot fail mid-apply, so
   * this apply has to be total for a nameless, typeless op). `'other'` is the one
   * member of that closed enum that means "none of the above", so an unspecified
   * type is written as unclassified rather than guessed at.
   *
   * The gap is left for its own change rather than fixed here: a change that
   * widens a validator it is not building is how a change stops being reviewable.
   */
  const CODEX_DEFAULT_TYPE = 'other';

  /** A codex entry copied whole, arrays included — §5's "prior-state copy". */
  function copyCodexEntry(entry: CodexEntry): CodexEntry {
    return {
      ...entry,
      aliases: [...entry.aliases],
      exclude: [...entry.exclude],
      attachments: [...entry.attachments],
      keywords: [...entry.keywords],
      sources: entry.sources.map((source) => ({ ...source })),
      ...(entry.visualRefs === undefined ? {} : { visualRefs: [...entry.visualRefs] }),
    };
  }

  /**
   * `attachTo` / `detachFrom` as the rest of the file computes them: against what
   * was attached, not against what was asked for, and deduplicated because §2 types
   * `attachments` as a set of node ids.
   *
   * **One implementation, two callers, on purpose.** `codex.attach` and
   * `codex.upsert` describe the same delta in different shapes, and two
   * implementations of one rule is how a format drifts — a batch op and a
   * single-entry op that disagree about whether an id that is already attached
   * counts as attached is a bug that only appears in whichever pair the test suite
   * forgot to cross. The delta is returned because `codex.attach` needs it to build
   * its inverse: an id this dispatch did not attach must not appear in the detach
   * that undoes it, or the undo destroys a pre-existing attachment.
   */
  function applyAttachmentDelta(
    entry: CodexEntry,
    attachTo: readonly string[],
    detachFrom: readonly string[],
  ): { readonly attached: string[]; readonly detached: string[] } {
    const before = new Set(entry.attachments);
    const attached: string[] = [];
    for (const id of attachTo) {
      if (!before.has(id) && !attached.includes(id)) attached.push(id);
    }
    const detached: string[] = [];
    for (const id of detachFrom) {
      if (before.has(id) && !detached.includes(id)) detached.push(id);
    }
    const keep = new Set(detached);
    entry.attachments = [...entry.attachments.filter((id) => !keep.has(id)), ...attached];
    return { attached, detached };
  }

  /**
   * `codex.upsert` — the batch.
   *
   * **One undo group for the batch, with each entry compensated inside it** (codex.md
   * §7, verbatim). That is one `compensate()` call, not one per entry: `undo.ts`'s
   * `UndoScope` holds a **single** payload, so a second `compensate()` would
   * overwrite the first and a five-entry batch would register a group that restores
   * only its last entry — a `write-confirm` command that reports a reversible
   * effect and is not one. The per-entry artifacts are therefore collected here and
   * replayed in reverse inside the one restore, which is also what makes a batch
   * with two updates to the same entry come back to where it started.
   *
   * **An update writes only the fields it carries.** `undefined` means "leave it
   * alone", the same rule as `binder.setMeta`'s patch, and the reason the prior-state
   * copy is a whole entry rather than a diff: the artifact then restores exactly
   * without having to record which fields this dispatch happened to touch.
   *
   * **`origin` follows the envelope and is never flipped.** codex.md requires an
   * agent-created entry to carry `origin: 'agent'` and a manual one `origin:
   * 'manual'`, and codex.md §2 types `origin` as required while `CodexUpsertOp` has
   * no such field — so the flow that issued the command is the only fact that can
   * decide it, and it is on the envelope. There is one flow that `issuedBy` cannot
   * name: an import (`provenance: 'import'`, codex.md §2), which stamps `'import'`
   * and so outranks nothing it should not. On an update it is left alone, because codex.md
   * is explicit that an agent updating a hand-authored entry "never flips its
   * origin". `sources` stays empty: the op carries no citations, and the extraction's
   * docIds and quoted spans are the harness's data, not a mutation command's.
   */
  const codexUpsert: ProjectApply<CodexUpsertParams> = (state, params, context) => {
    const codex = state.manifest.codex ?? (state.manifest.codex = []);
    const taken = new Set(codex.map((entry) => entry.id));
    const stamp = new Date(clock.now()).toISOString();
    const created: CodexEntry[] = [];
    const updated: { readonly entry: CodexEntry; readonly before: CodexEntry }[] = [];

    for (const op of params.entries) {
      if (op.action === 'create') {
        const entry: CodexEntry = {
          id: newId('c', { taken }),
          name: op.name ?? '',
          aliases: [...(op.aliases ?? [])],
          type: op.type ?? CODEX_DEFAULT_TYPE,
          description: op.description ?? '',
          // codex.md §2 states these two defaults by name.
          includePolicy: (op.includePolicy as CodexIncludePolicy) ?? 'detected',
          caseSensitive: op.caseSensitive ?? false,
          exclude: [...(op.exclude ?? [])],
          attachments: [],
          keywords: [...(op.keywords ?? [])],
          // The envelope's provenance decides first. codex.import (codex.md §2) sets 'import' on
          // the command it builds, and an op cannot name its own origin (the closed key set refuses it).
          origin: context.provenance === 'import' ? 'import' : context.issuedBy === 'agent' ? 'agent' : 'manual',
          // The citations the op carries, copied: the extraction's record, not a
          // reference into the caller's params.
          sources: (op.sources ?? []).map((source) => ({ ...source })),
          // video-prompt-pack.md §3: the visual references, repeats dropped. An empty list is left off the entry, as the manifest omits it.
          ...(op.visualRefs === undefined || op.visualRefs.length === 0 ? {} : { visualRefs: [...new Set(op.visualRefs)] }),
          createdAt: stamp,
          updatedAt: stamp,
        };
        taken.add(entry.id);
        // `detachFrom` on a create is inert rather than an error: a list of ids
        // nothing is attached to, on an entry that was not attached to anything.
        applyAttachmentDelta(entry, op.attachTo ?? [], op.detachFrom ?? []);
        codex.push(entry);
        created.push(entry);
        continue;
      }

      // `validateCodexOp` refuses an update with no `id`, and with an id that
      // resolves to nothing, so this is `requireDocument`'s case above: reaching the
      // throw means a command reached its apply that did not pass validation, and a
      // defect like that has to be loud rather than half-applied.
      if (typeof op.id !== 'string') {
        throw new Error('an update op reached codex.upsert with no entry id');
      }
      const entry = requireCodexEntry(state, op.id);
      const before = copyCodexEntry(entry);
      if (op.name !== undefined) entry.name = op.name;
      if (op.aliases !== undefined) entry.aliases = [...op.aliases];
      if (op.type !== undefined) entry.type = op.type;
      if (op.description !== undefined) entry.description = op.description;
      if (op.includePolicy !== undefined) entry.includePolicy = op.includePolicy as CodexIncludePolicy;
      if (op.caseSensitive !== undefined) entry.caseSensitive = op.caseSensitive;
      if (op.exclude !== undefined) entry.exclude = [...op.exclude];
      if (op.keywords !== undefined) entry.keywords = [...op.keywords];
      if (op.visualRefs !== undefined) entry.visualRefs = [...new Set(op.visualRefs)];
      if (op.attachTo !== undefined || op.detachFrom !== undefined) {
        applyAttachmentDelta(entry, op.attachTo ?? [], op.detachFrom ?? []);
      }
      // An update's citations are appended to the entry's, never replace them (codex.md:
      // an agent updating a hand-authored entry adds a source and keeps the entry's
      // own). `origin` is untouched: an update never flips it.
      if (op.sources !== undefined) {
        entry.sources = [...entry.sources, ...op.sources.map((source) => ({ ...source }))];
      }
      entry.updatedAt = stamp;
      updated.push({ entry, before });
    }

    context.undo.compensate(
      `undo the ${created.length} created and ${updated.length} updated codex entries`,
      () => {
        // Reverse order, so two updates to one entry unwind the way they were made.
        for (const { entry, before } of [...updated].reverse()) {
          Object.assign(entry, copyCodexEntry(before));
          // **`Object.assign` cannot remove a key the copy never had.** The update
          // above stamps `updatedAt` unconditionally, so an entry that carried no
          // stamp comes back from its own undo holding one — a timestamp for a write
          // the user just reversed, on a field nothing else in the compensation
          // touches. `updatedAt` is app-owned and optional (codex.md §2), so *absent*
          // is a legal value and has to be restored as absence rather than left as
          // whatever the undone write put there. Found's exit gate, whose
          // undo-replay family compares **bytes** rather than content: every field a
          // reader looks at was already correct, so a content comparison passes here
          // and only the byte comparison fails.
          if (!('updatedAt' in before)) delete entry.updatedAt;
          // The same rule for `visualRefs`: an update that adds the list leaves a key a copy that never had one cannot remove.
          if (!('visualRefs' in before)) delete entry.visualRefs;
        }
        for (const entry of [...created].reverse()) {
          const at = codex.findIndex((candidate) => candidate.id === entry.id);
          if (at >= 0) codex.splice(at, 1);
        }
      },
    );

    // §8's `affected` for a batch is the **nodes whose codex panel changed**, and
    // the batch is where that is least obvious: a `create` with no `attachTo`
    // changes no node at all, and only the `attachTo` of an op that attached
    // something counts. Collected from the ops rather than from `entry.attachments`
    // because the latter is the whole set — what the project looks like now, not
    // what this dispatch did to it. That distinction is the same one drawn for
    // the inverse, and for the same reason.
    const attachedNodes: string[] = [];
    for (const op of params.entries) {
      for (const id of op.attachTo ?? []) {
        if (!attachedNodes.includes(id)) attachedNodes.push(id);
      }
    }

    context.report({
      affected: affectedOf(state, attachedNodes),
      summary: agentWriteSummary(
        context,
        `the agent’s codex change: ${created.length} created, ${updated.length} updated${attachedNodes.length > 0 ? `, ${countOf(attachedNodes.length, 'node')} attached` : ''}`,
        `created ${created.length} and updated ${updated.length} codex ${created.length + updated.length === 1 ? 'entry' : 'entries'}${attachedNodes.length > 0 ? `, attached to ${countOf(attachedNodes.length, 'node')}` : ''}`,
      ),
    });

    return {
      created: created.map((entry) => entry.id),
      updated: updated.map(({ entry }) => entry.id),
      count: created.length + updated.length,
    };
  };

  // -------------------------------------------------------------------------
  // §5's `compensable` family — capture a restore artifact, do not reconstruct.
  // -------------------------------------------------------------------------

  /**
   * What a body write must be undoable *back to*, in full.
   *
   * `computedAt` is the field that makes this capture necessary — see the note
   * at `captureBody`. `had` is the part that is easy to leave out and cannot be
   * derived: a document the write gave its *first* count has nothing to restore
   * *to*, and an undo that assigned `captured.count` (0, because there was no
   * count) would leave the map carrying an entry for a state the project was
   * never in. So absence is captured as absence.
   */
  interface BodyCapture {
    readonly before: string;
    readonly revision: number;
    /** The document's count before this write; meaningful only when `had`. */
    readonly count: number;
    /** Whether the document had an entry at all. */
    readonly had: boolean;
    /** §2's `computedAt` before this write — restored verbatim. */
    readonly computedAt: string;
    /** The document's node `updatedAt` before this write, restored verbatim (absent stays absent). */
    readonly updatedAt: string | undefined;
  }

  /**
   * The body snapshot every `compensable` text write captures.
   *
   * **Captured before the write, never after.** §5 is explicit that the artifact
   * is the body *"before any text mutation"*, and the two orders differ in exactly
   * the case that matters: capture-after restores the *new* body, which is a
   * restore that changes nothing and is indistinguishable from a working undo.
   * That is the failure a `compensable` command cannot have — the registration
   * refusal exists so a command does not report a guarantee it cannot honour, and
   * a snapshot taken one line too late honours the letter of it and none of the
   * substance.
   *
   * **The revision is recorded, never restored.** The snapshot carries the revision
   * the body had, and it is part of the snapshot's key, so the same body cannot be
   * captured twice at the same revision: §5.1 rule 4 as a constraint rather than a
   * check. The undo does not move the counter back to it. `setBody` bumps the
   * counter on the restore as well, so the counter only rises (project-format §4),
   * and §6's comparison cannot match a number a document had before newer text.
   *
   * **The sink call cannot fail this dispatch.** It is fire-and-forget by
   * necessity (A2), and propagating a sink failure would abandon a write that has
   * already landed. A throw or a rejection is caught: the in-memory artifact is
   * what §5 requires, and losing the durable row is a retention loss the ladder
   * can rebuild, not an unrecoverable write.
   */
  function captureBody(
    state: ProjectState,
    params: { docId: string },
    command: CommandName,
  ): BodyCapture {
    const { body: before, revision } = requireDocument(state, params.docId);
    try {
      const result = sink({
        projectId: state.manifest.project.id,
        docId: params.docId,
        body: before,
        revision,
        capturedAt: clock.now(),
        command,
      });
      if (isPromise(result)) void result.catch(() => {});
    } catch {
      // See above: a sink failure must not undo a write that already happened.
    }
    // The `derived` entry the write is about to move. Captured because
    // `computedAt` — unlike the count — is NOT recomputed by the restore: it is
    // a field with no derivation, and `setBody` sets it to *now*. So a restore
    // that re-asserted only the body would leave the manifest claiming a
    // recompute that happened at the undo's instant, which is the `updatedAt`
    // defect in a new place. Measured: removing this restore is caught by
    // `exit-gate.test.ts`'s "snapshotOf(state) === before", whose sole differing
    // field was `computedAt`.
    //
    // **The count itself is not what this capture is for.** Measured, by
    // mutation: deleting the `wordCounts` restore below fails **zero** tests,
    // because the restore's own `setBody(state, docId, captured.before)` already
    // recomputes the count from the restored body. It is kept, with `had`,
    // because it is the one branch that has no other explanation: a document
    // that had *no* entry before the write would otherwise come back from the
    // undo carrying one, and `had` is what lets absence be restored as absence.
    const derived = state.manifest.derived;
    const had = Object.hasOwn(derived.wordCounts, params.docId);
    return {
      before,
      revision,
      count: derived.wordCounts[params.docId] ?? 0,
      had,
      computedAt: derived.computedAt,
      updatedAt: nodeById(state, params.docId)?.updatedAt,
    };
  }

  function compensateBody(
    state: ProjectState,
    docId: string,
    captured: BodyCapture,
    context: ApplyContext,
  ): void {
    context.undo.compensate(`restore the body of "${nodeTitle(state, docId)}"`, () => {
      // The restore is a write like any other, so `setBody` bumps the revision
      // and it stays bumped. The captured revision is NOT re-asserted: an undo
      // that moved the counter back would let a plan made against the text the
      // undo removed match a number the document reaches again over newer text
      // (project-format §4: every mutation bumps the counter, and §6 compares it).
      setBody(state, docId, captured.before);
      const derived = state.manifest.derived;
      if (captured.had) derived.wordCounts[docId] = captured.count;
      else delete derived.wordCounts[docId];
      derived.computedAt = captured.computedAt;
      // The node's stamp is the body write's own change to the node, so the undo puts back the one it replaced.
      const node = nodeById(state, docId);
      if (node !== undefined) node.updatedAt = captured.updatedAt;
    });
  }

  /** §8's `affected` rule — a human title, never a bare id. */
  function nodeTitle(state: ProjectState, id: string): string {
    return nodeById(state, id)?.title ?? id;
  }

  /**
   * §8's `affected` list for one dispatch, resolved against the tree **as it is
   * at the point of knowledge** — after a rename, before a delete.
   *
   * Ids that do not resolve fall back to the bare id, which is §8's one thing it
   * says not to do. That is deliberate and it is loud: a `validate` that admits
   * an id no node carries is a defect in the validator, and a fallback makes the
   * log show the raw id where a title belongs instead of dropping the entry.
   * `test/activity-log.test.ts` asserts that no shipped command produces one, so
   * the fallback is a diagnostic rather than a habit.
   */
  function affectedOf(state: ProjectState, ids: readonly string[]): { nodeId: string; title: string }[] {
    return ids.map((id) => ({ nodeId: id, title: nodeTitle(state, id) }));
  }

  /** "1 keyword" / "3 keywords" — §8's digests count the things that changed. */
  function countOf(n: number, noun: string): string {
    return `${n} ${noun}${n === 1 ? '' : 's'}`;
  }

  const notesSet: ProjectApply<NotesSetParams> = (state, params, context) => {
    const node = requireNode(state, params.nodeId);
    const before = node.notes;
    const beforeStamp = node.updatedAt;
    node.notes = params.notes;
    stampContent(node, clock);
    context.undo.compensate(`restore the notes of "${node.title}"`, () => {
      node.notes = before;
      node.updatedAt = beforeStamp;
    });
    // §8: notes are a node field, so the node is what changed. The digest is the
    // command's own, because a replacement and an append write the same field and
    // only the sentence tells them apart in the log.
    context.report({
      affected: [{ nodeId: node.id, title: node.title }],
      summary: agentWriteSummary(context, `the agent’s notes for “${node.title}”`, `set the notes of "${node.title}"`),
    });
    return { nodeId: node.id, notes: params.notes, previousNotes: before };
  };

  /**
   * `notes.append` — the append half of the pair, and the one place §5's
   * "restore artifact" is not a body snapshot.
   *
   * The artifact is the whole prior `notes` string, which is what makes the undo
   * exact rather than approximate: an append has no inverse command (§9 gives
   * `notes.set` a different shape — a *replacement*, not a truncation — and
   * dispatching one would be a command the user's click did not mean), so the
   * captured value is the text. ui-modules §2's "renders as a visual separator,
   * not literal text" is a *rendering* rule over that stored string, so the
   * divider is written literally and the UI is what draws it as a rule.
   *
   * The separator is a blank line before the divider rather than a bare newline,
   * so the divider is its own Markdown block and cannot run into the previous
   * paragraph. `divider: false` is the escape hatch for a caller appending to
   * notes it has already separated.
   */
  const notesAppend: ProjectApply<NotesAppendParams> = (state, params, context) => {
    const node = requireNode(state, params.nodeId);
    const before = node.notes;
    const block =
      params.divider === false ? params.text : `${dividerLine(clock.now())}\n${params.text}`;
    const beforeStamp = node.updatedAt;
    node.notes = before === '' ? block : `${before}\n\n${block}`;
    stampContent(node, clock);
    context.undo.compensate(`restore the notes of "${node.title}"`, () => {
      node.notes = before;
      node.updatedAt = beforeStamp;
    });
    context.report({
      affected: [{ nodeId: node.id, title: node.title }],
      summary: agentWriteSummary(context, `the agent’s added notes for “${node.title}”`, `appended to the notes of "${node.title}"`),
    });
    return { nodeId: node.id, appended: block, notes: node.notes, previousNotes: before };
  };

  const docWrite: ProjectApply<DocWriteParams> = (state, params, context) => {
    // The title is read before the write, for the same reason §8's rule is
    // "human titles": the row is about this document, and a document has one
    // title for the whole dispatch.
    const title = nodeTitle(state, params.docId);
    const captured = captureBody(state, params, 'doc.write');
    setBody(state, params.docId, params.body, { now: new Date(clock.now()) });
    stampBodyOf(state, params.docId, clock);
    compensateBody(state, params.docId, captured, context);
    context.report({
      affected: [{ nodeId: params.docId, title }],
      summary: agentWriteSummary(context, `the agent’s draft of “${title}”`, `wrote the body of "${title}" (revision ${getRevision(state, params.docId)})`),
    });
    return {
      docId: params.docId,
      body: params.body,
      revision: getRevision(state, params.docId),
      previousRevision: captured.revision,
    };
  };

  /**
   * `editor.insert` / `editor.replaceRange` — the two §4 "internal composition"
   * primitives.
   *
   * Both splice the body rather than replacing it, and both compute the splice
   * from the body **the dispatch observed**, not from offsets validated against a
   * body it no longer has. Validate already bounded `offset` and `range` against
   * the loaded body (§2's invariant: a command that passed validation cannot
   * fail mid-apply), so these are not re-checked — a re-check would be a second
   * implementation of the same rule, and the corpus's standing argument is that
   * two implementations of one rule is how a format drifts.
   *
   * `editor.insert` is `agentRisk: 'never'` and inheritable; that is §4's gate,
   * evaluated before the apply and untouched by any of this.
   */
  const editorInsert: ProjectApply<EditorInsertParams> = (state, params, context) => {
    const title = nodeTitle(state, params.docId);
    const captured = captureBody(state, params, 'editor.insert');
    const body = getBody(state, params.docId);
    const next = body.slice(0, params.offset) + params.text + body.slice(params.offset);
    setBody(state, params.docId, next, { now: new Date(clock.now()) });
    stampBodyOf(state, params.docId, clock);
    compensateBody(state, params.docId, captured, context);
    // The character count, because an insert's size is the fact a reader of the
    // log wants and the offset alone does not carry it.
    context.report({
      affected: [{ nodeId: params.docId, title }],
      summary: agentWriteSummary(context, `the agent’s edit to “${title}”`, `inserted ${countOf(params.text.length, 'character')} into "${title}" at offset ${params.offset}`),
    });
    return {
      docId: params.docId,
      offset: params.offset,
      inserted: params.text,
      revision: getRevision(state, params.docId),
    };
  };

  const editorReplaceRange: ProjectApply<EditorReplaceRangeParams> = (state, params, context) => {
    const title = nodeTitle(state, params.docId);
    const captured = captureBody(state, params, 'editor.replaceRange');
    const body = getBody(state, params.docId);
    const next = body.slice(0, params.range.from) + params.text + body.slice(params.range.to);
    setBody(state, params.docId, next, { now: new Date(clock.now()) });
    stampBodyOf(state, params.docId, clock);
    compensateBody(state, params.docId, captured, context);
    // The range is named, not the length: §4's `editor.replaceRange` is the
    // composition step an agent turn drives, and "where" is the part of it a
    // later turn needs to reason about.
    context.report({
      affected: [{ nodeId: params.docId, title }],
      summary: agentWriteSummary(
        context,
        `the agent’s edit to “${title}”`,
        `replaced characters ${params.range.from}-${params.range.to} of "${title}" with ${countOf(params.text.length, 'character')}`,
      ),
    });
    return {
      docId: params.docId,
      range: params.range,
      text: params.text,
      revision: getRevision(state, params.docId),
    };
  };

  // -------------------------------------------------------------------------
  // Export — `export.compile` and `export.compileSelection`. Registered only when an
  // exporter is injected (see `ProjectCommandOptions.exporter`).
  // -------------------------------------------------------------------------

  /**
   * §8's digest for one compile. The counts are the point of the row: an agent
   * reading the log can tell a whole-book compile from a part, and see what was
   * skipped, without opening the artifact.
   */
  function exportSummary(digest: ExportCommandDigest): string {
    const skipped =
      digest.skippedDocs.length === 0
        ? ''
        : `; skipped ${countOf(digest.skippedDocs.length, 'empty document')}`;
    return `compiled ${countOf(digest.chapterCount, 'chapter')} and ${countOf(digest.sceneCount, 'scene')} (${countOf(digest.wordCount, 'word')}) as ${digest.format} to ${digest.output}${skipped}`;
  }

  /**
   * The shared tail of both export applies.
   *
   * **The compensation is the emitted file, and undo removes it** (exporter.md §5:
   * "undo = delete the emitted file(s)"). The compile log is **not** rewound: it is
   * append-only, so an undone compile stays a row in it, which is the accurate record
   * that the compile happened and was then reverted.
   *
   * **`affected` is empty, and that is §8's rule rather than an omission.** A compile
   * changes no node's rendered content, so no subscriber has anything to re-read.
   */
  function finishExport(outcome: ExportCommandOutcome, context: ApplyContext): ExportCommandDigest {
    context.undo.compensate(outcome.restoreLabel, outcome.restore);
    context.report({ affected: [], summary: exportSummary(outcome.digest) });
    return outcome.digest;
  }

  // -------------------------------------------------------------------------
  // The coherence file's two mutations (coherence.md §7.1). The rules are the bus's
  // (coherence.ts), the same ones `validate` ran, so an apply reached through the pipeline
  // is one whose patch or transition was already accepted. Both are `inverse`: the undo is
  // the command that restores the values this one changed, issued as a user gesture.
  // -------------------------------------------------------------------------

  const coherenceSetSceneMeta: ProjectApply<CoherenceSetSceneMetaParams> = (state, params, context) => {
    const file = requireCoherenceFile(state);
    const current = file.sceneMeta[params.docId];
    const before = current === undefined ? undefined : structuredClone(current);
    const result = applySceneMetaPatch(params.docId, current, params.patch, sceneMetaContextOf(state));
    if (!result.ok) {
      // `validate` ran this rule against this record, so a refusal here is a defect in the descriptor.
      throw new Error(`coherence.setSceneMeta reached its apply with a patch validate refused: ${result.error}`);
    }
    if (isEmptySceneMeta(result.meta)) delete file.sceneMeta[params.docId];
    else file.sceneMeta[params.docId] = result.meta;
    context.undo.inverse(
      inverseCommand(
        'coherence.setSceneMeta',
        { docId: params.docId, patch: inverseScenePatch(before, params.patch, result.meta) },
        clock,
      ),
    );
    const title = nodeTitle(state, params.docId);
    const changed = Object.keys(params.patch);
    context.report({
      affected: [{ nodeId: params.docId, title }],
      summary:
        changed.length === 0
          ? `changed nothing in the scene declarations of "${title}"`
          : `set ${declarationChangeWords(changed)} on the scene declarations of "${title}"`,
    });
    return { docId: params.docId, meta: result.meta };
  };

  const coherenceSetFindingStatus: ProjectApply<CoherenceSetFindingStatusParams> = (state, params, context) => {
    const file = requireCoherenceFile(state);
    const finding = file.findings.find((candidate) => candidate.id === params.findingId);
    if (finding === undefined) {
      throw new Error(`coherence.setFindingStatus reached its apply with finding "${params.findingId}", which validate refused`);
    }
    const before = { status: finding.status, dismissedReason: finding.dismissedReason, note: finding.note };
    const stamp = new Date(clock.now()).toISOString();
    const note = trimCoherenceNote(params.note);

    finding.status = params.status;
    if (params.status === 'dismissed' && params.reason !== undefined) finding.dismissedReason = params.reason;
    else delete finding.dismissedReason;
    // The lifecycle's own rule (coherence/lifecycle.ts): a fix keeps the note it had unless one is
    // given; a dismissal or a re-open takes the note it is given, and clears it when none is.
    if (note !== undefined) finding.note = note;
    else if (params.status !== 'fixed') delete finding.note;
    finding.updatedAt = stamp;
    finding.touchedAt = stamp;

    // The inverse restores the status, the reason and the note this change replaced. Its
    // `updatedAt` is the undo's own reading: the restored timestamp is display metadata, and
    // a status command has no field that could carry the prior one (see the coherence notes).
    const inverse: CoherenceSetFindingStatusParams = {
      findingId: params.findingId,
      status: before.status as CoherenceStatusName,
      ...(before.status === 'dismissed' && before.dismissedReason !== undefined ? { reason: before.dismissedReason } : {}),
      ...(before.note !== undefined ? { note: before.note } : {}),
    };
    context.undo.inverse(inverseCommand('coherence.setFindingStatus', inverse, clock));

    const docIds = [...new Set((finding.evidence ?? []).map((passage) => passage.docId))].filter((id) => nodeById(state, id) !== undefined);
    const titles = docIds.map((docId) => nodeTitle(state, docId));
    context.report({
      affected: docIds.map((docId) => ({ nodeId: docId, title: nodeTitle(state, docId) })),
      summary: agentWriteSummary(
        context,
        agentFindingWords(params.status, titles),
        findingChangeWords(finding, params.status, params.reason, titles),
      ),
    });
    return { findingId: params.findingId, status: params.status, previousStatus: before.status };
  };

  const registry: CommandRegistry = {
    ...buildRegistry(),
    'coherence.setSceneMeta': { descriptor: commands.coherenceSetSceneMeta, apply: narrow(coherenceSetSceneMeta) },
    'coherence.setFindingStatus': { descriptor: commands.coherenceSetFindingStatus, apply: narrow(coherenceSetFindingStatus) },
    'coherence.discardRun': { descriptor: coherenceDiscardRunDescriptor, apply: narrow(applyCoherenceDiscardRun) },
    'binder.move': { descriptor: commands.binderMove, apply: narrow(binderMove) },
    'binder.rename': { descriptor: commands.binderRename, apply: narrow(binderRename) },
    'binder.setMeta': { descriptor: commands.binderSetMeta, apply: narrow(binderSetMeta) },
    'binder.setSynopsis': {
      descriptor: commands.binderSetSynopsis,
      apply: narrow(binderSetSynopsis),
    },
    'codex.attach': { descriptor: commands.codexAttach, apply: narrow(codexAttach) },
    'binder.create': { descriptor: commands.binderCreate, apply: narrow(binderCreate) },
    'codex.upsert': { descriptor: commands.codexUpsert, apply: narrow(codexUpsert) },
    'project.deleteNode': {
      descriptor: commands.projectDeleteNode,
      apply: narrow(projectDeleteNode),
    },
    'notes.set': { descriptor: commands.notesSet, apply: narrow(notesSet) },
    'notes.append': { descriptor: commands.notesAppend, apply: narrow(notesAppend) },
    'doc.write': { descriptor: commands.docWrite, apply: narrow(docWrite) },
    'editor.insert': { descriptor: commands.editorInsert, apply: narrow(editorInsert) },
    'editor.replaceRange': {
      descriptor: commands.editorReplaceRange,
      apply: narrow(editorReplaceRange),
    },
  };

  // The saved-filter and project-goal applies (binder-filters §5, goals-progress §4). Their descriptors are
  // the bus's own, already in `registry` through `buildRegistry()`, so each entry keeps its descriptor and gains the apply.
  const furniture = furnitureApplies(clock, restore);
  registry['binder.saveFilter'] = { descriptor: registry['binder.saveFilter'].descriptor, apply: narrow(furniture['binder.saveFilter']) };
  registry['binder.deleteFilter'] = { descriptor: registry['binder.deleteFilter'].descriptor, apply: narrow(furniture['binder.deleteFilter']) };
  registry['project.saveGoal'] = { descriptor: registry['project.saveGoal'].descriptor, apply: narrow(furniture['project.saveGoal']) };
  registry['project.deleteGoal'] = { descriptor: registry['project.deleteGoal'].descriptor, apply: narrow(furniture['project.deleteGoal']) };

  // The whole-script imports and the dialogue container's settings (screenplay.md §2.2, dialogue-narrative.md
  // §2.1 and §4). Their descriptors are the bus's own, already in `registry` through `buildRegistry()`.
  const script = scriptApplies(clock);
  registry['screenplay.import'] = { descriptor: registry['screenplay.import'].descriptor, apply: narrow(script['screenplay.import']) };
  registry['dialogue.importInk'] = { descriptor: registry['dialogue.importInk'].descriptor, apply: narrow(script['dialogue.importInk']) };
  registry['dialogue.setMeta'] = { descriptor: registry['dialogue.setMeta'].descriptor, apply: narrow(script['dialogue.setMeta']) };

  const exportPort = options.exporter;
  if (exportPort !== undefined) {
    // The whole manuscript. A recipe, if named, is resolved by the port, which owns
    // the recipe list; this apply only says which scope the command means.
    const exportCompile: ProjectApply<ExportCompileParams> = (state, params, context) =>
      finishExport(
        exportPort.compile(state, {
          selection: { kind: 'manuscript' },
          format: params.format,
          recipeName: params.recipeName,
          templateId: params.templateId,
          at: clock.now(),
        }),
        context,
      );

    // A part: the named nodes, and nothing inferred from them. A recipe, if named, supplies only the options the part compiles with
    // (the port reads the recipe's selection for a whole manuscript and never for a part).
    const exportCompileSelection: ProjectApply<ExportCompileSelectionParams> = (state, params, context) =>
      finishExport(
        exportPort.compile(state, {
          selection: { kind: 'nodes', includeRootIds: [...params.includeRootIds] },
          format: params.format,
          recipeName: params.recipeName,
          templateId: params.templateId,
          at: clock.now(),
        }),
        context,
      );

    registry['export.compile'] = { descriptor: commands.exportCompile, apply: narrow(exportCompile) };
    registry['export.compileSelection'] = {
      descriptor: commands.exportCompileSelection,
      apply: narrow(exportCompileSelection),
    };
  }

  // The external call is an async apply, so its registration is dispatched through the bus's `executeAsync`
  // (command-bus §3). The descriptor is the client's, which knows the server, its pins and the loaded tools.
  const mcpPort = options.mcpInvoke;
  if (mcpPort !== undefined) {
    registry['mcp.invoke'] = {
      descriptor: mcpPort.descriptor as CommandRegistry['mcp.invoke']['descriptor'],
      apply: mcpPort.apply,
    };
  }

  // The storyboard shot commands. Each apply is the module's, through the port, and what it returns is what the
  // bus owns: the inverse, registered after the write, and the row. A refusal is thrown as an ApplyRefusal, so the
  // bus returns the module's own error, with its corrective text, and writes nothing.
  const shotPort = options.shots;
  if (shotPort !== undefined) {
    const runShot = (state: ProjectState, name: 'storyboard.create' | 'shot.create' | 'shot.setMeta', params: unknown): ShotCommandReport => {
      const applied = shotPort.apply(state, name, params, new Date(clock.now()));
      if (!applied.ok) throw new ApplyRefusal(applied.error);
      return applied.value;
    };

    const storyboardCreate: ProjectApply<StoryboardCreateCommandParams> = (state, params, context) => {
      const report = runShot(state, 'storyboard.create', params);
      // Undoing a created folder removes it. Its shots are created after it, so they are undone first.
      context.undo.inverse(inverseCommand('project.deleteNode', { nodeId: params.id }, clock));
      context.report({ affected: [...report.affected], summary: report.summary });
      return { nodeId: params.id };
    };

    const shotCreate: ProjectApply<ShotCreateCommandParams> = (state, params, context) => {
      const report = runShot(state, 'shot.create', params);
      context.undo.inverse(inverseCommand('project.deleteNode', { nodeId: params.id }, clock));
      context.report({ affected: [...report.affected], summary: report.summary });
      return { nodeId: params.id };
    };

    // The inverse is the same command with the two values swapped: the value the plan read becomes the stored
    // one, and the value now stored becomes the expectation the inverse checks (storyboard.md §4, undo).
    const shotSetMeta: ProjectApply<ShotSetMetaCommandParams> = (state, params, context) => {
      const report = runShot(state, 'shot.setMeta', params);
      context.undo.inverse(
        inverseCommand(
          'shot.setMeta',
          {
            nodeId: params.nodeId,
            stored: (params.expect ?? null) as Record<string, unknown> | null,
            expect: params.stored ?? null,
          },
          clock,
        ),
      );
      context.report({ affected: [...report.affected], summary: report.summary });
      return { nodeId: params.nodeId };
    };

    registry['storyboard.create'] = { descriptor: commands.storyboardCreate, apply: narrow(storyboardCreate) };
    registry['shot.create'] = { descriptor: commands.shotCreate, apply: narrow(shotCreate) };
    registry['shot.setMeta'] = { descriptor: commands.shotSetMeta, apply: narrow(shotSetMeta) };
  }

  // Project export: the project block, the saved recipes, the vocabulary and the cover import. The applies are in
  // commands-project.ts; `project.importAsset` is added only when the host injects its asset port.
  Object.assign(registry, projectCommandRegistrations({ clock, ...(options.assets === undefined ? {} : { assets: options.assets }) }));
  // Storyboard: the shot image import needs both the asset port and the storyboard port (commands-shot-image.ts).
  Object.assign(
    registry,
    shotImageCommandRegistrations({
      clock,
      ...(options.assets === undefined ? {} : { assets: options.assets }),
      ...(shotPort === undefined ? {} : { shots: shotPort }),
    }),
  );

  return registry;
}

/** A2: the pipeline refuses a thenable from an apply, so the sink's is detected here. */
function isPromise(value: Promise<void> | void): value is Promise<void> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
