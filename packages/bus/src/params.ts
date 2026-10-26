/**
 * Validation primitives — the shared vocabulary [command-bus.md §2](docs/architecture/command-bus.md)
 * requires of every `validate`: **pure and total**. Nothing here touches state
 * beyond reading the snapshot, and nothing here throws.
 *
 * Every helper returns `Result<never, CommandError>` on refusal, which composes
 * into any `Result<P, CommandError>` — so a validator reads as a sequence of
 * `if (!r.ok) return r;` steps and each refusal carries §7's two load-bearing
 * fields: a `message` that names what is wrong in prose (never a bare code) and
 * a `correctiveHint` that names the surface that fixes it.
 */

import { err, ok, type CommandError, type PerOpFailure, type Result } from './result.js';
import { isFixedRootId, type CommandName, type ValidationNode, type ValidationSnapshot } from './command.js';

/** §7's own example hint, verbatim: "use binder.read_tree to list valid ids". */
export const HINT_READ_TREE = 'use binder.read_tree to list valid ids';

/* ------------------------------------------------------------------ *
 * The closed params surface
 * ------------------------------------------------------------------ */

/**
 * Every top-level key §9 declares for each name, in §9's order — **the accepted
 * surface, stated once**.
 *
 * ## What this is for
 *
 * `test/registry.test.ts` reads §9's Params column out of the spec and compares
 * it against the key set of a *successful* `validate` payload. That measures
 * what **survived**, so a key a descriptor *accepted and dropped* is invisible
 * to it; this table closes that seam. Measured on `binder.rename`:
 * `{nodeId, title, order: 99}` came back `{nodeId, title}`, green.
 *
 * A silent drop is the worst outcome available here, and `codex.upsert`'s
 * `origin` is why it is worse than a typo. codex.md §2 makes provenance load-bearing —
 * hand-authored outranks agent-inferred, so a wrong `origin` changes which entry
 * is canon — and the harness owns it from `context.issuedBy`. An agent that
 * passes `origin: 'agent'` and is silently ignored has been *told* it set
 * something it did not set. A refusal says so.
 *
 * ## Why §2's word "schema-validated" is the authority
 *
 * §2's envelope block types `params: object;` and annotates it
 * *"flat, enum-constrained, **schema-validated**"*. A schema validation is what
 * refuses an unknown key; a hand-written reader that picks the fields it knows is
 * the thing that annotation rules out. §9's Params column is that schema. The
 * alternative reading — "essential**s**" as *"the keys you must send, others
 * ignored"* — is.md with the ambiguity quoted, because it is
 * genuinely available and it is what the code did.
 *
 * ## One table, and it is typed so it cannot fall behind
 *
 * `Record<CommandName, readonly string[]>` over the closed set, so **a name
 * added to `COMMAND_NAMES` without a row here is a compile error** — the same
 * enforcement `CommandRegistry` already uses, for the same reason. A key list
 * typed into seventeen `validate` functions instead would be the fifth
 * hand-written copy of §9's column that review exists to prevent.
 *
 * ## The three "various" rows are declared here, and only here
 *
 * §9 gives the `view.*` family the word `various` rather than a literal, so for
 * those three **this table is the only declaration of their shape** — the
 * decision itself is docs/decisions.md, and `descriptors.ts`'s header
 * states why the shapes are the minimum that makes each name mean what it says.
 * They are held to the same rule as the rest of the set: a `view.*` command
 * refuses a key it does not declare. `registry.test.ts` asserts the count is
 * exactly three, so a fourth "various" row fails instead of joining a hole.
 */
