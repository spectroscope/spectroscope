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
import { hlLangForFence } from "../workspace/highlight";
import { findRanges, getSearch } from "../state/search";
import { highlight } from "./Highlighted";

/** Wrap every literal occurrence of `query` in `text`. Case-insensitive and
 *  non-overlapping, matching the find box's own rule. */
function markText(text: string, query: string, key: string, regex: boolean): ReactNode[] {
  const ranges = findRanges(text, query, regex);
  if (ranges.length === 0) return [text];
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([from, to], i) => {
    if (from > at) out.push(text.slice(at, from));
    out.push(
      <mark key={`${key}.m${i}`} className="find-hit">
        {text.slice(from, to)}
      </mark>,
    );
    at = to;
  });
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function renderInline(nodes: Inline[], key: string, mark?: string): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}.${i}`;
    switch (n.kind) {
      case "text":
        // The only place a rendered answer holds raw text, so the only place a
        // find can mark an occurrence without rewriting the tree.
        return mark !== undefined && mark.trim() !== ""
          ? markText(n.text, mark, k, getSearch().regex)
          : n.text;
      case "br":
        return <br key={k} />;
      case "code":
        return (
          <code key={k} className="md-code">
            {n.text}
          </code>
        );
      case "strong":
        return <strong key={k}>{renderInline(n.children, k, mark)}</strong>;
      case "em":
        return <em key={k}>{renderInline(n.children, k, mark)}</em>;
      case "del":
        return <del key={k}>{renderInline(n.children, k, mark)}</del>;
      case "link":
        return n.href !== null ? (
          <a key={k} href={n.href} target="_blank" rel="noopener noreferrer">
            {renderInline(n.children, k, mark)}
          </a>
        ) : (
          <span key={k}>{renderInline(n.children, k, mark)}</span>
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

function renderBlock(block: Block, key: string, mark?: string): ReactNode {
  switch (block.kind) {
    case "heading": {
      const Tag = `h${Math.min(block.level, 6)}` as "h1";
      return <Tag key={key}>{renderInline(block.children, key, mark)}</Tag>;
    }
    case "para":
      return <p key={key}>{renderInline(block.children, key, mark)}</p>;
    case "code":
      return (
        <div key={key} className="md-pre">
          <div className="md-pre-head">
            <span className="md-pre-lang">{block.lang ?? "text"}</span>
            <CopyButton text={() => block.text} />
          </div>
          <pre>
            <code>{highlight(block.text, block.lang != null ? hlLangForFence(block.lang) : null)}</code>
          </pre>
        </div>
      );
    case "list":
      return renderList(block, key);
    case "quote":
      return (
        <blockquote key={key}>{block.children.map((b, i) => renderBlock(b, `${key}.${i}`, mark))}</blockquote>
      );
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

export function Markdown(props: { text: string; mark?: string }) {
  const blocks = useMemo(() => parseMarkdown(props.text), [props.text]);
  return <div className="md">{blocks.map((b, i) => renderBlock(b, `b${i}`, props.mark))}</div>;
}
