import { assertNever, canMove, defineMachine, type MachineTable } from '@caotang/machine';
import type { ReviewPlan, ReviewRunResult } from '@caotang/coherence';

export interface ReviewOutcome {
  readonly added: number;
  readonly notes: readonly string[];
}

export type ReviewState =
  | { readonly kind: 'idle'; readonly outcome?: ReviewOutcome }
  | { readonly kind: 'planned'; readonly plan: ReviewPlan }
  | { readonly kind: 'running'; readonly plan: ReviewPlan; readonly completedCalls: number; readonly stopRequested: boolean }
  | { readonly kind: 'cancelled'; readonly outcome?: ReviewOutcome }
  | { readonly kind: 'partial'; readonly outcome: ReviewOutcome }
  | { readonly kind: 'failed'; readonly message: string };

export type ReviewEvent =
  | { readonly type: 'plan'; readonly plan: ReviewPlan }
  | { readonly type: 'dismiss' }
  | { readonly type: 'start' }
  | { readonly type: 'progress'; readonly completedCalls: number }
  | { readonly type: 'stop' }
  | { readonly type: 'done'; readonly status: 'complete' | 'partial'; readonly outcome: ReviewOutcome }
  | { readonly type: 'fail'; readonly message: string };

export const reviewTable: MachineTable<ReviewState, ReviewEvent> = {
  id: 'findings.review', initial: 'idle', final: [],
  on: {
    idle: { plan: ['planned'] },
    planned: { dismiss: ['idle'], start: ['running'] },
    running: { progress: ['running'], stop: ['running'], done: ['idle', 'partial', 'cancelled'], fail: ['failed', 'cancelled'] },
    cancelled: { plan: ['planned'] },
    partial: { plan: ['planned'] },
    failed: { plan: ['planned'] },
  },
};

export function stepReview(state: ReviewState, event: ReviewEvent): ReviewState {
  if (!canMove(reviewTable, state.kind, event.type)) return state;
  switch (event.type) {
    case 'plan': return { kind: 'planned', plan: event.plan };
    case 'dismiss': return { kind: 'idle' };
    case 'start': return state.kind === 'planned' ? { kind: 'running', plan: state.plan, completedCalls: 0, stopRequested: false } : state;
    case 'progress': return state.kind === 'running' ? { ...state, completedCalls: event.completedCalls } : state;
    case 'stop': return state.kind === 'running' ? { ...state, stopRequested: true } : state;
    case 'done': return state.kind === 'running'
      ? { kind: state.stopRequested ? 'cancelled' : event.status === 'complete' ? 'idle' : 'partial', outcome: event.outcome }
      : state;
    case 'fail': return state.kind === 'running' ? state.stopRequested ? { kind: 'cancelled' } : { kind: 'failed', message: event.message } : state;
    default: return assertNever(event);
  }
}

export const reviewMachine = defineMachine(reviewTable, stepReview);

export class CoherenceReviewSession {
  private state: ReviewState = { kind: 'idle' };
  private controller: AbortController | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly changed: () => void, private readonly apply: (result: ReviewRunResult) => void) {}

  snapshot(): ReviewState { return this.state; }

  plan(plan: ReviewPlan): void { this.move({ type: 'plan', plan }); }

  dismiss(): void { this.move({ type: 'dismiss' }); }

  start(run: (plan: ReviewPlan, signal: AbortSignal, progress: (completedCalls: number) => void) => Promise<ReviewRunResult>): void {
    if (this.state.kind !== 'planned') return;
    const plan = this.state.plan;
    const controller = new AbortController();
    this.controller = controller;
    this.move({ type: 'start' });
    this.pending = (async () => {
      try {
        const result = await run(plan, controller.signal, (completedCalls) => this.move({ type: 'progress', completedCalls }));
        this.apply(result);
        this.move({ type: 'done', status: result.status, outcome: { added: result.run.findingsUpserted.length, notes: result.notes } });
      } catch (error) {
        this.move({ type: 'fail', message: error instanceof Error ? error.message : String(error) });
      } finally {
        this.controller = null;
      }
    })();
  }

  stop(): void {
    this.move({ type: 'stop' });
    this.controller?.abort();
  }

  settled(): Promise<void> { return this.pending; }

  private move(event: ReviewEvent): void {
    const next = stepReview(this.state, event);
    if (next === this.state) return;
    this.state = next;
    this.changed();
  }
}
