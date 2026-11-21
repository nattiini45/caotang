/**
 * `openProject`: Caotang's agent against a project folder, from Node (agent-harness.md §11).
 *
 * The pieces are the ones the app is made of, wired for a host with no browser and no one to click a card:
 *
 * - the folder is the MCP server's (`openFolder`): the single-writer lock, the folder-drift checks, the write queue;
 * - the harness is the product's (`createProductHarness`, every port wired), the same factory the app builds its own with;
 * - the model is one profile the caller names, its key sealed in memory (`createNodeProviders`);
 * - the cards are answered by the approval policy (`approval.ts`), and the loop is the app's `createAgentSession`.
 *
 * Changes stay in memory until `save()`, unless the project was opened with `write: true`, which saves after each turn. The agent
 * changes the project through the command bus only, exactly as in the app; `state` is a read-only view of it.
 */

import type { CommandError, Result, UndoOutcome } from '@caotang/bus';
import {
  createAgentSession,
  createContextPort,
  createProductHarness,
  estimateReplay,
  gatewayCoherenceModel,
  indexTrace,
  parseTrace,
  replay as replayTrace,
  type AgentEvent,
  type AgentSession,
  type Decision,
  type PendingCard,
  type ReplayEstimate,
  type ReplayMode,
  type ReplayResult,
  type ReplaySource,
  type ToolOutcome,
  type TurnReport,
} from '@caotang/harness';
import type { ThinkingLevel } from '@caotang/gateway';
import { cloneProjectState, type LoadNotice, type ProjectState } from '@caotang/store';

import { allowsAutoWrites, askBackFor, explainDecision, withAskBack, withoutAutoWrites, type ApprovalPolicy, type DecisionRecord } from './approval.js';
import { diffFolder, renderOwned, type FileChange } from './diff.js';
import { openFolder } from './folder.js';
import { createNodeProviders, type NodeProviders, type ProviderConfig } from './providers.js';
import { projectRules } from './rules.js';
import { createEventQueue, type AgentRun } from './run.js';
import { MCP_VOICE, type FolderVoice } from './voice.js';

export interface OpenOptions {
  /** The project folder. It must hold a Caotang project (`caotang.json`). */
  readonly root: string;
  /** 'mock' is the deterministic demo provider: no key, no network. */
  readonly provider: ProviderConfig | 'mock';
  /** Who answers the cards. Default `'read-only'`. */
  readonly approval?: ApprovalPolicy;
  /** Called with every card's answer and the rule that gave it, in the order they were given: the audit trail of an unattended run. */
  readonly onDecision?: (record: DecisionRecord) => void;
  /** Called after each write of the folder, with the files it changed: what `diff()` held just before, which `diff()` no longer holds once the folder is saved. */
  readonly onSave?: (changes: readonly FileChange[]) => void;
  /** false (default): changes stay in memory and `diff()` shows them; true: the folder is written after each turn. */
  readonly write?: boolean;
  /** The most model calls one turn may make, retries and drafts included. Default 8. */
  readonly maxModelCalls?: number;
  /** The fetch the provider calls go through. Default the global. */
  readonly fetch?: typeof fetch;
  readonly clock?: () => number;
}

/**
 * What to replay: a trace file's JSONL, a mode, and which turn and call. The provider the project was opened with is the
 * destination, so a replay can only be sent where the caller already pointed this project (agent-harness §8.1).
 */
export interface ReplayInput {
  /** The `caotang.trace/1` file's contents: one record per line. */
  readonly trace: string;
  /** `call` (default) replays one recorded model call, `turn` a whole turn against this project's provider, `cassette` a whole turn answered from the recording. */
  readonly mode?: ReplayMode;
  /** The turn to replay. Default: the last turn the recording holds. */
  readonly turnId?: string;
  /** Which request of the turn, for mode `call`. Default: the turn's first. */
  readonly callIndex?: number;
  /** The most model calls the replayed turn may make. Default: the session's own bound (8). */
  readonly maxModelCalls?: number;
}

export interface RunOptions {
  readonly signal?: AbortSignal;
  /** A plan the caller wrote (`{ steps: [{ tool, params, expect }] }`): the turn runs it with no planner call, and its cards are decided like any other. */
  readonly plan?: unknown;
}

