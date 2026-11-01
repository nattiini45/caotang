/**
 * The interface's reading direction for keyboard and layout code (i18n.md §5.5). It follows the activated catalogue, never the project
 * language: a right-to-left manuscript under an English interface still has a left-to-right shell.
 */

import { directionOf } from '@caotang/i18n';

import { uiLocale } from './format-locale.js';

/** Whether the interface is laid out right to left. */
export function uiIsRtl(): boolean {
  return directionOf(uiLocale()) === 'rtl';
}

/** The key as a horizontal group reads it: Left and Right swap in a right-to-left interface, so Right still means the next item in reading order. */
export function inlineKey(key: string): string {
  if (!uiIsRtl()) return key;
  return key === 'ArrowLeft' ? 'ArrowRight' : key === 'ArrowRight' ? 'ArrowLeft' : key;
}
