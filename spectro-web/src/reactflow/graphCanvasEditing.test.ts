// Card 483: the edit mode the shared canvas can switch on. Without `editing`
// nothing changes for the three canvases that already mount it; with it the
// four handlers arrive and every default that lets the left button do
// something the spec's gesture table does not say is switched off.

import { describe, expect, it } from "vitest";
import { editingProps, type GraphCanvasEditing } from "./GraphCanvas";

const HANDLERS: GraphCanvasEditing = {
  onNodesChange: () => {},
  onEdgesChange: () => {},
  onConnect: () => {},
  onBeforeDelete: async () => false,
};

describe("the shared canvas in edit mode", () => {
  it("adds nothing when no editing group is given", () => {
    expect(editingProps(undefined)).toEqual({});
  });

  it("hands over the four handlers and switches the left button defaults off", () => {
    const props = editingProps(HANDLERS);
    expect(props.onNodesChange).toBe(HANDLERS.onNodesChange);
    expect(props.onEdgesChange).toBe(HANDLERS.onEdgesChange);
    expect(props.onConnect).toBe(HANDLERS.onConnect);
    expect(props.onBeforeDelete).toBe(HANDLERS.onBeforeDelete);
    expect(props.nodesDraggable).toBe(false);
    expect(props.nodesConnectable).toBe(true);
    expect(props.elementsSelectable).toBe(true);
    expect(props.deleteKeyCode).toEqual(["Backspace", "Delete"]);
    // Strictly null: undefined would leave React Flow's Space default in place.
    expect("panActivationKeyCode" in props).toBe(true);
    expect(props.panActivationKeyCode).toBeNull();
    expect("selectionKeyCode" in props).toBe(true);
    expect(props.selectionKeyCode).toBeNull();
    expect("multiSelectionKeyCode" in props).toBe(true);
    expect(props.multiSelectionKeyCode).toBeNull();
    expect(props.selectionOnDrag).toBe(false);
    expect(props.zoomOnDoubleClick).toBe(false);
  });

  it("never carries the pan rule or the attribution, which stay fixed in the canvas", () => {
    const props = editingProps(HANDLERS);
    expect("panOnDrag" in props).toBe(false);
    expect("proOptions" in props).toBe(false);
  });
});
