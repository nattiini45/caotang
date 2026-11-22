/**
 * One opening at a time, whichever surface asked for it (#774): the change offer's reopen and the projects list both put a project
 * in front of the writer, and a reopen that clears the session while a chosen project is still opening loses the writer's choice.
 */

import { describe, expect, it } from 'vitest';

import { openInTurn } from '../src/app/open-queue.js';

const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

describe('the opening queue', () => {
  it('runs the next opening only once the one asked for before it has finished', async () => {
    const log: string[] = [];
    const reopen = openInTurn(async () => {
      log.push('reopen started');
      await tick();
      log.push('reopen finished');
      return 'folder';
    });
    const chosen = openInTurn(async () => {
      log.push('chosen started');
      return 'project';
    });
    expect(await Promise.all([reopen, chosen])).toEqual(['folder', 'project']);
    expect(log).toEqual(['reopen started', 'reopen finished', 'chosen started']);
  });

  it('still runs the opening behind one that failed', async () => {
    const failed = openInTurn(async () => {
      throw new Error('the folder would not open');
    });
    const next = openInTurn(async () => 'project');

    await expect(failed).rejects.toThrow('the folder would not open');
    await expect(next).resolves.toBe('project');
  });
});
