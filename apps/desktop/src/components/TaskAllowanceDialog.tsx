import { useRef, useState, type ReactNode } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@ui-sdk/react/dialog';
import type { RecurringTasks, TaskRowView } from '../app/recurring-tasks.js';
import './task-allowance-dialog.css';

/* lingui-set comment="Interpolated values: calls" */

export default function TaskAllowanceDialog({ task, recurring, onClose, finalFocus }: {
  task: TaskRowView | null;
  recurring: RecurringTasks;
  onClose: () => void;
  finalFocus: () => HTMLElement | null;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement | null>(null);
  const calls = task?.maxModelCalls ?? 0;
  const close = (): void => { setError(null); onClose(); };
  return (
    <Dialog open={task !== null} onOpenChange={(open, details) => {
      if (busy) details.cancel();
      else if (!open) close();
    }}>
      <DialogContent container={typeof document === 'undefined' ? undefined : document.body} className="confirm recurring-allowance" initialFocus={() => cancel.current} finalFocus={finalFocus}>
        <div className="confirm-body" aria-busy={busy}>
          <DialogTitle><Trans>Allow this task to start by itself?</Trans></DialogTitle>
          <DialogDescription><Trans>This allowance stays in this browser. Drafts wait in the Inbox for your review. Nothing is applied automatically.</Trans></DialogDescription>
          <div className="recurring-allowance-details">
          <p><strong>{task?.name}</strong> · {task?.schedule}</p>
          <p>{task?.permission === 'read-only' ? t`May not change anything` : t`Asks before it changes anything`}</p>
          <p>{task?.maxModelCalls === null ? t`This plan calls no model.` : t`At most ${{ calls }} model calls per run. A lower limit in Settings still applies.`}</p>
          <p><Trans>Model calls send project context to your configured provider and may incur charges. The call limit is not a spending limit. Changing the plan, schedule, permission or cap requires a new allowance.</Trans></p>
          <pre className="recurring-steps">{task?.draft.steps}</pre>
          </div>
          {error === null ? null : <p className="form-message is-error" role="alert">{error}</p>}
          <div className="confirm-actions">
            <button ref={cancel} type="button" className="button" disabled={busy} onClick={close}><Trans>Cancel</Trans></button>
            <button type="button" className="button is-primary" disabled={busy} onClick={() => {
              if (task === null) return;
              setBusy(true);
              void recurring.allowSelfStart(task.id, task.fingerprint).then((failure) => {
                setBusy(false);
                if (failure === null) close();
                else setError(failure);
              });
            }}>{busy ? t`Saving…` : t`Allow automatic starts`}</button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
