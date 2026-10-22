/**
 * The writer's review of each skill in a project ([extensibility.md §10](../../../../docs/architecture/extensibility.md)).
 *
 * A skill is text the agent will read, and a shared project's skills were written by someone else, so the agent is not told of a skill
 * until the writer has read all of it and approved it. The approval is the skill's pin as it was then (`skillPin`): any change to any
 * file of the skill is a different pin, and the skill is unreviewed again.
 *
 * The reviews are kept in the app database (`caotang-app`, the `skill-reviews` store), keyed by project and skill, and **never in the
 * project, a bundle or an export**. A shared project therefore cannot ship its own approval, and a bundle opened on another machine
 * starts with every skill unreviewed. With no app database (a private window that will not open one) the reviews are kept for the
 * session only, and the next open asks again: failing to remember is never a reason to trust.
 */

import type { SkillReviewDb, SkillReviewRecord } from './app-db.js';
import { activeAppDb } from './app-db.js';

const keyOf = (projectId: string, name: string): string => `${projectId}:${name}`;

export class SkillReviews {
  private readonly pins = new Map<string, string>();
  /** Why the last write to the app database failed, or `null`. The review itself still holds for the session. */
  failure: string | null = null;

  private constructor(
    readonly projectId: string,
    private readonly db: SkillReviewDb | null,
  ) {}

  /** The reviews kept for a project. A database that cannot be read gives none, and says why in {@link failure}. */
  static async open(projectId: string, db: { readonly reviews?: SkillReviewDb } | null = activeAppDb()): Promise<SkillReviews> {
    const reviews = new SkillReviews(projectId, db?.reviews ?? null);
    if (reviews.db === null) return reviews;
    try {
      for (const record of await reviews.db.list(projectId)) reviews.pins.set(record.name, record.pin);
    } catch (error) {
      reviews.failure = error instanceof Error ? error.message : String(error);
    }
    return reviews;
  }

  /** A project's reviews with nowhere to keep them: every skill is unreviewed, and an approval holds for the session. */
  static none(projectId: string): SkillReviews {
    return new SkillReviews(projectId, null);
  }

  /** The pin of the skill as the writer last reviewed it, or `undefined` when they have not. Read by the harness at each call. */
  pinOf(name: string): string | undefined {
    return this.pins.get(name);
  }

  /** Records that the writer read the skill `name` as it is now (its `pin`) and approved it. */
  async approve(name: string, pin: string, now: Date = new Date()): Promise<void> {
    this.pins.set(name, pin);
    if (this.db === null) return;
    const record: SkillReviewRecord = { key: keyOf(this.projectId, name), projectId: this.projectId, name, pin, reviewedAt: now.toISOString() };
    try {
      await this.db.put(record);
      this.failure = null;
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
    }
  }

  /** Forgets the review of a skill: it is unreviewed from now on. */
  async forget(name: string): Promise<void> {
    if (!this.pins.delete(name)) return;
    if (this.db === null) return;
    try {
      await this.db.delete([keyOf(this.projectId, name)]);
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
    }
  }
}

/** Removes every review kept for a project, when the project is removed. A database that cannot be reached leaves them: they name no project that exists. */
export async function dropReviewsOf(projectId: string, db: { readonly reviews?: SkillReviewDb } | null = activeAppDb()): Promise<void> {
  const reviews = db?.reviews;
  if (reviews === undefined) return;
  try {
    const kept = await reviews.list(projectId);
    await reviews.delete(kept.map((record) => record.key));
  } catch {
    // A review of a project that is gone is never read, so a failed sweep costs a few bytes and nothing else.
  }
}
