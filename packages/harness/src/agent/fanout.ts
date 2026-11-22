interface FanOutItem<I> {
  readonly key: string;
  readonly input: I;
}

type FanOutOutcome<O> =
  | { readonly key: string; readonly ok: true; readonly value: O }
  | { readonly key: string; readonly ok: false; readonly error: string };

interface FanOutOptions {
  readonly concurrency: number;
  readonly signal?: AbortSignal;
  readonly onSettled?: (done: number, total: number) => void;
}

export async function fanOut<I, O>(
  items: readonly FanOutItem<I>[],
  work: (input: I, signal: AbortSignal) => Promise<O>,
  options: FanOutOptions,
): Promise<readonly FanOutOutcome<O>[]> {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
    throw new RangeError('Fan-out concurrency must be a positive integer.');
  }
  const signal = options.signal ?? new AbortController().signal;
  const outcomes: FanOutOutcome<O>[] = [];
  let next = 0;
  let done = 0;
  async function worker(): Promise<void> {
    while (!signal.aborted) {
      const index = next++;
      const item = items[index];
      if (item === undefined) return;
      try {
        outcomes[index] = { key: item.key, ok: true, value: await work(item.input, signal) };
      } catch (error) {
        outcomes[index] = { key: item.key, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      options.onSettled?.(++done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, items.length) }, worker));
  return items.map((item, index) => outcomes[index] ?? { key: item.key, ok: false, error: 'Stopped before starting.' });
}
