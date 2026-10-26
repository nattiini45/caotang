/**
 * The applies of the three agent-file commands — `project.setInstructions`, `memory.write` and `memory.forget`
 * ([context-assembly.md §2](docs/architecture/context-assembly.md), layer LI). Their descriptors are the bus's (`agentFileCommands`).
 *
 * The files are `ProjectState.agentFiles`, replaced as a whole by each apply and never edited in place. An apply also keeps
 * `removedAgentFiles` right: a path the change takes out is listed for the next save to remove, and a path it puts back is not. The folder
 * is written by the next save (write.ts), the browser store by the next state write.
 *
 * Every apply reports its own undo once, after the change, as a restore of the files and of the removals as they were. An undone `memory.write`
 * of a new note therefore leaves no note and no file, and an undone forget brings the note back and keeps its file.
 */

import {
  agentFileCommands,
  type ApplyContext,
  type CommandApply,
  type CommandRegistry,
  type MemoryForgetParams,
  type MemoryWriteParams,
  type ProjectSetInstructionsParams,
} from '@caotang/bus';

import { INSTRUCTIONS_FALLBACK, INSTRUCTIONS_FILE, agentFileTexts, memoryIndexOf, memoryPath, type AgentFiles, type MemoryFile } from './agent-files.js';
import type { ProjectState } from './state.js';

type AgentApply<P> = CommandApply<P, ProjectState>;

/** The clock seam the note's `modified` is stamped from. Structural, so the store's `CommandClock` satisfies it. */
export interface AgentFilesClock {
  now(): number;
}

const bySlug = (a: MemoryFile, b: MemoryFile): number => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

/** Puts `next` in the state and keeps the removals right: what it takes out is listed, and what it holds is not. `AGENTS.md` is read-only, so it is never listed. */
function hold(state: ProjectState, next: AgentFiles): void {
  const before = new Set(Object.keys(agentFileTexts(state.agentFiles)));
  const after = new Set(Object.keys(agentFileTexts(next)));
  for (const path of before) if (!after.has(path) && path !== INSTRUCTIONS_FALLBACK) state.removedAgentFiles.add(path);
  for (const path of after) state.removedAgentFiles.delete(path);
  state.agentFiles = next;
}

function instructionsApply(): AgentApply<ProjectSetInstructionsParams> {
  return (state, params, context: ApplyContext) => {
    const before = state.agentFiles;
    const created = before.instructions?.path !== INSTRUCTIONS_FILE;
    hold(state, { ...before, instructions: { path: INSTRUCTIONS_FILE, text: params.text } });
    context.undo.compensate(`restore ${INSTRUCTIONS_FILE}`, () => hold(state, before));
    context.report({ affected: [], summary: `${created ? 'created' : 'changed'} ${INSTRUCTIONS_FILE}` });
    return { path: INSTRUCTIONS_FILE, created };
  };
}

function writeApply(clock: AgentFilesClock): AgentApply<MemoryWriteParams> {
  return (state, params, context: ApplyContext) => {
    const before = state.agentFiles;
    const created = !before.memory.some((note) => note.slug === params.slug);
    const agent = context.issuedBy === 'agent';
    const note: MemoryFile = {
      slug: params.slug,
      type: params.type,
      title: params.title,
      body: params.body,
      modified: new Date(clock.now()).toISOString(),
      origin: agent ? 'agent' : 'writer',
      ...(agent && context.turnId !== undefined ? { sourceTurn: context.turnId } : {}),
    };
    const memory = [...before.memory.filter((held) => held.slug !== params.slug), note].sort(bySlug);
    hold(state, { ...before, memory, index: memoryIndexOf(memory) });
    context.undo.compensate(`restore the memory note “${params.title}”`, () => hold(state, before));
    context.report({ affected: [], summary: `${created ? 'saved' : 'updated'} the memory note “${params.title}”` });
    return { slug: params.slug, created, path: memoryPath(params.slug) };
  };
}

function forgetApply(): AgentApply<MemoryForgetParams> {
  return (state, params, context: ApplyContext) => {
    const before = state.agentFiles;
    const path = memoryPath(params.slug);
    const note = before.memory.find((held) => held.slug === params.slug);
    const declined = new Map(before.declined);
    declined.delete(path);
    const memory = before.memory.filter((held) => held.slug !== params.slug);
    // The index lists the notes that are left; with none left it goes too, as a project with no memory has no folder.
    const { index: _index, ...rest } = before;
    hold(state, { ...rest, memory, declined, ...(memory.length === 0 ? {} : { index: memoryIndexOf(memory) }) });
    const title = note?.title ?? params.slug;
    context.undo.compensate(`restore the memory note “${title}”`, () => hold(state, before));
    context.report({ affected: [], summary: `forgot the memory note “${title}”` });
    return { slug: params.slug };
  };
}

/** The apply, narrowed to the registry's state type (the bus does not type project state; see `commands.ts`'s `narrow`). */
function narrow<P>(apply: AgentApply<P>): CommandApply<P, unknown> {
  return apply as CommandApply<P, unknown>;
}

/** The agent-file registrations, for the store's registry. */
export function agentFileCommandRegistrations(options: { readonly clock: AgentFilesClock }): Partial<CommandRegistry> {
  return {
    'project.setInstructions': { descriptor: agentFileCommands.projectSetInstructions, apply: narrow(instructionsApply()) },
    'memory.write': { descriptor: agentFileCommands.memoryWrite, apply: narrow(writeApply(options.clock)) },
    'memory.forget': { descriptor: agentFileCommands.memoryForget, apply: narrow(forgetApply()) },
  };
}