export const DECLARED_PARAMS: Readonly<Record<CommandName, readonly string[]>> = {
  'binder.create': ['parentId', 'type', 'title', 'kind'],
  'binder.move': ['nodeId', 'newParentId', 'index'],
  'binder.rename': ['nodeId', 'title'],
  'binder.setMeta': ['nodeId', 'patch'],
  'binder.setSynopsis': ['nodeId', 'synopsis'],
  'notes.set': ['nodeId', 'notes'],
  'notes.append': ['nodeId', 'text', 'divider'],
  'doc.write': ['docId', 'body', 'expectedRevision'],
  'editor.insert': ['docId', 'offset', 'text', 'expectedRevision'],
  'editor.replaceRange': ['docId', 'range', 'text', 'expectedRevision'],
  'codex.upsert': ['entries'],
  'codex.attach': ['entryId', 'attachTo', 'detachFrom'],
  'export.compile': ['format', 'recipeName', 'templateId'],
  'export.compileSelection': ['includeRootIds', 'format', 'templateId', 'recipeName'],
  'project.deleteNode': ['nodeId'],
  'view.setSelection': ['nodeIds'],
  'view.setActiveDoc': ['docId'],
  'view.setScroll': ['nodeId', 'offset'],
  'view.setExpanded': ['nodeId', 'expanded'],
  'view.setCorkboardScope': ['nodeId'],
  'coherence.setSceneMeta': ['docId', 'patch'],
  'coherence.setFindingStatus': ['findingId', 'status', 'reason', 'note'],
  'coherence.discardRun': ['runId'],
  'coherence.addKnowledgeFact': ['text', 'ruleId', 'entryId'],
  'coherence.editKnowledgeFact': ['factId', 'text', 'ruleId', 'entryId'],
  'coherence.removeKnowledgeFact': ['factId'],
  'mcp.invoke': ['serverKey', 'toolName', 'args', 'expectedPins'],
  'mcp.readResource': ['serverKey', 'uri', 'pickedBy', 'viaTemplate'],
  'storyboard.create': ['id', 'parentId', 'title', 'scene'],
  'shot.create': ['id', 'parentId', 'title', 'stored'],
  'shot.setMeta': ['nodeId', 'stored', 'expect'],
  'project.rename': ['title'],
  'project.setMetadata': ['patch'],
  'project.importAsset': ['stagingId', 'target'],
  'vocabulary.upsert': ['kind', 'id', 'name', 'color'],
  'vocabulary.remove': ['kind', 'id'],
  'recipe.save': ['name', 'includeRootIds', 'format', 'templateId', 'options'],
  'recipe.delete': ['name'],
  'binder.saveFilter': ['filter'],
  'binder.deleteFilter': ['filterId'],
  'project.saveGoal': ['goal'],
  'project.deleteGoal': ['goalId'],
  'shot.importImage': ['nodeId', 'stagingId'],
  'shot.importImages': ['items'],
  'screenplay.import': ['format', 'text', 'parentId'],
  'dialogue.importInk': ['containers', 'parentId'],
  'dialogue.setMeta': ['nodeId', 'patch'],
  'skill.import': ['stagingId'],
  'skill.write': ['name', 'path', 'text'],
  'skill.delete': ['name'],
  'skill.setEnabled': ['name', 'enabled'],
  'project.setInstructions': ['text', 'expectedDigest'],
  'memory.write': ['slug', 'type', 'title', 'body', 'expectedDigest'],
  'memory.forget': ['slug'],
};

/** §9's three "various" rows, spelled out — asserted, not inferred. */
export const VARIOUS_PARAM_NAMES: readonly CommandName[] = [
  'view.setSelection',
  'view.setActiveDoc',
  'view.setScroll',
];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Shape refusals: `invalid-params` per the shipped nine-code enum. */
export function invalidError(message: string, correctiveHint?: string, target?: string): CommandError {
  return { code: 'invalid-params', message, ...(target === undefined ? {} : { target }), ...(correctiveHint === undefined ? {} : { correctiveHint }) };
}

export function notFoundError(message: string, correctiveHint?: string, target?: string): CommandError {
  return { code: 'not-found', message, ...(target === undefined ? {} : { target }), ...(correctiveHint === undefined ? {} : { correctiveHint }) };
}

export function limitExceededError(message: string, correctiveHint?: string, target?: string): CommandError {
  return { code: 'limit-exceeded', message, ...(target === undefined ? {} : { target }), ...(correctiveHint === undefined ? {} : { correctiveHint }) };
}

