import { type ReactNode } from 'react';
import type { parse } from '@caotang/editor';

type Node = Awaited<ReturnType<typeof parse>>;

export function Prose({ node }: { node: Node }): ReactNode {
  if (node.isText) {
    return node.marks.reduce<ReactNode>((text, mark) => {
      switch (mark.type.name) {
        case 'em': return <em>{text}</em>;
        case 'strong': return <strong>{text}</strong>;
        case 'strike': return <s>{text}</s>;
        case 'code': return <code>{text}</code>;
        default: return text;
      }
    }, node.text);
  }
  const children: ReactNode[] = [];
  node.forEach((child, offset) => children.push(<Prose key={offset} node={child} />));
  switch (node.type.name) {
    case 'paragraph': return <p>{children}</p>;
    case 'heading': {
      const level: unknown = node.attrs['level'];
      const Heading = level === 1 ? 'h3' : level === 2 ? 'h4' : level === 3 ? 'h5' : 'h6';
      return <Heading>{children}</Heading>;
    }
    case 'blockquote': return <blockquote>{children}</blockquote>;
    case 'bullet_list': return <ul>{children}</ul>;
    case 'ordered_list': return <ol start={Number(node.attrs['start'])}>{children}</ol>;
    case 'list_item': return <li>{children}</li>;
    case 'horizontal_rule': return <hr />;
    case 'code_block': return <pre><code>{children}</code></pre>;
    case 'hard_break': return <br />;
    case 'image': return typeof node.attrs['alt'] === 'string' ? <i>{node.attrs['alt']}</i> : null;
    case 'footnote_reference': return <sup>[{String(node.attrs['label'])}]</sup>;
    case 'footnote_definition': return <div><sup>[{String(node.attrs['label'])}]</sup>{children}</div>;
    default: return children;
  }
}
