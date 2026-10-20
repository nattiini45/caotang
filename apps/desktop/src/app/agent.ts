/**
 * The agent controller: one per open project. It runs a turn on the harness's agent session, folds the turn's events into
 * views (agent-model.ts), holds the decision the loop is waiting for, and carries each drafted scene to its editor's ghost
 * preview (agent-harness §8).
 *
 * ## The decision is the user's, and the loop waits for it
 *
 * `createAgentSession` asks `decide` for every card and does nothing until it is answered. `decide` parks the card here
 * and resolves when the panel or the ghost calls `answer`. Approval first saves the writer's typing, so the agent applies
 * to the text the writer sees (the revision backstop still guards the rest, command-bus §6).
 *
 * ## Approval needs each draft on screen
 *
 * Prose is never applied without a preview (agent-harness §8). A pending card that drafts a scene can be approved only once
 * the draft has been on screen in its scene while the card was shown. The ghost region belongs to one open document, so a
 * plan that drafts several scenes is approved once each has been shown in turn; a draft not yet shown is written out in the
 * card (`draftCheckOf`). A scene is on screen only while its editor is shown, so the corkboard does not count.
 *
 * ## The ghost
 *
 * A drafted scene reaches the editor as a `ghost` event that names the scene as the model wrote it. `documentIdFor` resolves
 * the name the way the harness does, so the draft goes to the editor of the scene it will land in. Each open document has one
 * ghost region (editor-engine §8): the text is handed to the region of the draft's document when it is mounted, and that
 * document is opened first if it is not. Apply, Retry and Discard are the ghost's own callbacks, and they answer the decision
 * the loop is waiting on.
 *
 * ## Restore
 *
 * "Restore to before this turn" is the session's `restoreBefore`. It takes back every change made after the turn as well, so
 * the document ends where it was before the turn, and the confirmation says so.
 */

import type { GhostPreview } from '@caotang/editor/tiptap';
import type { ProfileView } from '@caotang/gateway';
import {
  createAgentSession,
  createContextPort,
  type ContextConfig,
  type AgentEvent,
  type AgentSession,
  type Decision,
  type PendingCard,
  type TurnReport,
} from '@caotang/harness';

import { documentIdFor, draftCheckOf, newTurnView, reduceTurn, type DraftCheck, type GhostView, type TurnView } from './agent-model.js';
import { fixPlanFor } from './findings-model.js';
import type { ProviderService } from './providers.js';
import type { ProjectSession, RestoreResult } from './session.js';

/** Where a turn runs. The demo intents run on the built-in demo profile, whatever is active (context-assembly §6). */
export interface SubmitOptions {
  readonly demo?: boolean;
}

export interface AgentSnapshot {
  /** Every turn this project has run in this visit, oldest first. */
  readonly turns: readonly TurnView[];
  /** The decision the loop is waiting for, or `null`. */
  readonly pending: PendingCard | null;
  /** A turn is running. The panel does not start another. */
  readonly busy: boolean;
  /** The name of the active provider, or `null` when none is active. */
  readonly providerName: string | null;
  /** Whether the active provider is the demo one, which answers only the demo intents. */
  readonly providerIsDemo: boolean;
  /** The drafts of the card the loop is showing: one for each drafted scene. */
  readonly ghosts: readonly GhostView[];
  /** What the pending card's drafts need before it can be approved, or `null` when no card waits. */
  readonly drafts: DraftCheck | null;
  /** Whether the pending card may be approved now: it is approvable, and every draft has been on screen. */
  readonly approvable: boolean;
  /** Why the last action did not go through, for the panel. `null` when there is nothing to say. */
  readonly message: string | null;
}

// Said without a pointer to the first-run card, which the writer can dismiss for good (settings firstRun), so it may not be on screen.
const NO_PROVIDER = 'No provider is active. Add one in Settings > Providers to use the agent.';

/** The controller each open project's session has, so a panel outside the agent panel (the findings tab) can start a turn in it. */
const controllers = new WeakMap<ProjectSession, AgentController>();

/** The agent controller of an open project, or `undefined` when its panel has not been made. */
export function agentFor(session: ProjectSession): AgentController | undefined {
  return controllers.get(session);
}

