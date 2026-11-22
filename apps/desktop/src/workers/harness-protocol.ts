
import type { ScanComputeOutcome } from '@caotang/coherence';
import type { AssembledCall, LanguagePolicy, ProjectedContextInput, ScanWorkerInput } from '@caotang/harness';

export type HarnessWorkerRequest =
  | { readonly id: number; readonly op: 'assemble'; readonly input: ProjectedContextInput; readonly role: string; readonly languages?: LanguagePolicy }
  | { readonly id: number; readonly op: 'scan'; readonly input: ScanWorkerInput };

export type HarnessWorkerReply =
  | { readonly id: number; readonly ok: true; readonly op: 'assemble'; readonly call: AssembledCall }
  | { readonly id: number; readonly ok: true; readonly op: 'scan'; readonly outcome: ScanComputeOutcome }
  | { readonly id: number; readonly ok: false; readonly error: string };