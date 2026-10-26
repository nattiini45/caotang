/**
 * The Context section of Settings (ui-modules §5.2, context-assembly §3): the prompt's whole budget, and the caps of the three
 * layers the spec names as config-exposed. An empty field keeps the spec's own default. A typed value is checked on save and
 * stored clamped into its range, the same way it loads, and the warn line names a total that is below the layer caps together.
 * The preview bar links to the prompt a scene draft would send under the typed budgets (context-assembly §5), when a project is open.
 *
 * Every sentence is a catalogue message (i18n.md §4.2, I5); the fixed layer names travel inside the sentence's own `select`, so no
 * sentence is assembled from translated fragments.
 */
/* lingui-set comment="Interpolated values: count, layerId, max, min" */

import { useState, type FormEvent, type ReactNode } from 'react';
import { select, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';

import { contextPreviewOf, type ContextPreviewView } from '../app/context-preview.js';
import type { AppServices } from '../app/services.js';
import type { ProjectSession } from '../app/session.js';
import {
  CONTEXT_LAYER_MAX,
  CONTEXT_LAYER_MIN,
  CONTEXT_TOTAL_MAX,
  CONTEXT_TOTAL_MIN,
  contextWarningOf,
  type ContextLayerId,
  type ContextSettings,
} from '../app/settings.js';
import { PromptPreview } from './PlanCard.js';
import { formatCount, useComposingEnter } from './shared.js';

/** Each layer's id and the default the spec gives it for a scene draft (context-assembly §2). */
const LAYERS: readonly { readonly id: ContextLayerId; readonly fallback: number }[] = [
  { id: 'L2', fallback: 1_000 },
  { id: 'L4', fallback: 2_000 },
  { id: 'L5', fallback: 2_000 },
];

/** A layer's name, as a field label. */
function layerLabel(id: ContextLayerId): string {
  switch (id) {
    case 'L2':
      return t`Codex entries`;
    case 'L4':
      return t`Story so far, from the synopses`;
    case 'L5':
      return t`Focus document text`;
  }
}

const WORDS_OF = (value: number): string => formatCount(value);

/**
 * A typed budget read as a whole number in range. `null` for an empty field (the default applies), and `undefined` for a
 * value that is not a whole number in range, which the form names rather than stores.
 */
function readBudget(text: string, min: number, max: number): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < min || value > max) return undefined;
  return value;
}

/** The budgets as the fields currently read, leaving out any field that does not read, so the warn line tracks what is typed. */
function draftOf(total: string, layers: Readonly<Record<ContextLayerId, string>>): ContextSettings {
  const totalValue = readBudget(total, CONTEXT_TOTAL_MIN, CONTEXT_TOTAL_MAX);
  const layerBudgets: Partial<Record<ContextLayerId, number>> = {};
  for (const layer of LAYERS) {
    const value = readBudget(layers[layer.id], CONTEXT_LAYER_MIN, CONTEXT_LAYER_MAX);
    if (typeof value === 'number') layerBudgets[layer.id] = value;
  }
  return { ...(typeof totalValue === 'number' ? { totalBudgetTokens: totalValue } : {}), layerBudgets };
}

/**
 * The preview bar's words (ui-modules §5.2, context-assembly §5): how the budgets divide one prompt, so the writer sees the split the
 * plan card's budget bar will show for each request. A layer with no budget of its own is read at its default, and the whole prompt
 * is the budget the writer typed, or the largest the layers add up to.
 */
function BudgetPreview({ draft }: { draft: ContextSettings }): ReactNode {
  const tokens = (id: ContextLayerId, fallback: number): number => draft.layerBudgets[id] ?? fallback;
  const layerTotal = LAYERS.reduce((sum, layer) => sum + tokens(layer.id, layer.fallback), 0);
  const whole = Math.max(draft.totalBudgetTokens ?? 0, layerTotal);
  return (
    <p className="muted" data-testid="context-preview">
      {t`A prompt of about ${{ whole: WORDS_OF(whole) }} tokens: ${{ l2: WORDS_OF(tokens('L2', 1_000)) }} tokens for the codex entries, ${{ l4: WORDS_OF(tokens('L4', 2_000)) }} tokens for the story so far, ${{ l5: WORDS_OF(tokens('L5', 2_000)) }} tokens for the focus document, and the rest for the instruction and the reply. The plan card shows this split for each request before you approve it.`}
    </p>
  );
}

/**
 * The prompt the preview link shows (context-assembly §5): the plan card's own prompt view for a scene draft of the open document,
 * or the sentence that says why there is none.
 */
function ContextPromptPreview({ view }: { view: ContextPreviewView }): ReactNode {
  if (view.kind === 'none') return <p className="muted">{view.message}</p>;
  return <PromptPreview context={view.preview} />;
}

