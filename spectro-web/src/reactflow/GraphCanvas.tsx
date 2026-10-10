// The shared React Flow canvas frame. Fleet, graph and (later) other node-graph
// surfaces had near-identical <ReactFlow> scaffolds — same pan-on-drag rule,
// same hidden attribution, same non-interactive Controls, same fitView. This
// owns that invariant chrome; each surface supplies its own nodes, node/edge
// types, and optional background / minimap / overlay children.
//
// The invariants baked in (not props, on purpose — they are the same on every
// surface by owner decision): right + middle mouse pan (panOnDrag [1, 2]),
// hidden attribution, and Controls without the interactive lock toggle.

import { Background, Controls, ReactFlow } from "@xyflow/react";
import type {
  Edge as FlowEdge,
  EdgeTypes,
  Node as FlowNode,
  NodeTypes,
  OnBeforeDelete,
  OnConnect,
  OnEdgesChange,
  OnNodesChange,
  ReactFlowProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { MouseEvent, ReactNode } from "react";

/** Right + middle mouse button pan; left is left for click/drag. Owner rule. */
const PAN_ON_DRAG: number[] = [1, 2];
const PRO_OPTIONS = { hideAttribution: true } as const;

/** The handlers an editing surface supplies (card 483). React Flow reports
 *  intents through them; the surface's store holds the document. */
export interface GraphCanvasEditing {
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  onBeforeDelete: OnBeforeDelete;
}

/**
 * The props editing adds. Undefined editing adds nothing, so the canvases that
 * only show a graph do not change. With editing, every default that lets the
 * left button do something other than select or connect is switched off:
 * Space would turn a left drag into a pan, Shift would draw a marquee.
 *
 * @param editing the handlers, or undefined for a canvas that only shows
 * @return the props to spread into ReactFlow
 */
export function editingProps(editing: GraphCanvasEditing | undefined): Partial<ReactFlowProps> {
  if (editing === undefined) return {};
  return {
    onNodesChange: editing.onNodesChange,
    onEdgesChange: editing.onEdgesChange,
    onConnect: editing.onConnect,
    onBeforeDelete: editing.onBeforeDelete,
    nodesDraggable: false,
    nodesConnectable: true,
    elementsSelectable: true,
    deleteKeyCode: ["Backspace", "Delete"],
    panActivationKeyCode: null,
    selectionKeyCode: null,
    multiSelectionKeyCode: null,
    selectionOnDrag: false,
    zoomOnDoubleClick: false,
  };
}

export interface GraphCanvasProps {
  nodes: FlowNode[];
  edges: FlowEdge[];
  nodeTypes?: NodeTypes;
  edgeTypes?: EdgeTypes;
  onNodeClick?: (event: MouseEvent, node: FlowNode) => void;
  /** Minimum zoom-out; omitted = React Flow's default. */
  minZoom?: number;
  /** fitView padding; omitted = React Flow's default. */
  fitViewPadding?: number;
  /** Class on the wrapping div — surface-specific sizing / theming. */
  className?: string;
  /**
   * Suppress the browser context menu on the pane (right-drag pans, so a bare
   * right-click would otherwise pop the menu). Surfaces that pan with the right
   * button set this; the fleet canvas historically did not, so it defaults off.
   */
  suppressContextMenu?: boolean;
  /** Background override; defaults to React Flow's plain dotted background. */
  background?: ReactNode;
  /** A MiniMap (or any corner overlay); omitted by default. */
  miniMap?: ReactNode;
  /** Extra overlays rendered inside <ReactFlow> (panels, spawn UI, legends). */
  children?: ReactNode;
  /** Edit mode (card 483); omitted, the canvas only shows. */
  editing?: GraphCanvasEditing;
}

export function GraphCanvas({
  nodes,
  edges,
  nodeTypes,
  edgeTypes,
  onNodeClick,
  minZoom,
  fitViewPadding,
  className,
  suppressContextMenu = false,
  background,
  miniMap,
  children,
  editing,
}: GraphCanvasProps) {
  return (
    <div className={className} onContextMenu={suppressContextMenu ? (e) => e.preventDefault() : undefined}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={fitViewPadding !== undefined ? { padding: fitViewPadding } : undefined}
        minZoom={minZoom}
        {...editingProps(editing)}
        panOnDrag={PAN_ON_DRAG}
        proOptions={PRO_OPTIONS}
      >
        {background ?? <Background />}
        <Controls showInteractive={false} />
        {miniMap}
        {children}
      </ReactFlow>
    </div>
  );
}
