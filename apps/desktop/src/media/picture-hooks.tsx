/**
 * The hooks the picture surfaces share: a picture's object URL with its life managed, whether a tile is near the screen, and the
 * importer with the large-photo question it asks (pictures.md §5, §6.4).
 */

import { Trans } from '@lingui/react/macro';
import { plural, t } from '@lingui/core/macro';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AssetSource, AssetTarget, ReadAssetRecord } from '@caotang/pictures';
import type { LargePhotoChoice } from '@caotang/bus';

import { THUMB_EDGE, makeThumbnail } from '../app/picture-thumbs.js';
import { processPictureInBrowser } from '../app/picture-transcoder.js';
import type { ProjectSession } from '../app/session.js';
import { ChoiceDialog, useReport } from '../components/shared.js';

import { importSummary, type ImportReport } from './picture-board-model.js';
import { importPictureFiles, type LargePhotoQuestion } from './picture-import-host.js';

export type PictureImageState = 'idle' | 'loading' | 'ready' | 'missing' | 'error';

export interface PictureImage {
  readonly url: string | null;
  readonly state: PictureImageState;
}

/**
 * An object URL for one registered picture's bytes. The URL is revoked when the picture is replaced, when the view unmounts, and when
 * `enabled` turns off (a tile that scrolled far away), so a long board never holds every picture at once. `missing` is a file no store
 * holds; `error` is bytes that could not be read. `version` is the session's assets version: it moves when the files were listed again,
 * which is when a missing file may have come back (a folder attached, an undo).
 */
export function usePictureImage(session: ProjectSession, record: Pick<ReadAssetRecord, 'file' | 'mime'> | undefined, enabled = true, version = 0): PictureImage {
  const [held, setHeld] = useState<{ readonly key: string; readonly image: PictureImage } | null>(null);
  const file = record?.file;
  const mime = record?.mime;
  const key = file === undefined ? null : `${file}|${version}`;

  useEffect(() => {
    if (file === undefined || mime === undefined || !enabled || key === null) return;
    let live = true;
    let created: string | null = null;
    session.assets.readBytes(`assets/${file}`).then(
      (bytes) => {
        if (!live) return;
        if (bytes === null) {
          setHeld({ key, image: { url: null, state: 'missing' } });
          return;
        }
        created = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
        setHeld({ key, image: { url: created, state: 'ready' } });
      },
      () => {
        if (live) setHeld({ key, image: { url: null, state: 'error' } });
      },
    );
    return () => {
      live = false;
      if (created !== null) URL.revokeObjectURL(created);
    };
  }, [session, file, mime, enabled, key, version]);

  if (record === undefined || !enabled) return { url: null, state: 'idle' };
  if (held === null || held.key !== key) return { url: null, state: 'loading' };
  return held.image;
}

/**
 * The board's S thumbnail of one picture, as an object URL with its life managed like {@link usePictureImage}'s. It is read from this
 * browser's thumbnail store, and made and kept there when it is not (picture-thumbs.ts); a store that will not keep it still shows it
 * this once. `error` is a thumbnail that could not be made at either size, which the tile shows as a placeholder.
 */
export function usePictureThumb(session: ProjectSession, record: Pick<ReadAssetRecord, 'file' | 'mime' | 'width' | 'height'> | undefined, enabled = true, version = 0): PictureImage {
  const [held, setHeld] = useState<{ readonly key: string; readonly image: PictureImage } | null>(null);
  const file = record?.file;
  const mime = record?.mime;
  const width = record?.width;
  const height = record?.height;
  const key = file === undefined ? null : `${file}|${version}`;

  useEffect(() => {
    if (file === undefined || !enabled || key === null) return;
    let live = true;
    let created: string | null = null;
    const show = (bytes: Uint8Array): void => {
      if (!live) return;
      created = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }));
      setHeld({ key, image: { url: created, state: 'ready' } });
    };
    const path = `assets/${file}`;
    void (async () => {
      try {
        const kept = await session.assets.readThumb(path, THUMB_EDGE);
        if (kept !== undefined) {
          show(kept);
          return;
        }
        const bytes = await session.assets.readBytes(path);
        if (!live) return;
        if (bytes === null) {
          setHeld({ key, image: { url: null, state: 'missing' } });
          return;
        }
        const made = await makeThumbnail(processPictureInBrowser, { bytes, mime: mime ?? 'image/png', width: width ?? 1, height: height ?? 1 }, THUMB_EDGE);
        show(made);
        // A store that is full or gone does not stop the thumbnail from showing; it is made again next time.
        await session.assets.writeThumb(path, THUMB_EDGE, made).catch(() => undefined);
      } catch {
        if (live) setHeld({ key, image: { url: null, state: 'error' } });
      }
    })();
    return () => {
      live = false;
      if (created !== null) URL.revokeObjectURL(created);
    };
  }, [session, file, mime, width, height, enabled, key, version]);

  if (record === undefined || !enabled) return { url: null, state: 'idle' };
  if (held === null || held.key !== key) return { url: null, state: 'loading' };
  return held.image;
}

