// A tiny, dependency-free, collapsible JSON viewer. Objects and arrays fold on
// click; leaves are syntax-coloured with the design tokens (keys=sand,
// strings=text, numbers=ok-tinted, punctuation=faint). Used inside the
// expandable node sections to show untrusted tool input / MCP calls / context.

import { useState, type ReactNode } from "react";

function Punct({ children }: { children: ReactNode }) {
  return <span className="pf-json__punct">{children}</span>;
}

function Leaf({ value }: { value: unknown }) {
  if (typeof value === "string") return <span className="pf-json__str">"{value}"</span>;
  if (typeof value === "number") return <span className="pf-json__num">{value}</span>;
  if (typeof value === "boolean") return <span className="pf-json__bool">{String(value)}</span>;
  if (value === null) return <span className="pf-json__punct">null</span>;
  return <span className="pf-json__str">{String(value)}</span>;
}

function Node({ name, value, depth, last }: { name?: string; value: unknown; depth: number; last: boolean }) {
  const isObj = value !== null && typeof value === "object";
  const [open, setOpen] = useState(depth < 2);
  const pad = { paddingLeft: depth * 14 };

  const key = name !== undefined ? (
    <>
      <span className="pf-json__key">"{name}"</span>
      <Punct>: </Punct>
    </>
  ) : null;

  if (!isObj) {
    return (
      <div className="pf-json__row" style={pad}>
        {key}
        <Leaf value={value} />
        {!last && <Punct>,</Punct>}
      </div>
    );
  }

  const entries = Array.isArray(value)
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  const [openB, closeB] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];

  return (
    <div>
      <div className="pf-json__row" style={pad}>
        {key}
        <span className="pf-json__toggle" onClick={() => setOpen((o) => !o)}>
          {open ? "▾" : "▸"} <Punct>{openB}</Punct>
          {!open && <Punct> … {closeB}</Punct>}
        </span>
        {!open && !last && <Punct>,</Punct>}
      </div>
      {open && (
        <>
          {entries.map(([k, v], i) => (
            <Node
              key={k}
              name={Array.isArray(value) ? undefined : k}
              value={v}
              depth={depth + 1}
              last={i === entries.length - 1}
            />
          ))}
          <div className="pf-json__row" style={pad}>
            <Punct>{closeB}</Punct>
            {!last && <Punct>,</Punct>}
          </div>
        </>
      )}
    </div>
  );
}

export function JsonTree({ data }: { data: unknown }) {
  return (
    <div className="pf-json">
      <Node value={data} depth={0} last />
    </div>
  );
}
