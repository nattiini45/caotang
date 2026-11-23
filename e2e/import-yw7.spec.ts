/**
 * **Import yWriter…** (issue #291): a `.yw7` project chosen in the binder opens in the shared import preview with its
 * chapters and scenes, its cast as codex entries, and a part-start chapter's part; Import writes the tree, the
 * declared cast on the timeline and the codex entries as one `binder.importTree`. Cancel writes nothing, and a file
 * that is not a yWriter project is refused.
 */

import { expect, test, type Page } from '@playwright/test';

import { createProject, traceNames, treeOf, waitForSaved } from './support.js';

// yWriter 7's own file shape, with invented text.
const PROJECT = `<?xml version="1.0" encoding="UTF-8"?>
<YWRITER7>
  <PROJECT>
    <Title>The Lighthouse Keeper</Title>
  </PROJECT>
  <CHAPTERS>
    <CHAPTER>
      <ID>1</ID>
      <Title>Chapter One</Title>
      <SectionStart>1</SectionStart>
      <PartTitle>Part One</PartTitle>
      <Scenes>
        <ScID>1</ScID>
        <ScID>2</ScID>
      </Scenes>
    </CHAPTER>
    <CHAPTER>
      <ID>2</ID>
      <Title>Drafts</Title>
      <Type>1</Type>
    </CHAPTER>
  </CHAPTERS>
  <SCENES>
    <SCENE>
      <ID>1</ID>
      <Title>The Landing</Title>
      <Desc>Mara arrives by ferry.</Desc>
      <SceneContent>The ferry came at noon and [i]Mara[/i] watched.</SceneContent>
      <Status>1</Status>
      <Tags>storm, arrival</Tags>
      <Day>4</Day>
      <LastsDays>2</LastsDays>
      <Characters>
        <CharID>1</CharID>
      </Characters>
      <Locations>
        <LocID>1</LocID>
      </Locations>
    </SCENE>
    <SCENE>
      <ID>2</ID>
      <Title>Night Watch</Title>
      <SceneContent>Night fell.</SceneContent>
      <Status>1</Status>
      <Unused>-1</Unused>
    </SCENE>
  </SCENES>
  <CHARACTERS>
    <CHARACTER>
      <ID>1</ID>
      <Title>Mara</Title>
      <AKA>the keeper's niece</AKA>
      <Desc>The captain.</Desc>
    </CHARACTER>
  </CHARACTERS>
  <LOCATIONS>
    <LOCATION>
      <ID>1</ID>
      <Title>The Harbour</Title>
      <Desc>A rocky shore.</Desc>
    </LOCATION>
  </LOCATIONS>
  <PROJECTNOTES>
    <PROJECTNOTE>
      <ID>1</ID>
      <Title>Ideas</Title>
      <Desc>A storm chapter.</Desc>
    </PROJECTNOTE>
  </PROJECTNOTES>
</YWRITER7>
`;

const choose = async (page: Page): Promise<void> => {
  await page.locator('input[type="file"][aria-label="yWriter file"]').setInputFiles({ name: 'demo.yw7', mimeType: 'text/xml', buffer: Buffer.from(PROJECT) });
};

test('a yWriter project offers its chapters, cast and notes, and Import writes them as one step', async ({ page }) => {
  await createProject(page, 'yWriter Import');
  await choose(page);

  const dialog = page.getByRole('dialog', { name: 'Import “demo.yw7”' });
  await expect(dialog).toBeVisible();
  const carried = dialog.getByRole('list', { name: 'What the project carried' });
  await expect(carried).toContainText('2 scenes');
  await expect(carried).toContainText('2 chapters');
  await expect(carried).toContainText('2 characters, places and items are offered as codex entries with their own pages');
  await expect(carried).toContainText('2 notes and non-manuscript chapters became Research documents');
  const codex = dialog.getByRole('region', { name: 'Codex rows' });
  await expect(codex).toContainText('Mara');
  await expect(codex).toContainText('The Harbour');

  // Cancel writes nothing.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(await traceNames(page)).not.toContain('binder.importTree');

  await choose(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /Import \d+ document/ }).click();
  await expect(dialog).toBeHidden();
  await waitForSaved(page);

  expect((await traceNames(page)).filter((name) => name === 'binder.importTree')).toHaveLength(1);
  const tree = await treeOf(page);
  const titles = tree.map((node) => node.title);
  expect(titles).toContain('Part One');
  expect(titles).toContain('Chapter One');
  expect(titles).toContain('The Landing');
  expect(titles).toContain('Night Watch');
  const research = tree.filter((node) => node.parentId === 'research').map((node) => node.title);
  expect(research).toContain('Drafts');
  expect(research).toContain('Ideas');

  await page.getByRole('tab', { name: 'Codex' }).click();
  const entries = page.getByRole('region', { name: 'Codex entries' });
  await expect(entries).toContainText('Mara');
  await expect(entries).toContainText('The Harbour');
});

test('a file that is not a yWriter project is refused with a plain message', async ({ page }) => {
  await createProject(page, 'yWriter Refusal');
  await page.locator('input[type="file"][aria-label="yWriter file"]').setInputFiles({ name: 'notes.yw7', mimeType: 'text/xml', buffer: Buffer.from('<root/>') });
  await expect(page.getByText('This is not a yWriter project.')).toBeVisible();
  expect(await traceNames(page)).not.toContain('binder.importTree');
});
