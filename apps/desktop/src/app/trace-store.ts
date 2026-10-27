/**
 * The tab's agent trace (agent-harness §5.2): the in-memory store, the switch that turns it on and off, and the one place the
 * writer's export is made.
 *
 * Everything here is memory. The store lives as long as the page does and is written to no IndexedDB record, no project, no bundle
 * and nothing over the network; a reload starts empty. It is owned by the provider service, whose gateway it listens to, and it is
 * handed to the agent sessions as a sink. It is not reachable from the command bus, an agent tool or the MCP server, so the model
 * cannot read its own earlier prompts.
 *
 * Off means off: no observer is attached to the gateway, the sessions are given no sink, and what was kept is cleared at once.
 * A model call already under way tells nothing either: its observer writes through the switch, so its reply never lands.
 */

import { createTraceStore, traceGateway, type TraceExportOptions, type TraceSink, type TraceStore } from '@caotang/harness';
import type { Gateway } from '@caotang/gateway';

/** A label for this tab's trace, stamped on every record: `tab-` and eight hex digits from the browser's random source. */
function tabSessionId(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return `tab-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export class TabTrace {
  readonly store: TraceStore;
  private on = false;
  private project = '';
  private version = 0;

  constructor(private readonly gateway: Pick<Gateway, 'setObserver'>) {
    this.store = createTraceStore({ sessionId: tabSessionId(), project: () => this.project });
    this.store.subscribe(() => {
      this.version += 1;
    });
  }

  /** Whether turns are being recorded now. */
  get enabled(): boolean {
    return this.on;
  }

  /** Turns recording on or off (Settings › Agent, "Keep agent traces for this tab"). Turning it off drops what was kept. */
  keep(enabled: boolean): void {
    if (enabled === this.on) return;
    this.on = enabled;
    if (enabled) {
      // A call under way keeps the observer it started with, so the sink it writes through checks the switch on every record.
      this.gateway.setObserver(traceGateway({ write: (record) => { if (this.on) this.store.write(record); } }));
    } else {
      this.gateway.setObserver(undefined);
      this.store.clear();
    }
  }

  /** The sink a session writes its turns to, or `undefined` while recording is off. */
  sink = (): TraceSink | undefined => (this.on ? this.store : undefined);

  /** The project the export header names. Read at export time, so it is the project open then. */
  setProject(name: string): void {
    this.project = name;
  }

  /** The JSONL for a turn (or the reviews group), or for every turn held. */
  export(options: TraceExportOptions = {}): string {
    return this.store.toJsonl(options);
  }

  /** Clears the trace now. Recording stays as it was. */
  clear(): void {
    this.store.clear();
  }

  /** A number that changes whenever the store does: what a view subscribes to. */
  snapshot = (): number => this.version;

  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);
}

/** The file a trace export is saved as: `<project>-trace-<turn>.jsonl`, with the turn's id as the harness names it (or `all`). */
export function traceFileName(project: string, turnId: string | undefined): string {
  const stem = project.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'project';
  const turn = turnId === undefined ? 'all' : turnId.replace(/[^\p{L}\p{N}._-]+/gu, '-');
  return `${stem}-trace-${turn}.jsonl`;
}
