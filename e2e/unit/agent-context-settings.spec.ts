import { expect, test } from '@playwright/test';

import { priceFromInputs } from '../../apps/desktop/src/app/providers.js';
import {
  CONTEXT_LAYER_MIN,
  CONTEXT_TOTAL_MAX,
  DEFAULT_SETTINGS,
  applyPatch,
  contextConfigOf,
  contextWarningOf,
  normalizeContext,
  normalizeSettings,
} from '../../apps/desktop/src/app/settings.js';

/**
 * The Context section's budgets (context-assembly §3, ui-modules §5.1-5.2): they load clamped, reach the assembler as its
 * config, and the warn line names a total below the layer caps. Also the provider form's optional prices (provider-gateway §2).
 */

test.describe('the context budgets load clamped, and an unset record keeps the spec’s defaults', () => {
  test('a total and a layer cap are clamped into range, and a layer that is not a number is left unset', () => {
    expect(normalizeContext({ totalBudgetTokens: 1_000_000, layerBudgets: { L2: 50, L4: 'lots', L9: 3, L5: 9_000 } })).toEqual({
      totalBudgetTokens: CONTEXT_TOTAL_MAX,
      layerBudgets: { L2: CONTEXT_LAYER_MIN, L5: 9_000 },
    });
  });

  test('a missing record is the default: no total, and no layer caps', () => {
    expect(normalizeContext(undefined)).toEqual({ layerBudgets: {} });
    expect(normalizeSettings({}).context).toEqual({ layerBudgets: {} });
    expect(DEFAULT_SETTINGS.context).toEqual({ layerBudgets: {} });
  });

  test('a patch replaces the whole context record, and the result is normalised', () => {
    const patched = applyPatch(DEFAULT_SETTINGS, { context: { layerBudgets: { L4: 3_000 } } });
    expect(patched.context).toEqual({ layerBudgets: { L4: 3_000 } });
  });
});

// A view-model test: it checks the mapping `contextConfigOf` makes. The agent does not pass that mapping to its context port yet
// (Workspace builds the controller without it), so the saved budgets do not reach a request until that wiring lands.
test.describe('contextConfigOf maps the saved budgets to the assembler config shape', () => {
  test('the total becomes contextBudget and the caps become layerBudgets, and an unset value adds nothing', () => {
    expect(contextConfigOf({ layerBudgets: {} })).toEqual({});
    expect(contextConfigOf({ totalBudgetTokens: 12_000, layerBudgets: { L2: 1_500 } })).toEqual({
      contextBudget: 12_000,
      layerBudgets: { L2: 1_500 },
    });
  });
});

test.describe('the warn line names a total that is below the layer caps together', () => {
  test('a total below the caps warns with both numbers, and a total that covers them does not', () => {
    const warning = contextWarningOf({ totalBudgetTokens: 5_000, layerBudgets: { L2: 2_000, L4: 4_000 } }, 'en-US');
    expect(warning).toContain('5,000 tokens');
    expect(warning).toContain('6,000 tokens');
    expect(contextWarningOf({ totalBudgetTokens: 10_000, layerBudgets: { L2: 2_000, L4: 4_000 } }, 'en-US')).toBeUndefined();
  });

  test('the warning groups its numbers the way the formatter locale does', () => {
    const warning = contextWarningOf({ totalBudgetTokens: 5_000, layerBudgets: { L2: 2_000, L4: 4_000 } }, 'de-DE');
    expect(warning).toContain('5.000 tokens');
    expect(warning).toContain('6.000 tokens');
  });

  test('no total set, or no cap set, gives no warning', () => {
    expect(contextWarningOf({ layerBudgets: { L2: 2_000 } }, 'en-US')).toBeUndefined();
    expect(contextWarningOf({ totalBudgetTokens: 1_000, layerBudgets: {} }, 'en-US')).toBeUndefined();
  });
});

test.describe('the provider form’s prices are both or neither, and zero or more', () => {
  test('two empty fields are no price, and two numbers are a price per 1,000 tokens', () => {
    expect(priceFromInputs('', '')).toEqual({ ok: true });
    expect(priceFromInputs(' 0.0015 ', '0.002')).toEqual({ ok: true, price: { prompt: 0.0015, completion: 0.002 } });
  });

  test('one field alone, a negative number, or text is named for the writer and not read', () => {
    expect(priceFromInputs('0.001', '')).toMatchObject({ ok: false });
    expect(priceFromInputs('-1', '1')).toMatchObject({ ok: false });
    expect(priceFromInputs('abc', '1')).toMatchObject({ ok: false });
  });
});
