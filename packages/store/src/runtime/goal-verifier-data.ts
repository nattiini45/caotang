export const GOAL_VERIFIER_LIMITS = Object.freeze({
  rubric: 4000, title: 160, side: 2000, total: 12000, documents: 5, reply: 20000, reasons: 8, reason: 1000,
} as const);
export const GOAL_VERIFIER_UNAVAILABLE_CODES = Object.freeze(['no-changes', 'route', 'reply', 'source', 'budget', 'interrupted', 'stopped'] as const);

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const amount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = (value: unknown): value is number => amount(value) && Number.isSafeInteger(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max * 2 && [...value].length <= max;
const id = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const keys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every(key => allowed.includes(key));

export function goalVerifierDefinitionProblem(value: unknown): string | undefined {
  if (!record(value) || value['kind'] !== 'verifier') return 'it is not a verifier check';
  if (!keys(value, ['kind', 'rubric', 'scope', 'gate'])) return 'the verifier has an unsupported setting';
  if (!text(value['rubric'], GOAL_VERIFIER_LIMITS.rubric) || value['rubric'].trim() === '') return 'the verifier needs a nonblank rubric of at most 4000 characters';
  if (value['gate'] !== undefined && typeof value['gate'] !== 'boolean') return 'the verifier gate must be true or false';
  const scope = value['scope'];
  if (!record(scope) || (scope['mode'] !== 'full' && scope['mode'] !== 'changed' && scope['mode'] !== 'doc')) return 'the verifier names no supported scope';
  if (!keys(scope, scope['mode'] === 'doc' ? ['mode', 'docIds'] : ['mode'])) return 'the verifier scope has an unsupported setting';
  if (scope['mode'] === 'doc' && (!Array.isArray(scope['docIds']) || scope['docIds'].length === 0 || !scope['docIds'].every(id))) return 'the verifier scope must name documents';
  return undefined;
}

function definitionIdentity(value: Record<string, unknown>): string {
  const scope = value['scope'] as Record<string, unknown>;
  return JSON.stringify({ kind: 'verifier', rubric: value['rubric'], gate: value['gate'], scope: { mode: scope['mode'], ...(scope['mode'] === 'doc' ? { docIds: scope['docIds'] } : {}) } });
}

function matchesKey(value: unknown, definition: Record<string, unknown>): boolean {
  if (typeof value !== 'string') return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return record(parsed) && goalVerifierDefinitionProblem(parsed) === undefined && definitionIdentity(parsed) === definitionIdentity(definition);
  } catch {
    return false;
  }
}

function sources(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.length <= GOAL_VERIFIER_LIMITS.documents && value.every(source => record(source) && keys(source, ['docId', 'hash']) && id(source['docId']) && typeof source['hash'] === 'string' && /^[a-f0-9]{64}$/.test(source['hash'])) && new Set(value.map(source => (source as Record<string, unknown>)['docId'])).size === value.length;
}

function verdict(value: unknown): boolean {
  if (!record(value) || !keys(value, ['pass', 'reasons']) || typeof value['pass'] !== 'boolean' || !Array.isArray(value['reasons'])) return false;
  return value['reasons'].length <= GOAL_VERIFIER_LIMITS.reasons && (value['pass'] || value['reasons'].length > 0) && value['reasons'].every(reason => text(reason, GOAL_VERIFIER_LIMITS.reason) && reason.trim() !== '');
}

function input(value: unknown, definition: Record<string, unknown>, sourceIds: ReadonlySet<unknown>): boolean {
  if (!record(value) || !keys(value, ['rubric', 'excerpts', 'omitted', 'truncated']) || value['rubric'] !== definition['rubric'] || !count(value['omitted']) || typeof value['truncated'] !== 'boolean') return false;
  const excerpts = value['excerpts'];
  if (!Array.isArray(excerpts) || excerpts.length > GOAL_VERIFIER_LIMITS.documents * 2) return false;
  let used = 0;
  let truncated = false;
  const found = new Set<unknown>();
  const fields = new Set<string>();
  for (const excerpt of excerpts) {
    if (!record(excerpt) || !keys(excerpt, ['docId', 'title', 'field', 'before', 'after', 'truncated']) || !id(excerpt['docId']) || !sourceIds.has(excerpt['docId'])) return false;
    if ((excerpt['field'] !== 'body' && excerpt['field'] !== 'synopsis') || typeof excerpt['truncated'] !== 'boolean') return false;
    if (!text(excerpt['title'], GOAL_VERIFIER_LIMITS.title) || !text(excerpt['before'], GOAL_VERIFIER_LIMITS.side) || !text(excerpt['after'], GOAL_VERIFIER_LIMITS.side)) return false;
    used += [...excerpt['before']].length + [...excerpt['after']].length;
    truncated ||= excerpt['truncated'];
    found.add(excerpt['docId']);
    fields.add(JSON.stringify([excerpt['docId'], excerpt['field']]));
  }
  return used <= GOAL_VERIFIER_LIMITS.total && fields.size === excerpts.length && found.size === sourceIds.size && truncated === value['truncated'];
}

