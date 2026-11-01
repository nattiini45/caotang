/**
 * Text runs are joined exactly as the file holds them. A word Final Draft split across `<Text>` runs (a style change in
 * the middle of it, an edit, a revision mark) reads back as one word, a space a run carries is kept, and no space is
 * inserted where the file has none. Real separators stay: paragraphs are separate lines, and an anchored script note is
 * set off from the text around it.
 */

import { describe, expect, it } from 'vitest';

import { importFdx, parseFdxParagraphs } from '../src/index.js';

function doc(...paragraphs: string[]): string {
  return ['<FinalDraft DocumentType="Script" Version="6">', '  <Content>', ...paragraphs.map((p) => `    ${p}`), '  </Content>', '</FinalDraft>'].join('\n');
}

const HEADING = '<Paragraph Type="Scene Heading"><Text>INT. HALL - DAY</Text></Paragraph>';

function bodyOf(...paragraphs: string[]): string {
  const script = importFdx(doc(HEADING, ...paragraphs));
  const scene = script.nodes.find((node) => node.kind === 'scene');
  if (scene === undefined || scene.kind !== 'scene') throw new Error('no scene');
  return scene.body;
}

describe('FDX text runs', () => {
  it('joins a word split across runs without a space', () => {
    const [p] = parseFdxParagraphs(doc('<Paragraph Type="Action"><Text>Wo</Text><Text>rd</Text></Paragraph>'));
    expect(p?.text).toBe('Word');
    expect(bodyOf('<Paragraph Type="Action"><Text>Wo</Text><Text>rd</Text></Paragraph>')).toContain('\nWord');
  });

  it('joins a word split across runs in a Note paragraph without a space', () => {
    const body = bodyOf('<Paragraph Type="Note"><Text>Wo</Text><Text>rd count</Text><Text> stays</Text></Paragraph>');
    expect(body).toContain('[[Word count stays]]');
    expect(body).not.toContain('Wo rd');
  });

  it('keeps a bold or italic change in the middle of a word as one word', () => {
    const body = bodyOf(
      '<Paragraph Type="Action"><Text>un</Text><Text Style="Bold">believ</Text><Text>able, </Text><Text Style="Italic">re</Text><Text>ally</Text></Paragraph>',
      '<Paragraph Type="Note"><Text>un</Text><Text Style="Bold">believ</Text><Text Style="Italic">able</Text></Paragraph>',
    );
    expect(body).toContain('un**believ**able, *re*ally');
    expect(body).toContain('[[unbelievable]]');
  });

  it('keeps the spaces runs carry, and adds none', () => {
    const [p] = parseFdxParagraphs(doc('<Paragraph Type="Dialogue"><Text>Hello </Text><Text Style="Bold">there</Text><Text>, friend.</Text></Paragraph>'));
    expect(p?.text).toBe('Hello there, friend.');
    const body = bodyOf(
      '<Paragraph Type="Character"><Text>ANA</Text></Paragraph>',
      '<Paragraph Type="Dialogue"><Text>Hello </Text><Text Style="Bold">there</Text><Text>, friend.</Text></Paragraph>',
      '<Paragraph Type="Note"><Text>Check </Text><Text Style="Italic">this</Text><Text> line.</Text></Paragraph>',
    );
    expect(body).toContain('Hello **there**, friend.');
    expect(body).toContain('[[Check this line.]]');
  });

  it('still sets an anchored script note off from the text in a Note paragraph', () => {
    const body = bodyOf(
      '<Paragraph Type="Note"><Text>Before</Text><ScriptNote><Paragraph><Text>inside</Text></Paragraph></ScriptNote><Text>after</Text></Paragraph>',
    );
    expect(body).toContain('[[Before inside after]]');
    const spaced = bodyOf(
      '<Paragraph Type="Note"><Text>Before </Text><ScriptNote><Paragraph><Text>inside</Text></Paragraph></ScriptNote><Text> after</Text></Paragraph>',
    );
    expect(spaced).toContain('[[Before inside after]]');
  });

  it('keeps separate paragraphs on separate lines', () => {
    const body = bodyOf('<Paragraph Type="Action"><Text>One</Text></Paragraph>', '<Paragraph Type="Action"><Text>Two</Text></Paragraph>');
    expect(body).toMatch(/One\n\nTwo/);
  });
});
