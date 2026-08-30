// A small recursive JSON tree with per-node collapse — self-built, no
// external lib. Colors are decorative pastels from the token sheet (they
// distinguish value kinds, they never carry status); the collapse toggles
// are the only interactive parts and get the global Coral focus ring.
// Used by the trace tab and the graph detail panel.

import { useState, type ReactNode } from "react";

const INDENT_PX = 14;

/** How "open everything" is spelled as a level count.
 *
 *  One home for the number, because two places now say it: the trace's insight
 *  face, which is always fully open, and the source pane's verbose reading
 *  (state/sourceDepth.ts). Measured rather than picked: the deepest structural
 *  nesting readable.ts found in the corpus is 9, so a real record never comes
 *  within an order of magnitude of this and "99" reads as "all". */
export const ALL_LEVELS = 99;

/**
 * How a string leaf is shown: `inline` carries the JSON encoding of the value,
 * quotes included; `block` carries the value's own characters, and the caller
 * supplies the quotes as punctuation around it.
 */
export type StringLeaf = { kind: "inline" | "block"; text: string };

// Every C0 control plus DEL is opaque, minus the two a pre-wrap block renders
// as themselves: the line feed and the tab. A carriage return stays opaque on
// purpose — captured command output uses a bare CR to redraw a progress line,
// and breaking there would invent lines the terminal never had.
function hasOpaqueControl(value: string): boolean {
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if ((code < 0x20 && ch !== "\n" && ch !== "\t") || code === 0x7f) return true;
  }
  return false;
}

/**
 * A value with real line feeds is shown as the text it is, because its line
 * structure is data and an encoded run of it wraps at whatever column the
 * container happens to end on. Everything else keeps the encoding: it is the
 * only form in which a lone control character is visible at all, and a value
 * that types its own backslash and n must not be read as a break.
 *
 * The encoded form stays reachable next to every tree — the trace detail's raw
 * face and its copy button hand over the payload with escapes intact — so this
 * is a second reading of the value, not the loss of the first.
 */
export function describeStringLeaf(value: string): StringLeaf {
  if (value.includes("\n") && !hasOpaqueControl(value)) {
    return { kind: "block", text: value };
  }
  return { kind: "inline", text: JSON.stringify(value) };
}

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

  // Primitives: one leaf line, no toggle. The leaf takes the comma rather than
  // the line, because a block leaf ends inside its own last line and a comma
  // left to the line would sit alone under it.
  if (typeof value !== "object" || value === null) {
    return (
      <div className="json-line" style={indent}>
        <span className="json-caret-spacer" aria-hidden="true" />
        {label}
        <JsonLeaf value={value} trailing={comma} />
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
        <button type="button" className="json-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
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

function JsonLeaf({ value, trailing }: { value: unknown; trailing: ReactNode }) {
  if (typeof value === "string") {
    const leaf = describeStringLeaf(value);
    // The opening quote stays on the key's line so the block below it starts at
    // the node's own indent: a value that carries code is read down its left
    // edge, and one shifted first line misreports that line's indentation. The
    // closing quote and the comma live inside the block for the same reason in
    // reverse — inline content after a block box would start a further line.
    if (leaf.kind === "block") {
      return (
        <>
          <span className="json-punct">&quot;</span>
          <span className="json-string json-string-block">
            {leaf.text}
            <span className="json-punct">&quot;</span>
            {trailing}
          </span>
        </>
      );
    }
    return (
      <>
        <span className="json-string">{leaf.text}</span>
        {trailing}
      </>
    );
  }
  // booleans, null — and, defensively, anything non-JSON that slipped in.
  const kind = typeof value === "number" ? "json-number" : "json-bool";
  return (
    <>
      <span className={kind}>{String(value)}</span>
      {trailing}
    </>
  );
}
