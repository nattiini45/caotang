/**
 * The app's side of a picture import (pictures.md §6.4): the files a writer chose, dropped or pasted become staged bytes and one
 * `asset.importBatch`, and the large-photo question is asked here, once, when the command says it must be.
 *
 * Files that cannot be pictures are left out one by one with the reason, before anything is staged, so a stray text file in a drop does
 * not stop the pictures beside it. Everything after that is the command's: it is all or nothing, so a refusal names the picture and
 * writes nothing. A HEIC photo is converted to JPEG where this browser can decode it and left out, with the remedy, where it cannot.
 */

import type { LargePhotoChoice } from '@caotang/bus';
import { decideImportSize, isPictureRefusal, PICTURE_LIMITS, sniffPicture, type AssetSource, type AssetTarget } from '@caotang/pictures';
import { t } from '@lingui/core/macro';

import { convertHeicInBrowser } from '../app/picture-transcoder.js';
import type { ProjectSession } from '../app/session.js';
import { explain } from '../components/actions.js';

import { largePhotoQuestionOf, type ImportReport, type ImportSkip } from './picture-board-model.js';

/** What the large-photo question says about the batch. The answer is the writer's; `null` is Cancel, and nothing is written. */
export interface LargePhotoQuestion {
  readonly count: number;
  readonly because: readonly ('pixels' | 'bytes')[];
}

export type AskLargePhotos = (question: LargePhotoQuestion) => Promise<LargePhotoChoice | null>;

export interface PictureImportOptions {
  /** Where the pictures are placed as plain references. */
  readonly links?: readonly AssetTarget[];
  readonly source: AssetSource;
  readonly ask: AskLargePhotos;
}

interface Readable {
  readonly name: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Reads the files, leaves out what cannot be a picture, and converts HEIC where the browser can. */
async function readPictures(files: readonly Readable[]): Promise<{ readonly pictures: { readonly name: string; readonly bytes: Uint8Array }[]; readonly skipped: ImportSkip[] }> {
  const pictures: { name: string; bytes: Uint8Array }[] = [];
  const skipped: ImportSkip[] = [];
  for (const file of files) {
    // The byte cap is checked on the size the browser reports, so a huge file is never read into memory to be refused.
    const size = decideImportSize({ bytes: file.size });
    if (size.action === 'refuse') {
      skipped.push({ name: file.name, reason: size.message });
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      skipped.push({ name: file.name, reason: t`The file could not be read.` });
      continue;
    }
    const sniffed = sniffPicture(bytes);
    if (sniffed.ok) {
      pictures.push({ name: file.name, bytes });
      continue;
    }
    if (sniffed.format !== 'heic') {
      skipped.push({ name: file.name, reason: sniffed.reason });
      continue;
    }
    try {
      const converted = await convertHeicInBrowser(bytes);
      pictures.push({ name: file.name, bytes: converted.bytes });
    } catch (failure) {
      skipped.push({ name: file.name, reason: isPictureRefusal(failure) ? failure.message : sniffed.reason });
    }
  }
  return { pictures, skipped };
}

/**
 * Imports the files as pictures. Resolves with what came of it, and never throws: a refusal is the report's `failed`, in the command's
 * own words. The staged bytes are let go whatever the outcome, so a cancel or a refusal leaves nothing held.
 */
export async function importPictureFiles(session: ProjectSession, files: readonly Readable[], options: PictureImportOptions): Promise<ImportReport> {
  const { pictures, skipped } = await readPictures(files);
  if (pictures.length === 0) return { status: 'nothing', created: 0, reused: 0, assetIds: [], skipped };

  const staged = pictures.map((picture) => session.stagePicture(picture.bytes));
  // The file's own name is the source label, so a picture is called by what the writer chose until they caption it.
  const items = staged.map((stagingId, index) => ({
    stagingId,
    ...(options.links === undefined || options.links.length === 0 ? {} : { links: [...options.links] }),
    source: { ...options.source, label: (pictures[index]?.name ?? '').slice(0, PICTURE_LIMITS.label) },
  }));
  const letGo = (): void => session.discardStagedPictures(staged);

  const attempt = async (known?: LargePhotoChoice): Promise<ImportReport> => {
    let kept = false;
    try {
      let choice = known;
      let result = await session.importPictures(items, choice);
      if (!result.ok && choice === undefined) {
        const question = largePhotoQuestionOf(result.error.details);
        if (question !== null) {
          const answer = await options.ask(question);
          if (answer === null) return { status: 'cancelled', created: 0, reused: 0, assetIds: [], skipped };
          choice = answer;
          result = await session.importPictures(items, choice);
        }
      }
      if (!result.ok) {
        // A full disk keeps what the writer chose staged, so Try again needs no second choosing of the files (pictures.md §6.4).
        kept = (result.error.details as { kept?: unknown } | undefined)?.kept === true;
        const again = choice;
        return {
          status: 'failed',
          created: 0,
          reused: 0,
          assetIds: [],
          skipped,
          message: explain(result.error),
          ...(kept ? { retry: () => attempt(again), discard: letGo } : {}),
        };
      }
      const made = (result.value.result as { items?: readonly { assetId: string; created: boolean }[] } | undefined)?.items ?? [];
      return {
        status: 'imported',
        created: made.filter((item) => item.created).length,
        reused: made.filter((item) => !item.created).length,
        assetIds: made.map((item) => item.assetId),
        skipped,
      };
    } finally {
      // Imported bytes are already forgotten; the rest (a cancel, a refusal) must not stay held in memory.
      if (!kept) letGo();
    }
  };
  return attempt();
}
