/**
 * The two things a media view cannot reach by itself: the project folder's files, and a bus command the bus
 * does not register yet. The App supplies them through `MediaPorts`, and a view works without either.
 */

import type { ArtifactFs } from '@caotang/store';

import type { ShotCommand } from './engines.js';
import type { NewShotParams } from './storyboard-model.js';

/**
 * Every command a storyboard view sends: the storyboard module's shot commands, and the `binder.create` that makes a card
 * (storyboard.md §3.1 makes a new card a create with no command of its own). The App's port takes all of them.
 */
export type MediaCommand = ShotCommand | { readonly name: 'binder.create'; readonly params: NewShotParams };

/**
 * What a committed storyboard command answers. A refusal carries the sentence to show the writer. A create names the node it
 * made, so the view can select the card it made.
 */
export type ShotCommitResult =
  | { readonly ok: true; readonly createdId?: string }
  | { readonly ok: false; readonly message: string };

export interface MediaPorts {
  /**
   * The project folder as an artifact store (the one `folderArtifactFs` returns, for an attached folder). It holds
   * `assets/`, so the storyboard reads each shot's image through it. Absent: a card shows its alt text instead.
   */
  readonly assets?: ArtifactFs;
  /**
   * Commits one storyboard command, whatever its name (a create, a reorder or a field write). Its presence is what makes
   * the shot fields and the New shot button editable, so a view without one shows the fields read only and no New shot
   * button. The reorder buttons still reach the bus without it, through `commitShotCommand`.
   */
  readonly commitShot?: (command: MediaCommand) => ShotCommitResult;
  /**
   * Imports one picture as a shot's image, with the bytes the writer chose (drop, paste or the file picker). The App's session
   * stages the bytes and runs `shot.importImage`, so the file and the reference are one undo group. Absent: the image slot is
   * read only.
   */
  readonly importImage?: (shotId: string, bytes: Uint8Array) => Promise<ShotCommitResult>;
  /**
   * Imports several pictures, each as its own shot's image, as one undo step (`shot.importImages`, storyboard.md §6): a drop of
   * photographs on the board. Absent: the board takes no batch.
   */
  readonly importImages?: (items: readonly { readonly shotId: string; readonly bytes: Uint8Array }[]) => Promise<ShotCommitResult>;
}
