// Card 525: the store behind the bundle tabs of the playbook pane. It reads
// the folder's tree and one file at a time through the routes of card 522,
// writes a file with the hash it was read with, and calls the import routes
// of card 523. The server is the authority on every refusal; this store keeps
// its reason and its sentence.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetBundleEditor,
  bundleEditorState,
  deleteFile,
  editText,
  entriesOf,
  fileDirty,
  importHooks,
  importSkills,
  listEntry,
  loadSources,
  loadTree,
  newAgent,
  newCommand,
  openPath,
  reasonText,
  reloadFile,
  removeEntry,
  saveFile,
  opensGraph,
  scopeTree,
  scopeTruncated,
  type TreeView,
} from "./bundleEditor";
import { __resetPlaybookEditor, editorState } from "./playbookEditor";
import { __resetPlaybooks, paneView, showFolder } from "./playbooks";
import type { FileNode } from "../workspace/FileBrowser";

const DIR = "/pb/spectro";

const file = (path: string, size = 10): FileNode => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  dir: false,
  size,
  children: [],
});
const folder = (path: string, children: FileNode[]): FileNode => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  dir: true,
  size: 0,
  children,
});

const TREE: TreeView = {
  root: "spectro",
  truncated: false,
  capped: false,
  deeper: [],
  findings: [],
  entries: [
    folder("agents", [file("agents/reviewer.md"), file("agents/notes.txt")]),
    folder("commands", [file("commands/ship.md")]),
    folder("hooks", [file("hooks/hooks.json"), file("hooks/lint.sh")]),
    folder("skills", [
      folder("skills/spectropowers", [
        folder("skills/spectropowers/brainstorming", [file("skills/spectropowers/brainstorming/SKILL.md")]),
      ]),
      folder("skills/mine", [folder("skills/mine/a", [file("skills/mine/a/SKILL.md")])]),
    ]),
    folder("workflows", [file("workflows/build.js")]),
    file("LICENSE"),
    file("playbook.json"),
  ],
};

function answer(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

type Route = (url: string, init: RequestInit | undefined) => Response | undefined;
let routes: Route[] = [];

const calls = (): { url: string; init: RequestInit | undefined }[] =>
  vi.mocked(fetch).mock.calls.map(([u, i]) => ({ url: String(u), init: i as RequestInit | undefined }));
const bodyOf = (url: string): Record<string, unknown> => {
  const hit = calls().filter((c) => c.url === url);
  return JSON.parse(String(hit[hit.length - 1]?.init?.body)) as Record<string, unknown>;
};

beforeEach(() => {
  __resetBundleEditor();
  __resetPlaybooks();
  __resetPlaybookEditor();
  routes = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      for (const r of routes) {
        const hit = r(u, init);
        if (hit !== undefined) return Promise.resolve(hit);
      }
      if (u.startsWith("/api/playbooks/tree")) return Promise.resolve(answer(200, TREE));
      return Promise.resolve(answer(404));
    }),
  );
});

afterEach(() => {
  __resetBundleEditor();
  __resetPlaybooks();
  __resetPlaybookEditor();
  vi.unstubAllGlobals();
});

const reads =
  (text: string, sha256 = "h1"): Route =>
  (u) =>
    u.startsWith("/api/playbooks/read")
      ? answer(200, { path: "x", text, sha256, size: text.length })
      : undefined;

describe("the tree", () => {
  it("is read in one request for the folder", async () => {
    await loadTree(DIR);
    expect(calls().map((c) => c.url)).toEqual([`/api/playbooks/tree?dir=${encodeURIComponent(DIR)}`]);
    expect(bundleEditorState().tree).toEqual(TREE);
    expect(bundleEditorState().dir).toBe(DIR);
  });

  it("is scoped to the kind's folder, and Files shows the whole folder", () => {
    expect(scopeTree(TREE.entries, "skills")?.map((n) => n.path)).toEqual([
      "skills/spectropowers",
      "skills/mine",
    ]);
    expect(scopeTree(TREE.entries, "hooks")?.map((n) => n.path)).toEqual([
      "hooks/hooks.json",
      "hooks/lint.sh",
    ]);
    expect(scopeTree(TREE.entries, null)).toBe(TREE.entries);
    expect(scopeTree(TREE.entries, "nothere")).toBeNull();
  });
});