/** The same four, as refusals a validator can return directly. */
export function invalid(message: string, correctiveHint?: string, target?: string): Result<never, CommandError> {
  return err(invalidError(message, correctiveHint, target));
}

/**
 * A vocabulary id the project does not hold. It carries `details.unknownVocabulary`, so a plan can tell this miss from a shape
 * error: a step that names a term an earlier step of the plan adds is checked again when it runs, not refused up front.
 */
export function unknownTerm(kind: 'status' | 'label', message: string, correctiveHint: string, target: string): Result<never, CommandError> {
  return err({ ...invalidError(message, correctiveHint, target), details: { unknownVocabulary: kind } });
}

export function notFound(message: string, correctiveHint?: string, target?: string): Result<never, CommandError> {
  return err(notFoundError(message, correctiveHint, target));
}

/** A limit from the format or a tool contract, not a malformed value. */
export function limitExceeded(message: string, correctiveHint?: string, target?: string): Result<never, CommandError> {
  return err(limitExceededError(message, correctiveHint, target));
}

/**
 * A refusal that says the request asks for no change at all.
 *
 * `details.changesNothing` is the machine-readable half of it, and the undo
 * path reads that half: an inverse that changes nothing has nothing to undo.
 * The contract the undo path leans on is the registering side's, and
 * **`binder.setMeta` is the command that keeps it**: an apply that wrote a field
 * mints an inverse carrying that field's previous value, and an apply that
 * wrote none stamps nothing and registers no restore entry — so a
 * changes-nothing inverse has nothing to put back, dispatching it can only
 * refuse, and that refusal says the work is already done, not that the undo
 * failed. A group with such an entry in it is therefore not a group with a
 * failure in it.
 *
 * **The other patch commands are safe for a different reason, and the paragraph
 * above does not describe them.** `dialogue.setMeta` stamps on every accepted
 * patch and `project.setMetadata` registers an inverse for a field that already
 * holds the requested value; neither can ever produce a changes-nothing
 * refusal, because one is compensable and the other's inverse is never empty.
 */
export function changesNothing(message: string, correctiveHint: string, target: string): Result<never, CommandError> {
  return err({ code: 'invalid-params', message, correctiveHint, target, details: { changesNothing: true } });
}

export function cycleError(message: string, correctiveHint?: string, target?: string): Result<never, CommandError> {
  return err({ code: 'cycle', message, ...(target === undefined ? {} : { target }), ...(correctiveHint === undefined ? {} : { correctiveHint }) });
}

/** The params root, or a refusal naming what a caller actually passed. */
export function requireParams(params: unknown): Result<Record<string, unknown>, CommandError> {
  if (isRecord(params)) return ok(params);
  return invalid(
    `params must be an object, got ${describe(params)}`,
    'every command takes one flat params object — see the registry table for this name',
  );
}

/**
 * §2's `requireParams` **and** the closed-key refusal, in one call.
 *
 * **Why these two are one function and not two.** A descriptor that calls
 * `requireParams` alone checks the shape and forgets the set; one that calls both
 * can check the set and forget the shape, or check them in the wrong order and
 * report `params.titel must be a string, got undefined` for a payload whose real
 * defect is a misspelled key. Every descriptor's first statement is now this
 * call, so the two obligations cannot be satisfied one at a time.
 *
 * **The check runs before any field is read**, which is what makes the refusal
 * actionable: a caller who misspelled one key is told the misspelling, rather
 * than being walked through a cascade of missing-field errors for a payload that
 * was never valid.
 *
 * **Presence, not value.** A key set to `undefined` is still a key the caller
 * named — `{nodeId, title, order: undefined}` is a payload that believes it
 * carries an ordering instruction, and `binder.rename` has no such instruction.
 * Refusing it keeps the emitted payload's meaning equal to the submitted
 * payload's. (Optional §9 keys — `expectedRevision?`, `divider?` — are *declared*
 * keys whose value may be absent, which is a different thing entirely and is
 * allowed.)
 *
 * **The refusal is `invalid-params`, the code §2's own validation failures use**,
 * and the message names both the offending key and the accepted set — §7's
 * "model/user-facing: names the corrective surface, never a bare code". A model
 * that is told `order` is not a key of `binder.rename` can fix the call in one
 * round trip; a model told only "invalid params" retries blind.
 */
