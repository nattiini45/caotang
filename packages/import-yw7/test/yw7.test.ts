import { describe, expect, it } from 'vitest';
import { readYw7, sceneMarkup } from '../src/index.js';

const FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<YWRITER7>
<PROJECT><Title>Demo</Title></PROJECT>
<CHARACTERS>
<CHARACTER><ID>1</ID><Title>Mara</Title><AKA>The Rider</AKA><Desc>A courier.</Desc><Bio>Born at sea.</Bio></CHARACTER>
<CHARACTER><ID>2</ID><Title>Jonas</Title></CHARACTER>
</CHARACTERS>
<LOCATIONS>
<LOCATION><ID>1</ID><Title>The Harbour</Title><Desc>Where ships land.</Desc></LOCATION>
</LOCATIONS>
<ITEMS>
<ITEM><ID>1</ID><Title>Compass</Title><Desc>Always north.</Desc></ITEM>
</ITEMS>
<SCENES>
<SCENE><ID>10</ID><Title>The Landing</Title><Desc>A boat arrives.</Desc>
<SceneContent>She stepped [i]ashore[/i].\n\n[b]Later[/b] the bell rang. [h1]Part one[/h1]</SceneContent>
<Status>2</Status><Day>4</Day><Hour>9</Hour><Minute>30</Minute><LastsDays>2</LastsDays><LastsHours>3</LastsHours>
<Characters><CharID>1</CharID><CharID>2</CharID></Characters>
<Locations><LocID>1</LocID></Locations><Items><ItemID>1</ItemID></Items>
<Tags><Tag>arrival</Tag></Tags><Goal>Reach the inn</Goal><Conflict>The gate is shut</Conflict><Outcome>She climbs the wall</Outcome>
</SCENE>
<SCENE><ID>11</ID><Title>The Inn</Title><Desc>Rest.</Desc><SceneContent>Quiet.</SceneContent><Unused>1</Unused><SpecificDateTime>2020-03-01 20:00</SpecificDateTime></SCENE>
<SCENE><ID>12</ID><Title>Unlisted</Title><Desc>Not in a chapter.</Desc><SceneContent>Orphan.</SceneContent></SCENE>
</SCENES>
<CHAPTERS>
<CHAPTER><ID>1</ID><Title>Part one</Title><SectionStart>1</SectionStart><Type>0</Type><Scenes></Scenes></CHAPTER>
<CHAPTER><ID>2</ID><Title>Chapter one</Title><Type>0</Type><Scenes><ScID>10</ScID><ScID>11</ScID></Scenes></CHAPTER>
<CHAPTER><ID>3</ID><Title>Scratch notes</Title><Type>1</Type><Desc>Internal.</Desc><Scenes></Scenes></CHAPTER>
</CHAPTERS>
<PROJECTNOTES><PROJECTNOTE><ID>1</ID><Title>Ideas</Title><Desc>A bigger boat.</Desc></PROJECTNOTE></PROJECTNOTES>
</YWRITER7>`;

const utf16 = (text: string): Uint8Array => {
  const buf = new Uint8Array(text.length * 2 + 2);
  buf[0] = 0xff;
  buf[1] = 0xfe;
  for (let i = 0; i < text.length; i += 1) {
    buf[2 + i * 2] = text.charCodeAt(i) & 0xff;
    buf[3 + i * 2] = text.charCodeAt(i) >> 8;
  }
  return buf;
};

describe('sceneMarkup', () => {
  it('converts [i], [b] and [hN], and counts other tags', () => {
    const out = sceneMarkup('[i]it[/i] [b]bd[/b] [h2]Head[/h2] [u]u[/u]');
    expect(out.body).toBe('*it* **bd** ## Head [u]u[/u]');
    expect(out.dropped).toBe(2);
  });
});

describe('readYw7', () => {
  const read = readYw7(new TextEncoder().encode(FIXTURE));
  it('reads the fixture', () => {
    expect(read.ok).toBe(true);
  });
  const value = read.ok ? read.value : undefined;
  it('builds the part with its chapter and scenes', () => {
    expect(value?.parts.length).toBe(2); // Part one + Unsorted
    const part = value?.parts[0];
    expect(part?.title).toBe('Part one');
    expect(part?.chapters[0]?.title).toBe('Chapter one');
    expect(part?.chapters[0]?.scenes.map((scene) => scene.title)).toEqual(['The Landing', 'The Inn']);
  });
  it('carries the declarations: pov, cast, day, duration', () => {
    const scene = value?.parts[0]?.chapters[0]?.scenes[0];
    expect(scene?.pov).toBe('Mara');
    expect(scene?.expectedPresent).toEqual(['Mara', 'Jonas', 'The Harbour', 'Compass']);
    expect(scene?.dayOffset).toBe(4);
    expect(scene?.durationDays).toBe(2);
    expect(scene?.status).toBe('Draft');
    expect(scene?.keywords).toEqual(['arrival']);
  });
  it('keeps clocks, dates and sub-day lengths as notes and losses', () => {
    const scene = value?.parts[0]?.chapters[0]?.scenes[0];
    expect(scene?.notes.some((line) => line.startsWith('Goal:'))).toBe(true);
    expect(scene?.notes.some((line) => line.includes('Time of day'))).toBe(true);
    expect(scene?.notes.some((line) => line.includes('Lasts:'))).toBe(true);
    const inn = value?.parts[0]?.chapters[0]?.scenes[1];
    expect(inn?.keywords).toContain('unused');
    expect(inn?.notes.some((line) => line.startsWith('When:'))).toBe(true);
    expect(value?.losses.map((loss) => loss.code)).toEqual(expect.arrayContaining(['clock-time', 'calendar-date', 'sub-day-duration']));
  });
  it('converts the markup', () => {
    const scene = value?.parts[0]?.chapters[0]?.scenes[0];
    expect(scene?.body).toContain('*ashore*');
    expect(scene?.body).toContain('**Later**');
    expect(scene?.body).toContain('# Part one');
  });
  it('reads UTF-16', () => {
    const utf16Read = readYw7(utf16(FIXTURE));
    expect(utf16Read.ok).toBe(true);
    if (utf16Read.ok) expect(utf16Read.value.parts[0]?.title).toBe('Part one');
  });
  it('reads the codex and the research', () => {
    expect(value?.codex.map((row) => row.name)).toEqual(['Mara', 'Jonas', 'The Harbour', 'Compass']);
    const mara = value?.codex[0];
    expect(mara?.aliases).toEqual(['The Rider']);
    expect(mara?.page.body).toContain('# Mara');
    expect(value?.research.map((doc) => doc.title)).toEqual(['Scratch notes', 'Ideas']);
  });
  it('refuses a non-yw7 file and an empty one', () => {
    expect(readYw7(new TextEncoder().encode('<root/>'))).toEqual({ ok: false, error: { kind: 'not-yw7' } });
    const empty = readYw7(new TextEncoder().encode('<YWRITER7/>'));
    expect(empty).toEqual({ ok: false, error: { kind: 'empty' } });
  });
});
