/**
 * The pictures on the timeline ([timeline.md §9.1](docs/architecture/timeline.md)): the thumbnails on a scene's bar, the pictures of
 * the focused scene, a character lane's portrait, and the lightbox they open. Pin markers are drawn by the view with the same
 * {@link PictureButton}.
 *
 * Nothing here writes to the project. A picture whose file is missing shows what the Picture board shows: a thumbnail that could not
 * be made is tried once more at half the size (`makeThumbnail`), and then it is a placeholder that says why.
 */
/* lingui-set comment="The pictures on the timeline. Interpolated values: title is the picture's name, which is the writer's own text, and count is a number." */

import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { plural, t } from '@lingui/core/macro';
import { isolate } from '@caotang/i18n';
import type { ReadAssetRecord } from '@caotang/pictures';

import type { BarPictures, ScenePicture } from '../../app/timeline-pictures.js';
import type { ProjectSession } from '../../app/session.js';
import { accessibleText } from '../../i18n/accessible-text.js';
import { UserText } from '../../i18n/UserText.js';
import { usePictureImage, usePictureThumb } from '../../media/picture-hooks.js';
import { ShotLightbox } from '../../media/ShotLightbox.js';

/** A picture the writer asked to see large, and the element to give focus back to when it closes. */
export interface OpenedPicture {
  readonly record: ReadAssetRecord;
  readonly title: string;
  readonly alt: string;
  readonly opener: HTMLElement | null;
}

type ButtonExtras = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'className' | 'aria-label'> & { readonly [attribute: `data-${string}`]: string | undefined };

export interface PictureButtonProps {
  readonly session: ProjectSession;
  readonly version: number;
  readonly record: ReadAssetRecord;
  readonly title: string;
  readonly alt: string;
  readonly className: string;
  /** The accessible name, already worded by the caller. Absent: "View <title> larger". */
  readonly label?: string;
  /** Show the picture's name beside the thumbnail. */
  readonly named?: boolean;
  /** Whether a click may open the lightbox now; a click that ends a drag may not. */
  readonly canOpen?: () => boolean;
  readonly onOpen: (opened: OpenedPicture) => void;
  readonly extras?: ButtonExtras;
}

/**
 * A thumbnail that opens the lightbox. The image carries the picture's alt text (empty for a decorative one), and the button its own
 * name, so a decorative picture is still a button a screen reader can name.
 */
export function PictureButton({ session, version, record, title, alt, className, label, named = false, canOpen, onOpen, extras }: PictureButtonProps): ReactNode {
  const thumb = usePictureThumb(session, record, true, version);
  const missing = thumb.state === 'missing';
  const failed = thumb.state === 'error';
  const unavailable = missing || failed;
  const base = label ?? accessibleText(t`View ${{ title: isolate(title) }} larger`);
  const name = missing ? accessibleText(t`${{ name: base }}, the picture file is missing`) : failed ? accessibleText(t`${{ name: base }}, no preview could be made`) : base;
  return (
    <button
      {...extras}
      type="button"
      className={`${className}${unavailable ? ' is-unavailable' : ''}`}
      aria-label={name}
      aria-disabled={unavailable ? true : undefined}
      onClick={(event) => {
        event.stopPropagation();
        if (unavailable || (canOpen !== undefined && !canOpen())) return;
        onOpen({ record, title, alt, opener: event.currentTarget });
      }}
    >
      {thumb.url !== null ? (
        <img className="tl-thumb-img" src={thumb.url} alt={alt} loading="lazy" decoding="async" draggable={false} />
      ) : (
        <span className={`tl-thumb-ph${unavailable ? ' is-missing' : ''}`} aria-hidden="true" aria-busy={thumb.state === 'loading'}>
          {missing ? '\u26a0' : failed ? '\u2013' : ''}
        </span>
      )}
      {named ? (
        <span className="tl-thumb-name">
          <UserText value={title} />
        </span>
      ) : null}
    </button>
  );
}

/**
 * The thumbnails on a scene's bar: at most three and "+N" for the rest. A press on one never starts a drag of the bar or selects it;
 * the bar's own keys are how a keyboard reaches the scene, and the pictures of the focused scene are listed below the grid.
 */
export function BarThumbs({
  session,
  version,
  bar,
  canOpen,
  onOpen,
}: {
  readonly session: ProjectSession;
  readonly version: number;
  readonly bar: BarPictures;
  readonly canOpen: () => boolean;
  readonly onOpen: (opened: OpenedPicture) => void;
}): ReactNode {
  if (bar.shown.length === 0) return null;
  return (
    <span className="tl-thumbs" data-testid="timeline-bar-thumbs" onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
      {bar.shown.map((picture) => (
        <PictureButton
          key={picture.linkId}
          session={session}
          version={version}
          record={picture.record}
          title={picture.label}
          alt={picture.alt}
          className="tl-thumb"
          canOpen={canOpen}
          onOpen={onOpen}
          extras={{ tabIndex: -1, 'data-link': picture.linkId }}
        />
      ))}
      {bar.more > 0 ? (
        <span className="tl-thumbs-more" aria-hidden="true">
          +{bar.more}
        </span>
      ) : null}
    </span>
  );
}

/** The pictures of the focused scene as a list of buttons: the keyboard's way to the same lightbox the bar's thumbnails open. */
export function ScenePictures({
  session,
  version,
  pictures,
  onOpen,
}: {
  readonly session: ProjectSession;
  readonly version: number;
  readonly pictures: readonly ScenePicture[];
  readonly onOpen: (opened: OpenedPicture) => void;
}): ReactNode {
  if (pictures.length === 0) return null;
  return (
    <ul className="tl-pictures" aria-label={plural({ count: pictures.length }, { one: '# picture on this scene', other: '# pictures on this scene' })} data-testid="timeline-scene-pictures">
      {pictures.map((picture) => (
        <li key={picture.linkId}>
          <PictureButton session={session} version={version} record={picture.record} title={picture.label} alt={picture.alt} className="button tl-picture-button" named onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}

/** A character lane's portrait: the codex entry's first visual reference as a small image, else the first letter of its name. */
export function LanePortrait({ session, version, record, name }: { readonly session: ProjectSession; readonly version: number; readonly record: ReadAssetRecord | undefined; readonly name: string }): ReactNode {
  const thumb = usePictureThumb(session, record, record !== undefined, version);
  const initial = Array.from(name.trim())[0] ?? '';
  if (record !== undefined && thumb.url !== null) {
    // The lane's own name sits beside it, so the portrait adds nothing a screen reader needs.
    return <img className="tl-portrait" src={thumb.url} alt="" draggable={false} data-testid="timeline-portrait" />;
  }
  return (
    <span className="tl-portrait is-initial" aria-hidden="true">
      {initial}
    </span>
  );
}

/** The picture at full size over the timeline, in the lightbox the storyboard and the Picture board use. */
export function PictureLightbox({ session, version, opened, onClose }: { readonly session: ProjectSession; readonly version: number; readonly opened: OpenedPicture; readonly onClose: () => void }): ReactNode {
  const image = usePictureImage(session, opened.record, true, version);
  const gone = image.state === 'missing' || image.state === 'error';
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);
  if (image.url === null) return null;
  const caption = opened.record.caption?.trim();
  return <ShotLightbox url={image.url} title={opened.title} alt={opened.alt} caption={caption === undefined || caption === '' ? null : caption} returnFocusTo={opened.opener} onClose={onClose} />;
}

/** The words for a bar that carries pictures, for its accessible name. */
export function picturesNote(count: number): string {
  return count === 0 ? '' : plural(count, { one: '# picture', other: '# pictures' });
}