export class AgentController {
  private turns: TurnView[] = [];
  private pending: PendingCard | null = null;
  private resolveDecision: ((decision: Decision) => void) | null = null;
  /** A turn is running, from its start until the loop has settled it: an approved card runs under it, so it is not clear at the approval. */
  private busy = false;
  /** The turn that set the per-turn fields below, so only that turn clears them. */
  private turnOwner = 0;
  private turnsStarted = 0;
  private intentForNextTurn: string | null = null;
  private providerForNextTurn: string | null = null;
  private priceForNextTurn: { readonly prompt: number; readonly completion: number } | null = null;
  /**
   * The agent session one open panel keeps across turns (context-assembly §2, L6): the loop's
   * `started` RecentTurn array lives in this session's closure, so two turns through one controller
   * share the prior turns and the next turn's assembled prompt carries them as L6. The session is
   * rebuilt only when the resolved profile, model or thinking changes (a new conversation the writer
   * starts, a provider switch) — per-turn state is cleared by `harness.endTurn` on every settlement,
   * so a cancelled/refused/failed turn never leaves its per-turn state behind. A reload restarts the
   * controller's `started` list — the conversation memory is in memory only (harness #66 is the
   * cross-reload feature, not this).
   */
  private session_:
    | {
        readonly agent: AgentSession;
        readonly profileId: string;
        readonly model: string | undefined;
        readonly thinking: string | undefined;
      }
    | null = null;
  /** The drafts of the card the loop is showing. Each is a value of its own, so a draft shown for an earlier card is never this one. */
  private ghosts: GhostView[] = [];
  /** The drafts that have been on screen in their scene while their card is shown. */
  private readonly previewed = new Set<GhostView>();
  /** The documents whose editor is on screen now. A draft is on screen only in one of these. */
  private readonly visibleDocs = new Set<string>();
  private readonly editors = new Map<string, GhostPreview>();
  /** The text a scene's draft has streamed so far, by document, while the model writes it (agent-harness §8). */
  private readonly streams = new Map<string, string>();
  private message: string | null = null;
  private readonly listeners = new Set<() => void>();
  private snapshotValue: AgentSnapshot;
  /** Whether the panel that shows this controller has gone. A detached controller refuses to park a decision. */
  private detached = false;

