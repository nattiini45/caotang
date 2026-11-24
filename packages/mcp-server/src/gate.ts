/**
 * The pause a desktop app asks for while it saves (desktop.md §The project's own MCP server).
 *
 * One folder can have two writers: this server and the app that started it. The server's writes are atomic per file, and the app
 * checks each file's digest before it replaces it, so the window both can lose a change in is the instant between the app's check
 * and its rename. The app closes that window itself: it asks for a pause, and the pause is a barrier — it raises the gate so no new
 * write can start, then answers only once every write already admitted has finished. The app saves while nothing of the server's is
 * writing, and resumes. A folder with no write in flight answers at once.
 *
 * A pause and the resume that lets it go name each other with a lease, because the two calls can cross: the app stops waiting for one
 * it has sent, sends the resume, and the pause lands after it. A resume that reached the gate first cancels that lease, so the pause
 * it belongs to never stands. A call with no lease is a pause of its own, as counting always was.
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
   * Raises a pause, then answers once every write already admitted has released. The pause stands before this returns its promise, so a
   * write asked for after this call is refused rather than admitted behind it. `lease` names this pause for the resume that lets it go;
   * a lease whose resume arrived first is already let go, and the pause never stands.
   */
  pause(lease?: string): Promise<PauseState>;
  /**
   * Lifts `lease`'s pause. Without one it lifts the oldest pause standing, which is the counting pair for a pause that named no lease. A
   * lease with nothing standing is remembered, so a pause that lands after its resume does not stand either.
   */
  resume(lease?: string): PauseState;
  /** The pause as it stands, for a status call. */
  state(): PauseState;
}

/** How many leases a resume reached before their pause did are remembered. A pause later than this many such resumes cannot arrive. */
const LET_GO_REMEMBERED = 16;

/**
 * A gate with a clock the tests set. A pause counts: asking twice keeps the first instant and lifts only when the second resume
 * arrives, because the app that asks twice is two saves overlapping, and the first of them finishing is not the folder being free.
 * A pause is also a barrier: it answers once the writes in flight have released, and a folder with none answers at once. A resume
 * with no pause standing is not an error — it answers what the gate already said. A pause and its resume may name each other with a
 * lease: a resume that arrives first is remembered and cancels the pause when it lands, so the pair holds whatever order they cross in.
 */
export function createWriteGate(now: () => Date = () => new Date()): WriteGate {
  /** The pauses standing, by the lease they were raised with (or a number of their own), and the instant the first of them began. */
  const standing = new Set<string>();
  let since: string | undefined;
  /** The leases a resume reached while no pause of theirs stood: their pause is one still in flight, and it does not stand when it lands. */
  const letGo: string[] = [];
  /** The calls waiting for the writes in flight to release, by the pause they belong to. */
  const waiting = new Map<string, (() => void)[]>();
  let unnamed = 0;
  let inFlight = 0;

  const stateOf = (): PauseState => (standing.size === 0 ? { paused: false } : { paused: true, since: since ?? now().toISOString() });

  const settle = (): void => {
    if (inFlight > 0 || waiting.size === 0) return;
    // Every waiter is taken before any of them runs, so a continuation that raises a pause of its own meets a map of its own.
    const lists = [...waiting.values()];
    waiting.clear();
    for (const list of lists) for (const resolve of list) resolve();
  };

  /** Lets a pause go: it stops standing, and every call still waiting on it answers the state that is left. */
  const lift = (key: string): void => {
    standing.delete(key);
    if (standing.size === 0) since = undefined;
    const list = waiting.get(key);
    if (list === undefined) return;
    waiting.delete(key);
    for (const resolve of list) resolve();
    settle();
  };

  return {
    paused: () => standing.size > 0,
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
    pause: (lease) => {
      const key = lease ?? `#${(unnamed += 1)}`;
      const letGoAt = lease === undefined ? -1 : letGo.indexOf(lease);
      if (letGoAt !== -1) {
        // This pause's resume arrived first. It was let go before it ever stood, so it does not stand now and has nothing to wait for.
        letGo.splice(letGoAt, 1);
        return Promise.resolve(stateOf());
      }
      if (!standing.has(key)) {
        since ??= now().toISOString();
        standing.add(key);
      }
      if (inFlight === 0) return Promise.resolve(stateOf());
      return new Promise<PauseState>((resolve) => {
        const list = waiting.get(key);
        if (list === undefined) waiting.set(key, [() => resolve(stateOf())]);
        else list.push(() => resolve(stateOf()));
      });
    },
    resume: (lease) => {
      if (lease === undefined) {
        const oldest = standing.values().next();
        if (oldest.done !== true) lift(oldest.value);
        return stateOf();
      }
      if (standing.has(lease)) {
        lift(lease);
        return stateOf();
      }
      letGo.push(lease);
      if (letGo.length > LET_GO_REMEMBERED) letGo.shift();
      return stateOf();
    },
    state: stateOf,
  };
}
