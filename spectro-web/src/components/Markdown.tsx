// Renders parsed markdown as React elements — never raw HTML: the text is
// model output and stays untrusted end to end (the parser already vets link
// protocols). Code blocks carry a language chip and the shared CopyButton;
// everything is styled via .md classes on design tokens, so answers reskin
// with every genome.

import { useMemo } from "react";
import type { ReactNode } from "react";
import { parseMarkdown } from "../markdown/parse";
import type { Block, Inline } from "../markdown/parse";
import { CopyButton } from "./CopyButton";

function renderInline(nodes: Inline[], key: string): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}.${i}`;
    switch (n.kind) {
      case "text":
        return n.text;
      case "br":
        return <br key={k} />;
      case "code":
        return (
          <code key={k} className="md-code">
            {n.text}
          </code>
        );
      case "strong":
        return <strong key={k}>{renderInline(n.children, k)}</strong>;
      case "em":
        return <em key={k}>{renderInline(n.children, k)}</em>;
      case "del":
        return <del key={k}>{renderInline(n.children, k)}</del>;
      case "link":
        return n.href !== null ? (
          <a key={k} href={n.href} target="_blank" rel="noopener noreferrer">
            {renderInline(n.children, k)}
          </a>
        ) : (
          <span key={k}>{renderInline(n.children, k)}</span>
        );
    }
  });
}

function renderList(list: Extract<Block, { kind: "list" }>, key: string): ReactNode {
  const items = list.items.map((item, i) => (
    <li key={`${key}.${i}`}>
      {renderInline(item.children, `${key}.${i}`)}
      {item.sub !== null && renderList(item.sub, `${key}.${i}s`)}
    </li>
  ));
  return list.ordered ? (
    <ol key={key} start={list.start !== 1 ? list.start : undefined}>
      {items}
    </ol>
  ) : (
    <ul key={key}>{items}</ul>
  );
}

function renderBlock(block: Block, key: string): ReactNode {
  switch (block.kind) {
    case "heading": {
      const Tag = `h${Math.min(block.level, 6)}` as "h1";
      return <Tag key={key}>{renderInline(block.children, key)}</Tag>;
    }
    case "para":
      return <p key={key}>{renderInline(block.children, key)}</p>;
    case "code":
      return (
        <div key={key} className="md-pre">
          <div className="md-pre-head">
            <span className="md-pre-lang">{block.lang ?? "text"}</span>
            <CopyButton text={() => block.text} />
          </div>
          <pre>
            <code>{block.text}</code>
          </pre>
        </div>
      );
    case "list":
      return renderList(block, key);
    case "quote":
      return <blockquote key={key}>{block.children.map((b, i) => renderBlock(b, `${key}.${i}`))}</blockquote>;
    case "hr":
      return <hr key={key} className="md-hr" />;
    case "table":
      return (
        <div key={key} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th key={i} style={block.align[i] ? { textAlign: block.align[i] } : undefined}>
                    {renderInline(cell, `${key}.h${i}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} style={block.align[c] ? { textAlign: block.align[c] } : undefined}>
                      {renderInline(cell, `${key}.${r}.${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export function Markdown(props: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(props.text), [props.text]);
  return <div className="md">{blocks.map((b, i) => renderBlock(b, `b${i}`))}</div>;
}
