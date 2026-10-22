/**
 * Who answers the cards when nobody is there to click them (agent-harness.md §11).
 *
 * The loop asks `decide` for every card and does nothing until it is answered. A script, a CLI or a CI job has no one to ask, so the
 * answer comes from a policy. The three built-in ones line up with the interactive modes of the permission-mode work, with no one to
 * ask: `read-only` is plan-only, `auto` is ask with every card cancelled, `approve-all` is accept-edits.
 */

import { metadataFor, type AskBack, type Decision, type Harness, type PendingCard, type ToolOutcome, type TurnReport } from '@caotang/harness';

/** Who answers the cards. A string is a built-in policy; a function is the caller's own `decide`. */
export type ApprovalPolicy =
  | 'read-only' // default: every card is cancelled and a write-auto call is refused, so only reads run
  | 'auto' // write-auto calls run (they never show a card); every write-confirm card is cancelled
  | 'approve-all' // every card is approved as shown; a cut draft is still never accepted
  | ((pending: PendingCard) => Decision | Promise<Decision>);

const CANCEL: Decision = { action: 'cancel' };
const APPROVE: Decision = { action: 'approve' };

/**
 * The decision a built-in policy gives a card. `approve-all` approves what the card says it can run. A card that cannot be approved as
 * shown (a draft the provider cut at its output limit, a step the preflight refused) is cancelled, so the loop is not asked the same
 * question again, and `acceptTruncated` is never sent: nobody has read the cut text.
 */
export function decisionFor(policy: NamedPolicy, pending: PendingCard): Decision {
  if (policy === 'approve-all') return pending.card.approvable ? APPROVE : CANCEL;
  return CANCEL;
}

/** The built-in policies, by name. */
export type NamedPolicy = Exclude<ApprovalPolicy, (pending: PendingCard) => unknown>;

/**
 * What a turn reports when a built-in policy cancelled a card: the turn stopped on an approval nobody gave, so it needs input, and
 * the report says which step and why. Without it a cancelled turn reads as one the writer stopped (agent-harness §2 step 4).
 */
export function askBackFor(policy: NamedPolicy, cancelled: readonly PendingCard[]): AskBack {
  const tools = [...new Set(cancelled.flatMap((pending) => pending.card.steps.filter((step) => step.status !== 'done').map((step) => step.tool)))];
  const cut = cancelled.some((pending) => pending.card.cut);
  const what = tools.length === 0 ? 'a step' : tools.join(', ');
  const why = cut
    ? `a draft was cut off at the model’s output limit, and the "${policy}" policy does not keep cut text`
    : policy === 'approve-all'
      ? 'the card could not be approved as shown'
      : `the "${policy}" policy approves no card`;
  return {
    code: 'needs_input',
    reason: `the turn needs an approval before ${what} can run, and ${why}. Nothing was written for it.`,
    options: cut
      ? ['ask again, or raise the provider’s output limit', 'run the turn with a policy function that decides on the cut draft']
      : ["run the turn with approval: 'approve-all', or a policy function that decides on the card", 'make the change yourself'],
  };
}

/** The report with the ask-back a policy's cancel earns it, or the report as it is when the turn stopped for another reason. */
export function withAskBack(report: TurnReport, askBack: AskBack): TurnReport {
  return report.askBack === undefined ? { ...report, askBack } : report;
}

/** Whether a policy lets a write-auto call run: a built-in `read-only` is the one that does not. */
export function allowsAutoWrites(policy: ApprovalPolicy): boolean {
  return policy !== 'read-only';
}

/**
 * A harness that refuses a write-auto call (`meta.set`, `notes.append`). A write-auto call shows no card, so `decide` never sees it,
 * and `read-only` has to stop it where it is made. Every other member is the harness's own.
 */
export function withoutAutoWrites(harness: Harness): Harness {
  return new Proxy(harness, {
    get(target, property) {
      if (property === 'call') {
        return (call: Parameters<Harness['call']>[0], turn: Parameters<Harness['call']>[1]): ToolOutcome => {
          if (metadataFor(call.name)?.risk !== 'write-auto') return target.call(call, turn);
          return {
            ok: false,
            error: {
              code: 'permission-denied',
              message: `"${call.name}" changes the project, and this project was opened read-only. Nothing was written.`,
              correctiveHint: 'do not retry it: open the project with a policy that lets the agent write, or tell the user what you would have changed',
              target: call.name,
            },
          };
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
