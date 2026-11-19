import { MODEL_HOOK_LIMIT, MODEL_HOOK_PROMPT_MAX, MODEL_HOOK_TOOLS, modelHookTransformField, type ModelHook } from '@caotang/harness';
import { isIdWithPrefix } from '@caotang/ids';
import { HOOK_NAME_MAX } from '@caotang/bus';

export type ModelHooksByProject = Readonly<Record<string, readonly ModelHook[]>>;

export function modelHooksForProject(hooks: ModelHooksByProject, projectId: string): readonly ModelHook[] {
  return Object.hasOwn(hooks, projectId) ? hooks[projectId] ?? [] : [];
}

export function canTransformModelHook(event: ModelHook['event'], tool: string | null): boolean {
  return event === 'tool.before' && tool !== null && modelHookTransformField(tool) !== undefined;
}

function readHook(value: unknown): ModelHook | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { id, name, enabled, event, tool, prompt, failClosed, canTransform } = value as Record<string, unknown>;
  if (typeof id !== 'string' || !isIdWithPrefix('r', id) ||
      typeof name !== 'string' || name.trim() === '' || name.length > HOOK_NAME_MAX ||
      typeof prompt !== 'string' || prompt.trim() === '' || prompt.length > MODEL_HOOK_PROMPT_MAX ||
      typeof enabled !== 'boolean' || typeof failClosed !== 'boolean' ||
      (event !== 'tool.before' && event !== 'tool.after' && event !== 'turn.end') ||
      typeof tool !== 'string' || (event !== 'turn.end' && !MODEL_HOOK_TOOLS.some(candidate => candidate === tool))) return undefined;
  const common = { id, name: name.trim(), enabled, prompt: prompt.trim() };
  if (event === 'turn.end') return { ...common, event, tool: '', failClosed: false };
  return {
    ...common, event, tool,
    failClosed: event === 'tool.before' && failClosed,
    ...(canTransform === true && canTransformModelHook(event, tool) ? { canTransform: true } : {}),
  };
}

export function readModelHooks(value: unknown): ModelHooksByProject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const projects: [string, ModelHook[]][] = [];
  for (const [id, stored] of Object.entries(value)) {
    if (!isIdWithPrefix('p', id) || !Array.isArray(stored)) continue;
    const hooks: ModelHook[] = [];
    for (const entry of stored.slice(0, MODEL_HOOK_LIMIT)) {
      const hook = readHook(entry);
      if (hook !== undefined && !hooks.some(item => item.id === hook.id)) hooks.push(hook);
    }
    if (hooks.length > 0) projects.push([id, hooks]);
  }
  return Object.fromEntries(projects);
}
