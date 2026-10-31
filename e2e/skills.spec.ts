import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { fakeEndpoint, planThenAnswer, useFakeEndpoint, type FakeRequest } from './endpoint.js';
import { createProject, waitForSaved, loose } from './support.js';

/**
 * Skills (extensibility.md §10): a project's reusable writing instructions for the agent. A folder is imported, read in full and approved
 * before the agent is told of it, listed, and read again when any file of it changes. The model is a fake endpoint (endpoint.ts), so
 * what the agent was sent is what the test reads off its requests; nothing reaches a real provider.
 */

const STYLE = 'Keep every sentence in close third person and past tense.';
const SKILL_MD = ['---', 'name: close-third', 'description: Draft scenes in close third person, past tense.', '---', '', STYLE, ''].join('\n');

/** A skill folder on disk, as a writer would have one: its instructions, a reference and a script. */
function skillFolder(): string {
  const root = mkdtempSync(join(tmpdir(), 'caotang-skills-'));
  const folder = join(root, 'close-third');
  mkdirSync(join(folder, 'references'), { recursive: true });
  mkdirSync(join(folder, 'scripts'), { recursive: true });
  writeFileSync(join(folder, 'SKILL.md'), SKILL_MD);
  writeFileSync(join(folder, 'references', 'voice.md'), 'Stay with the narrator. Never leave the room.\n');
  writeFileSync(join(folder, 'scripts', 'check.sh'), 'echo "not run by Caotang"\n');
  return folder;
}

async function openSkills(page: Page) {
  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Skills' });
  await expect(panel).toBeVisible();
  return panel;
}

/** The agent drawer, open, with the Intent box ready. */
async function agentReady(page: Page): Promise<void> {
  const field = page.getByRole('textbox', { name: 'Intent' });
  if (!(await field.isVisible())) await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(field).toBeEnabled();
}

