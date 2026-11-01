/**
 * Writer text interpolated into the interface is bidi-isolated (i18n.md §5.3; I4 / #194).
 *
 * `<UserText>` is the JSX form (`<bdi lang dir="auto">`); `isolatedText` is the form for attributes
 * and plain strings (FSI…PDI, U+2068…U+2069). Neither translates anything: the writer's text is
 * carried through byte for byte.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { isolatedText, UserText } from '../src/i18n/UserText.js';

describe('writer text in the interface', () => {
  it('renders a JSX interpolation as an isolated bdi with the content language and automatic direction', () => {
    expect(renderToStaticMarkup(<UserText value="الفصل الأول" lang="ar" />)).toBe(
      '<bdi lang="ar" dir="auto">الفصل الأول</bdi>',
    );
  });

  it('leaves the language off when the surface does not know the project language', () => {
    expect(renderToStaticMarkup(<UserText value="Chapter One" />)).toBe('<bdi dir="auto">Chapter One</bdi>');
  });

  it('wraps a plain-string interpolation in FSI…PDI and leaves empty text empty', () => {
    expect(isolatedText('الفصل الأول')).toBe('\u2068الفصل الأول\u2069');
    expect(isolatedText('')).toBe('');
  });
});
