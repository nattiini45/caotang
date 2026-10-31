import { expect, test } from '@playwright/test';
import { emptyCoherenceFile } from '../../packages/coherence/src/index.js';
import type { ChatMessage, ChatRequest, ProfileView, ProviderGateway } from '../../packages/gateway/src/index.js';
import {
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectState,
  type CodexEntry,
  type ProjectState,
} from '../../packages/store/src/index.js';

import { gatewayCoherenceModel, planCoherenceReview, runCoherenceReview } from '../../apps/desktop/src/app/coherence-review.js';
import { IDS } from './fixtures.js';

// The codex a review sends for one document is the L2 selection of codex.md §5 and §6: a never entry is never sent, a manual
// entry only when attached to the scene or a folder above it, and a detected entry only when its name or alias is in the text.

const NOW = new Date('2026-10-08T09:00:00.000Z');
const SCENE = 'n_SCX0000001';
const SCENE_BODY = 'Elena walked in. Mara waited.';

const PROFILE = {
  id: 'pr_TESTPROFIL',
  name: 'Test provider',
  kind: 'endpoint',
  endpoint: 'https://example.invalid/v1',
  defaultModel: 'test-model',
  hasKey: true,
} as unknown as ProfileView;

/** A gateway that answers every one-shot request with an empty span list, and keeps the requests it was given. */
function recordingGateway(): { gateway: ProviderGateway; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const gateway = {
    async completeOnce(request: ChatRequest): Promise<ChatMessage> {
      requests.push(request);
      return { role: 'assistant', content: '{"spans":[]}' };
    },
  } as unknown as ProviderGateway;
  return { gateway, requests };
}

function codexEntry(id: string, name: string, extra: Partial<CodexEntry> = {}): CodexEntry {
  return {
    id,
    name,
    aliases: [],
    type: 'character',
    description: `${name}, described.`,
    includePolicy: 'detected',
    caseSensitive: false,
    exclude: [],
    attachments: [],
    keywords: [],
    origin: 'manual',
    sources: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...extra,
  };
}

/** A project with one scene (Chapter 1 holds it) and a second chapter, and the given codex. */
function projectWith(codex: CodexEntry[]): ProjectState {
  const manifest = createEmptyManifest('Codex Book', NOW, { locale: 'en-US' });
  manifest.codex = codex;
  const state = createProjectState(manifest, { now: NOW });
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', id: IDS.chapterOne, now: NOW });
  addDocument(state, { parentId: IDS.chapterOne, title: 'Scene X', id: SCENE, body: SCENE_BODY, now: NOW });
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 2', id: IDS.chapterTwo, now: NOW });
  return state;
}

function planFor(state: ProjectState): string {
  return planCoherenceReview(state, emptyCoherenceFile(), { scope: { mode: 'doc', docIds: [SCENE] }, maxFindings: 10 }).promptPreview;
}

test.describe('the codex a model review sends for one scene (codex.md §5, §6)', () => {
  test('a never entry is absent from the plan preview and from the extraction prompt, though the scene names it', async () => {
    const state = projectWith([codexEntry('c_ELENAAAAAA', 'Elena', { includePolicy: 'never', description: 'SPOILER: Elena lit the lamp.' })]);
    expect(planFor(state)).not.toContain('SPOILER');

    const { gateway, requests } = recordingGateway();
    const plan = planCoherenceReview(state, emptyCoherenceFile(), { scope: { mode: 'doc', docIds: [SCENE] }, maxFindings: 10 });
    await runCoherenceReview({
      state,
      file: emptyCoherenceFile(),
      plan,
      model: gatewayCoherenceModel(gateway, PROFILE),
      maxFindings: 10,
      now: NOW,
    });
    expect(requests.length).toBeGreaterThan(0);
    expect(JSON.stringify(requests)).not.toContain('SPOILER');
  });

  test('a manual entry is sent only when attached to the scene or a folder above it, even when the scene names it', () => {
    const state = projectWith([
      codexEntry('c_MARAAAAAA', 'Mara', { includePolicy: 'manual', description: 'Mara, unattached.' }),
      codexEntry('c_TOMASAAAA', 'Tomas', { includePolicy: 'manual', description: 'Tomas, attached to Chapter 1.', attachments: [IDS.chapterOne] }),
    ]);
    const preview = planFor(state);
    expect(preview).not.toContain('Mara, unattached.');
    expect(preview).toContain('Tomas, attached to Chapter 1.');
  });

  test('a detected entry is sent only when its name or alias is in the scene text', () => {
    const state = projectWith([
      codexEntry('c_ELENAAAAAA', 'Elena', { description: 'Elena, the lamplighter.' }),
      codexEntry('c_RUTHAAAAAA', 'Ruth', { description: 'Ruth, never named here.' }),
      codexEntry('c_LIESELAAAA', 'Liesl', { aliases: ['Walked'], description: 'Liesl, named by an alias.' }),
    ]);
    const preview = planFor(state);
    expect(preview).toContain('Elena, the lamplighter.');
    expect(preview).not.toContain('Ruth, never named here.');
    expect(preview).toContain('Liesl, named by an alias.');
  });

  test('an always entry is sent whether or not the scene names it', () => {
    const state = projectWith([codexEntry('c_STYLEAAAAA', 'House style', { includePolicy: 'always', description: 'Plain sentences.' })]);
    expect(planFor(state)).toContain('Plain sentences.');
  });
});