/** Whether an element is within a screen's height of the viewport. Everywhere an observer is missing, it is always near. */
export function useNearViewport<E extends Element>(): { readonly watch: (node: E | null) => void; readonly near: boolean } {
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');
  const [node, setNode] = useState<E | null>(null);
  useEffect(() => {
    if (node === null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => setNear(entries.some((entry) => entry.isIntersecting)), { rootMargin: '600px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return { watch: setNode, near };
}

export interface PictureImporter {
  /** Imports the files, asking the large-photo question when the command needs it. Resolves with the report; also says it in the status line. */
  readonly importFiles: (files: readonly File[], options: { readonly links?: readonly AssetTarget[]; readonly source?: AssetSource }) => Promise<ImportReport>;
  readonly busy: boolean;
  /** The question's dialog, for the view to render once. */
  readonly dialog: ReactNode;
}

/** The kind of source a drop, a choice and a paste each record on the picture (pictures.md §2.1). */
export const IMPORT_SOURCE: AssetSource = { kind: 'import' };
export const PASTE_SOURCE: AssetSource = { kind: 'paste' };

interface Asking {
  readonly question: LargePhotoQuestion;
  readonly answer: (choice: LargePhotoChoice | null) => void;
}

export function usePictureImporter(session: ProjectSession): PictureImporter {
  const report = useReport();
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<Asking | null>(null);
  const running = useRef(false);

  const importFiles: PictureImporter['importFiles'] = useCallback(
    async (files, options) => {
      if (running.current) return { status: 'nothing', created: 0, reused: 0, assetIds: [], skipped: [], message: t`Another import is still running.` };
      running.current = true;
      setBusy(true);
      try {
        const done = await importPictureFiles(session, files, {
          ...(options.links === undefined ? {} : { links: options.links }),
          source: options.source ?? IMPORT_SOURCE,
          ask: (question) => new Promise<LargePhotoChoice | null>((resolve) => setAsking({ question, answer: resolve })),
        });
        report(importSummary(done));
        return done;
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [session, report],
  );

  const close = (choice: LargePhotoChoice | null): void => {
    asking?.answer(choice);
    setAsking(null);
  };
  const count = asking?.question.count ?? 1;
  const dialog = (
    <ChoiceDialog
      open={asking !== null}
      title={count === 1 ? t`This picture is large` : t`These pictures are large`}
      onCancel={() => close(null)}
      choices={[
        { label: t`Keep originals`, onChoose: () => close('keep-originals') },
        { label: t`Store 4096 px working copies`, onChoose: () => close('working-copies') },
      ]}
    >
      <p>
        {asking?.question.because.includes('bytes') === true && !asking.question.because.includes('pixels')
          ? t({ message: `${plural(count, { one: '# picture is over 8 MB.', other: '# pictures are over 8 MB.' })}`, comment: "Shown when imported pictures exceed the size limit and the writer is asked which to keep; the value is the number of pictures." })
          : t({ message: `${plural(count, { one: '# picture is over 24 megapixels or 8 MB.', other: '# pictures are over 24 megapixels or 8 MB.' })}`, comment: "Shown when imported pictures exceed the pixel or size limit and the writer is asked which to keep; the value is the number of pictures." })}
      </p>
      <p>
        <Trans>Keep originals stores each file as it is. A working copy is scaled so its longest side is at most 4096 pixels, which takes far less room; the original is not kept.</Trans>
      </p>
      <p>
        <Trans>Cancel imports nothing.</Trans>
      </p>
    </ChoiceDialog>
  );

  return { importFiles, busy, dialog };
}

/** The last import's notice: the files left out with their reasons, and Try again after a full disk. */
export function ImportNotice({ report, onDismiss, onRetry }: { readonly report: ImportReport; readonly onDismiss: () => void; readonly onRetry: () => void }): ReactNode {
  if (report.skipped.length === 0 && report.retry === undefined && report.status !== 'failed') return null;
  return (
    <div className="pb-notice" role="status">
      {report.message === undefined ? null : <p className="field-note">{report.message}</p>}
      {report.skipped.length === 0 ? null : (
        <>
          <p className="field-note">
            <Trans>These files were left out:</Trans>
          </p>
          <ul className="findings" aria-label={t`Files left out of the import`}>
            {report.skipped.map((skip, index) => (
              <li key={`${index}-${skip.name}`}>
                <span dir="auto">{skip.name}</span>
                {': '}
                {skip.reason}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="pb-notice-actions">
        {report.retry === undefined ? null : (
          <button type="button" className="button" onClick={onRetry}>
            <Trans>Try again</Trans>
          </button>
        )}
        <button
          type="button"
          className="button is-quiet"
          onClick={() => {
            report.discard?.();
            onDismiss();
          }}
        >
          <Trans>Dismiss</Trans>
        </button>
      </div>
    </div>
  );
}
