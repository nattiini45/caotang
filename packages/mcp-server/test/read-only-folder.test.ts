/**
 * A read never changes the manuscript, codex or manifest (extensibility.md §9). `coherence.scan` is a read, but it logs its run in the
 * harness log, and a log row used to make the session save the whole folder: every document body, `caotang.json`, and the
 * rotated backups. A read-only server keeps the run in memory and the folder keeps every byte it had. A writable server appends the run
 * to `coherence.json`, which is derived state, and writes nothing else.
 */

import { describe, expect, it } from 'vitest';

import { connectClient, folderBytes, startFixture } from './support.js';

describe('a read leaves the project folder as it was', () => {
  it('coherence.scan on a read-only server records its run in memory, and the folder keeps every byte', async () => {
    const fixture = await startFixture({ label: 'ro-scan', allowWrites: false, seed: true });
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const before = folderBytes(fixture.root);
      const logged = fixture.session.harness.log.length;
      const result = await client.callTool({ name: 'coherence.scan', arguments: {} });
      expect(result.isError).not.toBe(true);
      // The premise: the scan did log a row, which is what made the old session save the folder.
      expect(fixture.session.harness.log.length).toBeGreaterThan(logged);
      expect(folderBytes(fixture.root)).toEqual(before);
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it('coherence.scan on a writable server appends its run to coherence.json and changes no other file', async () => {
    const fixture = await startFixture({ label: 'rw-scan', allowWrites: true, seed: true });
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const before = folderBytes(fixture.root);
      expect(before['coherence.json']).toBeUndefined();
      const logged = fixture.session.harness.log.length;
      const result = await client.callTool({ name: 'coherence.scan', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(fixture.session.harness.log.length).toBeGreaterThan(logged);
      const { 'coherence.json': written, ...after } = folderBytes(fixture.root);
      expect(after).toEqual(before);
      expect(JSON.parse(written ?? '{}').runs).toHaveLength(1);
    } finally {
      await client.close();
      await fixture.close();
    }
  });
});
