import { useEffect, useState, type ReactNode } from 'react';
import { Trans } from '@lingui/react/macro';
import { Button } from '@ui-sdk/react/button';
import { isBodyType, type TreeNode } from '@caotang/store';
import { parse } from '@caotang/editor';
import { Prose } from './prose.js';
import { readHostedSnapshot, type ReaderSource } from './read.js';

type Snapshot = Awaited<ReturnType<typeof readHostedSnapshot>>;
type Load<T> = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; value: T };

function BinderGroup({ childrenOf, parent, selected, select }: {
  childrenOf: ReadonlyMap<string, readonly TreeNode[]>;
  parent: string;
  selected: string | undefined;
  select: (node: TreeNode) => void;
}): ReactNode {
  const nodes = childrenOf.get(parent);
  if (!nodes?.length) return null;
  return <ul>{nodes.map((node) => (
    <li key={node.id}>
      {isBodyType(node.type) ? (
        <Button className="reader-entry" aria-current={selected === node.id ? 'true' : undefined}
          onClick={() => select(node)}><bdi>{node.title}</bdi></Button>
      ) : (
        <span className="reader-group">
          {node.id === 'manuscript' ? <Trans>Manuscript</Trans> : node.id === 'research' ? <Trans>Research</Trans> : <bdi>{node.title}</bdi>}
        </span>
      )}
      <BinderGroup childrenOf={childrenOf} parent={node.id} selected={selected} select={select} />
    </li>
  ))}</ul>;
}

function DocumentBody({ snapshot, node, signal }: { snapshot: Snapshot; node: TreeNode; signal: AbortSignal }) {
  const [result, setResult] = useState<Load<ReactNode>>({ kind: 'loading' });
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let current = true;
    void snapshot.body(node).then(async (text) => {
      if (!current || signal.aborted) return;
      const value = node.type === 'document' && node.kind !== 'screenplay' && node.kind !== 'av-script'
        ? <Prose node={await parse(text)} />
        : <pre>{text}</pre>;
      if (current && !signal.aborted) setResult({ kind: 'ready', value });
    }).catch(() => {
      if (current && !signal.aborted) setResult({ kind: 'failed' });
    });
    return () => { current = false; };
  }, [snapshot, node, signal, attempt]);
  return (
    <article className="reader-document">
      <h2 dir="auto">{node.title}</h2>
      {result.kind === 'loading' && <p role="status"><Trans>Loading…</Trans></p>}
      {result.kind === 'failed' && (
        <div>
          <p role="alert"><Trans>The file could not be read.</Trans></p>
          <Button className="reader-retry" onClick={() => { setResult({ kind: 'loading' }); retry(attempt + 1); }}>
            <Trans>Try again</Trans>
          </Button>
        </div>
      )}
      {result.kind === 'ready' && <div className="reader-prose" dir="auto" lang={snapshot.manifest.project.language}>{result.value}</div>}
    </article>
  );
}

function SnapshotView({ snapshot, signal }: { snapshot: Snapshot; signal: AbortSignal }) {
  const { manifest } = snapshot;
  const childrenOf = new Map<string, TreeNode[]>();
  for (const node of manifest.tree) {
    if (node.parentId === null) continue;
    const siblings = childrenOf.get(node.parentId);
    if (siblings) siblings.push(node);
    else childrenOf.set(node.parentId, [node]);
  }
  for (const siblings of childrenOf.values()) siblings.sort((a, b) => a.order - b.order);
  const pending = [...childrenOf.get('root') ?? []].reverse();
  let first: TreeNode | undefined;
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isBodyType(node.type)) { first = node; break; }
    const children = childrenOf.get(node.id);
    if (children) for (let i = children.length - 1; i >= 0; i -= 1) pending.push(children[i]!);
  }
  const [chosen, choose] = useState<TreeNode | undefined>(undefined);
  const node = chosen ?? first;
  return (
    <>
      <header className="reader-header">
        <h1 dir="auto">{manifest.project.name}</h1>
        <span className="reader-mode"><Trans>Read only</Trans></span>
      </header>
      <div className="reader-layout">
        <div className="reader-rail">
          <nav className="reader-binder" aria-labelledby="reader-binder-label">
            <h2 id="reader-binder-label"><Trans>Binder</Trans></h2>
            <BinderGroup childrenOf={childrenOf} parent="root" selected={node?.id} select={choose} />
          </nav>
        </div>
        <main id="reader-page" className="reader-page" tabIndex={-1}>
          {node ? <DocumentBody key={node.id} snapshot={snapshot} node={node} signal={signal} />
            : <p className="reader-document"><Trans>This project has no documents to read.</Trans></p>}
        </main>
      </div>
    </>
  );
}

export function HostedReader({ source }: { source: ReaderSource }) {
  const [result, setResult] = useState<Load<Snapshot>>({ kind: 'loading' });
  const [attempt, retry] = useState(0);
  useEffect(() => {
    void readHostedSnapshot(source).then(
      (value) => { if (!source.signal.aborted) setResult({ kind: 'ready', value }); },
      () => { if (!source.signal.aborted) setResult({ kind: 'failed' }); },
    );
  }, [source, attempt]);
  return (
    <div className="hosted-reader">
      {result.kind === 'ready' ? (
        <>
          <a className="reader-skip" href="#reader-page"><Trans>Skip to the page</Trans></a>
          <SnapshotView snapshot={result.value} signal={source.signal} />
        </>
      ) : (
        <main className="reader-state">
          <h1><Trans>Read only</Trans></h1>
          {result.kind === 'loading' ? <p role="status"><Trans>Reading the project</Trans></p> : (
            <>
              <p role="alert"><Trans>This project could not be read.</Trans></p>
              <Button className="reader-retry" onClick={() => { setResult({ kind: 'loading' }); retry(attempt + 1); }}>
                <Trans>Try again</Trans>
              </Button>
            </>
          )}
        </main>
      )}
    </div>
  );
}
