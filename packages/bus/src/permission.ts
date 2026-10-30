/**
 * The permission gate — [command-bus.md §4](docs/architecture/command-bus.md).
 *
 * **A pure function of (descriptor, command, planContext).** No I/O, no clock, no
 * registry read, no state: the same three arguments always produce the same
 * answer. That is what makes §10's permission-matrix assertions runnable headless
 * and what lets the pipeline call it as step 2 without the gate owning anything.
 *
 * ## What the gate decides, in the spec's own words
 *
 * - `issuedBy: 'user'` — *"a UI gesture is its own confirmation; only destructive
 *   commands (`project.deleteNode`) add an explicit confirm dialog (UI
 *   responsibility)."* The gate therefore **never refuses a user command**. It
 *   reports the one thing the UI cannot infer on its own: that this gesture needs
 *   a confirm dialog first. §10's own wording is the contract — *"each `never`
 *   command refused for agent, allowed/destructive-confirmed for user"*.
 * - `issuedBy: 'agent'` — gated by `agentRisk`: `read` → auto, `write-auto` → auto,
 *   `write-confirm` → **only inside an approved plan or a one-step confirm card**,
 *   `never` → refused with a model-facing error naming the corrective path.
 * - **Hard-deny** — the four classes below are *"non-approvable by any flow"*.
 *   They are checked **before** `agentRisk` and nothing downstream can rescue one:
 *   not an approved plan, not a confirm card, not an inherited grant. **A test that
 *   approves a hard-denied command through a plan is the one that distinguishes the
 *   hard-deny path from §4's `never` bullet** — it exists in
 *   `test/permission.test.ts` — but the sweep over every flow is what pins the
 *   *ordering*, because a plan is not an inherited grant. (Moving hard-deny below the
 *   inherited-grant branch fails exactly 1 test, and it is not the plan test.)
 *
 * ## `never` and hard-deny are two different lists, and the difference is load-bearing
 *
 * Both `editor.insert` and `editor.replaceRange` are `agentRisk: 'never'` and
 * neither is hard-denied; §9 glosses them *"never (direct) — inheritable as
 * internal composition"*. Only `project.deleteNode` is in the hard-deny list. So a
 * blanket "never means denied" gate would refuse the one case §4 explicitly wants
 * to allow, and a blanket "never means inheritable" gate would let an agent delete
 * a project. They are separated here, and the separation is pinned by tests rather
 * than left to the reading.
 *
 * **Hard-deny is also not inheritable.** §4's inheritance sentence covers
 * *"internal primitives … inside their own apply step"* and then adds *"**Direct**
 * agent emission of a `never`-class command is refused even inside approved plans"*;
 * it says nothing about a compound tool whose primitive would perform a hard-deny
 * class. "Non-approvable by any flow" is read as the stronger, literal claim — see
 * docs/decisions.md for the ambiguity and the rejected alternative.
 */

import { err, ok, type CommandError, type Result } from './result.js';
import type { Command, CommandDescriptor, CommandName } from './command.js';

/** §2's four-level risk enum, named once so the gate and the descriptors agree. */
export type AgentRisk = 'read' | 'write-auto' | 'write-confirm' | 'never';

/**
 * §4's hard-deny classes, one per clause of its closing bullet:
 *
 * > "Hard-deny, non-approvable by any flow … network egress beyond the configured
 * > provider endpoint; deleting nodes or codex entries; mutating provider profiles;
 * > leaving project scope."
 *
 * **All four, not the subset v0.1 exercises.** Three of them have no command in
 * §9's closed set — the bus has no network (§1) and provider/settings mutation is
 * app-level state, never a project command (§9) — and the fourth covers codex-entry
 * deletion, which `codex.upsert`'s `action` (`create | update`) cannot express yet.
 * They are declared anyway, because the list is the gate's own vocabulary: a class
 * that only exists once a command needs it is a class written after the fact, and
 * `test/permission.test.ts` reads §4's bullet back to prove all four are still
 * named in the spec.
 */
export type HardDenyClass =
  | 'network-egress'
  | 'deletion'
  | 'provider-profile'
  | 'project-scope';

export const HARD_DENY_CLASSES: readonly HardDenyClass[] = [
  'network-egress',
  'deletion',
  'provider-profile',
  'project-scope',
];

/**
 * Which registered names perform a hard-deny class.
 *
 * **Two members, and the count is asserted.** The other three classes
 * have no command to attach to but `deletion`'s (§4's own reasons are above). A third member cannot
 * be added without a test failing that names it — the same treatment the registry gives
 * §9's three `various` rows, because a growing exemption-shaped list is how a gate
 * quietly stops refusing things.
 *
 * **`project.deleteNode` is hard-denied *and* `agentRisk: 'never'`.** Both, on
 * purpose: `never` is what the descriptor declares and what §9 tabulates, and the
 * hard-deny class is what makes the refusal unapprovable. The two facts are checked
 * against each other in the test file, so neither can drift away from the other.
 */
