import { assertNever, defineMachine, type MachineTable } from '@caotang/machine';

export type SaveChannelState =
  | { readonly kind: 'idle'; readonly failure: null }
  | { readonly kind: 'writing'; readonly pending: number; readonly failure: string | null }
  | { readonly kind: 'failed'; readonly failure: string };

export type SaveChannelEvent =
  | { readonly type: 'enqueue' }
  | { readonly type: 'settle'; readonly failure: string | null };

export const saveChannelTable: MachineTable<SaveChannelState, SaveChannelEvent> = {
  id: 'save.channel', initial: 'idle', final: [],
  on: {
    idle: { enqueue: ['writing'] },
    writing: { enqueue: ['writing'], settle: ['idle', 'writing', 'failed'] },
    failed: { enqueue: ['writing'] },
  },
};

export function stepSaveChannel(state: SaveChannelState, event: SaveChannelEvent): SaveChannelState {
  switch (event.type) {
    case 'enqueue':
      return { kind: 'writing', pending: state.kind === 'writing' ? state.pending + 1 : 1, failure: state.failure };
    case 'settle':
      if (state.kind !== 'writing') return state;
      if (state.pending > 1) return { kind: 'writing', pending: state.pending - 1, failure: event.failure };
      return event.failure === null ? { kind: 'idle', failure: null } : { kind: 'failed', failure: event.failure };
    default:
      return assertNever(event);
  }
}

export const saveChannelMachine = defineMachine(saveChannelTable, stepSaveChannel);
export type SaveChannelName = 'project' | 'findings' | 'tasks' | 'settings';

export class SaveChannel {
  private state: SaveChannelState = { kind: 'idle', failure: null };
  private chain: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(readonly name: SaveChannelName) {}

  readonly getSnapshot = (): SaveChannelState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  enqueue(write: () => Promise<string | null>): Promise<string | null> {
    this.send({ type: 'enqueue' });
    const run = this.chain.then(async () => {
      let failure: string | null;
      try {
        failure = await write();
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      this.send({ type: 'settle', failure });
      return failure;
    });
    this.chain = run.then(() => undefined);
    return run;
  }

  settled(): Promise<void> {
    return this.chain;
  }

  private send(event: SaveChannelEvent): void {
    this.state = stepSaveChannel(this.state, event);
    for (const listener of this.listeners) listener();
  }
}

export type SaveState = 'saved' | 'saving' | 'failed' | 'conflict';
export interface SaveSource {
  readonly state: SaveState;
  readonly channel?: SaveChannelName;
}

export function channelSource(channel: SaveChannel): SaveSource {
  const state = channel.getSnapshot();
  return {
    state: state.failure !== null ? 'failed' : state.kind === 'writing' ? 'saving' : 'saved',
    channel: channel.name,
  };
}

export function aggregateSaveState(sources: readonly SaveSource[]): SaveState {
  for (const state of ['conflict', 'failed', 'saving'] as const) {
    if (sources.some((source) => source.state === state)) return state;
  }
  return 'saved';
}
