import { Trans } from '@lingui/react/macro';
import { Button } from '@ui-sdk/react/button';
import type { ReactNode } from 'react';

import type { DirectoryHandleLike } from '../app/fs-access.js';
import { nativeFolderId } from '../app/native-folders.js';

type Props = {
  readonly disabled: boolean;
} & ({
  readonly kind: 'copy';
  readonly copy: () => void;
  readonly nameId: string;
} | {
  readonly kind: 'recent';
  readonly folders: readonly DirectoryHandleLike[];
  readonly open: (folder: DirectoryHandleLike) => void;
  readonly forget: (id: string) => void;
});

export default function NativeFolderControls(props: Props): ReactNode {
  if (props.kind === 'copy') return (
    <Button type="button" className="button k-quiet" disabled={props.disabled} aria-describedby={props.nameId} onClick={props.copy}>
      <Trans>Copy to a folder…</Trans>
    </Button>
  );
  return (
    <section className="home-section" aria-labelledby="home-recent-folders">
      <h2 id="home-recent-folders"><Trans>Recent project folders</Trans></h2>
      <ul className="project-list">
        {props.folders.map((folder) => {
          const id = nativeFolderId(folder);
          if (id === undefined) return null;
          const nameId = `native-folder-${id}`;
          return (
            <li className="project-row" key={id}>
              <bdi className="project-name" id={nameId}>{folder.name}</bdi>
              <div className="project-actions">
                <Button type="button" className="button is-primary k-tonal" disabled={props.disabled} aria-describedby={nameId} onClick={() => props.open(folder)}>
                  <Trans>Reopen folder</Trans>
                </Button>
                <Button type="button" className="button k-quiet" disabled={props.disabled} aria-describedby={nameId} onClick={() => props.forget(id)}>
                  <Trans>Forget folder</Trans>
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
