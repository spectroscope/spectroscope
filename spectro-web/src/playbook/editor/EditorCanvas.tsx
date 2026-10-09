// Card 483: the canvas of the playbook editor. The store holds the document;
// this file projects it, lets the layout engine place every box after every
// command, and turns what React Flow reports into a selection or one command.
// Nodes never drag, left drag connects, right and middle drag pan, and the
// viewport fits only when the editor opens or when Fit is pressed: the editor
// does not mount RefitOnLayout, so an edit never yanks the view.

import { Panel, useReactFlow, type Connection } from "@xyflow/react";
import { useEffect, useMemo } from "react";
import { t } from "../../i18n/i18n";
import { GraphCanvas, type GraphCanvasEditing } from "../../reactflow/GraphCanvas";
import { useLang } from "../../state/lang";
import {
  dispatch,
  editorState,
  EDIT_MARK,
  redoEdit,
  select,
  undoEdit,
  useEditorState,
} from "../../state/playbookEditor";
import { layoutStateGraph, type StateGraphLayout } from "../../stategraph/layout";
import { ARROWHEAD, ArrowEdge } from "./ArrowEdge";
import { outcomesOf, type PlaybookDoc, type Selection } from "./doc";
import { commandFromConnect, commandFromDelete, selectionFromChanges } from "./intents";
import { editorKeyIntent } from "./keys";
import { placeLabels } from "./labels";
import { PB_NODE_TYPES } from "./nodes";
import { assertJoined, project } from "./projection";
import { toFlow } from "./toFlow";

const EDGE_TYPES = { pbArrow: ArrowEdge };
/** The measure Task 12 reads: one command to the frame after its layout is drawn. */
export const EDIT_MEASURE = "pb:edit";

function onSelectChanges(changes: Parameters<typeof selectionFromChanges>[0]): void {
  const s = editorState();
  const doc = s.history?.present;
  if (!doc) return;
  const sel = selectionFromChanges(changes, doc, s.selection);
  if (sel !== undefined) select(sel);
}

/** React Flow's intents, read against the store at the moment they arrive. */
const EDITING: GraphCanvasEditing = {
  onNodesChange: onSelectChanges,
  onEdgesChange: onSelectChanges,
  onConnect: (c: Connection) => {
    const cmd = commandFromConnect(c);
    if (cmd !== null) dispatch(cmd);
  },
  onBeforeDelete: async ({ nodes, edges }) => {
    const doc = editorState().history?.present;
    if (doc) {
      const cmd = commandFromDelete(nodes, edges, doc);
      if (cmd !== null) dispatch(cmd);
    }
    // The command did the delete; React Flow removes nothing itself.
    return false;
  },
};

function FitButton({ laid }: { laid: StateGraphLayout }) {
  const lang = useLang();
  const { fitBounds } = useReactFlow();
  const { x0, y0, x1, y1 } = laid.bounds;
  return (
    <Panel position="top-right" className="nokey">
      <button
        type="button"
        className="pbe-fit"
        title={t(lang, "pbe.fit.title")}
        onClick={() => void fitBounds({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, { padding: 0.1 })}
      >
        {t(lang, "pbe.fit")}
      </button>
    </Panel>
  );
}

function Canvas({ doc, sel }: { doc: PlaybookDoc; sel: Selection }) {
  const projection = useMemo(() => project(doc), [doc]);
  const laid = useMemo(() => {
    const l = layoutStateGraph(projection.topo, "horizontal");
    assertJoined(projection, l);
    return l;
  }, [projection]);
  const labels = useMemo(() => placeLabels(doc, projection, laid), [doc, projection, laid]);
  const flow = useMemo(
    () => toFlow(doc, projection, laid, labels, sel, (n) => outcomesOf(doc, n)),
    [doc, projection, laid, labels, sel],
  );

  // One frame after the commit that drew a new layout, close the measure the
  // last command opened. A layout with no open mark (the first one) measures nothing.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (performance.getEntriesByName(EDIT_MARK, "mark").length === 0) return;
      performance.measure(EDIT_MEASURE, EDIT_MARK);
      performance.clearMarks(EDIT_MARK);
    });
    return () => cancelAnimationFrame(frame);
  }, [laid]);

  return (
    <GraphCanvas
      className="pbe pbe-canvas"
      nodes={flow.nodes}
      edges={flow.edges}
      nodeTypes={PB_NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      minZoom={0.1}
      suppressContextMenu
      editing={EDITING}
    >
      <svg className="pbe-defs" aria-hidden="true">
        <defs>
          <marker
            id={ARROWHEAD}
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={6}
            markerHeight={6}
            orient="auto-start-reverse"
            markerUnits="strokeWidth"
          >
            <path className="pbe-arrowhead" d="M0,1 L9,5 L0,9 z" />
          </marker>
        </defs>
      </svg>
      <FitButton laid={laid} />
    </GraphCanvas>
  );
}

/** The editor's canvas over the store's draft; nothing while no draft is open. */
export function EditorCanvas() {
  const state = useEditorState();
  const doc = state.history?.present ?? null;

  // Undo and redo from the keyboard while the canvas is mounted; a text field
  // keeps the keys for its own undo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      const intent = editorKeyIntent(e, target);
      if (intent === null) return;
      e.preventDefault();
      if (intent === "undo") undoEdit();
      else redoEdit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (doc === null) return null;
  return <Canvas doc={doc} sel={state.selection} />;
}