function reservation(value: unknown): boolean {
  if (!record(value) || !keys(value, ['id', 'promptTokens', 'maxOutputTokens', 'price']) || !id(value['id']) || !amount(value['promptTokens']) || !amount(value['maxOutputTokens'])) return false;
  if (!Number.isFinite(value['promptTokens'] + value['maxOutputTokens'])) return false;
  const price = value['price'];
  return price === undefined || record(price) && keys(price, ['prompt', 'completion']) && amount(price['prompt']) && amount(price['completion']) && Number.isFinite((value['promptTokens'] * price['prompt'] + value['maxOutputTokens'] * price['completion']) / 1000);
}

export function hasGoalVerifierData(value: unknown): boolean {
  if (!record(value)) return false;
  const goal = value['goal'];
  return value['verification'] !== undefined || value['pendingVerification'] !== undefined || record(goal) && Array.isArray(goal['checks']) && goal['checks'].some(check => record(check) && check['kind'] === 'verifier');
}

export function goalVerifierDataReadable(value: Record<string, unknown>): boolean {
  const goal = value['goal'];
  if (!record(goal) || !Array.isArray(goal['checks'])) return false;
  const definitions = goal['checks'].filter((check: unknown): check is Record<string, unknown> => record(check) && check['kind'] === 'verifier');
  const pending = value['pendingVerification'];
  const result = value['verification'];
  if (pending !== undefined && result !== undefined) return false;
  if (definitions.length === 0) return pending === undefined && result === undefined;
  const definition = definitions[0];
  if (definitions.length !== 1 || definition === undefined || goalVerifierDefinitionProblem(definition) !== undefined) return false;
  if (pending !== undefined) {
    if (!record(pending) || !keys(pending, ['key', 'iteration', 'phase', 'input', 'sources', 'reservation', 'uncertainUsage']) || !matchesKey(pending['key'], definition) || !count(pending['iteration']) || pending['iteration'] < 1) return false;
    if (pending['uncertainUsage'] !== undefined && (pending['uncertainUsage'] !== true || pending['phase'] !== 'settled')) return false;
    if (!Array.isArray(value['iterations']) || !value['iterations'].some(iteration => record(iteration) && iteration['n'] === pending['iteration']) || pending['iteration'] !== Number(value['nextIteration']) - 1) return false;
    if (!sources(pending['sources']) || !input(pending['input'], definition, new Set(pending['sources'].map(source => source['docId'])))) return false;
    if (pending['phase'] === 'reserved') {
      if (!reservation(pending['reservation'])) return false;
    } else if ((pending['phase'] !== 'prepared' && pending['phase'] !== 'settled') || pending['reservation'] !== undefined) return false;
  }
  if (result !== undefined) {
    if (!record(result) || !keys(result, ['key', 'iteration', 'status', 'verdict', 'reason', 'code', 'omitted', 'truncated', 'sources', 'uncertainUsage']) || !matchesKey(result['key'], definition) || !count(result['iteration']) || result['iteration'] >= Number(value['nextIteration'])) return false;
    if (result['code'] !== undefined && (result['status'] !== 'unavailable' || !(GOAL_VERIFIER_UNAVAILABLE_CODES as readonly unknown[]).includes(result['code']))) return false;
    if (result['uncertainUsage'] !== undefined && (result['uncertainUsage'] !== true || result['status'] !== 'unavailable')) return false;
    if (!sources(result['sources']) || !count(result['omitted']) || typeof result['truncated'] !== 'boolean') return false;
    if (result['status'] === 'complete') {
      if (result['iteration'] < 1 || result['sources'].length === 0 || !verdict(result['verdict']) || result['reason'] !== undefined) return false;
    } else if (result['status'] !== 'unavailable' || result['verdict'] !== undefined || !text(result['reason'], GOAL_VERIFIER_LIMITS.reason) || result['reason'].trim() === '' || result['sources'].length !== 0) return false;
  }
  if (record(pending) && pending['uncertainUsage'] === true || record(result) && result['uncertainUsage'] === true) {
    const limits = goal['limits'];
    const spend = value['spend'];
    if (!record(limits) || !record(spend)) return false;
    if (typeof limits['maxTokens'] === 'number' && Number(spend['promptTokens']) + Number(spend['completionTokens']) < limits['maxTokens']) return false;
    if (typeof limits['maxCostUsd'] === 'number' && Number(spend['costUsd'] ?? 0) < limits['maxCostUsd']) return false;
    if (typeof limits['maxActiveMs'] === 'number' && Number(spend['activeMs']) < limits['maxActiveMs']) return false;
  }
  const outcome = value['outcome'];
  if (outcome !== undefined) {
    if (!record(outcome) || typeof outcome['status'] !== 'string' || !['passed', 'stalled', 'regressed', 'budget', 'max-iterations', 'out-of-scope', 'cancelled', 'failed', 'refused'].includes(outcome['status']) || !id(outcome['reason'])) return false;
    if (outcome['status'] === 'passed' && definition['gate'] === true && (!record(result) || result['status'] !== 'complete' || !record(result['verdict']) || result['verdict']['pass'] !== true || result['iteration'] !== Number(value['nextIteration']) - 1)) return false;
  }
  return true;
}
