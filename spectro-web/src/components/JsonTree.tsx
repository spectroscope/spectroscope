// A small recursive JSON tree with per-node collapse — self-built, no
// external lib. Colors are decorative pastels from the token sheet (they
// distinguish value kinds, they never carry status); the collapse toggles
// are the only interactive parts and get the global Coral focus ring.
// Used by the trace tab and the graph detail panel.

import { useState } from "react";

const INDENT_PX = 14;

export function JsonTree(props: {
  value: unknown;
  /** How many levels start expanded. 0 = the root itself starts collapsed. */
  defaultDepth?: number;
  /** Optional key label rendered before the root value (e.g. the event type). */
  rootLabel?: string;
}) {
  return (
    <div className="json-tree">
      <JsonNode
        value={props.value}
        name={props.rootLabel}
        depth={0}
        defaultDepth={props.defaultDepth ?? 2}
        isLast
      />
    </div>
  );
}

function JsonNode(props: {
  value: unknown;
  name?: string;
  depth: number;
  defaultDepth: number;
  isLast: boolean;
}) {
  const { value, name, depth, defaultDepth, isLast } = props;
  const [open, setOpen] = useState(depth < defaultDepth);

  const label = name !== undefined && (
    <>
      <span className="json-key">{name}</span>
      <span className="json-punct">: </span>
    </>
  );
  const comma = !isLast && <span className="json-punct">,</span>;
  const indent = { paddingLeft: depth * INDENT_PX };

  // Primitives: one leaf line, no toggle.
  if (typeof value !== "object" || value === null) {
    return (
      <div className="json-line" style={indent}>
        <span className="json-caret-spacer" aria-hidden="true" />
        {label}
        <JsonLeaf value={value} />
        {comma}
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries: [string, unknown][] = isArray
    ? (value as unknown[]).map((v, i): [string, unknown] => [String(i), v])
    : Object.entries(value as Record<string, unknown>);
  const openBrace = isArray ? "[" : "{";
  const closeBrace = isArray ? "]" : "}";

  if (entries.length === 0) {
    return (
      <div className="json-line" style={indent}>
        <span className="json-caret-spacer" aria-hidden="true" />
        {label}
        <span className="json-punct">
          {openBrace}
          {closeBrace}
        </span>
        {comma}
      </div>
    );
  }

  const count = isArray
    ? `${entries.length} ${entries.length === 1 ? "item" : "items"}`
    : `${entries.length} ${entries.length === 1 ? "key" : "keys"}`;

  return (
    <>
      <div className="json-line" style={indent}>
        <button
          type="button"
          className="json-toggle"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="json-caret" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          {label}
          {open ? (
            <span className="json-punct">{openBrace}</span>
          ) : (
            <>
              <span className="json-punct">
                {openBrace}&#8230;{closeBrace}
              </span>
              <span className="json-count"> {count}</span>
            </>
          )}
        </button>
        {!open && comma}
      </div>
      {open && (
        <>
          {entries.map(([k, v], i) => (
            <JsonNode
              key={k}
              value={v}
              name={isArray ? undefined : k}
              depth={depth + 1}
              defaultDepth={defaultDepth}
              isLast={i === entries.length - 1}
            />
          ))}
          <div className="json-line" style={indent}>
            <span className="json-caret-spacer" aria-hidden="true" />
            <span className="json-punct">{closeBrace}</span>
            {comma}
          </div>
        </>
      )}
    </>
  );
}

function JsonLeaf({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return <span className="json-string">{JSON.stringify(value)}</span>;
  }
  if (typeof value === "number") {
    return <span className="json-number">{String(value)}</span>;
  }
  // booleans, null — and, defensively, anything non-JSON that slipped in.
  return <span className="json-bool">{String(value)}</span>;
}