export function requireDeclaredParams(
  name: CommandName,
  params: unknown,
): Result<Record<string, unknown>, CommandError> {
  const p = requireParams(params);
  if (!p.ok) return p;
  const accepted = DECLARED_PARAMS[name];
  const unexpected = Object.keys(p.value).filter((key) => !accepted.includes(key));
  if (unexpected.length > 0) {
    const named = unexpected.map((key) => `"${key}"`).join(', ');
    return invalid(
      `${name} takes no ${unexpected.length === 1 ? 'param' : 'params'} ${named}`,
      `${name} accepts only: ${accepted.join(', ')} — drop ${unexpected.length === 1 ? 'that key' : 'those keys'} and resend`,
      unexpected[0],
    );
  }
  return p;
}

export function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/**
 * A value as a refusal message names it, for the one place a message has to
 * quote the value itself.
 *
 * `JSON.stringify` is the obvious tool and the wrong one here: it throws on a
 * `BigInt` and on a cycle, and a `validate` that throws is not total (command-bus
 * §2). Strings are quoted so the message shows exactly what was sent; everything
 * else is named by kind, the way {@link describe} names it.
 */
export function showValue(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return describe(value);
}

export function requireString(
  params: Record<string, unknown>,
  key: string,
  maxChars?: number,
): Result<string, CommandError> {
  const value = params[key];
  if (typeof value !== 'string') {
    return invalid(`params.${key} must be a string, got ${describe(value)}`, `pass ${key} as a string`, key);
  }
  if (maxChars !== undefined && [...value].length > maxChars) {
    return limitExceeded(
      `params.${key} is ${[...value].length} characters, limit ${maxChars}`,
      `shorten ${key} to ${maxChars} characters`,
      key,
    );
  }
  return ok(value);
}

/**
 * A string that has to **name something**.
 *
 * `requireString` refuses a value of the wrong type; it does not refuse a value
 * that is a string and means nothing. §9 names four fields where the corpus
 * already decided a blank is a refusal rather than a value — `binder.create`'s
 * and `binder.rename`'s `title`, `export.compile`'s `recipeName` — and each had
 * its own hand-written `trim().length === 0` check, which is the fifth
 * hand-written copy of one rule a review exists to prevent.
 *
 * **Blank after trim, not just empty.** `'   '` is the case that matters: it
 * survives a naive `=== ''` check, reaches a file, and comes back as a node
 * titled with three spaces. The three existing refusals already used `.trim()`,
 * so this preserves their behaviour exactly rather than weakening it.
 *
 * **It is opt-in, and deliberately so.** Not every string field may refuse a
 * blank: `notes.set {notes}`, `binder.setSynopsis {synopsis}` and `doc.write
 * {body}` all take an empty string as a *legitimate instruction* ("clear this
 * field"), and a blanket rule in `requireString` would make "clear the notes"
 * uncallable. The rule is per-field because the spec's is.
 */
export function requireNonBlankString(
  params: Record<string, unknown>,
  key: string,
  opts: { maxChars?: number; blankHint?: string } = {},
): Result<string, CommandError> {
  const value = requireString(params, key, opts.maxChars);
  if (!value.ok) return value;
  if (value.value.trim().length === 0) {
    return invalid(
      `params.${key} must not be blank`,
      opts.blankHint ?? `pass a non-blank ${key}`,
      key,
    );
  }
  return value;
}

/** The optional form, for a field whose *absence* is allowed and whose blankness is not. */
export function optionalNonBlankString(
  params: Record<string, unknown>,
  key: string,
  opts: { maxChars?: number; blankHint?: string } = {},
): Result<string | undefined, CommandError> {
  if (params[key] === undefined) return ok(undefined);
  return requireNonBlankString(params, key, opts);
}

