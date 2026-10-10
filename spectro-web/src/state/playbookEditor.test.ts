import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { arrowKey, type PlaybookDoc } from "../playbook/editor/doc";
import {
  CHECK_DEBOUNCE_MS,
  __resetPlaybookEditor,
  __setEditorSeams,
  closeEditor,
  dispatch,
  editorState,
  loadView,
  openEditor,
  redoEdit,
  revertEdit,
  saveEdit,
  select,
  undoEdit,
  type EditorViewWire,
} from "./playbookEditor";

const DIR = "/work/pb one";
const WS = "/work/ws";

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

function viewOf(document: PlaybookDoc | null, extra: Partial<EditorViewWire> = {}): EditorViewWire {
  return {
    loaded: { playbook: null, topology: null, findings: [], steps: [], dir: DIR },
    document,
    diskHash: "h0",
    canonical: true,
    editable: true,
    outcomes: { write: [""], done: [] },
    choices: [],
    ...extra,
  } as EditorViewWire;
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

let calls: Call[];
let fetchMock: ReturnType<typeof vi.fn>;

function reply(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** Answers GET and POST with a view of DOC and PUT with the queued answer. */
function serve(put: () => Response = () => reply(200, viewOf(DOC, { diskHash: "h1" }))): void {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (method === "PUT") return Promise.resolve(put());
    return Promise.resolve(reply(200, viewOf(method === "POST" ? (body as PlaybookDoc) : DOC)));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  fetchMock = vi.fn();
  __resetPlaybookEditor();
  __setEditorSeams({ fetch: fetchMock as unknown as typeof fetch });
  serve();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  __resetPlaybookEditor();
});

describe("the editor store", () => {
  it("loadView reads the draft route and fills the view without opening the editor", async () => {
    await loadView(DIR, WS);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(
      `/api/playbooks/draft?dir=${encodeURIComponent(DIR)}&workspace=${encodeURIComponent(WS)}`,
    );
    const s = editorState();
    expect(s.view?.diskHash).toBe("h0");
    expect(s.saved).toEqual(DOC);
    expect(s.baseHash).toBe("h0");
    expect(s.open).toBe(false);
    expect(s.history).toBeNull();
  });

  it("openEditor reads the same route, starts the history and opens", async () => {
    await openEditor(DIR, WS);
    expect(calls[0].url).toContain("/api/playbooks/draft?dir=");
    const s = editorState();
    expect(s.open).toBe(true);
    expect(s.history?.present).toEqual(DOC);
    expect(s.saved).toEqual(DOC);
    expect(s.baseHash).toBe("h0");
    expect(s.dirty).toBe(false);
    expect(s.dir).toBe(DIR);
    expect(s.workspace).toBe(WS);
  });

  it("openEditor stays closed for a view that is not editable", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(reply(200, viewOf(null, { editable: false }))));
    await openEditor(DIR, WS);
    expect(editorState().open).toBe(false);
    expect(editorState().history).toBeNull();
  });

  it("one dispatch makes the draft dirty and checks it once after the debounce", async () => {
    await openEditor(DIR, WS);
    calls.length = 0;
    dispatch({ kind: "editEnd", id: "done", result: "shipped" });
    expect(editorState().dirty).toBe(true);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(CHECK_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(
      `/api/playbooks/draft?dir=${encodeURIComponent(DIR)}&workspace=${encodeURIComponent(WS)}`,
    );
    const sent = calls[0].body as PlaybookDoc;
    expect(sent.nodes[1]).toEqual({ kind: "end", id: "done", result: "shipped" });
    expect(editorState().sentSeq).toBe(editorState().viewSeq);
  });

  it("three dispatches inside the debounce send one check with the last draft", async () => {
    await openEditor(DIR, WS);
    calls.length = 0;
    dispatch({ kind: "editEnd", id: "done", result: "a" });
    await vi.advanceTimersByTimeAsync(50);
    dispatch({ kind: "editEnd", id: "done", result: "b" });
    await vi.advanceTimersByTimeAsync(50);
    dispatch({ kind: "editEnd", id: "done", result: "c" });
    await vi.advanceTimersByTimeAsync(CHECK_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
    expect((calls[0].body as PlaybookDoc).nodes[1]).toEqual({ kind: "end", id: "done", result: "c" });
  });

  it("a refused command records no history entry and sends no check", async () => {
    await openEditor(DIR, WS);
    calls.length = 0;
    dispatch({ kind: "renameNode", from: "write", to: "done" });
    expect(editorState().history?.past).toHaveLength(0);
    expect(editorState().dirty).toBe(false);
    expect(editorState().refused).toBe("pbe.renameTaken");
    await vi.advanceTimersByTimeAsync(CHECK_DEBOUNCE_MS);
    expect(calls).toHaveLength(0);
  });

  it("an older answer arriving after a newer one does not replace the view", async () => {
    await openEditor(DIR, WS);
    const resolvers: ((r: Response) => void)[] = [];
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return Promise.resolve(reply(200, viewOf(DOC)));
      return new Promise<Response>((res) => resolvers.push(res));
    });
    dispatch({ kind: "editEnd", id: "done", result: "first" });
    await vi.advanceTimersByTimeAsync(CHECK_DEBOUNCE_MS);
    dispatch({ kind: "editEnd", id: "done", result: "second" });
    await vi.advanceTimersByTimeAsync(CHECK_DEBOUNCE_MS);
    expect(resolvers).toHaveLength(2);
    expect(editorState().sentSeq).toBe(2);
    resolvers[1](reply(200, viewOf(DOC, { diskHash: "newer" })));
    await vi.advanceTimersByTimeAsync(0);
    expect(editorState().view?.diskHash).toBe("newer");
    resolvers[0](reply(200, viewOf(DOC, { diskHash: "older" })));
    await vi.advanceTimersByTimeAsync(0);
    expect(editorState().view?.diskHash).toBe("newer");
    expect(editorState().viewSeq).toBe(2);
  });

  it("undo after one command makes the draft clean again, redo makes it dirty", async () => {
    await openEditor(DIR, WS);
    dispatch({ kind: "editEnd", id: "done", result: "x" });
    expect(editorState().dirty).toBe(true);
    undoEdit();
    expect(editorState().dirty).toBe(false);
    expect(editorState().history?.present).toEqual(DOC);
    redoEdit();
    expect(editorState().dirty).toBe(true);
  });

  it("undo keeps the selection while its node exists and clears it when it does not", async () => {
    await openEditor(DIR, WS);
    dispatch({ kind: "add", nodeKind: "step", after: { kind: "node", id: "write" } });
    const added = editorState().selection;
    expect(added).toEqual({ kind: "node", id: "step_1" });
    select({ kind: "node", id: "write" });
    undoEdit();
    expect(editorState().selection).toEqual({ kind: "node", id: "write" });
    select({ kind: "node", id: "step_1" });
    redoEdit();
    expect(editorState().selection).toEqual({ kind: "node", id: "step_1" });
    undoEdit();
    expect(editorState().selection).toBeNull();
  });

  it("saveEdit puts the base hash and the draft, keeps the history and clears dirty", async () => {
    await openEditor(DIR, WS);
    dispatch({ kind: "editEnd", id: "done", result: "x" });
    const draft = editorState().history!.present;
    serve(() => reply(200, viewOf(draft, { diskHash: "h1" })));
    calls.length = 0;
    await saveEdit();
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe(
      `/api/playbooks/file?dir=${encodeURIComponent(DIR)}&workspace=${encodeURIComponent(WS)}`,
    );
    expect(put.body).toEqual({ baseHash: "h0", playbook: draft });
    const s = editorState();
    expect(s.dirty).toBe(false);
    expect(s.baseHash).toBe("h1");
    expect(s.saved).toEqual(draft);
    expect(s.history?.past).toHaveLength(1);
    expect(s.save).toEqual({ kind: "idle" });
  });

  it("a 400 with findings sets refused and keeps the draft", async () => {
    await openEditor(DIR, WS);
    dispatch({ kind: "editEnd", id: "done", result: "x" });
    const findings = [{ path: "nodes[1]", message: "no" }];
    serve(() => reply(400, { findings }));
    await saveEdit();
    expect(editorState().save).toEqual({ kind: "refused", findings });
    expect(editorState().dirty).toBe(true);
  });

  it("a 409 sets changed with the disk hash", async () => {
    await openEditor(DIR, WS);
    dispatch({ kind: "editEnd", id: "done", result: "x" });
    serve(() => reply(409, { diskHash: "other" }));
    await saveEdit();
    expect(editorState().save).toEqual({ kind: "changed", diskHash: "other" });
    expect(editorState().dirty).toBe(true);
  });

  it("any other refusal sets failed with the server's message", async () => {
    await openEditor(DIR, WS);
    dispatch({ kind: "editEnd", id: "done", result: "x" });
    serve(() => reply(500, { message: "disk full" }));
    await saveEdit();
    expect(editorState().save).toEqual({ kind: "failed", message: "disk full" });
  });

  it("revertEdit restores the saved document and empties the history", async () => {
    await openEditor(DIR, WS);
    dispatch({ kind: "editEnd", id: "done", result: "x" });
    revertEdit();
    const s = editorState();
    expect(s.history?.present).toEqual(DOC);
    expect(s.history?.past).toHaveLength(0);
    expect(s.dirty).toBe(false);
  });

  it("closeEditor is refused while the draft is dirty and closes a clean one", async () => {
    await openEditor(DIR, WS);
    dispatch({ kind: "editEnd", id: "done", result: "x" });
    closeEditor();
    expect(editorState().open).toBe(true);
    revertEdit();
    closeEditor();
    expect(editorState().open).toBe(false);
  });

  it("a view whose outcomes differ from the web rules is reported on the console", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock.mockImplementation(() =>
      Promise.resolve(reply(200, viewOf(DOC, { outcomes: { write: ["pass"], done: [] } }))),
    );
    await loadView(DIR, WS);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toContain("outcome rules differ");
  });

  it("a view whose outcomes agree stays quiet", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await loadView(DIR, WS);
    expect(err).not.toHaveBeenCalled();
    expect(editorState().view).not.toBeNull();
  });

  it("loadView leaves a dirty open draft alone and does not even ask the server", async () => {
    await openEditor(DIR, WS);
    dispatch({ kind: "editEnd", id: "done", result: "mine" });
    const before = editorState();
    calls.length = 0;
    const other = { ...DOC, name: "Other" };
    fetchMock.mockImplementation(() => Promise.resolve(reply(200, viewOf(other, { diskHash: "disk2" }))));
    await loadView(DIR, WS);
    const after = editorState();
    expect(calls).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(after.history?.present).toBe(before.history?.present);
    expect(after.saved).toEqual(DOC);
    expect(after.baseHash).toBe("h0");
    expect(after.view?.diskHash).toBe("h0");
    expect(after.dirty).toBe(true);
  });

  it("loadView drops a late answer when the draft turned dirty while the read was in flight", async () => {
    await openEditor(DIR, WS);
    let release: (r: Response) => void = () => undefined;
    fetchMock.mockImplementation(() => new Promise<Response>((res) => (release = res)));
    const pending = loadView(DIR, WS);
    dispatch({ kind: "editEnd", id: "done", result: "mine" });
    const mineDraft = editorState().history?.present;
    const other = { ...DOC, name: "Other" };
    release(reply(200, viewOf(other, { diskHash: "disk2" })));
    await pending;
    const s = editorState();
    expect(s.history?.present).toBe(mineDraft);
    expect(s.saved).toEqual(DOC);
    expect(s.baseHash).toBe("h0");
    expect(s.view?.diskHash).toBe("h0");
    expect(s.dirty).toBe(true);
  });

  it("openEditor on an open, dirty editor makes no read and keeps the draft", async () => {
    await openEditor(DIR, WS);
    dispatch({ kind: "editEnd", id: "done", result: "mine" });
    const mineDraft = editorState().history?.present;
    const reads = fetchMock.mock.calls.length;
    await openEditor(DIR, WS);
    expect(fetchMock.mock.calls.length).toBe(reads);
    expect(editorState().history?.present).toBe(mineDraft);
    expect(editorState().history?.past).toHaveLength(1);
    expect(editorState().dirty).toBe(true);
  });

  it("of two overlapping loads the newer one wins even when the older answers last", async () => {
    const resolvers: ((r: Response) => void)[] = [];
    fetchMock.mockImplementation(() => new Promise<Response>((res) => resolvers.push(res)));
    const a = loadView("/work/a", null);
    const b = loadView("/work/b", null);
    expect(resolvers).toHaveLength(2);
    resolvers[1](reply(200, viewOf(DOC, { diskHash: "b-disk" })));
    await b;
    resolvers[0](reply(200, viewOf({ ...DOC, name: "A" }, { diskHash: "a-disk" })));
    await a;
    const s = editorState();
    expect(s.dir).toBe("/work/b");
    expect(s.view?.diskHash).toBe("b-disk");
    expect(s.baseHash).toBe("b-disk");
    expect(s.saved).toEqual(DOC);
  });

  it("a reload of an open, clean editor into a view that is not editable closes the editor", async () => {
    await openEditor(DIR, WS);
    fetchMock.mockImplementation(() => Promise.resolve(reply(200, viewOf(null, { editable: false }))));
    await loadView(DIR, WS);
    const s = editorState();
    expect(s.open).toBe(false);
    expect(s.history).toBeNull();
    expect(s.selection).toBeNull();
    expect(s.saved).toBeNull();
    expect(s.dirty).toBe(false);
  });

  it("a check that answers with an error ends checking and keeps the previous view", async () => {
    await openEditor(DIR, WS);
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(init?.method === "POST" ? reply(500, { message: "down" }) : reply(200, viewOf(DOC))),
    );
    dispatch({ kind: "editEnd", id: "done", result: "x" });
    await vi.advanceTimersByTimeAsync(CHECK_DEBOUNCE_MS);
    const s = editorState();
    expect(s.sentSeq).toBe(1);
    expect(s.viewSeq).toBe(s.sentSeq);
    expect(s.view).not.toBeNull();
    expect(s.view?.diskHash).toBe("h0");
  });

  it("a check whose request fails ends checking and keeps the previous view", async () => {
    await openEditor(DIR, WS);
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? Promise.reject(new Error("offline"))
        : Promise.resolve(reply(200, viewOf(DOC))),
    );
    dispatch({ kind: "editEnd", id: "done", result: "x" });
    await vi.advanceTimersByTimeAsync(CHECK_DEBOUNCE_MS);
    const s = editorState();
    expect(s.sentSeq).toBe(1);
    expect(s.viewSeq).toBe(s.sentSeq);
    expect(s.view).not.toBeNull();
    expect(s.view?.diskHash).toBe("h0");
  });

  it("a command during a save is checked after the save lands and saved is the draft that was sent", async () => {
    await openEditor(DIR, WS);
    dispatch({ kind: "editEnd", id: "done", result: "sent" });
    const sentDraft = editorState().history!.present;
    let releasePut: (r: Response) => void = () => undefined;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      if (method === "PUT") return new Promise<Response>((res) => (releasePut = res));
      return Promise.resolve(reply(200, viewOf(method === "POST" ? (body as PlaybookDoc) : DOC)));
    });
    calls.length = 0;
    const saving = saveEdit();
    dispatch({ kind: "editEnd", id: "done", result: "newer" });
    await vi.advanceTimersByTimeAsync(CHECK_DEBOUNCE_MS);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    releasePut(reply(200, viewOf(sentDraft, { diskHash: "h1" })));
    await saving;
    await vi.advanceTimersByTimeAsync(CHECK_DEBOUNCE_MS);
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    expect((posts[1].body as PlaybookDoc).nodes[1]).toEqual({ kind: "end", id: "done", result: "newer" });
    const s = editorState();
    expect(s.dirty).toBe(true);
    expect(s.saved).toEqual(sentDraft);
    expect(s.history?.present.nodes[1]).toEqual({ kind: "end", id: "done", result: "newer" });
    expect(s.baseHash).toBe("h1");
    expect(s.sentSeq).toBe(s.viewSeq);
  });

  it("undo keeps a selected arrow that still exists and clears one that does not", async () => {
    await openEditor(DIR, WS);
    dispatch({ kind: "add", nodeKind: "step", after: { kind: "node", id: "write" } });
    const keptKey = arrowKey({ from: "write", to: "step_1" });
    const goneKey = arrowKey({ from: "step_1", to: "done" });
    expect(editorState().history!.present.arrows.map(arrowKey)).toEqual(
      expect.arrayContaining([keptKey, goneKey]),
    );
    select({ kind: "arrow", key: keptKey });
    undoEdit();
    expect(editorState().selection).toEqual({ kind: "arrow", key: keptKey });
    redoEdit();
    select({ kind: "arrow", key: goneKey });
    undoEdit();
    expect(editorState().selection).toBeNull();
  });
});
