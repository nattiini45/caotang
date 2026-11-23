/** Another device changed this file (or the project) since this device last looked. Nothing was written. */
export class RemoteConflictError extends Error {
  constructor(readonly path: string) {
    super(`${path} changed on another device since you last opened it. Nothing was overwritten.`);
    this.name = 'RemoteConflictError';
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
