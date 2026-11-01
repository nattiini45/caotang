/**
 * Same-day stacking: a start-sorted sweep with an interval-end min-heap ([timeline.md §3.2](../../../docs/architecture/timeline.md)).
 * Windows are half-open (`windowOf`), so a window that ends on a day frees its row for one that starts on that day.
 */

export class MinHeap<T> {
  private readonly data: T[] = [];

  constructor(private readonly before: (a: T, b: T) => boolean) {}

  get size(): number {
    return this.data.length;
  }

  peek(): T | undefined {
    return this.data[0];
  }

  push(value: T): void {
    const data = this.data;
    let at = data.length;
    data.push(value);
    while (at > 0) {
      const parent = (at - 1) >> 1;
      const up = data[parent] as T;
      if (!this.before(value, up)) break;
      data[at] = up;
      at = parent;
    }
    data[at] = value;
  }

  pop(): T | undefined {
    const data = this.data;
    const top = data[0];
    const last = data.pop();
    if (last === undefined || data.length === 0) return top;
    let at = 0;
    const half = data.length >> 1;
    while (at < half) {
      let child = 2 * at + 1;
      const right = child + 1;
      if (right < data.length && this.before(data[right] as T, data[child] as T)) child = right;
      const smaller = data[child] as T;
      if (!this.before(smaller, last)) break;
      data[at] = smaller;
      at = child;
    }
    data[at] = last;
    return top;
  }
}

export interface Interval {
  readonly start: number;
  readonly end: number;
}

interface Active {
  end: number;
  row: number;
}

/**
 * Assigns each interval the lowest row not held by an interval that is still running. `sorted` must already be in
 * start order; ties keep the order given, so the caller's tie-break (reading index) decides who sits on top.
 */
export function packRows(sorted: readonly Interval[]): { rows: number[]; rowCount: number } {
  const running = new MinHeap<Active>((a, b) => a.end < b.end || (a.end === b.end && a.row < b.row));
  const free = new MinHeap<number>((a, b) => a < b);
  const rows: number[] = new Array<number>(sorted.length);
  let rowCount = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const interval = sorted[i] as Interval;
    for (let top = running.peek(); top !== undefined && top.end <= interval.start; top = running.peek()) {
      free.push((running.pop() as Active).row);
    }
    const reused = free.pop();
    const row = reused ?? rowCount++;
    rows[i] = row;
    running.push({ end: interval.end, row });
  }
  return { rows, rowCount };
}
