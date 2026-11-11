import { ApplyRefusal, projectRestoreRun, type CommandRegistry, type ProjectRestoreRunParams, type CommandApply } from '@caotang/bus';

import { agentFileTexts } from './agent-files.js';
import { emptyCoherenceState } from './coherence-state.js';
import { assetIdsInValue, type UndoRetentionLedger } from './picture-retention.js';
import { getRevisionFloor, type ProjectState } from './state.js';

export interface StagedRunRestore {
  readonly state: ProjectState;
  readonly expected: string;
  readonly onUndo?: () => void;
  readonly retainedAssets?: readonly string[];
}

export interface RunRestorePort {
  read(runId: string): StagedRunRestore | undefined;
  beforeReplace?(before: ProjectState, next: ProjectState): void;
}

export function runRestoreSignature(state: ProjectState): string {
  return JSON.stringify(state, (_key, value: unknown) => value instanceof Map ? [...value] : value instanceof Set ? [...value] : value);
}

function replaceMap<T>(target: Map<string, T>, source: ReadonlyMap<string, T>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

function replaceState(state: ProjectState, source: ProjectState): void {
  const copy = structuredClone(source);
  const removedSkills = [...state.skills].flatMap(([folder, files]) => files.map((file) => `.agents/skills/${folder}/${file.path}`));
  const keptSkills = new Set([...copy.skills].flatMap(([folder, files]) => files.map((file) => `.agents/skills/${folder}/${file.path}`)));
  const keptAgentFiles = agentFileTexts(copy.agentFiles);
  const removedAgentFiles = Object.keys(agentFileTexts(state.agentFiles)).filter((path) => !(path in keptAgentFiles));
  const pendingSkills = [...state.removedSkillFiles];
  const pendingAgentFiles = [...state.removedAgentFiles];
  const floors = new Map(state.revisionFloors);
  for (const [id, document] of state.documents) floors.set(id, Math.max(floors.get(id) ?? 0, document.revision));
  for (const [id, revision] of copy.revisionFloors ?? []) floors.set(id, Math.max(floors.get(id) ?? 0, revision));
  for (const [id, document] of copy.documents) {
    document.revision = Math.max(document.revision, getRevisionFloor(state, id), floors.get(id) ?? 0) + 1;
    floors.set(id, document.revision);
  }
  state.revisionFloors = floors;
  state.manifest = copy.manifest;
  replaceMap(state.documents, copy.documents);
  replaceMap(state.declinedText, copy.declinedText);
  replaceMap(state.skills, copy.skills);
  for (const field of ['declinedCodexFiles', 'declinedDocFiles', 'removedSkillFiles', 'removedAgentFiles'] as const) {
    state[field].clear();
    for (const value of copy[field]) state[field].add(value);
  }
  for (const path of [...pendingSkills, ...removedSkills]) state.removedSkillFiles.add(path);
  for (const path of keptSkills) state.removedSkillFiles.delete(path);
  for (const path of [...pendingAgentFiles, ...removedAgentFiles]) state.removedAgentFiles.add(path);
  for (const path of Object.keys(keptAgentFiles)) state.removedAgentFiles.delete(path);
  state.agentFiles = copy.agentFiles;
  state.coherence = copy.coherence ?? emptyCoherenceState();
}

export function runRestoreRegistrations(port: RunRestorePort | undefined, retention: UndoRetentionLedger | undefined): Partial<CommandRegistry> {
  if (port === undefined) return {};
  const apply: CommandApply<ProjectRestoreRunParams, ProjectState> = (state, params, context) => {
    const staged = port.read(params.runId);
    if (staged === undefined || staged.state.manifest.project.id !== state.manifest.project.id) {
      throw new ApplyRefusal({ code: 'not-found', message: 'the run has no validated restore point for this project', correctiveHint: 'choose a run from this project and prepare its restore again' });
    }
    if (runRestoreSignature(state) !== staged.expected) {
      throw new ApplyRefusal({ code: 'revision-conflict', message: 'the project changed after the restore confirmation opened; nothing was restored', correctiveHint: 'review the current project, then open the restore confirmation again' });
    }
    const before = structuredClone(state);
    retention?.note(context.commandId, [...assetIdsInValue([before.manifest, ...[...before.documents.values()].map((document) => document.body), agentFileTexts(before.agentFiles)]), ...(staged.retainedAssets ?? [])], 'a run restore capture');
    port.beforeReplace?.(state, staged.state);
    replaceState(state, staged.state);
    context.undo.compensate('put back the project from before the run restore', () => {
      port.beforeReplace?.(state, before);
      replaceState(state, before);
      staged.onUndo?.();
    });
    context.report({ affected: state.manifest.tree.map((node) => ({ nodeId: node.id, title: node.title })), summary: 'restored the project to before the agent run' });
    return { runId: params.runId };
  };
  return { 'project.restoreRun': { descriptor: projectRestoreRun, apply: apply as CommandApply<ProjectRestoreRunParams, unknown> } };
}