export function optionalString(
  params: Record<string, unknown>,
  key: string,
  maxChars?: number,
): Result<string | undefined, CommandError> {
  if (params[key] === undefined) return ok(undefined);
  return requireString(params, key, maxChars);
}

/**
 * A patch field that may be **absent**, a string, or explicitly `null`.
 *
 * The three are different instructions and the type has to keep them apart:
 * `undefined` = leave the field alone, `null` = clear it, a string = set it. That
 * is `MetaPatch.status`'s widened shape (see `command.ts`) and it exists so
 * `binder.setMeta`'s `undo: 'inverse'` can restore the one value a node field can
 * hold that a plain string cannot: no status, no label. A helper that collapsed
 * `null` into `undefined` would make "clear it" unreachable while typechecking.
 */
export function optionalNullableString(
  params: Record<string, unknown>,
  key: string,
  maxChars?: number,
): Result<string | null | undefined, CommandError> {
  if (params[key] === undefined) return ok(undefined);
  if (params[key] === null) return ok(null);
  return requireString(params, key, maxChars);
}

export function requireInteger(
  params: Record<string, unknown>,
  key: string,
  opts: { min?: number; max?: number; maxHint?: string } = {},
): Result<number, CommandError> {
  const value = params[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return invalid(`params.${key} must be an integer, got ${describe(value)}`, `pass ${key} as an integer`, key);
  }
  if (opts.min !== undefined && value < opts.min) {
    return invalid(`params.${key} must be ≥ ${opts.min}, got ${value}`, undefined, key);
  }
  if (opts.max !== undefined && value > opts.max) {
    return invalid(
      `params.${key} must be ≤ ${opts.max}, got ${value}`,
      opts.maxHint ?? `pass ${key} at or below ${opts.max}`,
      key,
    );
  }
  return ok(value);
}

export function optionalBoolean(
  params: Record<string, unknown>,
  key: string,
): Result<boolean | undefined, CommandError> {
  const value = params[key];
  if (value === undefined) return ok(undefined);
  if (typeof value !== 'boolean') {
    return invalid(`params.${key} must be a boolean, got ${describe(value)}`, `pass ${key} as true or false`, key);
  }
  return ok(value);
}

/**
 * A list of strings where **every entry has to name something**.
 *
 * ## The gap this closes
 *
 * Without it, `includeRootIds: ['']` and
 * `['   ']` were **accepted**: `export.compileSelection` with a list holding one
 * blank id validated green, which is "compile a part naming no node and report
 * success" — the refusal on the *empty* list exists for exactly that reason, so
 * the blank twin of `[]` reached the same outcome one token over. The cause was that `requireStringArray` had no blank check.
 *
 * ## Why it lives here rather than in one descriptor
 *
 * Because the helper is the surface. Its other callers are
 * `codex.attach`'s `attachTo`/`detachFrom` and the `codex.upsert` op lists
 * (`aliases`, `keywords`, `exclude`), plus `binder.setMeta`'s
 * `keywords_add`/`keywords_remove` and `view.setSelection`'s `nodeIds` — every
 * one of them a list of **ids, names or tags**, where a blank entry names
 * nothing and has no reading. Writing the check into `export.compileSelection`
 * would leave five more call sites with the same hole, which is the mirror of
 * the bug `DECLARED_PARAMS` was built to kill.
 *
 * **This is deliberately not a "no empty list" rule.** `detachFrom: []` and
 * `keywords_add: []` are legitimate "nothing to do" payloads and stay accepted;
 * the at-least-one rule belongs to the command that states it
 * (`export.compileSelection`), and it is unchanged.
 *
 * **Whitespace counts as blank.** `['', 'n1']` is refused at index 0, not
 * silently cleaned, so the caller's payload and the emitted payload never
 * differ in length — the same reasoning `requireDeclaredParams` records for
 * presence.
 */