describe("the note that the folder holds more", () => {
  it("is drawn from the part of the tree a tab shows", () => {
    const deep: TreeView = {
      ...TREE,
      truncated: true,
      deeper: ["skills/spectropowers/brainstorming/scripts/a/b"],
    };
    expect(scopeTruncated(deep, "skills")).toBe(true);
    expect(scopeTruncated(deep, null)).toBe(true);
    expect(scopeTruncated(deep, "agents")).toBe(false);
    expect(scopeTruncated(deep, "hooks")).toBe(false);
  });

  it("matches a folder by its path, not by a name that starts the same", () => {
    const deep: TreeView = { ...TREE, truncated: true, deeper: ["skillset/a/b/c/d/e"] };
    expect(scopeTruncated(deep, "skills")).toBe(false);
    expect(scopeTruncated(deep, "skillset")).toBe(true);
  });

  it("is on every tab when the walk stopped at the file count, since what it missed is unknown", () => {
    const capped: TreeView = { ...TREE, truncated: true, capped: true };
    for (const folder of ["skills", "agents", "hooks", "commands", "workflows", null]) {
      expect(scopeTruncated(capped, folder)).toBe(true);
    }
  });

  it("is on no tab for a whole tree", () => {
    for (const folder of ["skills", "agents", null]) expect(scopeTruncated(TREE, folder)).toBe(false);
  });
});

describe("the contents entries of a kind (criterion 1)", () => {
  it("marks each entry listed, on disk only, or listed but missing", () => {
    const skills = entriesOf("skills", ["skills/spectropowers", "skills/gone"], TREE.entries, []);
    expect(skills).toEqual([
      { path: "skills/spectropowers", state: "listed", finding: null },
      { path: "skills/gone", state: "missing", finding: null },
      { path: "skills/mine", state: "disk-only", finding: null },
    ]);
    expect(entriesOf("agents", [], TREE.entries, []).map((e) => [e.path, e.state])).toEqual([
      ["agents/reviewer.md", "disk-only"],
    ]);
    expect(entriesOf("hooks", ["hooks/hooks.json"], TREE.entries, []).map((e) => e.state)).toEqual([
      "listed",
    ]);
    expect(entriesOf("commands", ["commands/ship.md"], TREE.entries, []).map((e) => e.state)).toEqual([
      "listed",
    ]);
    expect(entriesOf("workflows", [], TREE.entries, []).map((e) => [e.path, e.state])).toEqual([
      ["workflows/build.js", "disk-only"],
    ]);
  });

  it("carries the loader's rule 8 finding on a listed entry that is missing", () => {
    const rows = entriesOf("skills", ["skills/spectropowers", "skills/gone"], TREE.entries, [
      { path: "contents.skills[1]", message: "skills/gone does not exist in the playbook folder" },
    ]);
    expect(rows[1]).toEqual({
      path: "skills/gone",
      state: "missing",
      finding: "skills/gone does not exist in the playbook folder",
    });
  });
});

