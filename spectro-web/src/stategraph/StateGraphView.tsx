// The state graph view: the topology is known at compile(), so the graph is
// drawn FIRST and the event stream only lights it up. Observe without touching.
//
// This is a rebuild of docs/graph-view-reference/graphview.html — the owner's
// agreed template — on React Flow, with the same structure: header, transport
// with a timeline band, a canvas of rank columns, the right panel, and a footer
// that says where the picture came from.
//
// What separates it from a trace, and what must survive every future edit:
//   - the path NOT taken stays on the canvas and only steps back
//   - a returning edge reads as a LOOP, never as a reversed arrow (see layout.ts)
//   - four node states, so "never ran" is visibly different from "ran and did
//     nothing"
//   - absence is legible: "not recorded" and "was empty" are different claims

import { useCallback, useMemo, useRef, useState } from "react";
import { ReactFlow, Background, Handle, Position, ViewportPortal, type NodeProps } from "@xyflow/react";
import type { Edge as FlowEdge, Node as FlowNode } from "@xyflow/react";
import { layoutStateGraph, type Orientation, type PlacedNode } from "./layout";
import {
  readStateGraphRun,
  channelAbsence,
  type Absence,
  type StateGraphRun,
  type Marker,
  type TimelineRecord,
} from "./artifact";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

/** The four states a node can be in, and they must stay four: a run that never
 *  reached a node is a different fact from one that reached it and wrote
 *  nothing. */
export type Lifecycle = "pending" | "active" | "done" | "error";

interface CardData extends Record<string, unknown> {
  placed: PlacedNode;
  lifecycle: Lifecycle;
  entered: number;
  durationMs: number | null;
  updateKeys: string[];
  selected: boolean;
}

