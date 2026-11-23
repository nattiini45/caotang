/**
 * The pause a desktop app asks for while it saves (desktop.md §The project's own MCP server).
 *
 * One folder can have two writers: this server and the app that started it. The server's writes are atomic per file, and the app
 * checks each file's digest before it replaces it, so the window both can lose a change in is the instant between the app's check
 * and its rename. The app closes that window itself: it asks for a pause, saves while no new write can start, and resumes. A write
 * already running when the pause arrives finishes — the app's digest check then refuses the file it was about to replace and asks
 * the writer, which is what the pair did before this existed.
 *
 * A gate is only ever created by a server a person or an app started, never by a request: `startHttpServer` is given one, the
 * control endpoints read it, and the guard refuses a write tool while it is paused.
 */

/** A pause as the control endpoint answers it, so the caller can tell a fresh pause from one already in place. */
export interface PauseState {
  readonly paused: boolean;
  /** When the current pause began, as an ISO instant; absent while the server is not paused. */
  readonly since?: string;
}

export interface WriteGate {
  /** Whether a write tool must be refused right now. Read by the guard on every request, so it answers with the pause's live state. */
  paused(): boolean;
  pause(): PauseState;
  resume(): PauseState;
  /** The pause as it stands, for a status call. */
  state(): PauseState;
}

/**
 * A gate with a clock the tests set. A pause counts: asking twice keeps the first instant and lifts only when the second resume
 * arrives, because the app that asks twice is two saves overlapping, and the first of them finishing is not the folder being free.
 * A resume with no pause standing is not an error — it answers what the gate already said.
 */
export function createWriteGate(now: () => Date = () => new Date()): WriteGate {
  let since: string | undefined;
  let depth = 0;
  return {
    paused: () => depth > 0,
    pause: () => {
      since ??= now().toISOString();
      depth += 1;
      return { paused: true, since };
    },
    resume: () => {
      depth = Math.max(0, depth - 1);
      if (depth > 0) return { paused: true, since: since ?? now().toISOString() };
      since = undefined;
      return { paused: false };
    },
    state: () => (depth === 0 ? { paused: false } : { paused: true, since: since ?? now().toISOString() }),
  };
}
