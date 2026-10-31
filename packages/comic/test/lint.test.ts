import { describe, expect, it } from 'vitest';
import {
  MAX_WORDS_PER_BALLOON,
  MAX_WORDS_PER_PANEL,
  checkBalloonDensity,
  checkCapsPolicy,
  checkEmDash,
  countWords,
  lintComic,
  renderMessage,
  type ComicPageInput,
  type LintOptions,
} from '../src/index.js';
import { balloon, page, panel, words } from './fixtures.js';

const caps: LintOptions = { book: { capsTransform: true, esszett: false }, language: 'en' };
const input = (...panels: ReturnType<typeof panel>[]): ComicPageInput[] => [{ id: 'n_PAGE', number: 3, page: page(panels) }];

describe('balloon density', () => {
  it('pins the thresholds', () => {
    expect(MAX_WORDS_PER_BALLOON).toBe(25);
    expect(MAX_WORDS_PER_PANEL).toBe(50);
  });

  it('does not warn at 25 words and warns at 26', () => {
    expect(checkBalloonDensity(input(panel('p', [balloon('b', words(25))])), caps)).toEqual([]);
    const findings = checkBalloonDensity(input(panel('p', [balloon('b', words(26))])), caps);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ checkId: 'comic.balloon-density', code: 'balloon', severity: 'warning' });
    expect(findings[0]?.where).toMatchObject({ pageNumber: 3, panelId: 'p', balloonId: 'b' });
    expect(renderMessage(findings[0]!.message)).toContain('26 words');
  });

  it('does not warn at 50 words in a panel and warns at 51', () => {
    const at50 = [balloon('a', words(25)), balloon('b', words(25))];
    expect(checkBalloonDensity(input(panel('p', at50)), caps)).toEqual([]);
    const findings = checkBalloonDensity(input(panel('p', [balloon('a', words(25)), balloon('b', words(26))])), caps);
    expect(findings.map((f) => f.code)).toEqual(['balloon', 'panel']);
    const only = checkBalloonDensity(input(panel('p', [balloon('a', words(20)), balloon('b', words(20)), balloon('c', words(11))])), caps);
    expect(only.map((f) => f.code)).toEqual(['panel']);
    expect(only[0]?.evidence).toBe('51 words');
  });

  it('counts per panel, not per page', () => {
    const two = input(panel('p1', [balloon('a', words(30))]), panel('p2', [balloon('b', words(30))]));
    expect(checkBalloonDensity(two, caps).map((f) => f.code)).toEqual(['balloon', 'balloon']);
  });

  it('ignores emphasis markers when counting', () => {
    expect(checkBalloonDensity(input(panel('p', [balloon('b', `**${words(25)}**`)])), caps)).toEqual([]);
  });

  it('warns for an empty panel never, and for an empty balloon never', () => {
    expect(checkBalloonDensity(input(panel('p')), caps)).toEqual([]);
    expect(checkBalloonDensity(input(panel('p', [balloon('b', '')])), caps)).toEqual([]);
    expect(checkBalloonDensity([], caps)).toEqual([]);
  });

  it('counts Han text by word, not by whitespace', () => {
    expect(countWords('你好世界')).toBeGreaterThan(1);
    expect(checkBalloonDensity(input(panel('p', [balloon('b', '你好世界')])), caps)).toEqual([]);
    expect(checkBalloonDensity(input(panel('p', [balloon('b', '你好世界'.repeat(30))])), caps).map((f) => f.code)).toContain('balloon');
  });

  it('counts right-to-left text by its spaces', () => {
    const arabic = Array.from({ length: 26 }, () => 'مرحبا').join(' ');
    expect(checkBalloonDensity(input(panel('p', [balloon('b', arabic)])), caps)).toHaveLength(1);
    expect(checkBalloonDensity(input(panel('p', [balloon('b', arabic.split(' ').slice(0, 25).join(' '))])), caps)).toEqual([]);
  });

  it('keeps a stable key and accepts other limits', () => {
    const a = checkBalloonDensity(input(panel('p', [balloon('b', words(26))])), caps);
    const b = checkBalloonDensity(input(panel('p', [balloon('b', words(40))])), caps);
    expect(a[0]?.key).toBe(b[0]?.key);
    expect(checkBalloonDensity(input(panel('p', [balloon('b', words(10))])), { ...caps, balloonWordLimit: 9 })).toHaveLength(1);
  });
});

describe('em dash lint', () => {
  it('flags an em dash with the words around it, and not a double dash', () => {
    const findings = checkEmDash(input(panel('p', [balloon('b', 'Wait — no. Stop.')])));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ checkId: 'comic.em-dash', code: 'emDash', severity: 'warning' });
    expect(findings[0]?.evidence).toBe('Wait — no. Stop.');
    expect(findings[0]?.nextAction.message).toContain('two hyphens');
    expect(checkEmDash(input(panel('p', [balloon('b', 'Wait -- no.')])))).toEqual([]);
  });

  it('flags once per balloon', () => {
    expect(checkEmDash(input(panel('p', [balloon('b', 'a — b — c')])))).toHaveLength(1);
  });

  it('leaves Han and kana text alone, where the long dash is ordinary punctuation', () => {
    expect(checkEmDash(input(panel('p', [balloon('b', '你好——世界')])))).toEqual([]);
    expect(checkEmDash(input(panel('p', [balloon('b', 'こんにちは—さようなら')])))).toEqual([]);
  });

  it('flags right-to-left text that carries an em dash', () => {
    expect(checkEmDash(input(panel('p', [balloon('b', 'مرحبا — بالعالم')])))).toHaveLength(1);
  });
});

describe('caps policy lint', () => {
  const sz = input(panel('p', [balloon('b', 'Die Straße.')]));

  it('tells the writer a ß will be lettered as SS', () => {
    const findings = checkCapsPolicy(sz, { ...caps, language: 'de' });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ checkId: 'comic.caps-policy', code: 'esszettBecomesSS', severity: 'info' });
    expect(findings[0]?.nextAction.message).toContain('ẞ');
  });

  it('says nothing when the book opts into ẞ', () => {
    expect(checkCapsPolicy(sz, { book: { capsTransform: true, esszett: true }, language: 'de' })).toEqual([]);
  });

  it('says nothing when the book keeps mixed case', () => {
    expect(checkCapsPolicy(sz, { book: { capsTransform: false, esszett: false }, language: 'de' })).toEqual([]);
  });

  it('says nothing about mixed-case source when caps are on, or about caseless scripts', () => {
    const mixed = input(panel('p', [balloon('a', 'Who Is There?'), balloon('b', '你好，世界'), balloon('c', 'مرحبا'), balloon('d', 'שלום')]));
    expect(checkCapsPolicy(mixed, caps)).toEqual([]);
  });
});

describe('lintComic', () => {
  it('reports each rule that applies to one balloon', () => {
    const text = `${words(26)} — Straße`;
    const findings = lintComic(input(panel('p', [balloon('b', text)])), { ...caps, language: 'de' });
    expect(findings.map((f) => f.checkId).sort()).toEqual(['comic.balloon-density', 'comic.caps-policy', 'comic.em-dash']);
    expect(new Set(findings.map((f) => f.key)).size).toBe(findings.length);
  });

  it('reports nothing for clean lettering', () => {
    expect(lintComic(input(panel('p', [balloon('b', 'Who is there?')])), caps)).toEqual([]);
  });
});