export interface CaotangProject extends AsyncDisposable {
  readonly root: string;
  /** The profile the turns run on: its preset (`'mock'` for the demo provider) and the model its requests are sent with. */
  readonly provider: { readonly preset: string; readonly model: string };
  /** A read-only view; every change goes through `run()` or `call()`. */
  readonly state: Readonly<ProjectState>;
  readonly notices: readonly LoadNotice[];
  /** Runs one turn. Turns run one at a time, in the order they were started. */
  run(intent: string, options?: RunOptions): AgentRun;
  /** One registry call, gated exactly as an MCP caller's is (no model, no plan runner). */
  call(tool: string, params: unknown): Promise<ToolOutcome>;
  /** What saving would change in the folder. */
  diff(): Promise<readonly FileChange[]>;
  /** Restores to before a turn of this process. The undo history is in memory, so a turn cannot be restored by a later process. */
  restore(turnId: string): Result<UndoOutcome, CommandError>;
  /**
   * What a replay would cost, in tokens and money, before any of it is sent (agent-harness §8.1): the recording's own input tokens
   * against this project's provider.
   */
  replayEstimate(input: ReplayInput): ReplayEstimate;
  /**
   * Replays a recording against this project's provider. Nothing is written: a turn or a cassette runs on a copy of the project as
   * it is now, and the result is the caller's to print. A recording made elsewhere describes a project that has moved on, so the
   * copy is the current one and the caller is told to read the comparison, not the bytes.
   */
  replay(input: ReplayInput): Promise<ReplayResult>;
  /** Writes the folder. Refused unless the project was opened with `write: true`. */
  save(): Promise<void>;
  /** Waits for the running turns, saves if `write` is true, and releases the lock. */
  close(): Promise<void>;
}

/** How the SDK names itself in a refusal or a notice. */
const SDK_VOICE: FolderVoice = {
  ...MCP_VOICE,
  program: '@caotang/sdk',
  holder: 'this process',
  reload: 'Open the project again to reload the folder.',
  reopened: 'the project is opened again',
  noProjectHint: '',
};

/** The answer for a card nobody approved: the turn ends as a cancelled one, with a report. */
const CANCEL: Decision = { action: 'cancel' };

/** Where a headless replay is sent: the one profile this project was opened with, which is a destination the caller named. */
function replayTargetOf(providers: NodeProviders): { readonly profileId: string; readonly model?: string; readonly thinking?: ThinkingLevel } {
  return {
    profileId: providers.profile.id,
    ...(providers.model === undefined ? {} : { model: providers.model }),
    ...(providers.thinking === undefined ? {} : { thinking: providers.thinking }),
  };
}

/** A trace file read into the engine's terms: the records, the turn it names, and the mode. */
function replayInputOf(input: ReplayInput): {
  readonly mode: ReplayMode;
  readonly source: ReplaySource;
  readonly turnId: string;
  readonly callIndex?: number;
} {
  const parsed = parseTrace(input.trace);
  if (!parsed.ok) throw new Error(`this trace cannot be replayed: ${parsed.error}`);
  const records = parsed.value;
  const turns = records.filter((record): record is Extract<(typeof records)[number], { kind: 'turn.start' }> => record.kind === 'turn.start');
  const turnId = input.turnId ?? turns[turns.length - 1]?.turnId;
  if (turnId === undefined) throw new Error('this trace holds no turn: a replay needs one turn’s records, not a bare header.');
  if (input.turnId !== undefined && !turns.some((turn) => turn.turnId === turnId)) {
    throw new Error(`this trace holds no turn ${turnId}. It holds: ${turns.map((turn) => turn.turnId).join(', ') || 'none'}.`);
  }
  return {
    mode: input.mode ?? 'call',
    source: indexTrace(records),
    turnId,
    ...(input.callIndex === undefined ? {} : { callIndex: input.callIndex }),
    ...(input.maxModelCalls === undefined ? {} : { maxModelCalls: input.maxModelCalls }),
  };
}

