import { newId, type RandomBytes } from '@caotang/ids';

/** A `t_` id not in `taken`: ten Crockford base32 characters, as every id in the family. */
export function newTaskId(taken: ReadonlySet<string>, randomBytes?: RandomBytes): string {
  return newId('t', { taken, ...(randomBytes === undefined ? {} : { randomBytes }) });
}
