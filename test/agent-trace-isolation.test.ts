/**
 * The agent trace is the one place the app keeps prompts, so it has to stay where it was put (agent-harness §5.2): in the tab's memory,
 * written by the gateway's observer and the agent loop, read by the Trace tab, and by nothing the model can reach. The model reaches
 * the project through the command bus, the harness's tools and the MCP server, so none of those may import the store.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createAgentPorts, createHarness } from '../packages/harness/src/index.js';
import { makeState } from '../packages/harness/test/fixtures.js';

const repoRoot = resolve(__dirname, '..');

function sourcesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...sourcesUnder(path));
    else if (/\.(?:ts|tsx)$/.test(name)) found.push(path);
  }
  return found;
}

const TRACE_NAMES = /\b(?:createTraceStore|TraceStore|TabTrace|traceGateway|TraceSink)\b|agent\/trace\.js|trace-store\.js/;

describe('nothing the model can reach touches the trace store', () => {
  // Where the model's tools live: the bus, the harness's registry and commands, the MCP server and client, and the SDK.
  const reachable = [
    'packages/bus/src',
    'packages/harness/src/tools',
    'packages/harness/src/commands',
    'packages/mcp-server/src',
    'packages/mcp-client/src',
    'packages/sdk/src',
  ];

  it.each(reachable)('%s does not import or name it', (dir) => {
    const root = resolve(repoRoot, dir);
    let files: string[] = [];
    try {
      files = sourcesUnder(root);
    } catch {
      return;
    }
    const offenders = files.filter((file) => TRACE_NAMES.test(readFileSync(file, 'utf8'))).map((file) => relative(repoRoot, file));
    expect(offenders).toEqual([]);
  });

  it('is written only by the loop, the eval runner and the app', () => {
    const writers = sourcesUnder(resolve(repoRoot, 'packages/harness/src'))
      .filter((file) => TRACE_NAMES.test(readFileSync(file, 'utf8')))
      .map((file) => relative(repoRoot, file).split(sep).join('/'))
      .sort();
    expect(writers).toEqual(['packages/harness/src/agent/eval.ts', 'packages/harness/src/agent/loop.ts', 'packages/harness/src/agent/trace.ts', 'packages/harness/src/index.ts']);
  });

  it('is not a tool: no registry row is named for it or reads it', () => {
    const harness = createHarness({ state: makeState(), ports: createAgentPorts() });
    const rows = harness.tools();
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.filter((row) => /\btrace\b/i.test(`${row.name} ${row.description}`)).map((row) => row.name)).toEqual([]);
  });
});
