/** The process-bound half of `RunIo`, shared by `caotang-mcp` and the `caotang mcp serve` command that forwards to it. */

/** Waits for SIGINT or SIGTERM, or, for stdio, for the host to close stdin, then stops the server once. */
export function untilDone(stop: () => Promise<void>, mode: 'http' | 'stdio'): Promise<void> {
  return new Promise((resolve) => {
    let stopping = false;
    const finish = (): void => {
      if (stopping) return;
      stopping = true;
      void stop().then(resolve, resolve);
    };
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
    if (mode === 'stdio') process.stdin.once('end', finish);
  });
}
