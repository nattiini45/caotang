/* lingui-set comment="Interpolated values: id is the local run id; number is the step number; tool and status are recorded identifiers; detail is the recorded step detail; calls, reserved, prompt, completion, estimated and steps are counts; cost is recorded USD cost or unknown; active is milliseconds." */
import { redactDeep } from '@caotang/gateway';
import { t } from '@lingui/core/macro';
import type { RunEvent, RunRecord } from '@caotang/harness';
import { joinPath, type ArtifactFs } from '@caotang/store';

const EVENT_FIELDS = {
  'turn.start': ['v', 'intent', 'wire', 'native', 'resumedFrom', 'withheld', 'command', 'hiddenFromPlanner', 'outsidePrompt', 'contextOverrides'],
  messages: ['appended'],
  'skills.loading': [],
  'skills.loaded': ['skills'],
  'card.pending': ['kind', 'steps', 'proposals', 'revisions', 'done'],
  'card.decided': ['decision'],
  'rule.approved': ['callId', 'tool', 'rule'],
  'step.intent': ['callId', 'index', 'tool', 'expect', 'structure'],
  'step.applied': ['callId', 'index', 'tool', 'summary', 'after'],
  'step.failed': ['callId', 'index', 'tool', 'error'],
  spend: ['spend', 'reservedCalls'],
  'turn.end': ['status', 'summary'],
} as const satisfies Record<RunEvent['t'], readonly string[]>;

function withoutPrivateFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPrivateFields);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => {
    const name = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    return !name.startsWith('baseline') && !name.endsWith('headers') &&
      !/^(auth|authentication|authorization|proxyauthorization|key|apikey|token|credentials?|password|secret|secretkey|privatekey|clientsecret|accesstoken|refreshtoken|provider|profile|providerprofile)(config|configuration|s)?$/.test(name);
  }).map(([key, item]) => [key, withoutPrivateFields(item)]));
}

function fenced(text: string, language: string): string {
  let length = 3;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const ticks = '`'.repeat(length);
  return `${ticks}${language}\n${text}\n${ticks}`;
}

export function exportRunLog(run: RunRecord, events: readonly RunEvent[]): { readonly jsonl: string; readonly markdown: string } {
  const metadata = redactDeep({
    t: 'run.metadata',
    schema: run.schema,
    runId: run.runId,
    projectId: run.projectId,
    kind: run.kind,
    intent: run.intent,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    profileId: run.profileId,
    model: run.model,
    status: run.status,
    outcome: run.outcome,
    cannotResume: run.cannotResume,
  });
  const cleanEvents = events.map((event) => {
    const source = event as unknown as Record<string, unknown>;
    return redactDeep(withoutPrivateFields(Object.fromEntries(
      ['t', 'seq', 'at', 'turnId', ...EVENT_FIELDS[event.t]].map((key) => [key, source[key]]),
    ))) as RunEvent;
  });
  const eventLines = cleanEvents.map((event) => JSON.stringify(event)).join('\n');
  const end = cleanEvents.findLast((event) => event.t === 'turn.end');
  const spend = cleanEvents.findLast((event) => event.t === 'spend');
  const steps = new Map<string, string>();
  for (const event of cleanEvents) {
    if (event.t === 'step.intent' || event.t === 'step.applied' || event.t === 'step.failed') {
      const detail = event.t === 'step.failed' ? event.error : event.t === 'step.applied' ? event.summary : undefined;
      steps.set(event.callId, `- ${t`Step ${{ number: event.index + 1 }}: ${{ tool: event.tool }} — ${{ status: event.t.slice(5) }}${{ detail: detail ? `: ${detail}` : '' }}`}`);
    }
  }
  const spendText = spend === undefined ? t`No spend recorded.` : [
    t`Model calls: ${{ calls: spend.spend.modelCalls }}; reserved calls: ${{ reserved: spend.reservedCalls }}.`,
    t`Prompt tokens: ${{ prompt: spend.spend.promptTokens }}; completion tokens: ${{ completion: spend.spend.completionTokens }}; estimated tokens: ${{ estimated: spend.spend.estimatedTokens }}.`,
    t`Cost: ${{ cost: spend.spend.costUsd === undefined ? t`unknown` : `USD ${spend.spend.costUsd}` }}.`,
    t`Steps: ${{ steps: spend.spend.steps }}; active time: ${{ active: spend.spend.activeMs }} ms.`,
  ].join('\n');
  return {
    jsonl: `${JSON.stringify(metadata)}\n${eventLines}${eventLines ? '\n' : ''}`,
    markdown: [
      `# ${t`Agent run ${{ id: metadata.runId }}`}`,
      `## ${t`Intent`}`, metadata.intent,
      `## ${t`Outcome`}`, end === undefined ? metadata.outcome ?? metadata.status : `${metadata.outcome ?? end.status}\n\n${end.summary}`,
      ...(metadata.cannotResume ? [t`This run cannot be resumed.`] : []),
      `## ${t`Steps`}`, steps.size === 0 ? t`No steps recorded.` : [...steps.values()].join('\n'),
      `## ${t`Spend`}`, spendText,
      `## ${t`Events`}`, cleanEvents.length === 0 ? t`No events recorded.` : fenced(eventLines, 'jsonl'),
      '',
    ].join('\n\n'),
  };
}

export async function writeRunLogMirror(fs: ArtifactFs, run: RunRecord, events: readonly RunEvent[]): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(run.runId) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(run.runId)) {
    throw new Error(t`The run id is not safe for a folder log.`);
  }
  const { jsonl } = exportRunLog(run, events);
  await fs.ensureDir('runs');
  await fs.writeAtomic(joinPath('runs', run.runId + '.jsonl'), jsonl);
}
