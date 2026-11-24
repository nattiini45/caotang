// @vitest-environment jsdom

/**
 * What a hosted project keeps on this device rather than on the account (hosted.md §7): the marks that refuse a server serving older
 * ciphertext. They are per project and per account, and they have to survive junk and a store that is full.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { hostedMarksKey, loadHostedMarks, saveHostedMarks } from '../src/app/hosted-marks.js';
import { setStorageScope } from '../src/app/storage-scope.js';

beforeEach(() => {
  localStorage.clear();
  setStorageScope(null);
});

describe('the rollback marks', () => {
  it('keeps the marks for the next open', () => {
    expect(loadHostedMarks('p_lighthouse')).toEqual([]);
    saveHostedMarks('p_lighthouse', [['abc', 3], ['def', 1]]);
    expect(loadHostedMarks('p_lighthouse')).toEqual([['abc', 3], ['def', 1]]);
  });

  it('forgets every mark when there are none, so a device trusts what it meets', () => {
    saveHostedMarks('p_lighthouse', [['abc', 3]]);
    saveHostedMarks('p_lighthouse', []);
    expect(loadHostedMarks('p_lighthouse')).toEqual([]);
    expect(localStorage.getItem(hostedMarksKey('p_lighthouse'))).toBeNull();
  });

  it('drops a value this build did not write instead of trusting it', () => {
    localStorage.setItem(hostedMarksKey('p_lighthouse'), 'not json');
    expect(loadHostedMarks('p_lighthouse')).toEqual([]);
    localStorage.setItem(hostedMarksKey('p_lighthouse'), JSON.stringify([['abc', 'three'], ['def', 0], [], ['ghi', 2]]));
    expect(loadHostedMarks('p_lighthouse')).toEqual([['ghi', 2]]);
  });

  it('keeps two accounts’ marks apart', () => {
    setStorageScope('acc_one');
    saveHostedMarks('p_lighthouse', [['abc', 3]]);
    setStorageScope('acc_two');
    expect(loadHostedMarks('p_lighthouse')).toEqual([]);
  });
});
