/**
 * What the writer is owed to know about the account's copy of a hosted project — hosted.md §7, §11. A save that lands says
 * nothing; a save the server did not take says the account is behind; and a save another device committed first asks the same
 * "files changed" question a folder save asks, naming the documents and writing nothing over them.
 *
 * The question has two answers and both are the writer's: keep this device's text, which writes it on top of the other
 * device's version (theirs stays as the version this save replaced), or leave it for now, with the account still holding the
 * other device's version and this device's words only here.
 */
/* lingui-set comment="Interpolated values: files is the documents that changed on the other device, named and joined into one clause." */

import { useCallback, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { isolate } from '@caotang/i18n';
import { hostedTargetFor, type HostedSaveState } from '../app/hosted-target.js';
import type { ProjectSession } from '../app/session.js';
import { ChoiceDialog } from './shared.js';

const IDLE: HostedSaveState = { kind: 'idle' };
const NOTHING = (): void => {};

/**
 * The thing a path names, as the writer knows it: a scene's title, a codex entry's name, or the path for a file the app shows no
 * name of its own for (`caotang.json`, an asset).
 */
function nameOf(path: string, session: ProjectSession): string {
  const { manifest } = session.state;
  const document = /^docs\/([^/]+)\.md$/.exec(path);
  if (document !== null) {
    const title = manifest.tree.find((node) => node.id === document[1])?.title;
    if (title !== undefined && title.trim() !== '') return title;
  }
  const entry = /^codex\/([^/]+)\.md$/.exec(path);
  if (entry !== null) {
    const name = manifest.codex?.find((one) => one.id === entry[1])?.name;
    if (name !== undefined && name.trim() !== '') return name;
  }
  return path;
}

export function HostedSaveNotice({ session }: { readonly session: ProjectSession }): ReactNode {
  const target = hostedTargetFor(session.projectId);
  const subscribe = useCallback((listener: () => void) => (target === null ? NOTHING : target.subscribe(listener)), [target]);
  const state = useSyncExternalStore(subscribe, () => target?.state() ?? IDLE);
  // A question the writer put off stays off for those paths: a new conflict asks anew.
  const [putOff, setPutOff] = useState('');
  if (target === null || state.kind === 'idle' || state.kind === 'saving') return null;

  if (state.kind === 'unsaved') {
    return <p className="status-line" role="status">
      <span><Trans>This browser has your latest words. Your account does not have them yet.</Trans></span>
      <button type="button" className="button" onClick={() => void target.save(session.state)}>
        <Trans>Save to your account again</Trans>
      </button>
    </p>;
  }

  const key = state.paths.join('|');
  if (putOff === key) {
    return <p className="status-line" role="status">
      <span><Trans>Your account keeps the other device’s version. This device’s words stay only in this browser.</Trans></span>
      <button type="button" className="button is-quiet" onClick={() => setPutOff('')}>
        <Trans>Ask me again</Trans>
      </button>
    </p>;
  }

  const files = state.paths.map((path) => isolate(nameOf(path, session))).join(', ');
  return <ChoiceDialog
    open
    title={t`Another device saved these first`}
    choices={[
      { label: t`Keep this device’s text`, onChoose: () => void target.keepMine() },
      { label: t`Leave it for now`, onChoose: () => setPutOff(key) },
    ]}
    onCancel={() => setPutOff(key)}
  >
    <p>
      <Trans>These changed on another device: {files}</Trans>
    </p>
    <p>
      <Trans>Nothing here was written over them. Keep this device’s text to save it on top of their version; their version stays as the one it replaced.</Trans>
    </p>
  </ChoiceDialog>;
}
