import { DETERMINISTIC_CHECK_IDS, FINDING_SEVERITIES, type ScanComputeOutcome } from '@caotang/coherence';
import { LAYER_IDS, stagedOf, type AssembledCall } from '@caotang/harness';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const checks = (value: unknown): boolean => strings(value) && value.every((id) => (DETERMINISTIC_CHECK_IDS as readonly string[]).includes(id));

export function callOk(value: unknown): value is AssembledCall {
  if (!record(value)) return false;
  const preview = stagedOf({ context: value['preview'] }).context;
  if (preview === undefined || JSON.stringify(value['messages']) !== JSON.stringify(preview.payload)) return false;
  const prompt = value['prompt'];
  if (!record(prompt) || !['scene.draft', 'continuity.scan', 'synopsis.fill', 'dialogue.draft', 'delegate', 'meta'].includes(String(prompt['tool']))) return false;
  if (!count(prompt['totalBudget']) || typeof prompt['overBudget'] !== 'boolean' || !record(prompt['model'])) return false;
  const estimate = prompt['estimate'];
  if (!record(estimate) || !count(estimate['promptTokens'])) return false;
  const byLayer = estimate['byLayer'];
  if (!record(byLayer) || !LAYER_IDS.every((id) => count(byLayer[id]))) return false;
  const layers = prompt['layers'];
  if (!Array.isArray(layers) || layers.length !== LAYER_IDS.length || !layers.every((layer: unknown, index) => record(layer) && layer['id'] === LAYER_IDS[index] && strings(layer['dropped']) && Array.isArray(layer['kept']))) return false;
  if (stagedOf({ context: { ...preview, layers } }).context === undefined) return false;
  const messages = prompt['messages'];
  if (!Array.isArray(messages) || messages.length !== 2 || !messages.every((message: unknown, index) => record(message) && message['role'] === (index === 0 ? 'system' : 'user') && typeof message['content'] === 'string')) return false;
  const parts = prompt['parts'];
  if (!Array.isArray(parts) || !parts.every((part: unknown) => record(part) && (part['layer'] === 'status' || (LAYER_IDS as readonly unknown[]).includes(part['layer'])) && typeof part['text'] === 'string' && (part['cacheBoundary'] === undefined || typeof part['cacheBoundary'] === 'boolean'))) return false;
  const focus = prompt['focus'];
  return focus === undefined || (record(focus) && typeof focus['doc'] === 'string' && typeof focus['title'] === 'string' && typeof focus['head'] === 'string' && count(focus['chars']) && count(focus['documentChars']) && ['draft', 'continue', 'rewrite_selection', 'full'].includes(String(focus['mode'])));
}

export function outcomeOk(value: unknown): value is ScanComputeOutcome {
  if (!record(value)) return false;
  if (value['ok'] === false) return typeof value['code'] === 'string' && typeof value['message'] === 'string';
  if (value['ok'] !== true || !count(value['count'])) return false;
  const compute = value['compute'];
  if (!record(compute) || !checks(compute['ranIds']) || !checks(compute['branchIds']) || !count(compute['scopeCount']) || compute['scopeCount'] !== value['count']) return false;
  if (!['full', 'changed', 'doc'].includes(String(compute['scopeMode'])) || !['branchReads', 'parityRequested', 'parityReads'].every((key) => typeof compute[key] === 'boolean')) return false;
  if (!['scopeDocIds', 'unavailable', 'emptyDocIds', 'excludedDocIds', 'checkNotes'].every((key) => strings(compute[key]))) return false;
  const reviewed = compute['reviewed'];
  if (!Array.isArray(reviewed) || !reviewed.every((row: unknown) => record(row) && typeof row['docId'] === 'string' && count(row['revision']))) return false;
  const drafts = compute['drafts'];
  return Array.isArray(drafts) && drafts.every((draft: unknown) => {
    if (!record(draft) || !(DETERMINISTIC_CHECK_IDS as readonly unknown[]).includes(draft['checkId']) || !(FINDING_SEVERITIES as readonly unknown[]).includes(draft['severity'])) return false;
    if (!['type', 'factGroup', 'message'].every((key) => typeof draft[key] === 'string') || (draft['expected'] !== undefined && typeof draft['expected'] !== 'string')) return false;
    const evidence = draft['evidence'];
    if (!Array.isArray(evidence) || !evidence.every((span: unknown) => record(span) && typeof span['docId'] === 'string' && typeof span['quote'] === 'string' && count(span['from']) && count(span['to']) && span['to'] >= span['from'] && (span['paraHash'] === undefined || typeof span['paraHash'] === 'string'))) return false;
    const ref = draft['messageRef'];
    return ref === undefined || (record(ref) && typeof ref['id'] === 'string' && typeof ref['message'] === 'string' && (ref['values'] === undefined || (record(ref['values']) && Object.values(ref['values']).every((item) => typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item))))));
  });
}
