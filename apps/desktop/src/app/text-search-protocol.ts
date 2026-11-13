import type { CommandError, Result } from '@caotang/bus';
import type { CallParams, ToolValue } from '@caotang/harness';
import type { SearchState } from '@caotang/retrieval';

export interface TextSearchRequest {
  readonly id: number;
  readonly state: SearchState;
  readonly params: CallParams;
  readonly withheld?: ReadonlySet<string>;
}

export interface TextSearchReply {
  readonly id: number;
  readonly result: Result<ToolValue, CommandError>;
}