  constructor(
    private readonly session: ProjectSession,
    private readonly providers: ProviderService,
    /** The assembler's budgets, read at each turn so a change in Settings applies to the next one (context-assembly §3). */
    private readonly contextConfig: () => ContextConfig = () => ({}),
  ) {
    this.snapshotValue = this.buildSnapshot();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The current snapshot. It changes identity only when something the panel shows has changed. */
  snapshot = (): AgentSnapshot => this.snapshotValue;

  /** Tells the subscribers the provider or another input changed, so the snapshot is read again. */
  refresh(): void {
    this.bump();
  }

  private bump(): void {
    this.snapshotValue = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private buildSnapshot(): AgentSnapshot {
    const active = this.providers.active();
    const drafts = this.draftCheck();
    return {
      turns: this.turns,
      pending: this.pending,
      busy: this.busy,
      providerName: active?.name ?? null,
      providerIsDemo: active?.kind === 'mock',
      ghosts: this.ghosts,
      drafts,
      approvable: this.pending !== null && this.pending.card.approvable && (drafts === null || drafts.blocked === null),
      message: this.message,
    };
  }

  /* ------------------------------------------------------------------ *
   * Turns
   * ------------------------------------------------------------------ */

  /**
   * Runs one turn for `intent`. One turn runs at a time. A turn with no provider to run on is refused with a message, and no
   * model call is made. A demo turn runs on the built-in demo profile, whichever profile is active.
   */
  async submit(intent: string, options: SubmitOptions = {}): Promise<TurnReport | null> {
    const trimmed = intent.trim();
    if (trimmed === '') return null;
    return this.turnWith(trimmed, options, (agent) => agent.submit(trimmed));
  }

  /**
   * "Fix with agent" on a finding (coherence.md §6.3): a turn whose plan is the finding's passage, rewritten. The plan is built
   * here, from the text as it stands, and the turn's card is decided like any other. Nothing is written until the writer approves.
   */
  async fixFinding(findingId: string): Promise<TurnReport | null> {
    const fix = fixPlanFor(this.session.state, this.session.coherenceFile(), findingId);
    if (typeof fix === 'string') {
      this.message = fix;
      this.bump();
      return null;
    }
    return this.turnWith(fix.intent, {}, (agent) => agent.submitPlan(fix.intent, fix.plan));
  }

  /** Runs one turn on the active provider (or the demo's), with `start` as the turn's entry point. One turn runs at a time. */
  private async turnWith(intent: string, options: SubmitOptions, start: (agent: AgentSession) => Promise<TurnReport>): Promise<TurnReport | null> {
    if (this.busy) return null;
    this.message = null;
    this.busy = true;
    this.turnsStarted += 1;
    const owner = this.turnsStarted;
    this.bump();
    try {
      // The demo intents run on the built-in demo profile, whichever profile is active (context-assembly §6).
      // Every other turn runs under the 'chat' role (provider-gateway §6). The role's profile, model and thinking
      // resolve once here and pin the session: a turn cannot change provider mid-flight, and the pinned id is what
      // the loop's capability reads (modelCaps/modelLimits) must see.
      const resolved = options.demo === true ? undefined : this.providers.resolveForRole?.('chat');
      const profile: ProfileView | undefined =
        options.demo === true ? await this.providers.demoProfile() : (resolved?.profile ?? this.providers.active());
      if (profile === undefined) {
        this.message = NO_PROVIDER;
        return null;
      }
      this.turnOwner = owner;
      this.intentForNextTurn = intent;
      this.providerForNextTurn = profile.name;
      this.priceForNextTurn = profile.pricePer1k ?? null;
      // One agent session per controller keeps `started` RecentTurn list across turns (context-assembly §2, L6).
      // The session is rebuilt only when the resolved profile, model or thinking changes; the per-turn state
      // (call cache, plan cache, undo group, loaded tools) is cleared by `harness.endTurn` after every
      // settlement, so a cancelled/refused/failed turn cannot leave its state behind in the shared session.
      const cached = this.session_;
      const model = resolved?.model;
      const thinking = resolved?.thinking;
      const agent: AgentSession =
        cached !== null && cached.profileId === profile.id && cached.model === model && cached.thinking === thinking
          ? cached.agent
          : (() => {
              const created = createAgentSession({
                harness: this.session.harness,
                gateway: this.providers.gateway,
                context: createContextPort({ state: this.session.state, config: this.contextConfig }),
                decide: (pending) => this.decide(pending),
                emit: (event) => this.onEvent(event),
                role: 'chat',
                profileId: profile.id,
                ...(model === undefined ? {} : { model }),
                ...(thinking === undefined ? {} : { thinking }),
              });
              this.session_ = { agent: created, profileId: profile.id, model, thinking };
              return created;
            })();
      return await start(agent);
    } catch (error) {
      this.message = `The turn stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`;
      return null;
    } finally {
      // The turn has settled, so the next one may start. Only the turn that set the per-turn fields clears them.
      this.busy = false;
      if (this.turnOwner === owner) {
        this.turnOwner = 0;
        this.intentForNextTurn = null;
        this.providerForNextTurn = null;
        this.priceForNextTurn = null;
      }
      // The findings a turn's coherence tools wrote are saved with the turn, since no bus command reports them (coherence.md §3).
      this.session.coherenceChanged();
      // Usage and the request log are kept after every turn, so a closed tab loses at most the turn in flight.
      void this.providers.persist();
      this.bump();
    }
  }

  /** The loop's decision request. The card is parked here until the panel or the ghost answers it. */
  private decide(pending: PendingCard): Promise<Decision> {
    return new Promise<Decision>((resolve) => {
      if (this.detached) {
        resolve({ action: 'cancel' });
        return;
      }
      // A card that arrives while an older one still waits settles the older one first, so no decision is left parked.
      this.resolveDecision?.({ action: 'cancel' });
      this.pending = pending;
      this.resolveDecision = resolve;
      this.bump();
    });
  }

  /**
   * The user's answer to the card the loop is waiting on. An approval first saves the writer's typing, so the agent applies
   * to the text on the screen; an approval whose drafts are not yet on screen is refused, and the card stays. A retry or a
   * cancel retires the drafts; an edit keeps them until the card is shown again.
   */
  answer(decision: Decision): void {
    const resolve = this.resolveDecision;
    if (resolve === null) {
      this.message = 'That card is no longer waiting for a decision, so nothing was sent.';
      this.bump();
      return;
    }
    if (decision.action === 'approve') {
      const held = this.draftCheck()?.blocked ?? null;
      if (held !== null) {
        this.message = held;
        this.bump();
        return;
      }
    }
    // The card the decision answers, read before it leaves the screen: an approved compile needs its images listed again first.
    const card = this.pending?.card ?? null;
    this.resolveDecision = null;
    this.pending = null;
    if (decision.action !== 'edit') this.clearGhosts();
    this.message = null;
    this.bump();
    if (decision.action === 'approve') {
      // The turn is still running: the loop applies the approved steps under it, and an adjust call may follow. `busy` stays set
      // until the turn settles (turnWith), so the panel shows Working and no second turn starts meanwhile.
      const compiles = card?.steps.some((step) => step.tool.startsWith('export.compile')) ?? false;
      void this.session.autosave
        .flush()
        .catch(() => undefined)
        // An approved compile lists the project's images again, as the export dialog's compile does (session.exportsReady): the
        // compile reads the listing it last made, and an image added since would be missing from the shot list.
        .then(() => (compiles ? this.session.exportsReady().catch(() => undefined) : undefined))
        .then(() => {
          resolve(decision);
          this.bump();
        });
      return;
    }
    resolve(decision);
  }

  /**
   * Restores the project to before a turn: its checkpoint, through the session's `restoreBefore`. The result says how many
   * later changes went back with it, or why the restore stopped.
   */
  async restore(turnId: string): Promise<RestoreResult> {
    const group = this.checkpointOf(turnId);
    if (group === undefined) return { ok: false, message: 'That turn wrote nothing, so there is nothing to restore.' };
    const outcome = await this.session.restoreBefore(group);
    this.bump();
    return outcome;
  }

  /** The changes a restore to before this turn would also take back, oldest first, as the activity log words them. */
  laterChanges(turnId: string): readonly string[] {
    const group = this.checkpointOf(turnId);
    return group === undefined ? [] : this.session.laterChangesAfter(group);
  }

  private checkpointOf(turnId: string): string | undefined {
    const turn = this.turns.find((entry) => entry.turnId === turnId);
    return turn?.checkpoint?.undoGroupId ?? turn?.report?.undoGroupId;
  }

  /* ------------------------------------------------------------------ *
   * Events
   * ------------------------------------------------------------------ */

  private onEvent(event: AgentEvent): void {
    if (event.type === 'turn' && event.phase === 'started' && this.intentForNextTurn !== null) {
      this.turns = [...this.turns, newTurnView(event.turnId, this.intentForNextTurn, this.providerForNextTurn, this.priceForNextTurn)];
    }
    // A card is shown again after every edit and redraft, and each showing brings its own drafts, which follow its steps.
    if (event.type === 'plan') this.clearGhosts();
    this.turns = this.turns.map((turn) => reduceTurn(turn, event));
    if (event.type === 'ghost') this.addGhost(event);
    if (event.type === 'draft.delta') this.streamDraft(event);
    if (event.type === 'report') this.clearGhosts();
    this.bump();
  }

  /* ------------------------------------------------------------------ *
   * The ghost preview
   * ------------------------------------------------------------------ */

  private addGhost(event: Extract<AgentEvent, { type: 'ghost' }>): void {
    const docId = documentIdFor(this.session.state.manifest.tree, event.docTitle);
    const view: GhostView = {
      callId: event.callId,
      docTitle: event.docTitle,
      docId,
      text: event.text,
      words: event.words,
      cut: event.cut === true,
    };
    this.ghosts = [...this.ghosts, view];
    if (docId === null) return;
    // Open the draft's scene, so its ghost region is on screen to receive the text. A view change, never persisted.
    if (this.session.view.activeDocId !== docId) this.session.dispatch('view.setActiveDoc', { docId });
    this.deliverGhost(docId);
  }

  /**
   * A scene draft's text as the model writes it (agent-harness §8): it streams into the scene's ghost region, the first delta
   * empties the region, and the completed draft replaces the stream when its `ghost` event arrives. The scene is opened first,
   * as a completed draft opens it, so the region is on screen to receive the text. The stream is not the panel's text.
   */
  private streamDraft(event: Extract<AgentEvent, { type: 'draft.delta' }>): void {
    const docId = documentIdFor(this.session.state.manifest.tree, event.docTitle);
    if (docId === null) return;
    if (this.session.view.activeDocId !== docId) this.session.dispatch('view.setActiveDoc', { docId });
    const ghost = this.editors.get(docId);
    if (event.start === true) {
      this.streams.set(docId, '');
      ghost?.clear();
    }
    if (event.delta === '') return;
    this.streams.set(docId, `${this.streams.get(docId) ?? ''}${event.delta}`);
    ghost?.append(event.delta);
  }

  /** Writes the streamed text of `docId` into its editor's ghost region, for a stream that started before the editor was mounted. */
  private deliverStream(docId: string): void {
    const ghost = this.editors.get(docId);
    const text = this.streams.get(docId);
    if (ghost === undefined || text === undefined || text === '') return;
    ghost.clear();
    ghost.append(text);
  }

  /** Writes the draft of `docId` into its editor's ghost region, when that editor is mounted. */
  private deliverGhost(docId: string): void {
    const ghost = this.editors.get(docId);
    const view = this.latestGhost(docId);
    if (ghost === undefined || view === undefined) return;
    ghost.clear();
    ghost.append(view.text);
    if (this.visibleDocs.has(docId)) this.previewed.add(view);
  }

  private latestGhost(docId: string): GhostView | undefined {
    return this.ghosts.findLast((view) => view.docId === docId);
  }

  /** The ghost of the document the editor shows has been mounted or re-mounted: hand it the current draft. */
  attachGhost(docId: string, ghost: GhostPreview): void {
    this.editors.set(docId, ghost);
    // A completed draft is shown in full; a draft still streaming shows what it has written so far.
    if (this.latestGhost(docId) === undefined) this.deliverStream(docId);
    else this.deliverGhost(docId);
    this.bump();
  }

  /** The editor for a document has gone. Its ghost is no longer reachable from here. */
  detachGhost(docId: string, ghost: GhostPreview): void {
    if (this.editors.get(docId) === ghost) this.editors.delete(docId);
    this.bump();
  }

  /**
   * The editor of `docId` is on screen, or is hidden (the corkboard is shown, or another scene is). A draft counts as on screen
   * only while its scene's editor is shown, and a draft that has been on screen while its card is shown counts as previewed.
   */
  setEditorVisible(docId: string, visible: boolean): void {
    if (visible) this.visibleDocs.add(docId);
    else this.visibleDocs.delete(docId);
    const view = this.latestGhost(docId);
    if (visible && view !== undefined && this.editors.has(docId)) this.previewed.add(view);
    this.bump();
  }

  /** Retires every draft: the ghost regions that hold one are emptied, and the drafts are forgotten. */
  private clearGhosts(): void {
    for (const view of this.ghosts) {
      if (view.docId !== null) this.editors.get(view.docId)?.clear();
    }
    // A draft that streamed and was never staged (refused, or cut short by a stopped turn) leaves nothing behind.
    for (const docId of this.streams.keys()) this.editors.get(docId)?.clear();
    this.streams.clear();
    this.ghosts = [];
    this.previewed.clear();
  }

  /** What the pending card's drafts need before approval, or `null` when no card waits. */
  private draftCheck(): DraftCheck | null {
    if (this.pending === null) return null;
    const tree = this.session.state.manifest.tree;
    return draftCheckOf({
      card: this.pending.card,
      ghosts: this.ghosts,
      sceneOf: (ref) => {
        const docId = documentIdFor(tree, ref);
        if (docId === null) return null;
        const node = tree.find((candidate) => candidate.id === docId);
        return { docId, title: node?.title ?? ref, ...(node?.kind === undefined ? {} : { kind: node.kind }) };
      },
      onScreen: (docId) => this.visibleDocs.has(docId) && this.editors.has(docId),
      previewed: (view) => this.previewed.has(view),
    });
  }

  /* ------------------------------------------------------------------ *
   * Lifecycle
   * ------------------------------------------------------------------ */

  /** Ends the controller. A decision still waiting is cancelled, so the turn ends and nothing is left parked. */
  detach(): void {
    this.detached = true;
    const resolve = this.resolveDecision;
    this.resolveDecision = null;
    this.pending = null;
    this.clearGhosts();
    resolve?.({ action: 'cancel' });
    this.bump();
  }

  /**
   * The panel that shows this controller is (again) on screen. React runs effects twice in development, so a controller is
   * detached and attached again before the first screen is drawn; a detach is therefore not the end of the controller.
   */
  attach(): void {
    this.detached = false;
    // Registered here, where the panel that shows the controller attaches it, so a controller React discarded (StrictMode builds
    // one twice) is never the one a findings panel reaches.
    controllers.set(this.session, this);
  }
}
