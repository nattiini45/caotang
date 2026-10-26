/**
 * A golden writing task (agent-harness §9): one writer workflow, its fixture project, the deterministic checks that say it was done
 * well, and the synthetic model that authors its cassette. CI replays the committed cassette through the mock gateway; the task's
 * checks run over what the replayed turn did, and every request must match the recording.
 */

import type { MockScript } from '@caotang/gateway/mock';
import type { ProjectState } from '@caotang/store';

import type { Check } from '../../src/agent/checks.js';
import type { Expectation, ScenarioDecision } from '../../src/agent/eval.js';
import type { ToolName } from '../../src/metadata.js';

export type { CassetteHeader } from '../../src/agent/cassette.js';

export type GoldenCategory = 'draft' | 'continue' | 'rewrite' | 'synopsis' | 'structure' | 'metadata' | 'continuity' | 'codex' | 'screenplay' | 'dialogue' | 'storyboard' | 'refusal' | 'economy';

export interface GoldenTask {
  /** The name of the task's directory. */
  readonly id: string;
  readonly category: GoldenCategory;
  readonly intent: string;
  readonly project: () => ProjectState;
  readonly decisions?: readonly ScenarioDecision[];
  readonly preload?: readonly ToolName[];
  /** What the harness shows beyond the checks: the turn's status, its cards and its trace. */
  readonly expect: Pick<Expectation, 'status'> & Omit<Expectation, 'status' | 'maxModelCalls' | 'maxTokens'>;
  /** The run-context checks of the task: does the written text do the job. */
  readonly checks: readonly Check[];
  /** Turn-level ceilings that hold for any competent model, so a benchmark row can fail on economy. */
  readonly budgets?: { readonly maxModelCalls?: number; readonly maxTokens?: number };
  /** The synthetic model: the scripts that answer when the cassette is authored. A person wrote these answers; no model did. */
  readonly script: () => readonly MockScript[];
}