function NodeCard({ data }: NodeProps) {
  const d = data as CardData;
  const lang = useLang();
  return (
    <div className={`sg-card sg-card--${d.lifecycle}${d.selected ? " is-selected" : ""}`}>
      <Handle type="target" position={Position.Left} className="sg-handle" />
      <div className="sg-card-name mono">
        {d.placed.label}
        {d.entered > 1 && <span className="sg-card-times">×{d.entered}</span>}
      </div>
      <div className="sg-card-meta mono">
        {d.durationMs !== null ? `${d.durationMs} ms` : t(lang, "sg.st." + d.lifecycle)}
        {/* The RANK, labelled as a rank. It used to print "· s{rank}", and `s`
            means superstep everywhere else in this view — so a node that ran at
            supersteps 1 and 5 read as "· s2", which is its column, not a step it
            ever took. The right panel carries the true superstep. */}
        {d.lifecycle !== "pending" && <span className="sg-card-step"> · r{d.placed.rank}</span>}
      </div>
      {d.updateKeys.length > 0 && (
        <div className="sg-card-chips">
          {d.updateKeys.slice(0, 3).map((k) => (
            <span key={k} className="sg-chip mono">
              {k}
            </span>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Right} className="sg-handle" />
    </div>
  );
}

const NODE_TYPES = { sgCard: NodeCard };

/** How far through the record list the transport currently stands. */
function lifecycleAt(run: StateGraphRun, upto: number, id: string): Lifecycle {
  let seen: Lifecycle = "pending";
  for (let i = 0; i <= upto && i < run.records.length; i++) {
    const r = run.records[i];
    if (r.node !== id) continue;
    if (r.type === "node_start") seen = "active";
    else if (r.type === "node_end") seen = "done";
    else if (r.type === "node_error") seen = "error";
  }
  return seen;
}

/** The superstep of the visit the cursor stands in: the picked node's nearest
 *  lifecycle record at or before `upto` — or its FIRST visit while the cursor
 *  has not reached the node yet, because a picked node is a question about that
 *  node and an empty panel would answer a different one. Null only for a node
 *  the run never entered. */
function visitSuperstepAt(run: StateGraphRun, upto: number, id: string): number | null {
  let seen: number | null = null;
  let first: number | null = null;
  for (let i = 0; i < run.records.length; i++) {
    const r = run.records[i];
    if (r.node !== id || r.superstep === undefined) continue;
    if (r.type !== "node_start" && r.type !== "node_end" && r.type !== "node_error") continue;
    if (first === null) first = r.superstep;
    if (i > upto) break;
    seen = r.superstep;
  }
  return seen ?? first;
}

/** The current visit's failure, or null — the same fold the reference's
 *  computeState runs: node_start clears it, node_error sets it. Unlike the
 *  payload above, this never looks forward: a failure that has not happened
 *  yet at the cursor is not shown early. */
function visitErrorAt(run: StateGraphRun, upto: number, id: string): TimelineRecord | null {
  let err: TimelineRecord | null = null;
  for (let i = 0; i <= upto && i < run.records.length; i++) {
    const r = run.records[i];
    if (r.node !== id) continue;
    if (r.type === "node_start") err = null;
    else if (r.type === "node_error") err = r;
  }
  return err;
}

export interface StateGraphViewProps {
  /** The `<stem>.graph.jsonl` text. */
  graphJsonl: string;
  /** The `<stem>.state.jsonl` text, or null — absent is a normal state. */
  stateJsonl: string | null;
  /** Where the artifacts came from, for the footer. */
  source: string;
  onLoadFile?: (graph: string, state: string | null, source: string) => void;
}

export function StateGraphView({ graphJsonl, stateJsonl, source, onLoadFile }: StateGraphViewProps) {
  const lang = useLang();
  const [orientation, setOrientation] = useState<Orientation>("horizontal");
  const [cursor, setCursor] = useState<number | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const run = useMemo(() => readStateGraphRun(graphJsonl, stateJsonl), [graphJsonl, stateJsonl]);
  const laid = useMemo(() => layoutStateGraph(run.topology, orientation), [run.topology, orientation]);

  // null cursor = the whole run, which is how the view opens: the reader is
  // looking at a finished record, not watching it arrive.
  const upto = cursor ?? run.records.length - 1;

  const flowNodes: FlowNode[] = useMemo(
    () =>
      laid.nodes.map((p) => {
        const nr = run.nodes.get(p.id);
        return {
          id: p.id,
          type: "sgCard",
          position: { x: p.x, y: p.y },
          draggable: false,
          data: {
            placed: p,
            lifecycle: lifecycleAt(run, upto, p.id),
            entered: nr?.entered ?? 0,
            durationMs: nr?.durationMs ?? null,
            updateKeys: nr?.updateKeys ?? [],
            selected: picked === p.id,
          } satisfies CardData,
        };
      }),
    [laid, run, upto, picked],
  );

  const takenSoFar = useMemo(() => {
    const s = new Set<string>();
    for (let i = 0; i <= upto && i < run.records.length; i++) {
      const r = run.records[i];
      if (r.type === "edge_taken" && r.from !== undefined && r.to !== undefined) {
        s.add(`${r.from}->${r.to}`);
      }
    }
    return s;
  }, [run, upto]);

  const flowEdges: FlowEdge[] = useMemo(
    () =>
      laid.edges.map((e) => {
        const walked = takenSoFar.has(`${e.from}->${e.to}`);
        return {
          id: `${e.from}->${e.to}`,
          source: e.from,
          target: e.to,
          type: "straight",
          // The not-taken path STAYS and steps back — it is not removed. That is
          // the difference from a trace, and removing it would turn this into one.
          className: `sg-edge${e.back ? " sg-edge--back" : ""}${walked ? " is-walked" : " is-untaken"}${e.kind === "conditional" ? " sg-edge--cond" : ""}`,
          data: { path: e.path },
          selectable: false,
        };
      }),
    [laid, takenSoFar],
  );

  const onPick = useCallback((_: unknown, n: FlowNode) => setPicked(n.id), []);

  const openFiles = (files: FileList | null): void => {
    if (files === null || files.length === 0 || onLoadFile === undefined) return;
    const wanted = [...files];
    const graph = wanted.find((f) => f.name.endsWith(".graph.jsonl")) ?? wanted[0];
    const state = wanted.find((f) => f.name.endsWith(".state.jsonl")) ?? null;
    void Promise.all([graph.text(), state === null ? Promise.resolve(null) : state.text()]).then(([g, s]) =>
      onLoadFile(g, s, graph.name),
    );
  };

  return (
    <div className="sg">
      <header className="sg-head">
        <p className="sg-claim">{t(lang, "sg.claim")}</p>
        <div className="sg-head-actions">
          <button
            type="button"
            className={orientation === "horizontal" ? "is-on" : ""}
            onClick={() => setOrientation("horizontal")}
          >
            {t(lang, "sg.horizontal")}
          </button>
          <button
            type="button"
            className={orientation === "vertical" ? "is-on" : ""}
            onClick={() => setOrientation("vertical")}
          >
            {t(lang, "sg.vertical")}
          </button>
          <button type="button" onClick={() => fileRef.current?.click()}>
            {t(lang, "sg.load")}
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".jsonl"
            hidden
            onChange={(e) => openFiles(e.target.files)}
          />
        </div>
      </header>

      <div className="sg-transport">
        <button type="button" onClick={() => setCursor(0)} title={t(lang, "sg.rewind")}>
          |&lt;
        </button>
        <button type="button" onClick={() => setCursor(Math.max(0, upto - 1))}>
          &lt;
        </button>
        <button type="button" onClick={() => setCursor(Math.min(run.records.length - 1, upto + 1))}>
          &gt;
        </button>
        <button type="button" onClick={() => setCursor(null)}>
          &gt;|
        </button>
        {/* One tick per record, coloured by type and clickable — the band IS the
            scrubber, so a reader can jump to the moment a node turned red. */}
        <div className="sg-band" role="group" aria-label={t(lang, "sg.scrub")}>
          {run.records.map((r, i) => (
            <button
              key={i}
              type="button"
              className={`sg-tick sg-tick--${r.type}${i === upto ? " is-at" : ""}${i <= upto ? " is-past" : ""}`}
              title={`${r.type}${r.node !== undefined ? ` · ${r.node}` : ""}`}
              onClick={() => setCursor(i)}
            />
          ))}
        </div>
        <span className="sg-count mono tabular">
          record {upto + 1}/{run.records.length}
        </span>
        <span className="sg-state mono">
          {cursor === null ? t(lang, "sg.complete") : t(lang, "sg.inFlight")}
        </span>
      </div>

      <div className="sg-body">
        <div className="sg-canvas">
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={NODE_TYPES}
            onNodeClick={onPick}
            onPaneClick={() => setPicked(null)}
            // The owner's rule from GraphCanvas.tsx: right and middle drag pan,
            // left selects. Keeping the same grammar across both canvases.
            panOnDrag={[1, 2]}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} size={1} />
            {/* Inside the ViewportPortal, so the arcs pan and zoom WITH the
                nodes. A plain overlay is a sibling of the viewport pane and
                carries no transform: its paths would be drawn in raw layout
                coordinates while the cards are drawn transformed, and the two
                would drift apart the moment anybody scrolled. Caught by
                rendering it, not by reading it. */}
            <ViewportPortal>
              <svg className="sg-arcs" aria-hidden="true" style={{ overflow: "visible" }}>
                {laid.edges.map((e) => (
                  <path
                    key={`${e.from}->${e.to}`}
                    d={e.path}
                    className={`sg-arc${e.back ? " sg-arc--back" : ""}${e.skip ? " sg-arc--skip" : ""}`}
                  />
                ))}
              </svg>
            </ViewportPortal>
          </ReactFlow>
        </div>

        <aside className="sg-panel">
          {picked === null ? (
            <>
              <h3 className="sg-panel-h">{t(lang, "sg.currentRecord")}</h3>
              <dl className="sg-kv mono">
                <dt>{t(lang, "sg.record")}</dt>
                <dd>{run.records[upto]?.type ?? "—"}</dd>
                <dt>{t(lang, "sg.node")}</dt>
                <dd>{run.records[upto]?.node ?? "—"}</dd>
                <dt>{t(lang, "sg.superstep")}</dt>
                <dd>{run.records[upto]?.superstep ?? "—"}</dd>
              </dl>
              <h3 className="sg-panel-h">{t(lang, "sg.branches")}</h3>
              <p className="sg-note">{t(lang, "sg.branchesWhy")}</p>
            </>
          ) : (
            <NodeDetail
              run={run}
              rank={laid.nodes.find((n) => n.id === picked)?.rank ?? null}
              upto={upto}
              picked={picked}
            />
          )}
        </aside>
      </div>

      <footer className="sg-foot mono">
        <span>
          {t(lang, "sg.source")} {source}
        </span>
        <span>run {run.runId ?? "—"}</span>
        <span>
          {t(lang, "sg.nodes")} {run.topology.nodes.length}
        </span>
        <span>
          {t(lang, "sg.edges")} {run.topology.edges.length}
        </span>
        <span>
          {t(lang, "sg.supersteps")} {run.supersteps}
        </span>
        <span>
          {run.policy === null
            ? t(lang, "sg.noStateFile")
            : `${t(lang, "sg.state")} ${run.policy.mode} · ${run.payloads.length}`}
        </span>
        {run.badLines > 0 && <span className="sg-warn">{t(lang, "sg.badLines", { n: run.badLines })}</span>}
        {run.misfiled > 0 && <span className="sg-warn">{t(lang, "sg.misfiled", { n: run.misfiled })}</span>}
        <span className="sg-offline">{t(lang, "sg.offline")}</span>
      </footer>
    </div>
  );
}

export interface NodeDetailProps {
  run: StateGraphRun;
  /** The picked node's rank in the drawing, or null when the layout lost it. */
  rank: number | null;
  /** Index of the record the transport stands on — the panel's clock. */
  upto: number;
  /** The picked node's id. */
  picked: string;
}

/** The right panel's picked-node detail. Exported on its own because the pick
 *  and the cursor live in view state a server render cannot reach: the tests
 *  hand both in as props, the way the pane's own suite renders the empty
 *  state. */
export function NodeDetail({ run, rank, upto, picked }: NodeDetailProps) {
  const lang = useLang();
  const pickedRun = run.nodes.get(picked);
  // The owner's ordered picture: the panel shows the picked node AT the step
  // the transport stands in, not its last visit. payloadFor has carried the
  // superstep argument since artifact.ts was written; this is the one caller.
  const visitStep = visitSuperstepAt(run, upto, picked);
  const pickedPayload = run.payloadFor(picked, visitStep ?? undefined);
  const failure = visitErrorAt(run, upto, picked);
  // The strip is scoped by the WRITE truth: every written channel whose
  // recorded value is a list — plus every written channel the policy dropped,
  // because a reader of the strip alone must find the absence reason there,
  // never a silence that reads as "no documents".
  const strip =
    run.policy === null
      ? []
      : (pickedRun?.updateKeys ?? []).flatMap((ch) => {
          const absence = channelAbsence(run.policy!, ch);
          const value: unknown = pickedPayload?.channels[ch];
          if (absence.absent) return [{ ch, absence, value: undefined as unknown }];
          if (Array.isArray(value) || isListMarker(value)) return [{ ch, absence, value }];
          return [];
        });
  return (
    <>
      <h3 className="sg-panel-h">{t(lang, "sg.nodeDetail")}</h3>
      <p className="sg-panel-name mono">{picked}</p>
      <dl className="sg-kv mono">
        {/* "lifecycle", never "state" — a reader who sees "state" expects
            values and gets a status chip. Learned the expensive way. */}
        <dt>{t(lang, "sg.lifecycle")}</dt>
        <dd>
          <span className={`sg-life sg-life--${lifecycleAt(run, upto, picked)}`}>
            {t(lang, "sg.st." + lifecycleAt(run, upto, picked))}
          </span>
        </dd>
        <dt>{t(lang, "sg.rank")}</dt>
        <dd>{rank ?? "—"}</dd>
        {/* The visit's superstep, moving with the cursor — lastSuperstep here
            would let the row contradict the state label two sections down. */}
        <dt>{t(lang, "sg.superstep")}</dt>
        <dd>{visitStep ?? "—"}</dd>
        <dt>{t(lang, "sg.duration")}</dt>
        <dd>{pickedRun?.durationMs != null ? `${pickedRun.durationMs} ms` : "—"}</dd>
        <dt>{t(lang, "sg.bytes")}</dt>
        <dd>{pickedRun != null ? `wrote ${pickedRun.updateBytes} B` : "—"}</dd>
        <dt>{t(lang, "sg.entered")}</dt>
        <dd>{pickedRun?.entered ?? 0}×</dd>
      </dl>

      {(pickedRun?.updateKeys.length ?? 0) > 0 && (
        <>
          <h3 className="sg-panel-h">{t(lang, "sg.updateKeys")}</h3>
          <div className="sg-chips">
            {pickedRun!.updateKeys.map((k) => (
              <span key={k} className="sg-chip mono">
                {k}
              </span>
            ))}
          </div>
        </>
      )}

      {/* One string, one text node: "state · s5" says WHICH visit's values
          follow, in the card's own s{superstep} idiom. */}
      <h3 className="sg-panel-h">
        {`${t(lang, "sg.state")}${visitStep !== null ? ` · s${visitStep}` : ""}`}
      </h3>
      {run.policy === null ? (
        <p className="sg-note">{t(lang, "sg.noState")}</p>
      ) : (
        (pickedRun?.updateKeys ?? []).map((ch) => {
          const absence = channelAbsence(run.policy!, ch);
          const value = pickedPayload?.channels[ch];
          return (
            <div key={ch} className="sg-channel">
              <p className="sg-channel-h mono">
                {ch}
                {pickedPayload?.truncated.includes(ch) === true && (
                  <span className="sg-badge">{t(lang, "sg.clipped")}</span>
                )}
              </p>
              {absence.absent ? (
                // Absence must be readable, and the reason must be the
                // real one: off the allow list is not the same as denied.
                <p className="sg-absent mono">
                  {ch} → {t(lang, "sg.notRecorded")} · {absence.note}
                </p>
              ) : (
                <ChannelValue value={value} />
              )}
            </div>
          );
        })
      )}

      {strip.length > 0 && (
        <>
          <h3 className="sg-panel-h">{t(lang, "sg.documents")}</h3>
          {strip.map((s) => (
            <DocChannel key={s.ch} ch={s.ch} absence={s.absence} value={s.value} />
          ))}
        </>
      )}

      {/* The reference's errbox, in this file's grammar: the colour rides the
          2px rule, never the word. Rendered only for the CURRENT visit — a
          failure the cursor has stepped back before is not shown early. */}
      {failure !== null && (
        <div className="sg-errbox mono">
          <b>{failure.errorClass ?? t(lang, "sg.st.error")}</b>
          {failure.errorMessage}
        </div>
      )}
    </>
  );
}

/** One list channel of the documents strip: the kept entries as rows — or the
 *  channel's absence, which stays an absence and never an empty list. */
function DocChannel({ ch, absence, value }: { ch: string; absence: Absence; value: unknown }) {
  const lang = useLang();
  if (absence.absent) {
    return (
      <div className="sg-docs">
        <p className="sg-channel-h mono">{ch}</p>
        <p className="sg-absent mono">
          {ch} → {t(lang, "sg.notRecorded")} · {absence.note}
        </p>
      </div>
    );
  }
  const marker = isListMarker(value) ? (value as Marker) : null;
  const entries: unknown[] = marker !== null ? (marker.items as unknown[]) : (value as unknown[]);
  // The n-of-m truth comes out of the MARKER's own fields, never the row
  // count: eight were there, three were kept, and the strip says so.
  const kept = marker !== null && typeof marker.sampled === "number" ? marker.sampled : entries.length;
  const len = marker !== null && typeof marker.len === "number" ? marker.len : entries.length;
  return (
    <div className="sg-docs">
      <p className="sg-channel-h mono">
        {ch}
        {marker !== null ? (
          <span className="sg-badge">
            {t(lang, "sg.kept", { n: kept, m: len })}
            {typeof marker.bytes === "number" && ` · ${marker.bytes} B`}
          </span>
        ) : (
          <span className="sg-docs-count mono">
            {t(lang, entries.length === 1 ? "sg.item" : "sg.items", { n: entries.length })}
          </span>
        )}
      </p>
      {entries.map((e, i) => (
        <div key={i} className="sg-doc">
          <span className="sg-doc-i mono">[{i}]</span>
          <DocEntry value={e} />
        </div>
      ))}
    </div>
  );
}

/** One entry — a document. A string is its own text, a marker entry stays a
 *  marker line, an object shows the reference's preview: the first key out of
 *  PREVIEW_KEYS that carries text, a clipped text field lending its head. */
function DocEntry({ value }: { value: unknown }) {
  const m = markerOf(value);
  if (m !== null) return <MarkerLine m={m} />;
  if (typeof value === "string") return <p className="sg-doc-text">{value}</p>;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return <p className="sg-doc-text">{previewOf(value as Record<string, unknown>)}</p>;
  }
  return <p className="sg-doc-text mono">{JSON.stringify(value)}</p>;
}

const PREVIEW_KEYS = ["title", "name", "label", "question", "text", "snippet", "id", "chunk_id", "url"];

function previewOf(item: Record<string, unknown>): string {
  for (const k of PREVIEW_KEYS) {
    const v = item[k];
    if (typeof v === "string" && v !== "") return v.slice(0, 90);
    const m = markerOf(v);
    if (m?.kind === "str") return String(m.head ?? "").slice(0, 90);
  }
  const first = Object.keys(item)[0];
  return first === undefined ? "{}" : `${first}: ${String(item[first])}`.slice(0, 90);
}

/** The reference's rule: a marker is recognised by its companion fields, never
 *  by `kind` alone — a caller may legitimately name a document field `kind`,
 *  and mistaking one would print a truncation that never happened. */
function markerOf(v: unknown): Marker | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const m = v as Marker;
  if (m.kind === "str" && typeof m.head === "string") return m;
  if (m.kind === "list" && Array.isArray(m.items)) return m;
  if (m.kind === "redacted" && typeof m.rule === "string") return m;
  if (m.kind === "channel" && m.omitted === "recordCap") return m;
  if (m.kind === "unserializable") return m;
  return null;
}

const isListMarker = (v: unknown): boolean => markerOf(v)?.kind === "list";

/** One channel's recorded value — a real value, or a marker that says which
 *  ceiling fired. A marker is NEVER rendered as if it were the value. */
function ChannelValue({ value }: { value: unknown }) {
  const lang = useLang();
  if (typeof value === "string") return <p className="sg-value">{value}</p>;
  if (Array.isArray(value)) {
    return (
      <ol className="sg-list">
        {value.map((v, i) => (
          <li key={i} className="sg-value mono">
            {typeof v === "string" ? v : JSON.stringify(v)}
          </li>
        ))}
      </ol>
    );
  }
  if (typeof value === "object" && value !== null && "kind" in value) {
    return <MarkerLine m={value as Marker} />;
  }
  if (value === undefined) return <p className="sg-absent mono">{t(lang, "sg.notRecorded")}</p>;
  return <p className="sg-value mono">{JSON.stringify(value)}</p>;
}

/** The marker's one-line statement: which ceiling fired, the TRUE size, why.
 *  Shared between a channel's value and a strip entry — one line, one place. */
function MarkerLine({ m }: { m: Marker }) {
  const lang = useLang();
  return (
    <p className="sg-marker mono">
      {t(lang, "sg.marker." + m.kind)} · {String(m.bytes ?? "?")} B
      {m.omitted !== undefined && ` · ${t(lang, "sg.omitted." + m.omitted)}`}
    </p>
  );
}
