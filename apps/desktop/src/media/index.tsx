/**
 * The media views' one integration point. The App asks `mediaViewFor` for a node, and gets the view that node's kind
 * has, or `null` when the node has none and the App shows what it showed before. The README says where App.tsx
 * mounts it.
 *
 * The stylesheet is imported here, so the App gets it by importing this module and nowhere else.
 */

import type { ReactNode } from 'react';

import type { TreeNode } from '@caotang/store';

import type { ZoomLevel } from '../app/corkboard-model.js';
import type { ProjectSession } from '../app/session.js';
import type { RevealRequest } from '../components/EditorPane.js';
import { InkGate } from '../components/InkGate.js';
import { LazyBoundary, lazyView } from '../components/lazy-view.js';

import { commitShotCommand, importShotImage } from './commit.js';
import { MediaBoundary } from './MediaBoundary.js';
import { ScreenplayView } from './ScreenplayView.js';
import type { MediaPorts } from './ports.js';
import { mediaKindOf } from './route.js';

import './media.css';

// The dialogue and storyboard views load when a node of that kind is first opened (they carry the Ink view and the shot board). The
// screenplay view stays in the first download: it is small, and the screenplay package is also the store's for `kind: 'screenplay'`.
const DialogueView = lazyView(() => import('./DialogueView.js').then((module) => ({ default: module.DialogueView })));
const StoryboardView = lazyView(() => import('./StoryboardView.js').then((module) => ({ default: module.StoryboardView })));

export interface MediaViewProps {
  readonly session: ProjectSession;
  /** Optional: the project folder's assets, and the storyboard commit port. A view runs without either. */
  readonly ports?: MediaPorts;
  /**
   * A passage a finding quotes (coherence.md §8). The media view that holds its document selects it and clears the request, so a
   * click on a quote opens the scene or the container at the passage, as it does in the prose editor.
   */
  readonly reveal?: RevealRequest | null;
  readonly onRevealHandled?: () => void;
  /** The card size, which the corkboard and the shot board share (ui-modules §3.2). Absent: the shot board keeps its own. */
  readonly zoom?: ZoomLevel;
  readonly onZoom?: (zoom: ZoomLevel) => void;
  /** Sends a request to the agent. The scene view's derive action uses it (storyboard.md §4). Absent: the action is not offered. */
  readonly onAgentIntent?: (intent: string) => void;
}

/**
 * The ports the centre pane gives every media view. The storyboard's commits go through the bus (commit.ts), so a shot
 * edit, a new shot and a reorder are the bus's own dispatches, with their undo and their row. The project's images are read
 * through the session's asset store, which keeps them in the browser and in the project folder when one is open, so a
 * card shows its picture after a reload. The image import is the bus's `shot.importImage`.
 */
export function mediaPortsFor(session: ProjectSession): MediaPorts {
  return {
    assets: session.assets.artifactFs(),
    commitShot: (command) => commitShotCommand(session, command, undefined),
    importImage: (shotId, bytes) => importShotImage(session, shotId, bytes),
  };
}

/**
 * The view for a binder node: a screenplay scene, a storyboard folder (its board, with the prompt pack as a tab), or a
 * dialogue container. `null` for every other node, including a beat inside a container. The view is wrapped in an error
 * boundary, so a view that throws while drawing shows its fallback, and the App does not wrap it again. A storyboard or a
 * dialogue container loads its code on first use, so the boundary also holds the loading line and the failed-load question.
 */
export function mediaViewFor(node: TreeNode, props: MediaViewProps): ReactNode | null {
  const view = viewOf(node, props);
  if (view === null) return null;
  // Keyed on the node, so a view that failed on one node is not still failed on the next.
  return (
    <MediaBoundary key={node.id} title={node.title}>
      <LazyBoundary label={node.title}>{view}</LazyBoundary>
    </MediaBoundary>
  );
}

function viewOf(node: TreeNode, props: MediaViewProps): ReactNode | null {
  switch (mediaKindOf(node)) {
    case 'screenplay':
      return (
        <ScreenplayView
          key={node.id}
          session={props.session}
          node={node}
          reveal={props.reveal}
          onRevealHandled={props.onRevealHandled}
          onAgentIntent={props.onAgentIntent}
        />
      );
    case 'storyboard':
      return (
        <StoryboardView
          key={node.id}
          session={props.session}
          node={node}
          ports={props.ports}
          zoom={props.zoom}
          onZoom={props.onZoom}
          onAgentIntent={props.onAgentIntent}
        />
      );
    case 'dialogue':
      // The view reads the Ink through the compile gate, which needs the compiler loaded (InkGate).
      return (
        <InkGate key={node.id}>
          <DialogueView session={props.session} node={node} reveal={props.reveal} onRevealHandled={props.onRevealHandled} />
        </InkGate>
      );
    case null:
      return null;
  }
}

export { ScreenplayView };
export type { MediaPorts, ShotCommitResult } from './ports.js';
export { mediaKindOf, type MediaKind } from './route.js';
