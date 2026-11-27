/**
 * What the writer is owed to know about the account's copy of a hosted project — hosted.md §7, §11. A save that lands says
 * nothing; a save the server did not take says the account is behind; and a save another device committed first asks the same
 * "files changed" question a folder save asks, naming the documents and writing nothing over them.
 *
 * The writer can keep this device's text or leave the account version unchanged.
 */

/* lingui-set comment="Interpolated values: files and waitingFiles are lists of document titles or file names." */
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
  summary,
}: {
  readonly session: ProjectSession;
  /** Reads the account again after an explicit send. */
  readonly onReopenAccount?: (() => void) | undefined;
  readonly summary?: 'saved' | 'saving';
}): ReactNode {
  const target = hostedTargetFor(session.projectId);
  const subscribe = useCallback((listener: () => void) => (target === null ? NOTHING : target.subscribe(listener)), [target]);
  const state = useSyncExternalStore(subscribe, () => target?.state() ?? IDLE);
  // A question the writer put off stays off for those paths: a new conflict asks anew.
  const [putOff, setPutOff] = useState('');
  if (summary !== undefined) {
    if (target === null) return null;
    const pending = state.kind === 'unsaved' || state.waiting !== undefined;
    const saving = state.kind === 'saving' || (state.kind === 'idle' && summary === 'saving');
    const status = state.kind === 'conflict' ? 'conflict' : state.stageFailed || pending ? 'failed' : saving ? 'saving' : 'saved';
    const persisted = state.kind === 'unsaved' ? state.persisted : state.waiting?.persisted;
    return <span className={`save-state is-${status}`} role={status === 'saved' ? 'status' : undefined} data-testid="save-state" data-state={status}>
      {state.stageFailed ? t`Your latest edits aren’t ready to send.`
        : state.kind === 'conflict' ? t`Another device saved these first`
        : pending ? persisted ? t`Saved here, not to your account.` : t`Closing this tab loses these changes.`
        : saving ? t`Saving…`
        : t`Your account has the changes.`}
    </span>;
  }
  if (target === null || state.kind === 'idle' || state.kind === 'saving') return null;
  if (state.stageFailed) return <p className="status-line" role="alert">
    <span><Trans>Your latest edits aren’t ready to send.</Trans></span>
    {state.readFailed === 'save' && <span><Trans>Save your edits before reading the account copy.</Trans></span>}
    {state.kind !== 'stale' && state.paths.length > 0 && !state.persisted
      ? <span><Trans>Closing this tab loses these changes.</Trans></span>
      : null}
    <button type="button" className="button" onClick={() => { void target.save(session.state); }}><Trans>Try again</Trans></button>
  </p>;
  const pending = state.kind === 'stale' || state.persisted
    ? t`Saved here, not to your account.`
    : t`Closing this tab loses these changes.`;
  const read = <button type="button" className="button" onClick={() => onReopenAccount?.()}><Trans>Read them</Trans></button>;
  const waitingFiles = state.waiting?.paths.map((path) => isolate(nameOf(path, session))).join(', ');
  const waitingText = <Trans>Read before sending these files: {waitingFiles}</Trans>;
  const waiting = state.waiting === undefined ? null : (
    <p className="status-line" role="status">
      <span>{waitingText}</span>
      {state.waiting.persisted
        ? read
        : state.readFailed !== 'queue' && <span><Trans>Closing this tab loses these changes.</Trans></span>}
    </p>
  );
  const readFailed = state.readFailed ? <p className="status-line" role="alert">
    {state.readFailed === 'save' ? <Trans>Save your edits before reading the account copy.</Trans>
      : <Trans>Closing this tab loses these changes.</Trans>}
  </p> : null;

  if (state.kind === 'unsaved') {
    // Nothing here is sent on its own: the account gets these words when the writer says so. What the writer can act on is whether a copy
    // survived a reload — a full or blocked store leaves them in this tab, and saying "on this device" would be the sentence that costs
    // them the work.
    return <><p className="status-line" role="status">
      {state.readFailed !== 'queue' && <span>{pending}</span>}
      <button type="button" className="button" onClick={() => {
        void target.sendQueued();
      }}>
        <Trans>Send them to your account</Trans>
      </button>
      {state.readOffered && waiting === null ? read : null}
    </p>{waiting}{readFailed}</>;
  }

  if (state.kind === 'stale') {
    return <>{waiting ?? <p className="status-line" role="status">
      <span><Trans>Your account has the changes.</Trans></span>
      {state.readFailed !== 'queue' && read}
    </p>}{readFailed}</>;
  }

  const key = state.paths.join('|');
  if (putOff === key) {
    return <><p className="status-line" role="status">
      {state.readFailed !== 'queue' && <span>{pending}</span>}
      <button type="button" className="button is-quiet" onClick={() => setPutOff('')}>
        <Trans>Ask me again</Trans>
      </button>
      {state.readOffered && waiting === null ? read : null}
    </p>{waiting}{readFailed}</>;
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
      ...(state.waiting?.persisted ? [{
        label: t`Read them`,
        onChoose: () => {
          setPutOff(key);
          onReopenAccount?.();
        },
      }] : []),
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
    {state.waiting && <p>{waitingText}</p>}
  </ChoiceDialog>;
}