async function sendIntent(page: Page, intent: string): Promise<void> {
  await agentReady(page);
  await page.getByRole('textbox', { name: 'Intent' }).fill(intent);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/** Every request the fake endpoint has been sent, in order. */
function recordingEndpoint(plan: unknown): { seen: FakeRequest[]; reply: (request: FakeRequest) => ReturnType<ReturnType<typeof planThenAnswer>> } {
  const seen: FakeRequest[] = [];
  const answer = planThenAnswer(plan, 'Done.');
  return {
    seen,
    reply: (request) => {
      seen.push(request);
      return answer(request);
    },
  };
}

const LOAD_STYLE = { steps: [{ tool: 'skill.load', params: { name: 'close-third' }, expect: 'The style is loaded' }] };

test('a skill is imported, read, approved and listed, and the agent is told of it only then; a change asks for approval again', async ({ page }) => {
  const folder = skillFolder();
  try {
    const endpoint = recordingEndpoint(LOAD_STYLE);
    await fakeEndpoint(page, endpoint.reply);
    await useFakeEndpoint(page);
    await createProject(page, 'Skill Book');

    // Import the folder.
    let panel = await openSkills(page);
    await expect(panel.getByText('Reusable writing instructions for the agent')).toBeVisible();
    await expect(panel.getByText('This project has no skills yet.')).toBeVisible();
    await panel.locator('input[aria-label="Skill folder"]').setInputFiles(folder);
    const row = panel.locator('[data-skill="close-third"]');
    await expect(row).toBeVisible();
    await expect(row).toContainText('Draft scenes in close third person, past tense.');
    await expect(row).toContainText('Includes scripts');
    await expect(row).toContainText('Not approved yet');
    await expect(panel.getByText('1 skill is waiting for you to read and approve it.')).toBeVisible();
    await panel.getByRole('button', { name: 'Done' }).click();
    await waitForSaved(page);

    // Not approved: the agent panel says so, and a model that asks for the skill is refused and sent none of it.
    await agentReady(page);
    await expect(page.getByTestId('agent-skills-note')).toContainText('1 skill is waiting');
    await sendIntent(page, 'Use my house style.');
    await expect(page.getByTestId('agent-step')).toHaveCount(0, { timeout: 15_000 });
    const before = endpoint.seen.map((request) => `${request.system}\n${request.user}`).join('\n');
    expect(before).not.toContain('- close-third:');
    expect(before).not.toContain(STYLE);
    expect(endpoint.seen.some((request) => request.tools?.includes('skill.load'))).toBe(false);

    // Read it: every file, as it is, in plain text, with the scripts named and not run.
    panel = await openSkills(page);
    await panel.getByRole('button', { name: /Read and approve/ }).click();
    await expect(panel.getByRole('heading', { name: loose('Read “close-third”') })).toBeVisible();
    await expect(panel.getByRole('note').filter({ hasText: 'Caotang reads the instructions and does not run them' })).toBeVisible();
    await expect(panel.getByRole('note').filter({ hasText: 'cannot read them in this build' })).toBeVisible();
    await expect(panel.getByLabel('Text of Instructions')).toContainText(STYLE);
    await expect(panel.getByLabel('Text of references/voice.md')).toContainText('Never leave the room.');
    await expect(panel.getByLabel('Text of scripts/check.sh')).toContainText('not run by Caotang');
    await panel.getByRole('button', { name: 'Approve this skill' }).click();
    await expect(page.getByText(loose('Approved “close-third”. The agent can use it now.'))).toBeVisible();
    await expect(panel.locator('[data-skill="close-third"]')).toContainText('Approved. The agent is told about it.');
    await panel.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('agent-skills-note')).toHaveCount(0);

    // Approved: the agent is told of the skill, loads it, and gets its instructions.
    const from = endpoint.seen.length;
    await sendIntent(page, 'Use my house style, please.');
    await expect.poll(() => endpoint.seen.length - from).toBeGreaterThanOrEqual(2);
    const after = endpoint.seen.slice(from);
    expect(after[0]?.user).toContain('- close-third: Draft scenes in close third person, past tense.');
    expect(after[0]?.system).not.toContain('close-third');
    expect(after[0]?.tools).toContain('skill.load');
    expect(after.slice(1).map((request) => `${request.user}\n${request.tool}`).join('\n')).toContain(STYLE);
    await expect(page.getByTestId('agent-step')).toHaveCount(0, { timeout: 15_000 });

    // A change to any file of the skill is read and approved again, and the agent is told of none until then.
    panel = await openSkills(page);
    await panel.getByRole('button', { name: 'Edit close-third' }).click();
    const editor = panel.getByRole('textbox', { name: 'Instructions' });
    await editor.fill(`${SKILL_MD}Never name the narrator.\n`);
    await panel.getByRole('button', { name: 'Save' }).click();
    await expect(panel.locator('[data-skill="close-third"]')).toContainText('Changed since you approved it');
    await panel.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('agent-skills-note')).toContainText('1 skill is waiting');

    const edited = endpoint.seen.length;
    await sendIntent(page, 'Use my house style, once more.');
    await expect.poll(() => endpoint.seen.length - edited).toBeGreaterThanOrEqual(1);
    await expect(page.getByTestId('agent-step')).toHaveCount(0, { timeout: 15_000 });
    const afterEdit = endpoint.seen.slice(edited).map((request) => `${request.system}\n${request.user}`).join('\n');
    expect(afterEdit).not.toContain('- close-third:');
    expect(afterEdit).not.toContain('Never name the narrator.');
  } finally {
    rmSync(join(folder, '..'), { recursive: true, force: true });
  }
});

