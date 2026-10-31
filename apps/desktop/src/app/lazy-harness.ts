/**
 * The agent's harness for one open project, and the agent loop's own factories, in a module of its own so the tool registry, the
 * provider gateway's agent loop and the context assembler are downloaded when the writer first uses the agent, and not with the
 * page. `ProjectSession` and `AgentController` import this file only through `import()`; nothing that loads at start may import it
 * statically (the first-load budget in `tools/check-bundle-size.mjs` is what notices).
 */

import type { ActivityLog, CommandRegistry, UndoStore } from '@caotang/bus';
import { createPictureOutbox, createProductHarness, picturePorts, withReviewLanguages, type Harness, type PictureOutbox } from '@caotang/harness';
import { createImageStager, type ImageStager, type McpClient } from '@caotang/mcp-client';
import type { ProjectState, RetryableAssetStaging } from '@caotang/store';

import { uiLocale } from '../i18n/format-locale.js';
import type { ProjectAssets } from './project-assets.js';
import type { SessionCoherence } from './session.js';
import type { SkillReviews } from './skill-reviews.js';
import type { TranscriptionReviewBroker } from './transcription-review.js';
import { resizePictureInBrowser } from './picture-transcoder.js';
import { activeCoherenceModel } from './coherence-review.js';

export { createAgentSession, createBudgetMeter, createContextPort, preloadFor } from '@caotang/harness';

/** What a session lends its harness: the project, the registry and history it already runs, and the stores the picture tools reach. */
export interface HarnessHost {
  readonly state: ProjectState;
  readonly registry: CommandRegistry;
  readonly history: { readonly undo: UndoStore; readonly log: ActivityLog };
  readonly assets: ProjectAssets;
  readonly assetStaging: RetryableAssetStaging;
  readonly skillReviews: SkillReviews;
  readonly transcriptionReviews: TranscriptionReviewBroker;
  readonly pictureVision: () => boolean;
  readonly notify: () => void;
  readonly mcp?: { readonly client: McpClient };
  readonly presentAssets?: () => ReadonlySet<string>;
  readonly coherence?: SessionCoherence;
}

/** A project's harness with the pieces made beside it that the session and the agent loop reach. */
export interface HarnessRuntime {
  readonly harness: Harness;
  /** The transient hand-off between the picture view host and this project's agent session. */
  readonly pictureOutbox: PictureOutbox;
  /** The pictures an external tool returned, held in the session's staging area for ten minutes and dropped when the project closes (pictures.md §8.3). */
  readonly imageStager: ImageStager;
}

export function createHarnessRuntime(host: HarnessHost): HarnessRuntime {
  const pictureOutbox = createPictureOutbox();
  const imageStager = createImageStager({ staging: host.assetStaging });
  const { coherence } = host;
  const harness = createProductHarness({
    state: host.state,
    registry: host.registry,
    history: host.history,
    clock: () => Date.now(),
    ports: 'agent',
    // The agent is told only of the skills the writer has read and approved, and the harness checks that on every call.
    skills: { reviewedPin: (name) => host.skillReviews.pinOf(name) },
    asyncPorts: picturePorts({
      vision: () => host.pictureVision(),
      readBytes: async (path) => (await host.assets.readBytes(path)) ?? undefined,
      ...(typeof createImageBitmap === 'function' ? { resize: resizePictureInBrowser } : {}),
      deliver: pictureOutbox.deliver,
    }),
    transcription: {
      vision: () => host.pictureVision(),
      review: (draft, signal) => host.transcriptionReviews.review(draft, signal),
    },
    notify: host.notify,
    ...(host.mcp === undefined ? {} : { mcp: { ...host.mcp, images: imageStager } }),
    ...(host.presentAssets === undefined ? {} : { presentAssets: host.presentAssets }),
    // The agent's coherence scans read the writer's Coherence settings, and its review runs through the app's model
    // (coherence.md §5.3). The settings and the model are read at each call. The factory adds the dialogue facts and the review context.
    ...(coherence === undefined
      ? {}
      : {
          coherence: {
            checks: coherence.checks,
            model: () => {
              const model = activeCoherenceModel(coherence.providers);
              return model === undefined ? undefined : withReviewLanguages(model, () => ({ ui: uiLocale(), project: host.state.manifest.project.language ?? 'en' }));
            },
          },
        }),
  });
  return { harness, pictureOutbox, imageStager };
}