export const HARD_DENIED: Readonly<Partial<Record<CommandName, HardDenyClass>>> = {
  'project.deleteNode': 'deletion',
  // A memory note is the writer's to remove, as a node and a codex entry are (agent-harness §4, context-assembly §2 LI).
  'memory.forget': 'deletion',
};

/**
 * What the caller knows about the flow around this dispatch.
 *
 * All three are **facts about a flow, not permissions**: none of them can grant a
 * hard-denied command, and the names are chosen so that reading `approvedPlan: true`
 * never looks like an assertion that the command was therefore allowed.
 */
export interface PermissionContext {
  /**
   * §4: `write-confirm` is *"allowed only inside an approved plan"*. Set by the
   * harness once the user approves a plan card (agent-harness §2), and cleared when
   * the turn ends.
   */
  readonly approvedPlan?: boolean;
  /**
   * agent-harness §2: *"Single confirm-class ops show a one-step confirm card."*
   * Answers the `write-confirm` case for a call that is not part of a plan.
   */
  readonly confirmed?: boolean;
  /**
   * §4's grant inheritance. Present **only** for a primitive executing inside a
   * compound tool's own apply step — never for a dispatch the agent emitted
   * directly, which is exactly what the word "Direct" in §4 turns on.
   *
   * **The gate reads whether this is present, never what it says** — §4 gates an
   * internal primitive *"never individually gated"*, so the compound tool's own
   * grant is what decided, and `PermissionGrant.risk` reports the descriptor's class.
   * The value is the caller's record of where the grant came from; the gate's
   * answer carries no copy of it — `via: 'inherited'` is the whole of what the
   * answer carries.
   */
  readonly inheritedGrant?: AgentRisk;
}

/** How a dispatch was allowed — the `via` an activity-log row wants. */
export type PermissionVia =
  | 'user-gesture'
  | 'auto'
  | 'approved-plan'
  | 'confirm-card'
  | 'inherited';

export interface PermissionGrant {
  /** the risk class the descriptor declares — what the gate was asked about */
  readonly risk: AgentRisk;
  /** which §4 clause allowed it */
  readonly via: PermissionVia;
  /**
   * §4: a destructive **user** command needs an explicit confirm dialog before it
   * is dispatched. The gate cannot show it — that is the UI's job — so it reports
   * the requirement instead of pretending the gesture was unconditional.
   */
  readonly requiresUserConfirm: boolean;
}

/**
 * The four classes' corrective paths, one each, quoted from §4's own example.
 *
 * All four open with "do not retry", and that is not boilerplate: a hard-deny
 * refusal *reads* like a permission problem — it names a risk class and arrives
 * where an approval would normally arrive — so it is the one refusal a model is
 * most likely to retry by asking for a plan, a card or a mode. §4 already answers
 * that, so the sentence says so before it says anything else.
 */
const CORRECTIVE_PATHS: Readonly<Record<HardDenyClass, string>> = {
  deletion:
    'do not retry and do not ask for approval — propose it in your report; deletion is UI-only. project.deleteNode is hard-denied for agents and no plan, card or mode approves it',
  'network-egress':
    'do not retry — the bus has no network (§1) and the gateway owns transport; tell the user this needs doing outside Caotang rather than calling out from a tool',
  'provider-profile':
    'do not retry — provider profiles are app-level settings, never a project command (§9); tell the user which profile they want and stop',
  'project-scope':
    'do not retry — stay inside the project the user has open; if the work needs another project, say so in your report instead of reaching into it',
};

/** The hard-deny refusal. Checked before `agentRisk`, so nothing below can rescue it. */
function hardDenied(name: CommandName, hardDeny: HardDenyClass): Result<never, CommandError> {
  return err({
    code: 'hard-denied',
    message: `"${name}" is hard-denied for an agent (${hardDeny}) — the bus refused it, it was not dispatched, and nothing was written. No approved plan, confirm card or permission mode can approve this class.`,
    target: name,
    risk: 'never',
    correctiveHint: CORRECTIVE_PATHS[hardDeny],
  });
}

/**
 * The agent's status refusal for `coherence.setFindingStatus` (coherence.md §6.3, §7.1), which
 * depends on the command's params, so it cannot be a fixed class in `HARD_DENIED`.
 *
 * The agent may mark a finding `fixed` (after the coherence tool's postcondition) and nothing
 * else. A dismissal is the writer's judgment, and it is hard-refused here, before any grant
 * is read, so an approved plan or an inherited grant cannot carry it. The other statuses
 * (re-open) are refused too: the spec lists `fixed` as the only status the agent may set. The
 * refusal is `hard-denied`, the code §4 gives every non-approvable refusal.
 */
