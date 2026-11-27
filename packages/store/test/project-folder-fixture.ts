import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryArtifactFs } from '../src/artifact-fs.js';
import type { ProjectState } from '../src/state.js';
import { writeProject } from '../src/write.js';

export async function writeProjectFixture(root: string, state: ProjectState, now: Date): Promise<void> {
  const fs = new MemoryArtifactFs();
  await writeProject(fs, state, { now });
  const directories = [''];
  for (const dir of directories) {
    mkdirSync(join(root, dir), { recursive: true });
    directories.push(...(await fs.listDirs(dir)).map((name) => dir ? `${dir}/${name}` : name));
  }
  for (const [path, contents] of Object.entries({ ...fs.snapshot(), ...fs.snapshotBytes() })) {
    writeFileSync(join(root, path), contents);
  }
}