export function requireStringArray(
  params: Record<string, unknown>,
  key: string,
  opts: { maxItems?: number } = {},
): Result<string[], CommandError> {
  const value = params[key];
  if (!Array.isArray(value)) {
    return invalid(`params.${key} must be an array of strings, got ${describe(value)}`, `pass ${key} as an array of strings`, key);
  }
  const out: string[] = [];
  for (const [i, item] of value.entries()) {
    if (typeof item !== 'string') {
      return invalid(`params.${key}[${i}] must be a string, got ${describe(item)}`, undefined, `${key}[${i}]`);
    }
    if (item.trim().length === 0) {
      return invalid(
        `params.${key}[${i}] must not be blank`,
        `every entry in ${key} has to name something — drop the blank one, or leave the key out entirely`,
        `${key}[${i}]`,
      );
    }
    if (opts.maxItems !== undefined && value.length > opts.maxItems) {
      return limitExceeded(`params.${key} has ${value.length} entries, limit ${opts.maxItems}`, `send at most ${opts.maxItems} entries`, key);
    }
    out.push(item);
  }
  return ok(out);
}

/* ------------------------------------------------------------------ *
 * Snapshot reads — pure lookups over the §2 read-view
 * ------------------------------------------------------------------ */

export function findNode(snapshot: ValidationSnapshot, id: string): ValidationNode | undefined {
  return snapshot.manifest.tree.find((n) => n.id === id);
}

/**
 * Resolve a node id from a params field, refusing an unknown id with §7's own
 * corrective hint rather than letting the apply discover it later.
 */
export function requireNode(
  snapshot: ValidationSnapshot,
  params: Record<string, unknown>,
  key: string,
): Result<ValidationNode, CommandError> {
  const id = requireString(params, key);
  if (!id.ok) return id;
  const node = findNode(snapshot, id.value);
  if (!node) return notFound(`no node with id "${id.value}"`, HINT_READ_TREE, id.value);
  return ok(node);
}

/** A node that can hold children: the tree root, or a folder. */
export function isContainer(node: ValidationNode): boolean {
  return node.type === 'root' || node.type === 'folder';
}

/**
 * `binder.move`'s cycle check (§9: "Cycle check + manuscript-root invariant in
 * validate"). Walks *up* from the proposed parent: if the moving node is met
 * on the way, the new parent is the node itself or one of its descendants, and
 * the move would detach a subtree from the tree.
 */
export function isDescendantOf(
  snapshot: ValidationSnapshot,
  nodeId: string,
  ancestorId: string,
): boolean {
  let cursor = findNode(snapshot, nodeId);
  const seen = new Set<string>();
  while (cursor) {
    if (cursor.id === ancestorId) return true;
    if (seen.has(cursor.id)) return false; // defensive: a malformed parent cycle
    seen.add(cursor.id);
    if (cursor.parentId === null) return false;
    cursor = findNode(snapshot, cursor.parentId);
  }
  return false;
}

/** The document record a body-writing command addresses, if it is loaded. */
export function documentLength(snapshot: ValidationSnapshot, docId: string): number | undefined {
  return snapshot.documents.get(docId)?.body.length;
}

/* ------------------------------------------------------------------ *
 * Batch failures — §2's "list failures per-op"
 * ------------------------------------------------------------------ */

export function toPerOpFailure(target: string, error: CommandError): PerOpFailure {
  return {
    target,
    code: error.code,
    message: error.message,
    ...(error.correctiveHint === undefined ? {} : { correctiveHint: error.correctiveHint }),
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

/**
 * Collapse a batch's per-op failures into the single `CommandError` the caller
 * sees. The top-level code is `invalid-params` — the *batch* is what was
 * refused — and `details.failures` carries the whole list, so the model fixes
 * every bad op in one resubmission instead of one per round trip.
 */
export function batchRefusal(failures: PerOpFailure[], correctiveHint?: string): Result<never, CommandError> {
  const first = failures[0];
  return err({
    code: 'invalid-params',
    message:
      failures.length === 1 && first !== undefined
        ? `batch refused: ${first.message}`
        : `batch refused: ${failures.length} of the submitted ops failed validation`,
    ...(correctiveHint === undefined ? {} : { correctiveHint }),
    details: { failures },
  });
}

export { isFixedRootId };
