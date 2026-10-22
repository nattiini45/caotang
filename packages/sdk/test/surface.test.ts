import { describe, expect, it } from 'vitest';

import * as sdk from '../src/index.js';

describe('the package root', () => {
  it('exports openProject and the SDK’s own errors as values, and no value of an internal package', () => {
    expect(Object.keys(sdk).sort()).toEqual(['FolderChangedError', 'LOCK_FILE', 'NoProjectError', 'ProjectLockedError', 'openProject']);
  });
});
