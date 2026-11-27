import { EncryptedRemoteArtifactFs, HighWaterMarks, createHttpBlobStore } from '@caotang/remote-store';
import { DOCS_DIR, MANIFEST_FILE, bodyNamesOf, isBodyFileName, parseDocumentFile, validateManifest, type TreeNode } from '@caotang/store';
import { loadHostedMarks } from '../app/hosted-queue.js';
import type { HostedProjectHandoff } from '../app/hosted-receiver.js';

export interface ReaderSource {
  readonly account: string;
  readonly origin: string;
  readonly project: Extract<HostedProjectHandoff, { mode: 'read' }>;
  readonly signal: AbortSignal;
  readonly language: string | undefined;
}

export async function readHostedSnapshot({ project, origin, account, signal }: ReaderSource) {
  const http = createHttpBlobStore({
    origin,
    projectId: project.projectId,
    attempts: 1,
    fetch: (input, init) => fetch(input, { ...init, signal, redirect: 'error', cache: 'no-store' }),
  });
  const refuseWrite = async (): Promise<never> => { throw new TypeError('The hosted reader cannot write.'); };
  const fs = await EncryptedRemoteArtifactFs.open({
    projectId: project.projectId,
    projectKey: project.key,
    highWater: new HighWaterMarks(loadHostedMarks(project.projectId, account)),
    store: { get: http.get, list: http.list, put: refuseWrite, delete: refuseWrite },
  });
  signal.throwIfAborted();
  const files = new Set((await fs.listFiles(DOCS_DIR)).filter(isBodyFileName));
  const raw: unknown = JSON.parse(await fs.read(MANIFEST_FILE));
  const result = validateManifest(raw, { docFiles: [...files] });
  if (!result.ok || result.manifest?.project.id !== project.projectId) throw new Error('Invalid hosted project manifest.');
  return {
    manifest: result.manifest,
    async body(node: TreeNode): Promise<string> {
      signal.throwIfAborted();
      const file = bodyNamesOf(node).find((name) => files.has(name));
      if (!file) throw new Error('The hosted document is missing.');
      const text = await fs.read(`${DOCS_DIR}/${file}`);
      signal.throwIfAborted();
      if (node.type === 'dialogue') return text;
      try {
        return parseDocumentFile(text).body;
      } catch {
        return text;
      }
    },
  };
}
