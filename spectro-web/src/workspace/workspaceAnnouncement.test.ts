// Card 389 criterion 5 and card 288 criteria 3, 7 and 9: what the reducer keeps
// of a workspace_info frame. The frames below are shaped like the two that
// SessionConnection builds (sendProspectiveWorkspace and sendWorkspaceInfo).
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { initialState, reduce } from "../state/reducer";
import { WORKSPACE_MODES, paneState } from "./paneState";

const frame = (o: Record<string, unknown>): RunEvent =>
  ({ type: "workspace_info", ts: 1, ...o }) as unknown as RunEvent;

describe("the reducer keeps what the workspace frame says", () => {
  it("keeps the folder the record named and could not use", () => {
    // A resume whose recorded folder is gone: the server falls back and names
    // what it wanted. The web used to rebuild the object field by field and
    // leave this one out.
    const gone = frame({
      resolved: false,
      mode: "default",
      unavailable: "/Users/you/ForgeDemo",
      configured: true,
      path: "/Users/you/work",
      exists: true,
    });
    expect(reduce(initialState, gone).workspace?.unavailable).toBe("/Users/you/ForgeDemo");
  });

  it("keeps no unavailable folder when the frame names none", () => {
    const plain = frame({ resolved: false, mode: "default", configured: true, path: "/Users/you/work" });
    const w = reduce(initialState, plain).workspace;
    expect(w?.path).toBe("/Users/you/work");
    expect(w !== null && Object.prototype.hasOwnProperty.call(w, "unavailable")).toBe(false);
  });

  it("keeps a recorded mode as recorded", () => {
    const resumed = frame({
      resolved: true,
      mode: "recorded",
      exists: true,
      sessionId: "s1",
      path: "/Users/you/particle",
      configured: true,
    });
    expect(reduce(initialState, resumed).workspace?.mode).toBe("recorded");
  });

  it("reads an unknown mode the way it reads a missing one", () => {
    // The rule: a mode the web has no word for falls back exactly as a frame
    // from an older server without the field does, configured to "default"
    // and unconfigured to "random".
    const unknownConfigured = reduce(initialState, frame({ mode: "banana", configured: true, path: "/x" }));
    const unknownBare = reduce(initialState, frame({ mode: "banana", configured: false }));
    expect(unknownConfigured.workspace?.mode).toBe("default");
    expect(unknownBare.workspace?.mode).toBe("random");
    expect(WORKSPACE_MODES as readonly string[]).toContain(unknownConfigured.workspace?.mode);
  });

  it("keeps the fallback for a frame without any mode", () => {
    expect(reduce(initialState, frame({ configured: true, path: "/x" })).workspace?.mode).toBe("default");
    expect(reduce(initialState, frame({ configured: false })).workspace?.mode).toBe("random");
  });

  it("leaves the Files pane on the session tree for a resumed recorded folder", () => {
    const resumed = reduce(
      initialState,
      frame({
        resolved: true,
        mode: "recorded",
        exists: true,
        sessionId: "s1",
        path: "/p",
        configured: true,
      }),
    ).workspace;
    expect(paneState(resumed, { kind: "ok" }, "en")).toEqual({ kind: "tree", scope: "session" });
  });
});
