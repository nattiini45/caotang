import type { McpReadHook } from '@caotang/harness';

export const MCP_HOOK_LIMIT = 20;
export type McpHooksByProject = Readonly<Record<string, readonly McpReadHook[]>>;

export function mcpHooksForProject(hooks: McpHooksByProject, projectId: string): readonly McpReadHook[] {
  return Object.hasOwn(hooks, projectId) ? hooks[projectId] ?? [] : [];
}

function readHook(value: unknown): McpReadHook | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { id, name, enabled, event, tool, serverKey, toolName, pin, failClosed } = value as Record<string, unknown>;
  if (typeof id !== 'string' || !/^r_[0-9A-Z]{10}$/.test(id) ||
      typeof name !== 'string' || name.trim() === '' || name.length > 60 ||
      typeof enabled !== 'boolean' || typeof failClosed !== 'boolean' ||
      (event !== 'tool.before' && event !== 'tool.after') ||
      typeof tool !== 'string' || !/^[a-z][\w.-]{0,79}$/.test(tool) ||
      typeof serverKey !== 'string' || serverKey === '' || serverKey.length > 128 ||
      typeof toolName !== 'string' || toolName === '' || toolName.length > 256 ||
      typeof pin !== 'string' || !/^[a-f0-9]{64}$/.test(pin)) return undefined;
  return { id, name: name.trim(), enabled, event, tool, serverKey, toolName, pin, failClosed };
}

export function readMcpHooks(value: unknown): McpHooksByProject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const projects: [string, McpReadHook[]][] = [];
  for (const [id, stored] of Object.entries(value)) {
    if (id === '' || id.length > 128 || !Array.isArray(stored)) continue;
    const hooks: McpReadHook[] = [];
    for (const entry of stored.slice(0, MCP_HOOK_LIMIT)) {
      const hook = readHook(entry);
      if (hook !== undefined && !hooks.some(item => item.id === hook.id)) hooks.push(hook);
    }
    if (hooks.length > 0) projects.push([id, hooks]);
  }
  return Object.fromEntries(projects);
}
