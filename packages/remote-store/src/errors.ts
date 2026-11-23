/** Another device changed one or more of these files (or the project's index) since this device last looked. Nothing was written. */
export class RemoteConflictError extends Error {
  /** Every path of the refused batch that changed elsewhere; `path` is the first, for a caller that names one. */
  readonly paths: readonly string[];

  constructor(
    readonly path: string,
    paths?: readonly string[],
  ) {
    const changed = paths !== undefined && paths.length > 0 ? [...paths] : [path];
    const named = changed.length <= 3 ? changed.join(', ') : `${changed.slice(0, 3).join(', ')} and ${changed.length - 3} more`;
    super(`${named} changed on another device since you last opened ${changed.length === 1 ? 'it' : 'them'}. Nothing was overwritten.`);
    this.name = 'RemoteConflictError';
    this.paths = changed;
  }
}

/** The server returned bytes that are not what this project wrote: missing, altered, swapped or malformed. */
export class RemoteIntegrityError extends Error {
  constructor(
    readonly path: string | null,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(`${path ?? 'the project index'}: ${detail}`, options);
    this.name = 'RemoteIntegrityError';
  }
}

/** The account's storage allowance is exhausted (HTTP 507). Nothing was written. */
export class RemoteQuotaExceededError extends Error {
  constructor() {
    super('the account’s storage allowance is exhausted');
    this.name = 'RemoteQuotaExceededError';
  }
}
