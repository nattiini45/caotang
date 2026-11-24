/**
 * The pause a desktop app asks for while it saves (desktop.md §The project's own MCP server).
 *
 * One folder can have two writers: this server and the app that started it. The server's writes are atomic per file, and the app
 * checks each file's digest before it replaces it, so the window both can lose a change in is the instant between the app's check
 * and its rename. The app closes that window itself: it asks for a pause, and the pause is a barrier — it raises the gate so no new
 * write can start, then answers only once every write already admitted has finished. The app saves while nothing of the server's is
 * writing, and resumes. A folder with no write in flight answers at once.
 *
 * A gate is only ever created by a server a person or an app started, never by a request: `startHttpServer` is given one, the
 * control endpoints read it, the guard refuses a write tool while it is paused, and the request path admits each write it lets
 * through so a pause can wait for it.
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
  /**
   * Records a write as in flight, and returns the release to call once it settles. The release is idempotent: a request path releases
   * in a `finally`, and one write must never count as two writes finishing.
   */
  admit(): () => void;
  /**
   * Raises the pause, then answers once every write already admitted has released. The depth is raised before this returns its
   * promise, so a write asked for after this call is refused rather than admitted behind the pause.
   */
  pause(): Promise<PauseState>;
  resume(): PauseState;
  /** The pause as it stands, for a status call. */
  state(): PauseState;
}

/**
 * A gate with a clock the tests set. A pause counts: asking twice keeps the first instant and lifts only when the second resume
 * arrives, because the app that asks twice is two saves overlapping, and the first of them finishing is not the folder being free.
 * A pause is also a barrier: it answers once the writes in flight have released, and a folder with none answers at once. A resume
 * with no pause standing is not an error — it answers what the gate already said.
 */
export function createWriteGate(now: () => Date = () => new Date()): WriteGate {
  let since: string | undefined;
  let depth = 0;
  let inFlight = 0;
  /** The pauses waiting for the writes in flight to release; each answers the instant its own pause began. */
  const drained: (() => void)[] = [];

  const settle = (): void => {
    if (inFlight > 0 || drained.length === 0) return;
    // The queue is emptied before the resolves run, so a continuation that admits a write of its own meets a queue of its own.
    for (const resolve of drained.splice(0)) resolve();
  };

  return {
    paused: () => depth > 0,
    admit: () => {
      inFlight += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inFlight -= 1;
        settle();
      };
    },
    pause: () => {
      since ??= now().toISOString();
      const instant = since;
      depth += 1;
      if (inFlight === 0) return Promise.resolve({ paused: true, since: instant });
      // A pause answers the instant it raised, even if a resume arrives before the drain finishes. The app never makes that order, and
      // an answer that flipped to `paused: false` would tell the save its pause failed when the gate did go up.
      return new Promise<PauseState>((resolve) => {
        drained.push(() => resolve({ paused: true, since: instant }));
      });
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