describe("a text file (criterion 3)", () => {
  it("opens in one request and is not dirty until edited", async () => {
    routes.push(reads("# brainstorming\n"));
    expect(await openPath(DIR, null, "skills/spectropowers/brainstorming/SKILL.md")).toBe("opened");
    const f = bundleEditorState().file;
    expect(f).toMatchObject({
      path: "skills/spectropowers/brainstorming/SKILL.md",
      text: "# brainstorming\n",
      sha256: "h1",
    });
    expect(calls().filter((c) => c.url.startsWith("/api/playbooks/read"))).toHaveLength(1);
    expect(fileDirty()).toBe(false);
    editText("# changed\n");
    expect(fileDirty()).toBe(true);
  });

  it("Save sends the text with the hash it was read with", async () => {
    routes.push(reads("a\n", "h1"));
    routes.push((u) =>
      u === "/api/playbooks/write" ? answer(200, { path: "x", sha256: "h2", size: 2 }) : undefined,
    );
    await openPath(DIR, null, "templates/plan.md");
    editText("b\n");
    await saveFile();
    expect(bodyOf("/api/playbooks/write")).toEqual({
      dir: DIR,
      path: "templates/plan.md",
      text: "b\n",
      baseHash: "h1",
    });
    expect(calls().find((c) => c.url === "/api/playbooks/write")?.init?.method).toBe("PUT");
    expect(bundleEditorState().file).toMatchObject({
      text: "b\n",
      base: "b\n",
      sha256: "h2",
      status: "ready",
    });
    expect(fileDirty()).toBe(false);
  });

  it("Save reads the tree again, so a new file shows in it", async () => {
    routes.push(reads("a\n", "h1"));
    routes.push((u) =>
      u === "/api/playbooks/write" ? answer(200, { path: "x", sha256: "h2", size: 2 }) : undefined,
    );
    await openPath(DIR, null, "templates/plan.md");
    editText("b\n");
    const before = calls().filter((c) => c.url.startsWith("/api/playbooks/tree")).length;
    await saveFile();
    expect(calls().filter((c) => c.url.startsWith("/api/playbooks/tree"))).toHaveLength(before + 1);
  });

  it("a refused Save does not read the tree again", async () => {
    routes.push(reads("a\n", "h1"));
    routes.push((u) =>
      u === "/api/playbooks/write" ? answer(400, { reason: "name", message: "m" }) : undefined,
    );
    await openPath(DIR, null, "templates/plan.md");
    editText("b\n");
    await saveFile();
    expect(calls().filter((c) => c.url.startsWith("/api/playbooks/tree"))).toHaveLength(0);
  });

  it("only playbook.json turns to the graph editor", () => {
    expect(opensGraph("playbook.json")).toBe(true);
    expect(opensGraph("skills/x/playbook.json")).toBe(false);
    expect(opensGraph("LICENSE")).toBe(false);
  });

  it("a 409 says the disk changed and keeps the edit until a reload", async () => {
    routes.push(reads("a\n", "h1"));
    // The server's rule (card 522): a write without a baseHash is a bad
    // request; one whose baseHash is not the disk's hash is a 409.
    routes.push((u, i) => {
      if (u !== "/api/playbooks/write") return undefined;
      const sent = JSON.parse(String(i?.body)) as { baseHash?: unknown };
      if (typeof sent.baseHash !== "string")
        return answer(400, { reason: "bad-request", message: "A 'baseHash' is required." });
      return sent.baseHash === "h9"
        ? answer(200, { path: "x", sha256: "h10", size: 2 })
        : answer(409, { reason: "changed", message: "m", diskHash: "h9" });
    });
    await openPath(DIR, null, "templates/plan.md");
    editText("b\n");
    await saveFile();
    expect(bundleEditorState().file).toMatchObject({ status: "changed", diskHash: "h9", text: "b\n" });
    expect(fileDirty()).toBe(true);

    routes.unshift(reads("disk\n", "h9"));
    await reloadFile();
    expect(bundleEditorState().file).toMatchObject({
      status: "ready",
      text: "disk\n",
      base: "disk\n",
      sha256: "h9",
    });
    expect(fileDirty()).toBe(false);
  });

  it("a binary or oversized file shows the server's reason", async () => {
    routes.push((u) =>
      u.startsWith("/api/playbooks/read")
        ? answer(415, {
            reason: "binary",
            message: "The file is not UTF-8 text. The editor opens text files only.",
          })
        : undefined,
    );
    await openPath(DIR, null, "docs/logo.png");
    expect(bundleEditorState().file).toMatchObject({
      path: "docs/logo.png",
      status: "unreadable",
      reason: "binary",
      message: "The file is not UTF-8 text. The editor opens text files only.",
    });
    expect(reasonText("en", "too-large", "x")).toMatch(/1 MB/);
    expect(reasonText("de", "binary", "x")).toMatch(/Text/);
    expect(reasonText("en", "unknown-code", "The server's own words.")).toBe("The server's own words.");
  });

  it("Delete removes the file and reads the tree again", async () => {
    routes.push(reads("a\n"));
    routes.push((u, i) =>
      u.startsWith("/api/playbooks/file-at") && i?.method === "DELETE"
        ? answer(200, { path: "x", deleted: true })
        : undefined,
    );
    await openPath(DIR, null, "agents/notes.txt");
    await deleteFile();
    expect(calls().map((c) => c.url)).toContain(
      `/api/playbooks/file-at?dir=${encodeURIComponent(DIR)}&path=${encodeURIComponent("agents/notes.txt")}`,
    );
    expect(bundleEditorState().file).toBeNull();
    expect(calls().filter((c) => c.url.startsWith("/api/playbooks/tree"))).toHaveLength(1);
  });

  it("playbook.json opens the graph editor, never the text", async () => {
    showFolder(DIR, "files");
    routes.push((u) =>
      u.startsWith("/api/playbooks/draft")
        ? answer(200, {
            document: { schema_version: 1, id: "spectro", nodes: [], arrows: [] },
            diskHash: "d1",
            editable: true,
            canonical: true,
            outcomes: {},
            choices: [],
          })
        : undefined,
    );
    expect(await openPath(DIR, null, "playbook.json")).toBe("graph");
    expect(calls().some((c) => c.url.startsWith("/api/playbooks/read"))).toBe(false);
    expect(calls().some((c) => c.url.startsWith("/api/playbooks/draft"))).toBe(true);
    expect(bundleEditorState().file).toBeNull();
    expect(paneView().tab).toBe("playbook");
    expect(editorState().dir).toBe(DIR);
  });

  it("unsaved changes block opening another file", async () => {
    routes.push(reads("a\n"));
    await openPath(DIR, null, "templates/plan.md");
    editText("b\n");
    expect(await openPath(DIR, null, "templates/spec.md")).toBe("blocked");
    expect(bundleEditorState().file?.path).toBe("templates/plan.md");
  });
});