test('a skill can be turned off and on, written from nothing, and deleted, and Undo brings a deleted one back', async ({ page }) => {
  await createProject(page, 'Writing Skills');
  let panel = await openSkills(page);
  await panel.getByRole('button', { name: 'New skill…' }).click();
  await panel.getByRole('textbox', { name: 'Name' }).fill('Bad Name');
  await expect(panel.getByRole('alert')).toContainText('lower-case letters, digits and hyphens');
  await expect(panel.getByRole('button', { name: 'Create' })).toBeDisabled();
  await panel.getByRole('textbox', { name: 'Name' }).fill('slug-lines');
  await panel.getByRole('button', { name: 'Create' }).click();

  // The editor starts from a template that can be used, and says when a change cannot be.
  const editor = panel.getByRole('textbox', { name: 'Instructions' });
  await expect(panel.getByText('This skill can be used.')).toBeVisible();
  await editor.fill('no front matter at all');
  await expect(panel.getByRole('alert')).toContainText('does not start with');
  await expect(panel.getByRole('button', { name: 'Save' })).toBeDisabled();
  await editor.fill(['---', 'name: slug-lines', 'description: Use INT. and EXT. slug lines.', '---', 'Write a slug line for every scene.', ''].join('\n'));
  await expect(panel.getByText('This skill can be used.')).toBeVisible();
  await panel.getByRole('button', { name: 'Save' }).click();

  const row = panel.locator('[data-skill="slug-lines"]');
  await expect(row).toContainText('Use INT. and EXT. slug lines.');
  await row.getByRole('button', { name: 'Turn off' }).click();
  await expect(row).toContainText('Off');
  await row.getByRole('button', { name: 'Turn on' }).click();
  await expect(row.locator('.chip', { hasText: 'Off' })).toHaveCount(0);

  await row.getByRole('button', { name: 'Delete slug-lines' }).click();
  await expect(panel.getByText('This project has no skills yet.')).toBeVisible();
  await panel.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  panel = await openSkills(page);
  await expect(panel.locator('[data-skill="slug-lines"]')).toBeVisible();
});

test('a folder that is not a usable skill is named with what to change, and a skill over a cap is refused with the cap', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'caotang-skills-bad-'));
  try {
    // Its name is not its folder's name.
    mkdirSync(join(root, 'wrong-folder'), { recursive: true });
    writeFileSync(join(root, 'wrong-folder', 'SKILL.md'), ['---', 'name: other-name', 'description: A skill.', '---', 'Body.', ''].join('\n'));
    // One file over 256 KB.
    mkdirSync(join(root, 'too-big'), { recursive: true });
    writeFileSync(join(root, 'too-big', 'SKILL.md'), ['---', 'name: too-big', 'description: A big skill.', '---', 'Body.', ''].join('\n'));
    writeFileSync(join(root, 'too-big', 'huge.md'), 'x'.repeat(256 * 1024 + 1));

    await createProject(page, 'Bad Skills');
    const panel = await openSkills(page);
    await panel.locator('input[aria-label="Skill folder"]').setInputFiles(root);
    // The skill over the cap is refused before a byte of it is read, and the cap is named.
    await expect(page.getByText(/too-big.*256\.1 KB.*at most 256 KB/)).toBeVisible();
    // The one whose name differs from its folder is taken (the writer can fix it) and is listed as unusable, with the reason.
    await expect(panel.getByRole('region', { name: 'Skills that cannot be used' })).toContainText('Its name and its folder must be the same');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A zip whose entries are stored, not compressed: enough to hand the app a bundle without a zip tool. */
function storedZip(entries: Record<string, string>): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (data: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of data) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text);
    const path = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(path.length, 26);
    locals.push(local, path, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(path.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, path);
    offset += 30 + path.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('a zip with a skill in it is imported, and a zip with a path that leaves its folder is refused whole', async ({ page }) => {
  await createProject(page, 'Zip Skills');
  const panel = await openSkills(page);
  const zip = (entries: Record<string, string>, name: string) => ({ name, mimeType: 'application/zip', buffer: storedZip(entries) });
  await panel.locator('input[aria-label="Skill zip"]').setInputFiles(zip({ 'SKILL.md': SKILL_MD.replace('close-third', 'zipped-style'), 'references/a.md': 'a' }, 'zipped-style.zip'));
  await expect(panel.locator('[data-skill="zipped-style"]')).toBeVisible();
  await panel.locator('input[aria-label="Skill zip"]').setInputFiles(zip({ 'evil/SKILL.md': SKILL_MD, 'evil/../../escape.md': 'x' }, 'evil.zip'));
  await expect(page.getByText(/does not stay inside its folder/)).toBeVisible();
  await expect(panel.locator('[data-skill="close-third"]')).toHaveCount(0);
});