export async function openProject(options: OpenOptions): Promise<CaotangProject> {
  const policy = options.approval ?? 'read-only';
  const write = options.write === true;
  const clock = options.clock ?? Date.now;

  // The provider is built before the folder is locked, so a bad profile or a missing key is refused with nothing taken.
  const providers = await createNodeProviders({ provider: options.provider, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });

  const folder = await openFolder({
    root: options.root,
    voice: SDK_VOICE,
    // A read-only project writes nothing, and coherence.json is a file: a scan's run stays in memory.
    writeCoherence: write && policy !== 'read-only',
    // Notices are in `notices`; the SDK does not write to the caller's stderr.
    report: () => undefined,
    // Without `write`, an export lands in memory too: a project opened read-only does not change on disk, not even under `exports/`.
    exports: write ? 'folder' : 'memory',
    now: () => new Date(clock()),
  });

  try {
    const { state } = folder;
    // The project's own rules (agent.rules) bind a headless run as they bind the agent in the app (agent-harness §4): a read-deny
    // keeps its nodes out of every request, and a rules file that cannot be read refuses changes rather than allowing them.
    const rules = await projectRules(folder.fs, state);
    const base = createProductHarness({
      state,
      registry: folder.registry,
      clock,
      ports: 'agent',
      externalWrites: allowsAutoWrites(policy),
      rules,
      coherence: {
        // The review runs through the caller's model, read at each call.
        model: () => gatewayCoherenceModel(providers.gateway, providers.profile, {
          ...(providers.model === undefined ? {} : { model: providers.model }),
          ...(providers.thinking === undefined ? {} : { thinking: providers.thinking }),
        }),
      },
    });
    const harness = policy === 'read-only' ? withoutAutoWrites(base) : base;

    /** The turn that is running: where its events go, its signal, and a failure of the caller's policy. */
    interface RunningTurn {
      emit: (event: AgentEvent) => void;
      readonly signal: AbortSignal | undefined;
      /** The cards a built-in policy cancelled this turn. */
      readonly refused: PendingCard[];
      policyError?: unknown;
    }
    let current: RunningTurn | undefined;

    const decide = async (pending: PendingCard): Promise<Decision> => {
      const turn = current;
      const record = (decision: Decision, reason: string): Decision => {
        options.onDecision?.({ turnId: pending.turnId, kind: pending.kind, action: decision.action, reason });
        return decision;
      };
      if (typeof policy !== 'function') {
        const { decision, reason } = explainDecision(policy, pending);
        if (decision.action === 'cancel') turn?.refused.push(pending);
        return record(decision, reason);
      }
      try {
        const answer = Promise.resolve(policy(pending));
        const signal = turn?.signal;
        if (signal === undefined) {
          const decision = await answer;
          return record(decision, 'the policy function answered');
        }
        if (signal.aborted) return record(CANCEL, 'the run was stopped');
        // A stopped turn answers the card with Cancel, as the app's Stop does, so the turn ends as a cancelled one.
        const aborted = new Promise<Decision>((resolve) => signal.addEventListener('abort', () => resolve(CANCEL), { once: true }));
        const decision = await Promise.race([answer, aborted]);
        return record(decision, signal.aborted ? 'the run was stopped' : 'the policy function answered');
      } catch (error) {
        if (turn !== undefined) turn.policyError = error;
        return record(CANCEL, 'the policy function threw');
      }
    };

    const agent: AgentSession = createAgentSession({
      harness,
      gateway: providers.gateway,
      context: createContextPort({ state, config: {}, withheld: (tool) => harness.withheld(tool) }),
      decide,
      emit: (event) => current?.emit(event),
      role: providers.role,
      profileId: providers.profile.id,
      ...(providers.model === undefined ? {} : { model: providers.model }),
      ...(providers.thinking === undefined ? {} : { thinking: providers.thinking }),
      ...(options.maxModelCalls === undefined ? {} : { maxModelCalls: options.maxModelCalls }),
      clock,
    });

    let closed = false;
    /** Turns and calls run one after the other: the project has one writer. */
    let chain: Promise<unknown> = Promise.resolve();
    const inSequence = <T>(task: () => Promise<T>): Promise<T> => {
      const next = chain.then(task);
      chain = next.catch(() => undefined);
      return next;
    };
    const assertOpen = (): void => {
      if (closed) throw new Error('this project is closed');
    };
    /** What the state renders as, as of the open and of each save: `diff()` reports what the session changed since, not how the folder spells a file. */
    let baseline = await renderOwned(state);
    /**
     * Writes the folder when this project is open for writing and the session changed it. A save stamps the manifest and rewrites every
     * file that is not byte-canonical, so a project nothing changed in is left as it is, byte for byte. `force` is the caller's own save().
     */
    const saveIfWriting = async (force = false): Promise<void> => {
      if (!write) return;
      const changes = await diffFolder(state, folder.fs, baseline);
      if (force || changes.length > 0) {
        await folder.persist();
        baseline = await renderOwned(state);
        options.onSave?.(changes);
      }
      await folder.persistCoherence();
    };

    let calls = 0;

    const project: CaotangProject = {
      root: folder.root,
      provider: {
        preset: providers.profile.kind === 'mock' ? 'mock' : (providers.profile.preset ?? 'generic'),
        model: providers.model ?? providers.profile.defaultModel,
      },
      state,
      notices: folder.notices,

      run(intent, runOptions = {}) {
        assertOpen();
        const queue = createEventQueue();
        const signal = runOptions.signal;
        const report = inSequence(async (): Promise<TurnReport> => {
          const turn: RunningTurn = { emit: () => undefined, signal, refused: [] };
          // The report event and the report the call returns are one value: a built-in policy's cancel adds its ask-back to both.
          const amend = (report: TurnReport): TurnReport =>
            typeof policy === 'function' || turn.refused.length === 0 ? report : withAskBack(report, askBackFor(policy, turn.refused));
          let reported: TurnReport | undefined;
          turn.emit = (event) => {
            if (event.type !== 'report') return queue.push(event);
            reported = amend(event.report);
          };
          current = turn;
          try {
            const turnOptions = {
              ...(signal === undefined ? {} : { signal }),
              // A plan of reads needs no approval, and a headless host has nobody to approve a card: it runs at once, as a planner's
              // read-only reply does, and a read a rule refuses is refused as it runs with the plan's other reads still run.
              ...(runOptions.plan === undefined ? {} : { readsWithoutCard: true }),
            };
            const result = await (runOptions.plan === undefined ? agent.submit(intent, turnOptions) : agent.submitPlan(intent, runOptions.plan, turnOptions));
            if (turn.policyError !== undefined) throw turn.policyError;
            let settled = reported ?? amend(result);
            const failures: string[] = [];
            const steps = await Promise.all(settled.steps.map(async (step) => {
              if (step.tool !== 'export.compile' || step.status !== 'done') return step;
              const digest = step.data?.['result'] as { readonly jobId: string };
              const job = await folder.exporter.settled(digest.jobId);
              const data = { ...step.data, job };
              if (job.state.kind !== 'failed') return { ...step, data };
              const error = job.state.failures.map((failure) => failure.message).join('; ');
              failures.push(error);
              return { ...step, data, status: 'failed' as const, error };
            }));
            if (failures.length > 0) {
              const reason = `The export failed: ${failures.join('; ')}`;
              settled = { ...settled, steps, status: settled.status === 'cancelled' ? 'cancelled' : 'failed', summary: reason,
                askBack: settled.askBack ?? { code: 'needs_input', reason, options: ['Check the export folder and compile again.', 'Choose another export format.'] } };
            } else {
              settled = { ...settled, steps };
            }
            await saveIfWriting();
            queue.push({ type: 'report', turnId: settled.turnId, report: settled });
            return settled;
          } finally {
            current = undefined;
          }
        });
        report.then(
          () => queue.end(),
          (error: unknown) => queue.fail(error),
        );
        // The caller may read the events and never the report; its rejection is then the iterator's to raise, not an unhandled one.
        report.catch(() => undefined);
        const events = queue.iterator();
        return { report, [Symbol.asyncIterator]: () => events };
      },

      async call(tool, params) {
        assertOpen();
        return inSequence(async () => {
          calls += 1;
          const turnId = `sdk-call-${calls}`;
          const before = base.log.length;
          let outcome: ToolOutcome;
          try {
            outcome = base.external.call({ name: tool, callId: turnId, params }, { turnId });
          } catch (error) {
            // A refusal is a result. A defect in a tool (fontkit throws on the next tick) is one too, not an unhandled rejection.
            outcome = {
              ok: false,
              error: { code: 'internal', message: error instanceof Error ? error.message : String(error), target: tool },
            };
          } finally {
            base.external.endTurn(turnId);
          }
          await folder.exporter.idle();
          if (base.log.length !== before) await saveIfWriting();
          return outcome;
        });
      },

      diff: () => diffFolder(state, folder.fs, baseline),

      restore: (turnId) => agent.restore(turnId),

      replayEstimate: (input) =>
        estimateReplay(
          { ...replayInputOf(input), target: replayTargetOf(providers) },
          (profileId, model, thinking) => providers.gateway.modelLimits(profileId, model, thinking),
        ),

      replay(input) {
        assertOpen();
        return inSequence(() => {
          const parsed = replayInputOf(input);
          return replayTrace({
            ...parsed,
            // The project's own provider is the only destination a headless caller has, and it is one the writer configured.
            target: replayTargetOf(providers),
            // A recording describes a project that has moved on; the copy is the project as it is now, and nothing writes to it.
            snapshot: cloneProjectState(state),
            gateway: providers.gateway,
            // The project's read-deny binds a replay as it binds a turn: what the writer withheld never reaches a provider.
            rules,
            // The project's policy answers a card the recording does not have, exactly as it answers a turn's.
            decide: (pending) => decide(pending),
            clock,
          });
        });
      },

      async save() {
        assertOpen();
        if (!write) {
          throw new Error('this project was opened with write: false, so it cannot be saved. Open it with write: true, or read diff() and apply the changes yourself.');
        }
        await inSequence(() => saveIfWriting(true));
      },

      async close() {
        if (closed) return;
        closed = true;
        await chain;
        try {
          await saveIfWriting();
        } finally {
          await folder.close();
        }
      },

      [Symbol.asyncDispose]: () => project.close(),
    };
    return project;
  } catch (error) {
    await folder.close();
    throw error;
  }
}
