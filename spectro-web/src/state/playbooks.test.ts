import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetPlaybooks,
  copyBundled,
  loadPlaybook,
  pinFolder,
  refreshFolders,
  registerFolder,
  toWebTopology,
  useLoadedPlaybook,
  usePlaybookFolders,
  type LoadedPlaybook,
  type PlaybookFoldersState,
} from "./playbooks";

let fetchMock: ReturnType<typeof vi.fn>;

/** What the two hooks answer right now, read through a real render. */
function probe(): { folders: PlaybookFoldersState; loaded: LoadedPlaybook | null } {
  function Probe() {
    return createElement("i", {
      "data-v": JSON.stringify({ folders: usePlaybookFolders(), loaded: useLoadedPlaybook() }),
    });
  }
  const html = renderToStaticMarkup(createElement(Probe));
  const raw = /data-v="([^"]*)"/.exec(html)?.[1] ?? "";
  return JSON.parse(
    raw
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&#x27;/g, "'"),
  );
}

function respond(status: number, body: unknown = {}): void {
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

const LOADED: LoadedPlaybook = {
  playbook: {
    id: "spectro",
    name: "spectro",
    description: "Brainstorm, spec, plan, build with review, finish.",
    start: "classify",
    nodes: [
      {
        kind: "decision",
        id: "classify",
        name: "Classify",
        check: "c",
        outcomes: ["spike", "bounded"],
        maxRounds: null,
      },
      { kind: "end", id: "done", result: "done" },
    ],
    arrows: [{ from: "classify", to: "done", on: "spike" }],
    models: {},
    documents: {},
  },
  topology: {
    entry: "classify",
    nodes: [
      { id: "classify", label: "Classify" },
      { id: "done", label: "Done" },
    ],
    edges: [
      { from: "classify", to: "done", kind: "conditional", branch: "spike" },
      { from: "classify", to: "done", kind: "direct" },
    ],
  },
  findings: [],
  steps: [],
  dir: "/p/spectro",
};

beforeEach(() => {
  __resetPlaybooks();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("playbook folders", () => {
  it("reads the known folders and the pin for the workspace", async () => {
    respond(200, { folders: ["/p/a", "/p/b"], active: "/p/b" });
    expect(probe().folders).toEqual({ folders: [], active: null });

    await refreshFolders("/work/my project");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/api/playbooks?workspace=" + encodeURIComponent("/work/my project"));
    expect(probe().folders).toEqual({ folders: ["/p/a", "/p/b"], active: "/p/b" });
  });

  it("registers a folder with POST and keeps the pin it already had", async () => {
    respond(200, { folders: ["/p/a"], active: "/p/a" });
    await refreshFolders("/w");

    respond(200, { folders: ["/p/a", "/p/c"], active: null });
    await registerFolder("/p/c");

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/playbooks/folders");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ dir: "/p/c" });
    expect(probe().folders).toEqual({ folders: ["/p/a", "/p/c"], active: "/p/a" });
  });

  it("pins a folder to a workspace with PUT and takes the pin the server answers", async () => {
    respond(200, { folders: ["/p/a", "/p/b"], active: "/p/b" });
    await pinFolder("/w", "/p/b");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/playbooks/active");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ workspace: "/w", dir: "/p/b" });
    expect(probe().folders.active).toBe("/p/b");
  });

  it("throws the server's message when a registration is refused and changes nothing", async () => {
    respond(400, { message: "No playbook.json in /p/x" });
    await expect(registerFolder("/p/x")).rejects.toThrow("No playbook.json in /p/x");
    expect(probe().folders).toEqual({ folders: [], active: null });
  });
});

describe("loading a playbook", () => {
  it("loads with GET, dir and workspace in the query, and publishes the result", async () => {
    respond(200, LOADED);
    expect(probe().loaded).toBeNull();

    await loadPlaybook("/p/spectro", "/w");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe(
      "/api/playbooks/load?dir=" +
        encodeURIComponent("/p/spectro") +
        "&workspace=" +
        encodeURIComponent("/w"),
    );
    expect(init?.method ?? "GET").toBe("GET");
    expect(probe().loaded).toEqual(LOADED);
  });

  it("drops a previously loaded playbook when the next load is refused", async () => {
    respond(200, LOADED);
    await loadPlaybook("/p/spectro", "/w");
    expect(probe().loaded).not.toBeNull();

    respond(400, { message: "Not a registered playbook folder: /p/gone" });
    await expect(loadPlaybook("/p/gone", "/w")).rejects.toThrow("Not a registered playbook folder");
    expect(probe().loaded).toBeNull();
  });
});

describe("copyBundled", () => {
  it("posts the target folder to the bundled route and reports ok", async () => {
    respond(200, { dir: "/p/new", written: ["playbook.json"] });
    const out = await copyBundled("spectro", "/p/new");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/playbooks/bundled/spectro/copy");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ dir: "/p/new" });
    expect(out).toEqual({ ok: true });
  });

  it("adds the copied folder to the known folders without another round trip", async () => {
    respond(200, { dir: "/p/new", written: ["playbook.json"] });
    await copyBundled("spectro", "/p/new");
    expect(probe().folders.folders).toEqual(["/p/new"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("answers a 409 with ok false and the conflicting paths", async () => {
    respond(409, { message: "Some files already exist", conflicts: ["playbook.json", "LICENSE"] });
    const out = await copyBundled("spectro", "/p/full");
    expect(out).toEqual({ ok: false, conflicts: ["playbook.json", "LICENSE"] });
  });

  it("answers any other refusal with ok false and no conflicts", async () => {
    respond(404, { message: "Unknown bundled playbook: nope" });
    const out = await copyBundled("nope", "/p/x");
    expect(out.ok).toBe(false);
    expect(out.conflicts).toBeUndefined();
  });

  it("encodes the id in the path", async () => {
    respond(404, {});
    await copyBundled("a/b", "/p/x");
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("/api/playbooks/bundled/a%2Fb/copy");
  });
});

describe("toWebTopology", () => {
  it("keeps entry, nodes and edge kinds, and drops the branch name", () => {
    const topo = toWebTopology(LOADED);
    expect(topo.entry).toBe("classify");
    expect(topo.nodes).toEqual([
      { id: "classify", label: "Classify" },
      { id: "done", label: "Done" },
    ]);
    expect(topo.edges).toEqual([
      { from: "classify", to: "done", kind: "conditional" },
      { from: "classify", to: "done", kind: "direct" },
    ]);
    for (const e of topo.edges) expect("branch" in e).toBe(false);
  });

  it("narrows an unknown kind to direct", () => {
    const odd: LoadedPlaybook = {
      ...LOADED,
      topology: { ...LOADED.topology, edges: [{ from: "classify", to: "done", kind: "spawn" }] },
    };
    expect(toWebTopology(odd).edges[0].kind).toBe("direct");
  });
});
