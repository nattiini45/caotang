import { expect, it } from 'vitest';
import { openProject } from '../src/index.js';
import { folderBytes, LANDING, seedProject } from './fixture.js';
import { removeDir, tempDir } from './support.js';

it('finds passages through the Node folder harness without changing any file', async () => {
  const root = tempDir('text-search');
  await seedProject(root);
  const project = await openProject({ root, provider: 'mock' });
  try {
    const before = folderBytes(root);
    const result = await project.call('text.search', { query: 'ferry', fields: ['body'] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.data).toMatchObject({ total: 1, truncated: false, hits: [{ nodeId: LANDING, snippet: { text: 'The ferry was late, as always.' } }] });
    expect(folderBytes(root)).toEqual(before);
  } finally {
    await project.close();
    removeDir(root);
  }
});