/**
 * `session` is the project in view, when there is one. The preview link needs it, because the prompt is assembled from the
 * project's own text and codex. Absent or null, the section shows the budgets without the link.
 */
export function ContextSection({ services, session = null }: { services: AppServices; session?: ProjectSession | null }): ReactNode {
  const current = services.settings.current().context;
  const [total, setTotal] = useState(current.totalBudgetTokens === undefined ? '' : String(current.totalBudgetTokens));
  const [layers, setLayers] = useState<Record<ContextLayerId, string>>(() => ({
    L2: current.layerBudgets.L2 === undefined ? '' : String(current.layerBudgets.L2),
    L4: current.layerBudgets.L4 === undefined ? '' : String(current.layerBudgets.L4),
    L5: current.layerBudgets.L5 === undefined ? '' : String(current.layerBudgets.L5),
  }));
  const [message, setMessage] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const warning = contextWarningOf(draftOf(total, layers));
  // The budgets save on Enter (ui-modules §2.5): the mark from the keydown keeps a composing Enter from saving them.
  const ime = useComposingEnter();

  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (ime.takesSubmit()) return;
    const totalValue = readBudget(total, CONTEXT_TOTAL_MIN, CONTEXT_TOTAL_MAX);
    if (totalValue === undefined) {
      setMessage(
        t`The whole prompt is a whole number of tokens from ${{ min: WORDS_OF(CONTEXT_TOTAL_MIN) }} to ${{ max: WORDS_OF(CONTEXT_TOTAL_MAX) }}, or empty for the profile’s default.`,
      );
      return;
    }
    const layerBudgets: Partial<Record<ContextLayerId, number>> = {};
    for (const layer of LAYERS) {
      const value = readBudget(layers[layer.id], CONTEXT_LAYER_MIN, CONTEXT_LAYER_MAX);
      if (value === undefined) {
        const layerId = layer.id;
        setMessage(
          t`${select(layerId, { L2: 'Codex entries', L4: 'Story so far, from the synopses', L5: 'Focus document text', other: 'The layer' })} is a whole number of tokens from ${{ min: WORDS_OF(CONTEXT_LAYER_MIN) }} to ${{ max: WORDS_OF(CONTEXT_LAYER_MAX) }}, or empty for the default.`,
        );
        return;
      }
      if (value !== null) layerBudgets[layer.id] = value;
    }
    const next: ContextSettings = { ...(totalValue === null ? {} : { totalBudgetTokens: totalValue }), layerBudgets };
    // The agent reads the budgets at each turn (Workspace builds its controller with contextConfigOf), so a save applies to the
    // next request.
    void services.settings.update({ context: next }).then((error) => {
      setMessage(error ?? t`Saved. The agent’s next request uses these budgets.`);
    });
  };

  return (
    <section className="settings-section" aria-labelledby="settings-context">
      <h3 id="settings-context"><Trans>Context</Trans></h3>
      <p className="muted">
        <Trans>
          What the agent may send the model in one request, in tokens. An empty field keeps the default of the profile and the spec. A
          change applies from the agent’s next request.
        </Trans>
      </p>
      <form className="profile-form" onKeyDown={ime.noteKey} onSubmit={save} aria-label={t`Context budgets`}>
        <label>
          <span><Trans>Whole prompt</Trans></span>
          <input
            type="number"
            min={CONTEXT_TOTAL_MIN}
            max={CONTEXT_TOTAL_MAX}
            step={100}
            placeholder={t`Profile default`}
            value={total}
            onChange={(event) => setTotal(event.target.value)}
          />
        </label>
        {LAYERS.map((layer) => (
          <label key={layer.id}>
            <span>{layerLabel(layer.id)}</span>
            <input
              type="number"
              min={CONTEXT_LAYER_MIN}
              max={CONTEXT_LAYER_MAX}
              step={50}
              placeholder={t`${{ count: WORDS_OF(layer.fallback) }} by default`}
              value={layers[layer.id]}
              onChange={(event) => setLayers({ ...layers, [layer.id]: event.target.value })}
            />
          </label>
        ))}
        {warning !== undefined ? (
          <p className="status-line is-error" role="status">
            {warning}
          </p>
        ) : null}
        <BudgetPreview draft={draftOf(total, layers)} />
        {session === null ? null : (
          <div className="context-prompt">
            <button type="button" className="button is-quiet" aria-expanded={showPrompt} onClick={() => setShowPrompt((open) => !open)}>
              {showPrompt ? t`Hide the prompt for a scene` : t`See the prompt for a scene`}
            </button>
            {showPrompt ? <ContextPromptPreview view={contextPreviewOf(session.state, session.view.activeDocId, draftOf(total, layers))} /> : null}
          </div>
        )}
        <div className="profile-form-actions">
          <button type="submit" className="button is-primary">
            <Trans>Save budgets</Trans>
          </button>
        </div>
      </form>
      {message !== null ? (
        <p className="muted" role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}