function agentStatusRefusal(name: CommandName, params: unknown): Result<never, CommandError> | undefined {
  if (name !== 'coherence.setFindingStatus') return undefined;
  const status = typeof params === 'object' && params !== null ? (params as Record<string, unknown>)['status'] : undefined;
  if (status === 'fixed') return undefined;
  if (status === 'dismissed') {
    return err({
      code: 'hard-denied',
      message:
        '"coherence.setFindingStatus" with status "dismissed" is hard-denied for an agent: dismissal is a writer judgment. The bus refused it; nothing was written, and no plan, card or grant can approve it.',
      target: name,
      risk: 'never',
      correctiveHint:
        'do not retry — dismissal is a writer judgment, so put the finding and the reason you would give in your report and let the writer dismiss it in the findings inbox',
    });
  }
  return err({
    code: 'hard-denied',
    message: `"coherence.setFindingStatus" with status ${JSON.stringify(status ?? null)} is refused for an agent: the agent may set only "fixed". The bus refused it; nothing was written.`,
    target: name,
    risk: 'never',
    correctiveHint:
      'do not retry — the agent may mark a finding fixed once its text has changed, and re-opening or dismissing is the writer’s call; say what you changed in your report',
  });
}

/** §4's `never`: refused with a model-facing error naming the corrective path. */
function neverRefused(name: CommandName, risk: AgentRisk): Result<never, CommandError> {
  return err({
    code: 'permission-denied',
    message: `"${name}" is a ${risk}-class command and an agent may not emit it directly. The bus refused it; nothing was written.`,
    target: name,
    risk,
    correctiveHint:
      'do not retry it as a direct call — either call the compound tool that owns it (scene.draft composes editor.insert and editor.replaceRange inside its own apply step, where the grant is inherited), or tell the user what you wanted to write and let them do it',
  });
}

/** §4's `write-confirm`: allowed only inside an approved plan or a confirm card. */
function confirmRequired(name: CommandName): Result<never, CommandError> {
  return err({
    code: 'permission-denied',
    message: `"${name}" is a write-confirm command, so it may run only inside an approved plan or behind a one-step confirm card. The bus refused it; nothing was written.`,
    target: name,
    risk: 'write-confirm',
    correctiveHint:
      'emit it as a plan step and wait for the user to approve the plan card, or as a single op so the one-step confirm card can ask for it — do not retry it as a bare call',
  });
}

function grant(risk: AgentRisk, via: PermissionVia, requiresUserConfirm = false): PermissionGrant {
  return { risk, via, requiresUserConfirm };
}

/**
 * §3's second step. Returns the grant that let the command through, or §7's
 * error shape for the refusal — **never an exception**, for any of the 18 names,
 * with any context. A gate that throws on one path is a gate whose refusals are
 * indistinguishable from crashes, which is the failure mode `resolveCommand`
 * already had to be written against.
 */
export function checkPermission(
  descriptor: Pick<CommandDescriptor, 'agentRisk'>,
  command: Pick<Command, 'name' | 'issuedBy'> & { readonly params?: unknown },
  context: PermissionContext = {},
): Result<PermissionGrant, CommandError> {
  const risk = descriptor.agentRisk;
  const hardDeny = HARD_DENIED[command.name];

  // A UI gesture is its own confirmation (§4). Nothing here refuses a user command;
  // the one thing a caller cannot work out for itself — a destructive gesture
  // needing a confirm dialog — comes back as a flag on the grant.
  if (command.issuedBy === 'user') {
    return ok(grant(risk, 'user-gesture', hardDeny !== undefined));
  }

  // Hard-deny first, and outside every condition below it. §4's "non-approvable by
  // any flow" is the whole claim; checking it last would make it approvable by
  // whatever ran before it.
  if (hardDeny !== undefined) {
    return hardDenied(command.name, hardDeny);
  }

  // The same standing for the one param-dependent agent refusal (coherence.md §6.3):
  // a dismissal is refused before any grant below can be read.
  const statusRefusal = agentStatusRefusal(command.name, command.params);
  if (statusRefusal !== undefined) return statusRefusal;

  // §4's grant inheritance. Checked before `never` is refused, because inheriting a
  // compound tool's grant is precisely what makes a `never`-class *primitive*
  // dispatchable — and only inside an apply step, never for direct emission.
  if (context.inheritedGrant !== undefined) {
    return ok(grant(risk, 'inherited'));
  }

  switch (risk) {
    case 'read':
    case 'write-auto':
      // §4: `read` → auto. `write-auto` → auto, *undo-registered* — the undo
      // registration belongs to §5's step in the pipeline, and the gate says
      // nothing about it.
      return ok(grant(risk, 'auto'));
    case 'write-confirm':
      if (context.approvedPlan === true) return ok(grant(risk, 'approved-plan'));
      if (context.confirmed === true) return ok(grant(risk, 'confirm-card'));
      return confirmRequired(command.name);
    case 'never':
      return neverRefused(command.name, risk);
  }
}

/** The hard-deny class a name performs, or `undefined`. */
export function hardDenyClass(name: CommandName): HardDenyClass | undefined {
  return HARD_DENIED[name];
}
