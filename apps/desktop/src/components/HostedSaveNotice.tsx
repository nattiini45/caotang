/**
 * What the writer is owed to know about the account's copy of a hosted project — hosted.md §7, §11. A save that lands says
 * nothing; a save the server did not take says the account is behind; and a save another device committed first asks the same
 * "files changed" question a folder save asks, naming the documents and writing nothing over them.
 *
 * The writer can keep this device's text or leave the account version unchanged.
 */

/* lingui-set comment="Interpolated values: files is the documents that changed on the other device, named and joined into one clause." */
import { useCallback, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { isolate } from '@caotang/i18n';
import { hostedTargetFor } from '../app/hosted-target-registry.js';
import type { HostedSaveState } from '../app/hosted-target.js';
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

export function HostedSaveNotice({
  session,
  onReopenAccount,
}: {
  readonly session: ProjectSession;
  /** Reads the account again after this device's text won over another device's: only a conflict met at open needs it. */
  readonly onReopenAccount?: (() => void) | undefined;
}): ReactNode {
  const target = hostedTargetFor(session.projectId);
  const subscribe = useCallback((listener: () => void) => (target === null ? NOTHING : target.subscribe(listener)), [target]);
  const state = useSyncExternalStore(subscribe, () => target?.state() ?? IDLE);
  // A question the writer put off stays off for those paths: a new conflict asks anew.
  const [putOff, setPutOff] = useState('');
  if (target === null || state.kind === 'idle' || state.kind === 'saving') return null;
  const pending = state.kind === 'stale' || state.persisted
    ? t`Saved here, not to your account.`
    : t`Closing this tab loses these changes.`;

  if (state.kind === 'unsaved') {
    // Nothing here is sent on its own: the account gets these words when the writer says so. What the writer can act on is whether a copy
    // survived a reload — a full or blocked store leaves them in this tab, and saying "on this device" would be the sentence that costs
    // them the work.
    return <p className="status-line" role="status">
      <span>{pending}</span>
      <button type="button" className="button" onClick={() => {
        void target.sendQueued();
      }}>
        <Trans>Send them to your account</Trans>
      </button>
    </p>;
  }

  if (state.kind === 'stale') {
    return <p className="status-line" role="status">
      <span><Trans>Your account has the changes.</Trans></span>
      <button type="button" className="button" onClick={() => onReopenAccount?.()}>
        <Trans>Read them</Trans>
      </button>
    </p>;
  }

  const key = state.paths.join('|');
  if (putOff === key) {
    return <p className="status-line" role="status">
      <span>{pending}</span>
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
      {
        label: t`Keep this device’s text`,
        onChoose: () => {
          void target.keepMine();
        },
      },
      { label: t`Leave it for now`, onChoose: () => setPutOff(key) },
    ]}
    onCancel={() => setPutOff(key)}
  >
    <p>
      <Trans>These changed on another device: {files}</Trans>
    </p>
    <p>
      <Trans>This replaces the account files.</Trans>
    </p>
    {state.persisted ? null : <p>{pending}</p>}
  </ChoiceDialog>;
}
