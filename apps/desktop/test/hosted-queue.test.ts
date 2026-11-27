// @vitest-environment jsdom

/**
 * What a hosted project keeps on this device rather than on the account (hosted.md §7): the words an earlier tab could not
 * deliver, and the marks that refuse a server serving older ciphertext. Both are per project, per account, and both have to
 * survive junk, a missing store and a store that is full.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  QUEUE_CAP_CHARS,
  hostedMarksKey,
  hostedQueueKey,
  loadHostedMarks,
  loadHostedQueue,
  saveHostedMarks,
  saveHostedQueue,
} from '../src/app/hosted-queue.js';
import { setStorageScope } from '../src/app/storage-scope.js';

beforeEach(() => {
  localStorage.clear();
  setStorageScope(null);
});

describe('the offline queue', () => {
  it('keeps the text for the next open and forgets it when the account has it', () => {
    expect(loadHostedQueue('p_lighthouse')).toBeNull();
    expect(saveHostedQueue('p_lighthouse', '{"format":1,"edits":[]}')).toBe(true);
    expect(loadHostedQueue('p_lighthouse')).toBe('{"format":1,"edits":[]}');
    expect(saveHostedQueue('p_lighthouse', null)).toBe(true);
    expect(loadHostedQueue('p_lighthouse')).toBeNull();
  });

  it('reads nothing back from an empty value, and keeps a queue per project', () => {
    saveHostedQueue('p_lighthouse', '');
    expect(loadHostedQueue('p_lighthouse')).toBeNull();
    saveHostedQueue('p_lighthouse', 'one');
    saveHostedQueue('p_harbour', 'two');
    expect(loadHostedQueue('p_lighthouse')).toBe('one');
    expect(loadHostedQueue('p_harbour')).toBe('two');
  });

  it('says when a queue is too large to keep, rather than dropping it quietly', () => {
    expect(saveHostedQueue('p_lighthouse', 'x'.repeat(QUEUE_CAP_CHARS + 1))).toBe(false);
    expect(loadHostedQueue('p_lighthouse')).toBeNull();
  });

  it('forgets the queue it kept when the store refuses the newest one', () => {
    // Web Storage keeps the value it already holds when setItem throws, and that value is older than the words in this tab: a next open
    // that read it would send older text as this device's current work. Nothing is kept rather than the wrong thing.
    saveHostedQueue('p_lighthouse', '{"format":1,"edits":[]}');
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
    try {
      expect(saveHostedQueue('p_lighthouse', '{"format":1,"edits":[["docs/a.md",""]],"base":[]}')).toBe(false);
    } finally {
      Storage.prototype.setItem = setItem;
    }
    expect(loadHostedQueue('p_lighthouse')).toBeNull();
  });

  it('forgets the queue it kept when the newest one does not fit', () => {
    // The stored queue is older than what the tab holds, so a next open that read it would present older words as this device's current
    // save and send them over the account. Nothing is kept rather than the wrong thing.
    saveHostedQueue('p_lighthouse', 'the words from before');
    expect(saveHostedQueue('p_lighthouse', 'x'.repeat(QUEUE_CAP_CHARS + 1))).toBe(false);
    expect(loadHostedQueue('p_lighthouse')).toBeNull();
  });

  it('keeps two accounts’ queues apart', () => {
    setStorageScope('acc_one');
    saveHostedQueue('p_lighthouse', 'mine');
    setStorageScope('acc_two');
    expect(loadHostedQueue('p_lighthouse')).toBeNull();
    expect(hostedQueueKey('p_lighthouse')).toContain('acc_two');
    setStorageScope('acc_one');
    expect(loadHostedQueue('p_lighthouse')).toBe('mine');
  });
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
