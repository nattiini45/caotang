/**
 * The provider picker's one-line summaries — [provider-gateway.md §2](docs/architecture/provider-gateway.md), formatted in the
 * formatter locale ([i18n.md §4.2, §4.1](docs/architecture/i18n.md)).
 *
 * These are pure: they read the model info and the preset registry, and take the locale the app's accessor supplies, so a model
 * test can pin what a German or a British interface reads without a React render.
 */

import { modelRowFor, type ModelInfo, type PresetDef } from '@caotang/gateway';
import { currencyFormat } from '@caotang/i18n';

import { formatterLocale } from '../i18n/format-locale.js';
import { formatCount } from './counts.js';

/** A listed model's context window and price in one line, for the picker. Empty when the endpoint tells neither. */
export function modelDetails(model: ModelInfo, locale: string = formatterLocale()): string {
  const parts: string[] = [];
  if (model.contextWindow !== undefined) parts.push(`${formatCount(model.contextWindow, locale)} tokens`);
  if (model.pricePer1k !== undefined) {
    const { prompt, completion } = model.pricePer1k;
    // Provider prices are USD, written the way the locale writes money: `US$0.002` in en-GB, `0,002 $` in de-DE.
    const usd = currencyFormat(locale);
    parts.push(`${usd.format(prompt)} in, ${usd.format(completion)} out per 1,000 tokens`);
  }
  return parts.join(' · ');
}

/**
 * What a capability row says a model can do, in one muted line (provider-gateway §2's "the table supplies what a
 * listing does not say"). Nothing is invented: a capability the row does not state is simply absent from the line.
 */
export function capsLine(preset: PresetDef, model: string, locale: string = formatterLocale()): string {
  if (model.trim() === '') return '';
  // A local server's models are whatever the person pulled, so the row is a fallback and not a statement about this model.
  if (preset.local !== undefined) {
    const window = modelRowFor(preset, model.trim())?.contextWindow;
    return `Until the server says more: ${window === undefined ? 'a small' : `${formatCount(window, locale)}-token`} window, no native tools, no image input.`;
  }
  const row = modelRowFor(preset, model.trim());
  if (row === undefined) {
    return 'Not a documented model for this provider — it is called with conservative defaults (no tools, no thinking level).';
  }
  const parts: string[] = [];
  if (row.contextWindow !== undefined) parts.push(`${formatCount(row.contextWindow, locale)}-token window`);
  if (row.caps.tools === true) parts.push('native tools');
  if (row.caps.vision === true) parts.push('image input');
  if (row.caps.jsonSchema === true) parts.push('JSON-schema replies');
  else if (row.caps.jsonObject === true) parts.push('JSON-object replies');
  if (row.caps.effortLevels !== undefined && row.caps.effortLevels.length > 0) {
    parts.push(`thinking: ${row.caps.effortLevels.join(' / ')}`);
  }
  if (row.caps.streamRequired === true) parts.push('thinking always streams');
  return parts.length === 0 ? 'Text only — no documented capabilities beyond it.' : parts.join(' · ');
}