describe("the imports of card 523 (criterion 4)", () => {
  it("reads the import sources for the folder", async () => {
    routes.push((u) =>
      u.startsWith("/api/playbooks/import-sources")
        ? answer(200, { installed: [], catalogue: [], hooks: [], hooksInPlaybook: false })
        : undefined,
    );
    await loadSources(DIR);
    expect(calls()[0].url).toBe(`/api/playbooks/import-sources?dir=${encodeURIComponent(DIR)}`);
    expect(bundleEditorState().sources).toEqual({
      installed: [],
      catalogue: [],
      hooks: [],
      hooksInPlaybook: false,
    });
  });

  it("imports the ticked skills by label, pack and name", async () => {
    routes.push((u) =>
      u === "/api/playbooks/import-skills"
        ? answer(200, { imported: ["humanizer"], already: [] })
        : undefined,
    );
    const done = await importSkills(DIR, null, [
      { source: "installed", root: "user", pack: null, name: "humanizer" },
      { source: "catalogue", pack: "anthropic", name: "pdf" },
    ]);
    expect(done.ok).toBe(true);
    expect(bodyOf("/api/playbooks/import-skills")).toEqual({
      dir: DIR,
      items: [
        { source: "installed", root: "user", pack: null, name: "humanizer" },
        { source: "catalogue", pack: "anthropic", name: "pdf" },
      ],
    });
    expect(calls().some((c) => c.url.startsWith("/api/playbooks/tree"))).toBe(true);
  });

  it("imports hooks, with replace when the owner confirmed it", async () => {
    routes.push((u) =>
      u === "/api/playbooks/import-hooks" ? answer(200, { hooks: 1, scripts: [] }) : undefined,
    );
    await importHooks(DIR, null, true);
    expect(bodyOf("/api/playbooks/import-hooks")).toEqual({ dir: DIR, replace: true });
  });

  it("names the workspace to the hook import and the listing, so its paths become the project placeholder", async () => {
    routes.push((u) =>
      u.startsWith("/api/playbooks/import-sources")
        ? answer(200, { installed: [], catalogue: [], hooks: [], hooksInPlaybook: false })
        : u === "/api/playbooks/import-hooks"
          ? answer(200, { hooks: 1, scripts: [], left: [] })
          : undefined,
    );
    await loadSources(DIR, "/ws");
    expect(calls()[0].url).toBe(
      `/api/playbooks/import-sources?dir=${encodeURIComponent(DIR)}&workspace=${encodeURIComponent("/ws")}`,
    );
    await importHooks(DIR, "/ws", false);
    expect(bodyOf("/api/playbooks/import-hooks")).toEqual({ dir: DIR, replace: false, workspace: "/ws" });
  });

  it("creates an agent with a name and a type, and a command with a name", async () => {
    routes.push((u) =>
      u === "/api/playbooks/new-agent" || u === "/api/playbooks/new-command"
        ? answer(200, { path: "x" })
        : undefined,
    );
    await newAgent(DIR, null, "critic", "explore");
    await newCommand(DIR, null, "ship");
    expect(bodyOf("/api/playbooks/new-agent")).toEqual({ dir: DIR, name: "critic", type: "explore" });
    expect(bodyOf("/api/playbooks/new-command")).toEqual({ dir: DIR, name: "ship" });
  });

  it("removes an entry by kind and path, and keeps the server's refusal", async () => {
    routes.push((u) =>
      u === "/api/playbooks/remove-content"
        ? answer(400, { reason: "not-listed", message: "skills/x is not listed in contents.skills." })
        : undefined,
    );
    const out = await removeEntry(DIR, null, "skills", "skills/x");
    expect(bodyOf("/api/playbooks/remove-content")).toEqual({ dir: DIR, kind: "skills", path: "skills/x" });
    expect(out).toEqual({
      ok: false,
      reason: "not-listed",
      message: "skills/x is not listed in contents.skills.",
    });
  });

  it("Remove closes the open file under the removed entry", async () => {
    routes.push(reads("# A\n"));
    routes.push((u) => (u === "/api/playbooks/remove-content" ? answer(200, { removed: true }) : undefined));
    await openPath(DIR, null, "skills/mine/a/SKILL.md");
    expect(bundleEditorState().file?.path).toBe("skills/mine/a/SKILL.md");
    const out = await removeEntry(DIR, null, "skills", "skills/mine");
    expect(out.ok).toBe(true);
    expect(bundleEditorState().file).toBeNull();
  });

  it("Remove keeps a file open that is not under the removed entry", async () => {
    routes.push(reads("# B\n"));
    routes.push((u) => (u === "/api/playbooks/remove-content" ? answer(200, { removed: true }) : undefined));
    await openPath(DIR, null, "skills/mineral/SKILL.md");
    const out = await removeEntry(DIR, null, "skills", "skills/mine");
    expect(out.ok).toBe(true);
    expect(bundleEditorState().file?.path).toBe("skills/mineral/SKILL.md");
  });

  it("lists an entry that is on disk only through the draft and the save route, with the hash", async () => {
    const doc = {
      schema_version: 1,
      id: "spectro",
      contents: { skills: ["skills/spectropowers"], agents: [], hooks: [], commands: [], workflows: [] },
    };
    routes.push((u, i) =>
      u.startsWith("/api/playbooks/draft") && (i?.method ?? "GET") === "GET"
        ? answer(200, { document: doc, diskHash: "d1", editable: true, canonical: true })
        : undefined,
    );
    routes.push((u, i) =>
      u.startsWith("/api/playbooks/file") && i?.method === "PUT"
        ? answer(200, { diskHash: "d2" })
        : undefined,
    );
    const out = await listEntry(DIR, null, "skills", "skills/mine");
    expect(out.ok).toBe(true);
    const put = calls().find((c) => c.url.startsWith("/api/playbooks/file?"));
    const sent = JSON.parse(String(put?.init?.body)) as { baseHash: string; playbook: typeof doc };
    expect(sent.baseHash).toBe("d1");
    expect(sent.playbook.contents.skills).toEqual(["skills/spectropowers", "skills/mine"]);
  });
});
