/**
 * The Coherence section of Settings (ui-modules §5.2): which deterministic checks a scan runs, the scope the Findings tab starts
 * with, and the cap on the findings one model review may add. The values are app-level (the writer's own choices), so the
 * section writes them through the settings store and never through the project.
 */
/* lingui-set comment="Interpolated values: MAX_FINDINGS_CAP, max" */

import { useState, type FormEvent, type ReactNode } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { DETERMINISTIC_CHECK_IDS, MAX_FINDINGS_CAP, type DeterministicCheckId } from '@caotang/coherence';

import { SCOPE_CHOICES, checkLabelOf } from '../app/findings-model.js';
import { REVIEW_SCOPES, type ReviewScope } from '../app/settings.js';
import type { AppServices } from '../app/services.js';
import { useComposingEnter } from './shared.js';

/** A message beside the form, inline and next to what it is about (the same rule the other sections follow). */
function Message({ message }: { readonly message: { readonly text: string; readonly tone: 'info' | 'error' } | null }): ReactNode {
  if (message === null) return null;
  return (
    <p className={`form-message is-${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>
      {message.text}
    </p>
  );
}

/** The Coherence section's form, from the stored values, and the save that writes it back. */
export function CoherenceSection({ services }: { services: AppServices }): ReactNode {
  const current = services.settings.current().coherence;
  const [enabled, setEnabled] = useState<readonly DeterministicCheckId[]>(current.enabledChecks);
  const [scope, setScope] = useState<ReviewScope>(current.defaultReviewScope);
  const [cap, setCap] = useState(String(current.maxFindings));
  const [message, setMessage] = useState<{ readonly text: string; readonly tone: 'info' | 'error' } | null>(null);
  // The settings save on Enter (ui-modules §2.5): the mark from the keydown keeps a composing Enter from saving them.
  const ime = useComposingEnter();

  const toggle = (id: DeterministicCheckId, on: boolean): void => {
    setEnabled((previous) => (on ? DETERMINISTIC_CHECK_IDS.filter((known) => known === id || previous.includes(known)) : previous.filter((known) => known !== id)));
  };

  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (ime.takesSubmit()) return;
    const maxFindings = Number(cap);
    if (!Number.isInteger(maxFindings) || maxFindings < 1 || maxFindings > MAX_FINDINGS_CAP) {
      setMessage({ text: t`The most findings one review may add is a whole number from 1 to ${{ max: MAX_FINDINGS_CAP }}.`, tone: 'error' });
      return;
    }
    void services.settings
      .update({ coherence: { enabledChecks: enabled, defaultReviewScope: scope, maxFindings } })
      .then((error) => {
        setMessage(
          error === null || error === undefined
            ? { text: t`Saved. The Findings tab uses these from now on.`, tone: 'info' }
            : { text: error, tone: 'error' },
        );
      });
  };

  return (
    <section className="settings-section" aria-labelledby="settings-coherence">
      <h3 id="settings-coherence"><Trans>Coherence</Trans></h3>
      <form className="settings-form" onKeyDown={ime.noteKey} onSubmit={save}>
        <fieldset className="settings-checks">
          <legend><Trans>Quick checks the Findings tab’s scan runs</Trans></legend>
          {DETERMINISTIC_CHECK_IDS.map((id) => (
            <label key={id} className="settings-check">
              <input type="checkbox" checked={enabled.includes(id)} onChange={(event) => toggle(id, event.target.checked)} />
              <span>{checkLabelOf(id)}</span>
            </label>
          ))}
        </fieldset>
        <label>
          <span><Trans>Scope the Findings tab starts with</Trans></span>
          <select value={scope} onChange={(event) => setScope(event.target.value as ReviewScope)}>
            {REVIEW_SCOPES.map((choice) => (
              <option key={choice} value={choice}>
                {SCOPE_CHOICES.find((candidate) => candidate.id === choice)?.label ?? choice}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span><Trans>Most findings one model review may add (1–{MAX_FINDINGS_CAP})</Trans></span>
          <input type="number" min={1} max={MAX_FINDINGS_CAP} step={1} value={cap} onChange={(event) => setCap(event.target.value)} />
        </label>
        <button type="submit" className="button is-primary">
          <Trans>Save coherence settings</Trans>
        </button>
      </form>
      <Message message={message} />
    </section>
  );
}
