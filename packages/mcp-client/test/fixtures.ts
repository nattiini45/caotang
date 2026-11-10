/**
 * Two scripted servers and the client that holds them, for the search, invoke and eval tests. Both
 * servers answer from memory, so a test is deterministic and the wire is the mock's. The story server
 * has one description longer than the excerpt cap, and one read-only tool, which is what makes the
 * risk badges and the excerpt tests say something.
 */

import {
  createLoadedTools,
  createMcpClient,
  createMockWireFactory,
  type LoadedTools,
  type McpClient,
  type McpServerConfig,
  type McpSettings,
  type MockMcpScript,
  type WireTool,
} from '../src/index.js';
import { FIXED_NOW, serverFor } from './support.js';

export const STORY_KEY = 's_AAAAAAAAAA';
export const SHELF_KEY = 's_BBBBBBBBBB';

/** Longer than the 200-character excerpt cap, so the cap is exercised and not merely claimed. */
export const LONG_DESCRIPTION =
  'Walk the timeline forward from the opening chapter, noting every date, season and age a character mentions, and flag any gap longer than a week between two scenes that share a location. Report each finding with the chapter it is in.';

export function storyTools(): WireTool[] {
  return [
    {
      name: 'lore_update',
      description: 'Update a lore entry.',
      inputSchema: { type: 'object', properties: { entry: { type: 'string' }, text: { type: 'string' } }, required: ['entry', 'text'] },
    },
    {
      name: 'lore_lookup',
      description: 'Look up a lore entry by name, aliases included.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'timeline_check',
      description: LONG_DESCRIPTION,
      inputSchema: { type: 'object', properties: {} },
    },
  ];
}

export function shelfTools(): WireTool[] {
  return [
    {
      name: 'shelf_search',
      description: 'Search the research shelf.',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      annotations: { readOnlyHint: true },
    },
  ];
}

/** A script whose answers echo the tool and its arguments, so a test can see exactly what was sent. */
export function echoScript(listTools: WireTool[]): MockMcpScript {
  return {
    listTools,
    respond: (tool, args) => ({ content: [{ type: 'text', text: `${tool} ${JSON.stringify(args)}` }] }),
  };
}

export function fixtureScripts(): Record<string, MockMcpScript> {
  return {
    [STORY_KEY]: echoScript(storyTools()),
    [SHELF_KEY]: echoScript(shelfTools()),
  };
}

export function fixtureServers(): McpServerConfig[] {
  return [serverFor(STORY_KEY, 'Story Bible', { url: 'https://story.fixture.test/mcp' }), serverFor(SHELF_KEY, 'Research Shelf', { url: 'https://shelf.fixture.test/mcp' })];
}

export interface OpenedClient {
  readonly client: McpClient;
  readonly loaded: LoadedTools;
  readonly saved: McpSettings[];
}

/**
 * A client over the scripts, with every server connected. `approve` lists the servers the person has
 * reviewed; `trust` lists the servers whose reads they have also trusted. Both are done through the
 * client's own methods, so the test exercises the same path a person's clicks take.
 */
export async function openClient(options: {
  readonly scripts?: Record<string, MockMcpScript>;
  readonly servers?: McpServerConfig[];
  readonly approve?: readonly string[];
  readonly trust?: readonly string[];
  readonly connect?: readonly string[];
  readonly enabled?: boolean;
}): Promise<OpenedClient> {
  const servers = options.servers ?? fixtureServers();
  const saved: McpSettings[] = [];
  const client = createMcpClient({
    settings: { enabled: options.enabled ?? true, servers },
    wire: createMockWireFactory(options.scripts ?? fixtureScripts()),
    now: () => FIXED_NOW,
    onChange: (settings) => { saved.push(settings); },
  });
  const connect = options.connect ?? servers.map((server) => server.key);
  for (const key of connect) await client.connect(key);
  for (const key of options.approve ?? []) {
    const fingerprint = client.review(key)?.fingerprint ?? '';
    const approved = await client.approveReview(key, fingerprint);
    if (!approved.ok) throw new Error(`fixture approval failed: ${approved.error}`);
  }
  for (const key of options.trust ?? []) {
    const trusted = await client.setTrustReads(key, true);
    if (!trusted.ok) throw new Error(`fixture trust failed: ${trusted.error}`);
  }
  return { client, loaded: createLoadedTools(), saved };
}

export function qualified(serverKey: string, toolName: string): string {
  return `mcp__${serverKey}__${toolName}`;
}
