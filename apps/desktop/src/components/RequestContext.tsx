import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { ContextRef, RequestContextPreview } from '@caotang/harness';
import { formatCount } from './shared.js';
import { PromptPreview } from './PlanCard.js';

export function RequestContext({ request, running = false, pending = false, pinned, onExclude, onRestore }: {
  request: RequestContextPreview;
  running?: boolean;
  pending?: boolean;
  pinned?: readonly ContextRef[];
  onExclude?: (ref: ContextRef) => void;
  onRestore?: (ref: ContextRef) => void;
}) {
  const { meter, preview } = request;
  const capacity = Math.max(0, Math.min(meter.budgetTokens, meter.windowTokens === undefined ? Infinity : meter.windowTokens - meter.reserveTokens));
  const tokens = formatCount(meter.promptTokens);
  const budget = formatCount(meter.budgetTokens);
  const reserve = formatCount(meter.reserveTokens);
  const level = meter.level === 'over' ? t`Over capacity` : meter.level === 'near' ? t`Near capacity` : t`Within capacity`;
  return <section className={`request-context is-${meter.level}`} aria-label={t`Request context`} aria-busy={pending} data-testid="request-context" data-source={running ? 'running' : 'typed'} data-level={meter.level}>
    <p className="context-meter-line" role="status">
      {pending ? t`Updating context preview…` : <>
        {running ? t`Current request: about ${tokens} of ${budget} budgeted tokens` : t`Context estimate: about ${tokens} of ${budget} budgeted tokens`} · {level}
        {' · '}<span className="muted">{meter.windowTokens === undefined ? t`Model window: unknown.` : t`Model window: ${{ window: formatCount(meter.windowTokens) }} tokens.`}</span>
      </>}
    </p>
    <span className="context-bar" aria-hidden="true" style={{ visibility: pending ? 'hidden' : undefined }}><span style={{ width: `${capacity === 0 ? meter.promptTokens > 0 ? 100 : 0 : Math.min(100, meter.promptTokens / capacity * 100)}%` }} /></span>
    <PromptPreview context={preview} summary={running ? t`View the current planner prompt` : t`Preview this request`} pinned={pinned} onExclude={pending ? undefined : onExclude} onRestore={pending ? undefined : onRestore}>
      <p className="muted context-reserve"><Trans>Estimates include conversation messages. Output, thinking and system reserve: {reserve} tokens.</Trans></p>
    </PromptPreview>
  </section>;
}
