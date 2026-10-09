// Card 483, Task 11: what the toolbar offers follows the store's state. The
// model is a pure function of EditorState, read here through the real store.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECK_DEBOUNCE_MS,
  __resetPlaybookEditor,
  __setEditorSeams,
  dispatch,
  editorState,
  openEditor,
  saveEdit,
  select,
  type EditorViewWire,
} from "../../state/playbookEditor";
import { arrowKey, type PlaybookDoc } from "./doc";
import { toolbarModel } from "./EditorToolbar";

const DOC: PlaybookDoc = {
  schema_version: 1,
  id: "tiny",
  name: "Tiny",
  description: "Two steps.",
  models: {},
  documents: {},
  checks: {},
  vars: {},
  start: "write",
  nodes: [
    {
      kind: "step",
      id: "write",
      name: "Write",
      performer: "chat",
      skills: [],
      privacy: "cheap",
      permission: "inherit",
      consumes: [],
      produces: [],
      nod: false,
    },
    { kind: "end", id: "done", result: "done" },
  ],
  arrows: [{ from: "write", to: "done" }],
  contents: { skills: [], agents: [], hooks: [], commands: [], workflows: [] },
};

function view(): EditorViewWire {
  return {
    loaded: { playbook: null, topology: null, findings: [], steps: [], dir: "/pb" },
    document: DOC,
    diskHash: "h0",
    canonical: true,
    editable: true,
    outcomes: { write: [""], done: [] },
    choices: [],
  } as unknown as EditorViewWire;
}

function reply(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

let put: () => Promise<Response>;
let post: () => Promise<Response>;

beforeEach(() => {
  vi.useFakeTimers();
  __resetPlaybookEditor();
  put = () => Promise.resolve(reply(200, view()));
  post = () => Promise.resolve(reply(200, view()));
  __setEditorSeams({
    fetch: ((_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PUT") return put();
      if (method === "POST") return post();
      return Promise.resolve(reply(200, view()));
    }) as unknown as typeof fetch,
  });
});

afterEach(() => {
  vi.useRealTimers();
  __resetPlaybookEditor();
});

describe("toolbarModel", () => {
  it("offers nothing on a fresh draft: saved, undo off, save off, revert off", async () => {
    await openEditor("/pb", null);
    const m = toolbarModel(editorState());
    expect(m.status).toBe("saved");
    expect(m).toMatchObject({
      canAddAfter: false,
      canDelete: false,
      canUndo: false,
      canRedo: false,
      canSave: false,
      canRevert: false,
    });
  });

  it("after one command the draft is unsaved and undo, save and revert are on", async () => {
    await openEditor("/pb", null);
    dispatch({ kind: "editEnd", id: "done", result: "shipped" });
    const m = toolbarModel(editorState());
    expect(m.status).toBe("unsaved");
    expect(m).toMatchObject({ canUndo: true, canSave: true, canRevert: true, canRedo: false });
  });

  it("reads checking while a draft check is in flight", async () => {
    post = () => new Promise<Response>(() => undefined);
    await openEditor("/pb", null);
    dispatch({ kind: "editEnd", id: "done", result: "shipped" });
    await vi.advanceTimersByTimeAsync(CHECK_DEBOUNCE_MS);
    expect(editorState().sentSeq).toBeGreaterThan(editorState().viewSeq);
    expect(toolbarModel(editorState()).status).toBe("checking");
  });

  it("reads refused after a save the server refused, and keeps save available", async () => {
    put = () => Promise.resolve(reply(400, { findings: [{ path: "nodes[0].goal", message: "empty" }] }));
    await openEditor("/pb", null);
    dispatch({ kind: "editEnd", id: "done", result: "shipped" });
    await saveEdit();
    const m = toolbarModel(editorState());
    expect(m.status).toBe("refused");
    expect(m.canSave).toBe(true);
  });

  it("reads changed after a 409 and failed after any other error", async () => {
    put = () => Promise.resolve(reply(409, { diskHash: "h9" }));
    await openEditor("/pb", null);
    dispatch({ kind: "editEnd", id: "done", result: "shipped" });
    await saveEdit();
    expect(toolbarModel(editorState()).status).toBe("changed");
    put = () => Promise.resolve(reply(500, { message: "disk full" }));
    await saveEdit();
    expect(toolbarModel(editorState()).status).toBe("failed");
  });

  it("turns save off while a save is running", async () => {
    put = () => new Promise<Response>(() => undefined);
    await openEditor("/pb", null);
    dispatch({ kind: "editEnd", id: "done", result: "shipped" });
    expect(toolbarModel(editorState()).canSave).toBe(true);
    void saveEdit();
    expect(editorState().save.kind).toBe("saving");
    expect(editorState().dirty).toBe(true);
    expect(toolbarModel(editorState()).canSave).toBe(false);
  });

  it("can delete a selected node or a selected arrow and nothing otherwise", async () => {
    await openEditor("/pb", null);
    expect(toolbarModel(editorState()).canDelete).toBe(false);
    select({ kind: "node", id: "write" });
    expect(toolbarModel(editorState()).canDelete).toBe(true);
    select({ kind: "arrow", key: arrowKey(DOC.arrows[0]) });
    expect(toolbarModel(editorState()).canDelete).toBe(true);
    select(null);
    expect(toolbarModel(editorState()).canDelete).toBe(false);
  });

  it("can add after a step or an arrow, and not after an end or with nothing selected", async () => {
    await openEditor("/pb", null);
    expect(toolbarModel(editorState()).canAddAfter).toBe(false);
    select({ kind: "node", id: "write" });
    expect(toolbarModel(editorState()).canAddAfter).toBe(true);
    select({ kind: "arrow", key: arrowKey(DOC.arrows[0]) });
    expect(toolbarModel(editorState()).canAddAfter).toBe(true);
    select({ kind: "node", id: "done" });
    expect(toolbarModel(editorState()).canAddAfter).toBe(false);
  });
});
