/**
 * Recurring tasks are the writer's (agent-harness.md §12, decisions.md): they are made, changed and removed in the app, and neither the
 * agent nor an MCP client has a tool for them. A tool that could make a task could make the agent start itself.
 */

import { describe, expect, it } from 'vitest';

import { TOOL_METADATA, TOOL_NAMES } from '../src/index.js';
import { makeHarness } from './fixtures.js';

describe('the agent has no tool for recurring tasks', () => {
  it('names no tool for a task or the tasks file, and describes none in terms of them', () => {
    expect(TOOL_NAMES.filter((name) => /task|schedul|recurr/i.test(name))).toEqual([]);
    const described = Object.values(TOOL_METADATA).filter((row) => /tasks\.json|recurring task|scheduled task/i.test(row.description));
    expect(described.map((row) => row.name)).toEqual([]);
  });

  it('lists none in the harness’s own listing', () => {
    const harness = makeHarness();
    expect(harness.tools().filter((tool) => /task|schedul|recurr/i.test(tool.name))).toEqual([]);
  });
});
