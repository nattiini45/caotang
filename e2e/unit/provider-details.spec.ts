import { expect, test } from '@playwright/test';

import { modelDetails } from '../../apps/desktop/src/app/provider-details.js';

/**
 * The provider picker's model line (provider-gateway §2) formats in the formatter locale (i18n.md §4.1, §4.2). The capability
 * line in the same module uses the same count formatter; its en-US wording is pinned by the mounted providers e2e.
 */
const model = { id: 'test-model', contextWindow: 1_000_000, pricePer1k: { prompt: 0.0015, completion: 0.002 } };

test('a model line groups its window and writes its USD price the way the formatter locale does', () => {
  expect(modelDetails(model, 'en-US')).toBe('1,000,000 tokens · $0.0015 in, $0.002 out per 1,000 tokens');
});

test('a British system names the currency, so a bare dollar sign cannot be mistaken for pounds', () => {
  expect(modelDetails(model, 'en-GB')).toContain('US$0.0015 in, US$0.002 out');
});

test('a German system groups with dots and writes the amount before the currency', () => {
  const line = modelDetails(model, 'de-DE');
  expect(line).toContain('1.000.000 tokens');
  expect(line).toContain('0,0015');
  expect(line).toContain('0,002');
});

test('a model with no window and no price has no line at all', () => {
  expect(modelDetails({ id: 'bare' }, 'de-DE')).toBe('');
});
