/**
 * The synopsis field, shared by a corkboard card and the inspector (ui-modules §4.1):
 * one textarea, capped at 2,000 characters with a live counter, committed through
 * `binder.setSynopsis` 800 ms after the last keystroke.
 *
 * Both places edit the same node's synopsis, so each follows the store: a change made
 * in one shows in the other as soon as the first one commits.
 */

import type { ReactNode } from 'react';
import { t } from '@lingui/core/macro';

import { nodeById } from '../app/binder-model.js';
import { SYNOPSIS_MAX_CHARS } from '../app/corkboard-model.js';
import type { ProjectSession } from '../app/session.js';
import { explain, setSynopsis } from './actions.js';
import { formatCount, useDebouncedText, useReport, useSession } from './shared.js';

export function SynopsisField({
  session,
  nodeId,
  variant,
  fieldId,
}: {
  session: ProjectSession;
  nodeId: string;
  variant: 'card' | 'inspector';
  fieldId?: string;
}): ReactNode {
  useSession(session);
  const report = useReport();
  const stored = nodeById(session.state, nodeId)?.synopsis ?? '';
  const field = useDebouncedText(stored, (text) => {
    const outcome = setSynopsis(session, nodeId, text);
    if (!outcome.ok) {
      report({ text: explain(outcome.error), tone: 'error' });
      return false;
    }
    return true;
  });
  const count = [...field.value].length;

  return (
    <div className={`synopsis-field is-${variant}`}>
      <textarea
        id={fieldId}
        className="synopsis"
        aria-label={t`Synopsis`}
        maxLength={SYNOPSIS_MAX_CHARS}
        rows={variant === 'card' ? 2 : 4}
        placeholder={t`Add a synopsis`}
        lang={session.state.manifest.project.language}
        dir="auto"
        value={field.value}
        onChange={(event) => field.change(event.target.value)}
        onBlur={field.flush}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      />
      <span className={`counter${count > SYNOPSIS_MAX_CHARS * 0.9 ? ' is-near' : ''}`} aria-live="off">
        {formatCount(count)} / {formatCount(SYNOPSIS_MAX_CHARS)}
      </span>
    </div>
  );
}
