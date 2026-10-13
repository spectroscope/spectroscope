// Card 525: the playbook pane edits the whole bundle in tabs. One list of
// tabs (PANE_TABS) draws the header; each kind tab shows the contents entries
// of its kind and the file browser scoped to the kind's folder; the right
// side edits the selected text file; every toolbar ends with Export and
// Import ZIP. The suite has no DOM: the pane is rendered on the server
// renderer from the stores, and pressed through the drive kit.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dict } from "../i18n/i18n";
import {
  __resetBundleEditor,
  askRemove,
  bundleEditorState,
  editText,
  loadSources,
  loadTree,
  openPanel,
  openPath,
  PANE_TABS,
  saveFile,
  type TreeView,
} from "../state/bundleEditor";
import { __resetFolderPick } from "../state/folderPick";
import { setLang } from "../state/lang";
import { __resetBundle, openBundle } from "../state/playbookBundle";
import { __resetPlaybookEditor, dispatch, editorState, openEditor } from "../state/playbookEditor";
import {
  __resetPlaybooks,
  loadPlaybook,
  paneView,
  refreshFolders,
  showFolder,
  type LoadedPlaybook,
} from "../state/playbooks";
import { __resetLyzr, chooseKind, choose, generatePlaybook } from "../state/spectrolyzr";
import { SURFACES } from "../state/surfaces";
import { drive, type El } from "../testkit/driveComponent";
import { handZip } from "../testkit/handZip";
import { read, stripComments } from "../testkit/source";
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FileBrowser, Tree, type FileNode } from "../workspace/FileBrowser";
import { BundleImport } from "./BundleImport";
import {
  BundleTab,
  Entries,
  FileEditor,
  HooksImport,
  KindTools,
  NewEntryForm,
  RemoveConfirm,
  SkillPicker,
} from "./BundleTab";
import { PlaybookPane } from "./PlaybookPane";

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

const SKILL_NAMES = [
  "brainstorming",
  "dispatching-parallel-agents",
  "executing-plans",
  "finishing-a-development-branch",
  "receiving-code-review",
  "requesting-code-review",
  "subagent-driven-development",
  "systematic-debugging",
  "test-driven-development",
  "using-git-worktrees",
  "using-spectropowers",
  "verification-before-completion",
  "writing-plans",
  "writing-skills",
];

const TREE: TreeView = {
  root: "spectro",
  truncated: false,
  capped: false,
  deeper: [],
  findings: [],
  entries: [
    folder("agents", [file("agents/reviewer.md")]),
    folder("docs", [file("docs/index.html")]),
    folder("skills", [
      folder(
        "skills/spectropowers",
        SKILL_NAMES.map((n) =>
          folder(`skills/spectropowers/${n}`, [file(`skills/spectropowers/${n}/SKILL.md`)]),
        ),
      ),
      folder("skills/mine", [folder("skills/mine/a", [file("skills/mine/a/SKILL.md")])]),
    ]),
    folder("templates", [file("templates/plan.md")]),
    file("LICENSE"),
    file("PROVENANCE.md"),
    file("playbook.json"),
  ],
};

const LOADED: LoadedPlaybook = {
  playbook: {
    id: "spectro",
    name: "spectro",
    description: "",
    start: "s",
    nodes: [{ kind: "end", id: "s", result: "done" }],
    arrows: [],
    models: {},
    documents: {},
    contents: {
      skills: ["skills/spectropowers", "skills/gone"],
      agents: [],
      hooks: [],
      commands: [],
      workflows: [],
    },
  },
  topology: null,
  findings: [{ path: "contents.skills[1]", message: "skills/gone is not in the folder" }],
  steps: [],
  dir: DIR,
};

function answer(status: number, body: unknown = {}, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
    blob: () => Promise.resolve(new Blob(["zip"])),
  } as unknown as Response;
}

type Route = (url: string, init: RequestInit | undefined) => Response | undefined;
let routes: Route[] = [];

const calls = (): { url: string; init: RequestInit | undefined }[] =>
  vi.mocked(fetch).mock.calls.map(([u, i]) => ({ url: String(u), init: i as RequestInit | undefined }));

const DOC = {
  schema_version: 1,
  id: "spectro",
  name: "spectro",
  description: "",
  models: {},
  documents: {},
  checks: {},
  vars: {},
  start: "s",
  nodes: [{ kind: "end", id: "s", result: "done" }],
  arrows: [],
  contents: { skills: ["skills/spectropowers"], agents: [], hooks: [], commands: [], workflows: [] },
};

beforeEach(() => {
  __resetBundleEditor();
  __resetPlaybooks();
  __resetPlaybookEditor();
  __resetBundle();
  __resetFolderPick();
  __resetLyzr();
  setLang("en");
  routes = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      for (const r of routes) {
        const hit = r(u, init);
        if (hit !== undefined) return Promise.resolve(hit);
      }
      if (u.startsWith("/api/playbooks?"))
        return Promise.resolve(answer(200, { folders: [DIR], active: DIR }));
      if (u.startsWith("/api/playbooks/load")) return Promise.resolve(answer(200, LOADED));
      if (u.startsWith("/api/playbooks/tree")) return Promise.resolve(answer(200, TREE));
      if (u.startsWith("/api/playbooks/draft"))
        return Promise.resolve(
          answer(200, {
            loaded: LOADED,
            document: DOC,
            diskHash: "d1",
            editable: true,
            canonical: true,
            outcomes: {},
            choices: [],
          }),
        );
      if (u.startsWith("/api/playbooks/file?"))
        return Promise.resolve(answer(200, { document: DOC, diskHash: "d2" }));
      if (u === "/api/pick-workspace") return Promise.resolve(answer(200, { path: "/picked/empty" }));
      if (u === "/api/playbooks/import") return Promise.resolve(answer(200, { dir: "/picked/empty" }));
      return Promise.resolve(answer(404));
    }),
  );
});

afterEach(() => {
  __resetBundleEditor();
  __resetPlaybooks();
  __resetPlaybookEditor();
  __resetBundle();
  __resetFolderPick();
  __resetLyzr();
  setLang("en");
  vi.unstubAllGlobals();
});

const pane = <PlaybookPane workspace="/ws" wizard={<i className="wizard-probe" />} sessionId={null} />;

/** A folder shown, its playbook loaded and its tree read, on the tab asked for. */
async function ready(tab: (typeof PANE_TABS)[number]["id"]): Promise<void> {
  await refreshFolders("/ws");
  await loadPlaybook(DIR, "/ws");
  await loadTree(DIR);
  showFolder(DIR, tab);
}

const tabLabels = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*role="tab"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

function one(tree: El[], type: string, cls: string): El {
  const found = tree.filter(
    (el) =>
      el.type === type &&
      String(el.props.className ?? "")
        .split(/\s+/)
        .includes(cls),
  );
  if (found.length !== 1) throw new Error(`expected one <${type} class="${cls}">, found ${found.length}`);
  return found[0];
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the tabs (criterion 1)", () => {
  it("are drawn from one list: Steps (card 563), Skills, Agents, Hooks, Commands, Workflows, Plugin, Files and New", () => {
    expect(PANE_TABS.map((t) => t.id)).toEqual([
      "playbook",
      "skills",
      "agents",
      "hooks",
      "commands",
      "workflows",
      "plugin",
      "files",
      "lyzr",
    ]);
    const en = renderToStaticMarkup(pane);
    expect(tabLabels(en)).toEqual([
      "Steps",
      "Skills",
      "Agents",
      "Hooks",
      "Commands",
      "Workflows",
      "Plugin",
      "Files",
      "New",
    ]);
    expect(tabLabels(en)).toHaveLength(PANE_TABS.length);
    setLang("de");
    expect(tabLabels(renderToStaticMarkup(pane))).toEqual([
      "Schritte",
      "Skills",
      "Agenten",
      "Hooks",
      "Befehle",
      "Workflows",
      "Plugin",
      "Dateien",
      "Neu",
    ]);
  });

  it("the kind tabs are disabled with a title while no playbook is loaded", () => {
    const out = renderToStaticMarkup(pane);
    for (const label of ["Skills", "Agents", "Hooks", "Commands", "Workflows", "Files"]) {
      expect(out).toMatch(
        new RegExp(
          `<button[^>]*role="tab"[^>]*disabled=""[^>]*title="Load a playbook first[^"]*"[^>]*>${label}<`,
        ),
      );
    }
    expect(out).not.toMatch(/<button[^>]*role="tab"[^>]*disabled=""[^>]*>Steps</);
    expect(out).not.toMatch(/<button[^>]*role="tab"[^>]*disabled=""[^>]*>New</);
  });

  it("Steps, named Playbook until card 563, stays today's view", async () => {
    await ready("playbook");
    const out = renderToStaticMarkup(pane);
    expect(out).toMatch(/<button[^>]*role="tab"[^>]*aria-selected="true"[^>]*>Steps</);
    expect(out).toContain('class="pb-folders"');
    expect(out).not.toContain('class="pbb-tab"');
  });

  it("a kind tab shows the contents entries of its kind above the tree scoped to its folder", async () => {
    await ready("skills");
    const out = renderToStaticMarkup(pane);
    expect(out).toMatch(/<button[^>]*role="tab"[^>]*aria-selected="true"[^>]*>Skills</);
    const entries = out.indexOf('class="pbb-entries"');
    const tree = out.indexOf('role="tree"');
    expect(entries).toBeGreaterThan(-1);
    expect(tree).toBeGreaterThan(entries);
    expect(out).toMatch(/data-state="listed"[^>]*>[\s\S]*?skills\/spectropowers/);
    expect(out).toMatch(/data-state="missing"[\s\S]*?skills\/gone[\s\S]*?skills\/gone is not in the folder/);
    expect(out).toMatch(/data-state="disk-only"[\s\S]*?skills\/mine/);
    expect(out).toContain(">Listed<");
    expect(out).toContain(">On disk only<");
    expect(out).toContain(">Listed but missing<");
    // The tree holds the skills folder and nothing beside it.
    const browser = out.slice(tree);
    expect(browser).toContain(">spectropowers<");
    expect(browser).not.toContain(">templates<");
    expect(browser).not.toContain(">LICENSE<");
  });

  it("the entries heading does not call every row listed, since some are on disk only", async () => {
    await ready("skills");
    const out = renderToStaticMarkup(pane);
    const heading = out.match(/<section class="pbb-entries"[^>]*><h3 class="pb-h">([^<]*)</)?.[1] ?? "";
    expect(heading).toBe(dict["pbb.entries"].en);
    expect(heading.toLowerCase()).not.toContain("listed");
    expect(dict["pbb.entries"].de.toLowerCase()).not.toContain("aufgeführt");
  });

  it("while the tree is read, the left side says the folder is read, not a file", async () => {
    await refreshFolders("/ws");
    await loadPlaybook(DIR, "/ws");
    showFolder(DIR, "files");
    const out = renderToStaticMarkup(pane);
    const left = out.slice(out.indexOf('class="pbb-files"'), out.indexOf('class="pbb-right"'));
    expect(left).toContain(dict["pbb.loadingTree"]?.en ?? "missing key pbb.loadingTree");
    expect(left).not.toContain(dict["pbb.loading"].en);
  });

  it("the tree of the spectro copy lists spectropowers with its fourteen skills", async () => {
    await ready("skills");
    const out = renderToStaticMarkup(pane);
    for (const name of SKILL_NAMES) expect(out).toContain(`class="ws-row-name">${name}<`);
    expect(SKILL_NAMES).toHaveLength(14);
  });

  it("Files shows the whole folder", async () => {
    await ready("files");
    const out = renderToStaticMarkup(pane);
    const browser = out.slice(out.indexOf('role="tree"'));
    for (const name of [
      "agents",
      "docs",
      "skills",
      "templates",
      "LICENSE",
      "PROVENANCE.md",
      "playbook.json",
    ]) {
      expect(browser).toContain(`class="ws-row-name">${name}<`);
    }
    expect(out).not.toContain('class="pbb-entries"');
  });

  it("an entry on disk only offers List it and Remove, a listed one Remove", async () => {
    await ready("skills");
    const out = renderToStaticMarkup(pane);
    const row = (state: string): string =>
      out.match(new RegExp(`<li[^>]*data-state="${state}"[^>]*>([\\s\\S]*?)</li>`))?.[1] ?? "";
    expect(row("disk-only")).toMatch(/class="pbb-list-it"[^>]*>List it</);
    expect(row("disk-only")).toMatch(/class="pbb-remove"[^>]*>Remove</);
    expect(row("listed")).toMatch(/class="pbb-remove"[^>]*>Remove</);
    expect(row("listed")).not.toContain("pbb-list-it");
    expect(row("missing")).toMatch(/class="pbb-remove"[^>]*>Remove</);
  });
});

describe("the note that the folder holds more (criterion 2)", () => {
  const deepTree: TreeView = {
    ...TREE,
    truncated: true,
    deeper: ["skills/spectropowers/brainstorming/scripts/a/b"],
  };

  it("shows on the tabs whose part goes deeper, and not on the others", async () => {
    routes.push((u) => (u.startsWith("/api/playbooks/tree") ? answer(200, deepTree) : undefined));
    await ready("skills");
    const note = dict["pbb.truncated"].en;
    expect(renderToStaticMarkup(pane)).toContain(note);
    showFolder(DIR, "files");
    expect(renderToStaticMarkup(pane)).toContain(note);
    for (const tab of ["agents", "hooks", "commands", "workflows"] as const) {
      showFolder(DIR, tab);
      expect(paneView().tab).toBe(tab);
      expect(renderToStaticMarkup(pane)).not.toContain(note);
    }
  });

  it("shows on no tab for a whole tree", async () => {
    await ready("skills");
    expect(renderToStaticMarkup(pane)).not.toContain(dict["pbb.truncated"].en);
    showFolder(DIR, "files");
    expect(renderToStaticMarkup(pane)).not.toContain(dict["pbb.truncated"].en);
  });
});

describe("the keyboard in the Files tree (criterion 2)", () => {
  const press =
    (key: string) =>
    (tree: El[]): void => {
      const box = tree.find((el) => el.props.role === "tree");
      if (box === undefined) throw new Error("no tree");
      // The key lands on the box itself, as when the tree has the focus.
      const self = { querySelector: () => null };
      (box.props.onKeyDown as (e: unknown) => void)({
        key,
        preventDefault: () => {},
        target: self,
        currentTarget: self,
      });
    };
  const selectedRow = (tree: El[]): string[] =>
    tree
      .filter((el) => el.props.role === "treeitem" && el.props["aria-selected"] === true)
      .map((el) => String(el.props.title));
  const drafts = (): number => calls().filter((c) => c.url.startsWith("/api/playbooks/draft")).length;

  it("ArrowDown onto playbook.json selects it and stays on Files; Enter opens the graph editor", async () => {
    await ready("files");
    routes.push((u) =>
      u.startsWith("/api/playbooks/read")
        ? answer(200, { path: "p", text: "made here\n", sha256: "h", size: 10 })
        : undefined,
    );
    await openPath(DIR, "/ws", "PROVENANCE.md");
    const files = PANE_TABS.find((t) => t.id === "files");
    if (files === undefined) throw new Error("no Files tab");
    const seen: { tab: string; rows: string[]; drafts: number }[] = [];
    const look = (tree: El[]): void => {
      seen.push({ tab: paneView().tab, rows: selectedRow(tree), drafts: drafts() });
    };
    drive(
      <BundleTab spec={files} dir={DIR} workspace="/ws" loaded={LOADED} />,
      [BundleTab, FileBrowser, Tree],
      [
        press("ArrowDown"),
        (tree) => {
          look(tree);
          press("ArrowUp")(tree);
        },
        (tree) => {
          look(tree);
          press("ArrowDown")(tree);
        },
        (tree) => {
          look(tree);
          press("Enter")(tree);
        },
      ],
    );
    expect(seen).toEqual([
      { tab: "files", rows: ["playbook.json"], drafts: 0 },
      { tab: "files", rows: ["PROVENANCE.md"], drafts: 0 },
      { tab: "files", rows: ["playbook.json"], drafts: 0 },
    ]);
    expect(bundleEditorState().file?.path ?? null).toBeNull();
    expect(paneView().tab).toBe("playbook");
    await settle();
    expect(drafts()).toBeGreaterThan(0);
  });

  it("a press on playbook.json still opens the graph editor", async () => {
    await ready("files");
    const files = PANE_TABS.find((t) => t.id === "files");
    if (files === undefined) throw new Error("no Files tab");
    drive(
      <BundleTab spec={files} dir={DIR} workspace="/ws" loaded={LOADED} />,
      [BundleTab, FileBrowser, Tree],
      [
        (tree) =>
          tree
            .find((el) => el.props.role === "treeitem" && el.props.title === "playbook.json")
            ?.props.onClick?.(),
      ],
    );
    expect(paneView().tab).toBe("playbook");
  });
});

describe("the editor on the right (criterion 3)", () => {
  const reads =
    (text: string, sha = "h1"): Route =>
    (u) =>
      u.startsWith("/api/playbooks/read")
        ? answer(200, { path: "p", text, sha256: sha, size: text.length })
        : undefined;

  it("a Markdown file opens in a textarea with Save, Delete and a rendered preview beside it", async () => {
    await ready("skills");
    routes.push(reads("# Brainstorming\n\nOne line.\n"));
    await openPath(DIR, "/ws", "skills/spectropowers/brainstorming/SKILL.md");
    const out = renderToStaticMarkup(pane);
    expect(out).toMatch(/<textarea[^>]*class="pbb-text"[^>]*>/);
    expect(out).toContain("# Brainstorming");
    expect(out).toMatch(/class="pbb-save"[^>]*disabled=""[^>]*>Save</);
    expect(out).toMatch(/class="pbb-delete"[^>]*>Delete</);
    expect(out).toMatch(/class="pbb-preview"[\s\S]*?<div class="md"><h1[^>]*>Brainstorming<\/h1>/);
  });

  it("an edit enables Save and shows in the preview", async () => {
    await ready("skills");
    routes.push(reads("# Brainstorming\n"));
    await openPath(DIR, "/ws", "skills/spectropowers/brainstorming/SKILL.md");
    editText("# Brainstorming, changed\n");
    const out = renderToStaticMarkup(pane);
    expect(out).not.toMatch(/class="pbb-save"[^>]*disabled=""/);
    expect(out).toMatch(/<h1[^>]*>Brainstorming, changed<\/h1>/);
  });

  it("a JSON file shows the highlighted source beside the text", async () => {
    await ready("files");
    routes.push(reads('{ "a": 1 }\n'));
    await openPath(DIR, "/ws", "hooks/hooks.json");
    expect(renderToStaticMarkup(pane)).toMatch(/class="pbb-preview"[\s\S]*?class="ws-src mono"/);
  });

  it("a 409 says the disk changed and offers a reload", async () => {
    await ready("skills");
    routes.push(reads("a\n"));
    routes.push((u) =>
      u === "/api/playbooks/write"
        ? answer(409, { reason: "changed", message: "m", diskHash: "h9" })
        : undefined,
    );
    await openPath(DIR, "/ws", "templates/plan.md");
    editText("b\n");
    await saveFile();
    const out = renderToStaticMarkup(pane);
    expect(out).toContain("The file changed on disk since you opened it.");
    expect(out).toMatch(/class="pbb-reload"[^>]*>Reload from disk</);
  });

  it("a binary or oversized file shows the server's reason instead of a textarea", async () => {
    await ready("files");
    routes.push((u) =>
      u.startsWith("/api/playbooks/read") ? answer(413, { reason: "too-large", message: "big" }) : undefined,
    );
    await openPath(DIR, "/ws", "docs/index.html");
    const out = renderToStaticMarkup(pane);
    expect(out).not.toContain('class="pbb-text"');
    expect(out).toContain("larger than 1 MB");
  });

  it("the protected root files offer no Delete", async () => {
    await ready("files");
    routes.push(reads("MIT\n"));
    for (const path of ["LICENSE", "PROVENANCE.md"]) {
      await openPath(DIR, "/ws", path);
      expect(bundleEditorState().file?.path).toBe(path);
      expect(renderToStaticMarkup(pane)).not.toContain('class="pbb-delete"');
    }
  });

  it("a LICENSE inside a skill is not a root file and offers Delete", async () => {
    await ready("files");
    routes.push(reads("MIT\n"));
    await openPath(DIR, "/ws", "skills/mine/a/LICENSE");
    expect(renderToStaticMarkup(pane)).toMatch(/class="pbb-delete"[^>]*>Delete</);
  });

  describe("the save key", () => {
    const writes = (): number => calls().filter((c) => c.url === "/api/playbooks/write").length;
    const keyOnText =
      (e: { key: string; metaKey?: boolean; ctrlKey?: boolean }) =>
      (tree: El[]): void => {
        const area = tree.find((el) => el.type === "textarea");
        if (area === undefined) throw new Error("no textarea");
        (area.props.onKeyDown as (ev: unknown) => void)({ preventDefault: () => {}, ...e });
      };
    const opened = async (): Promise<void> => {
      await ready("skills");
      routes.push(reads("# Plan\n"));
      routes.push((u) =>
        u === "/api/playbooks/write" ? answer(200, { path: "p", sha256: "h2", size: 8 }) : undefined,
      );
      await openPath(DIR, "/ws", "templates/plan.md");
      editText("# Plan, changed\n");
    };

    it("Cmd+S saves the open file", async () => {
      await opened();
      drive(<FileEditor />, [FileEditor], [keyOnText({ key: "s", metaKey: true })]);
      await settle();
      expect(writes()).toBe(1);
      expect(bundleEditorState().file?.base).toBe("# Plan, changed\n");
    });

    it("Ctrl+S saves the open file", async () => {
      await opened();
      drive(<FileEditor />, [FileEditor], [keyOnText({ key: "s", ctrlKey: true })]);
      await settle();
      expect(writes()).toBe(1);
    });

    it("an s without the modifier types and saves nothing", async () => {
      await opened();
      drive(<FileEditor />, [FileEditor], [keyOnText({ key: "s" })]);
      await settle();
      expect(writes()).toBe(0);
    });
  });

  it("Delete asks first and sends the DELETE only after the confirm", async () => {
    await ready("skills");
    routes.push(reads("# Plan\n"));
    routes.push((u, init) =>
      u.startsWith("/api/playbooks/file-at") && init?.method === "DELETE" ? answer(200, {}) : undefined,
    );
    await openPath(DIR, "/ws", "templates/plan.md");
    const deletes = (): string[] =>
      calls()
        .filter((c) => c.init?.method === "DELETE")
        .map((c) => c.url);
    let asked = "";
    drive(
      <FileEditor />,
      [FileEditor],
      [
        (tree) => one(tree, "button", "pbb-delete").props.onClick?.(),
        (tree) => {
          asked = String(
            tree.find((el) => el.type === "p" && String(el.props.children).includes("templates/plan.md"))
              ?.props.children ?? "",
          );
          expect(deletes()).toEqual([]);
          one(tree, "button", "pbb-delete-go").props.onClick?.();
        },
      ],
    );
    expect(asked).toBe("Delete templates/plan.md from the folder?");
    await settle();
    expect(deletes()).toEqual([
      `/api/playbooks/file-at?dir=${encodeURIComponent(DIR)}&path=${encodeURIComponent("templates/plan.md")}`,
    ]);
  });

  it("Cancel on the Delete question sends nothing", async () => {
    await ready("skills");
    routes.push(reads("# Plan\n"));
    await openPath(DIR, "/ws", "templates/plan.md");
    drive(
      <FileEditor />,
      [FileEditor],
      [
        (tree) => one(tree, "button", "pbb-delete").props.onClick?.(),
        (tree) => one(tree, "button", "pbb-cancel").props.onClick?.(),
      ],
    );
    await settle();
    expect(calls().some((c) => c.init?.method === "DELETE")).toBe(false);
  });

  it("a refused Delete shows the server's reason", async () => {
    await ready("skills");
    routes.push(reads("# Plan\n"));
    routes.push((u, init) =>
      u.startsWith("/api/playbooks/file-at") && init?.method === "DELETE"
        ? answer(400, { reason: "protected", message: "m" })
        : undefined,
    );
    await openPath(DIR, "/ws", "templates/plan.md");
    drive(
      <FileEditor />,
      [FileEditor],
      [
        (tree) => one(tree, "button", "pbb-delete").props.onClick?.(),
        (tree) => one(tree, "button", "pbb-delete-go").props.onClick?.(),
      ],
    );
    await settle();
    await settle();
    const out = renderToStaticMarkup(pane);
    expect(out).toMatch(
      /class="pbb-refusal" role="alert">[^<]*playbook.json, LICENSE and PROVENANCE.md belong/,
    );
    expect(out).toContain('class="pbb-text"');
  });

  it("unsaved changes in a file block a tab switch, as the graph editor's draft does", async () => {
    await ready("skills");
    routes.push(reads("a\n"));
    await openPath(DIR, "/ws", "templates/plan.md");
    editText("b\n");
    const out = renderToStaticMarkup(pane);
    for (const label of ["Steps", "Agents", "Files", "New"]) {
      expect(out).toMatch(new RegExp(`<button[^>]*role="tab"[^>]*disabled=""[^>]*>${label}<`));
    }
    expect(out).toContain(dict["pbb.locked"].en);
    // A press on a locked tab does nothing.
    drive(
      pane,
      [PlaybookPane],
      [
        (tree) =>
          tree.find((el) => el.props.role === "tab" && el.props.children === "Files")?.props.onClick?.(),
      ],
    );
    expect(paneView().tab).toBe("skills");
  });

  it("a draft with unsaved changes in the graph editor locks the tabs too", async () => {
    await ready("playbook");
    await openEditor(DIR, "/ws");
    expect(renderToStaticMarkup(pane)).not.toMatch(/<button[^>]*role="tab"[^>]*disabled=""[^>]*>Skills</);
    dispatch({ kind: "editEnd", id: "s", result: "shipped" });
    expect(editorState().dirty).toBe(true);
    expect(renderToStaticMarkup(pane)).toMatch(/<button[^>]*role="tab"[^>]*disabled=""[^>]*>Skills</);
  });
});

describe("the toolbar of each kind (criterion 4)", () => {
  it("Skills offers Import and a hint that names the parts of a bundle and sends plugins to the Plugin tab", async () => {
    await ready("skills");
    const out = renderToStaticMarkup(pane);
    expect(out).toMatch(/class="pbb-import-skills"[^>]*>Import</);
    expect(out).toContain(dict["pbb.skills.hint"].en);
    const en = dict["pbb.skills.hint"].en;
    const de = dict["pbb.skills.hint"].de;
    for (const part of ["skills", "agents", "hooks", "commands", "workflows"])
      expect(en.toLowerCase()).toContain(part);
    for (const part of ["skills", "agenten", "hooks", "befehle", "workflows"])
      expect(de.toLowerCase()).toContain(part);
    expect(en).toMatch(/import plugins on the plugin tab/i);
    expect(de).toMatch(/plugins importierst du im plugin-tab/i);
    expect(en).not.toMatch(/no plugin tab/i);
    expect(de).not.toMatch(/gibt es nicht/i);
  });

  it("the skill picker lists the installed and the catalogue skills with checkboxes, and imports the ticked ones", async () => {
    await ready("skills");
    routes.push((u) =>
      u.startsWith("/api/playbooks/import-sources")
        ? answer(200, {
            installed: [
              {
                root: "user",
                pack: null,
                name: "humanizer",
                description: "Edits text",
                inPlaybook: false,
                importable: true,
              },
              {
                root: "user",
                pack: null,
                name: "linked",
                description: "",
                inPlaybook: false,
                importable: false,
                why: "a symbolic link; it is not imported",
              },
            ],
            catalogue: [
              {
                id: "anthropic/pdf",
                pack: "anthropic",
                name: "pdf",
                description: "PDF",
                licence: "MIT",
                inPlaybook: false,
              },
            ],
            hooks: [],
            hooksInPlaybook: false,
          })
        : undefined,
    );
    routes.push((u) =>
      u === "/api/playbooks/import-skills"
        ? answer(200, { imported: ["humanizer"], already: [] })
        : undefined,
    );
    await loadSources(DIR);
    openPanel("import-skills");
    const out = renderToStaticMarkup(pane);
    expect(out).toMatch(/class="pbb-picker"/);
    expect(out.indexOf(">Installed<")).toBeLessThan(out.indexOf(">Catalogue<"));
    expect(out).toMatch(/<input[^>]*type="checkbox"[^>]*data-skill="installed:user::humanizer"/);
    expect(out).toMatch(/<input[^>]*type="checkbox"[^>]*disabled=""[^>]*data-skill="installed:user::linked"/);
    expect(out).toMatch(/<input[^>]*type="checkbox"[^>]*data-skill="catalogue:anthropic:pdf"/);

    drive(
      <SkillPicker dir={DIR} workspace="/ws" />,
      [SkillPicker],
      [
        (tree) =>
          tree
            .find((el) => el.props["data-skill"] === "installed:user::humanizer")
            ?.props.onChange?.({ target: { value: "" } }),
        (tree) => one(tree, "button", "pbb-picker-go").props.onClick?.(),
      ],
    );
    await settle();
    const sent = calls().find((c) => c.url === "/api/playbooks/import-skills");
    expect(JSON.parse(String(sent?.init?.body))).toEqual({
      dir: DIR,
      items: [{ source: "installed", root: "user", pack: null, name: "humanizer" }],
    });
  });

  it("Hooks offers Import hooks", async () => {
    await ready("hooks");
    expect(renderToStaticMarkup(pane)).toMatch(/class="pbb-import-hooks"[^>]*>Import hooks</);
  });

  const hookSources =
    (inPlaybook: boolean): Route =>
    (u) =>
      u.startsWith("/api/playbooks/import-sources")
        ? answer(200, {
            installed: [],
            catalogue: [],
            hooks: [
              {
                event: "PreToolUse",
                matcher: "Bash",
                command: "~/.claude/guard.sh",
                timeoutSeconds: null,
                scripts: [],
              },
            ],
            hooksInPlaybook: inPlaybook,
          })
        : undefined;

  for (const inPlaybook of [false, true]) {
    it(`Import hooks sends replace ${inPlaybook} when hooks.json is ${inPlaybook ? "there" : "not there"}`, async () => {
      await ready("hooks");
      routes.push(hookSources(inPlaybook));
      routes.push((u) => (u === "/api/playbooks/import-hooks" ? answer(200, { imported: [] }) : undefined));
      await loadSources(DIR);
      openPanel("import-hooks");
      const out = renderToStaticMarkup(pane);
      expect(out).toContain(">PreToolUse<");
      expect(out).toContain("~/.claude/guard.sh");
      if (inPlaybook) {
        expect(out).toContain(dict["pbb.hooks.replace"].en);
        expect(out).toMatch(/class="pbb-hooks-go"[^>]*>Replace and import</);
      } else {
        expect(out).not.toContain(dict["pbb.hooks.replace"].en);
        expect(out).toMatch(new RegExp(`class="pbb-hooks-go"[^>]*>${dict["pbb.hooks.go"].en}<`));
      }
      drive(
        <HooksImport dir={DIR} workspace="/ws" />,
        [HooksImport],
        [(tree) => one(tree, "button", "pbb-hooks-go").props.onClick?.()],
      );
      await settle();
      const sent = calls().find((c) => c.url === "/api/playbooks/import-hooks");
      expect(JSON.parse(String(sent?.init?.body))).toEqual({
        dir: DIR,
        replace: inPlaybook,
        workspace: "/ws",
      });
    });
  }

  it("a hook the import leaves out says so on its row, and the others do not", async () => {
    await ready("hooks");
    routes.push((u) =>
      u.startsWith("/api/playbooks/import-sources")
        ? answer(200, {
            installed: [],
            catalogue: [],
            hooks: [
              {
                event: "pre_tool_use",
                matcher: null,
                command: "cat ~/.aws/credentials",
                timeoutSeconds: null,
                scripts: [],
                left: "home-dot-folder",
              },
              {
                event: "post_tool_use",
                matcher: null,
                command: "echo done",
                timeoutSeconds: null,
                scripts: [],
                left: null,
              },
            ],
            hooksInPlaybook: false,
          })
        : undefined,
    );
    await loadSources(DIR);
    openPanel("import-hooks");
    const out = renderToStaticMarkup(pane);
    const rows = out.split('class="pbb-pick-row"').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain(dict["pbb.hooks.leftOut"].en);
    expect(rows[1]).not.toContain(dict["pbb.hooks.leftOut"].en);
  });

  it("a hook left out for a path above the workspace says that reason on its row", async () => {
    await ready("hooks");
    routes.push((u) =>
      u.startsWith("/api/playbooks/import-sources")
        ? answer(200, {
            installed: [],
            catalogue: [],
            hooks: [
              {
                event: "pre_tool_use",
                matcher: null,
                command: "bash {project}/../x.sh",
                timeoutSeconds: null,
                scripts: [],
                left: "project-parent",
              },
              {
                event: "post_tool_use",
                matcher: null,
                command: "cat ~/.ssh/id_rsa",
                timeoutSeconds: null,
                scripts: [],
                left: "home-dot-folder",
              },
            ],
            hooksInPlaybook: false,
          })
        : undefined,
    );
    await loadSources(DIR);
    openPanel("import-hooks");
    const out = renderToStaticMarkup(pane);
    const rows = out.replaceAll("&#x27;", "'").split('class="pbb-pick-row"').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain(dict["pbb.hooks.leftOutParent"].en);
    expect(rows[0]).not.toContain(dict["pbb.hooks.leftOut"].en);
    expect(rows[1]).toContain(dict["pbb.hooks.leftOut"].en);
    expect(rows[1]).not.toContain(dict["pbb.hooks.leftOutParent"].en);
  });

  it("Import hooks on the toolbar reads the sources for the pane's workspace", async () => {
    await ready("hooks");
    routes.push((u) =>
      u.startsWith("/api/playbooks/import-sources")
        ? answer(200, { installed: [], catalogue: [], hooks: [], hooksInPlaybook: false })
        : undefined,
    );
    drive(
      <KindTools spec={PANE_TABS.find((x) => x.kind === "hooks")!} dir={DIR} workspace="/ws" />,
      [KindTools],
      [(tree) => one(tree, "button", "pbb-import-hooks").props.onClick?.()],
    );
    await settle();
    expect(calls().find((c) => c.url.startsWith("/api/playbooks/import-sources"))?.url).toBe(
      `/api/playbooks/import-sources?dir=${encodeURIComponent(DIR)}&workspace=${encodeURIComponent("/ws")}`,
    );
  });

  it("Agents offer New with a name and a type, Commands New with a name", async () => {
    await ready("agents");
    expect(renderToStaticMarkup(pane)).toMatch(/class="pbb-new"[^>]*>New</);
    openPanel("new-agent");
    const agents = renderToStaticMarkup(pane);
    expect(agents).toMatch(/<input[^>]*class="pbb-new-name"/);
    expect(agents).toMatch(
      /<select[^>]*class="pbb-new-type"[\s\S]*?>explore<[\s\S]*?>worker<[\s\S]*?>research</,
    );

    routes.push((u) =>
      u === "/api/playbooks/new-agent" ? answer(200, { path: "agents/critic.md" }) : undefined,
    );
    drive(
      <NewEntryForm dir={DIR} workspace="/ws" kind="agents" />,
      [NewEntryForm],
      [
        (tree) => one(tree, "input", "pbb-new-name").props.onChange?.({ target: { value: "critic" } }),
        (tree) => one(tree, "select", "pbb-new-type").props.onChange?.({ target: { value: "worker" } }),
        (tree) => one(tree, "button", "pbb-new-go").props.onClick?.(),
      ],
    );
    await settle();
    const sent = calls().find((c) => c.url === "/api/playbooks/new-agent");
    expect(JSON.parse(String(sent?.init?.body))).toEqual({ dir: DIR, name: "critic", type: "worker" });

    showFolder(DIR, "commands");
    openPanel("new-command");
    const commands = renderToStaticMarkup(pane);
    expect(commands).toMatch(/<input[^>]*class="pbb-new-name"/);
    expect(commands).not.toContain('class="pbb-new-type"');
  });

  it("Remove asks before it removes", async () => {
    await ready("skills");
    routes.push((u) =>
      u === "/api/playbooks/remove-content" ? answer(200, { removed: ["skills/spectropowers"] }) : undefined,
    );
    askRemove("skills", "skills/spectropowers");
    expect(renderToStaticMarkup(pane)).toMatch(/class="pbb-confirm"[\s\S]*?skills\/spectropowers/);
    expect(calls().some((c) => c.url === "/api/playbooks/remove-content")).toBe(false);
    drive(
      <RemoveConfirm dir={DIR} workspace="/ws" />,
      [RemoveConfirm],
      [(tree) => one(tree, "button", "pbb-confirm-go").props.onClick?.()],
    );
    await settle();
    const sent = calls().find((c) => c.url === "/api/playbooks/remove-content");
    expect(JSON.parse(String(sent?.init?.body))).toEqual({
      dir: DIR,
      kind: "skills",
      path: "skills/spectropowers",
    });
  });

  it("Remove on an entry on disk only lists it first, then removes it, after the confirm", async () => {
    await ready("skills");
    routes.push((u) =>
      u === "/api/playbooks/remove-content" ? answer(200, { removed: ["skills/mine"] }) : undefined,
    );
    const inside = (el: El, cls: string): El | null => {
      const kids = el.props.children;
      for (const k of Array.isArray(kids) ? kids.flat(4) : [kids]) {
        if (k === null || typeof k !== "object" || !("props" in k)) continue;
        const kid = k as El;
        if (
          String(kid.props.className ?? "")
            .split(/\s+/)
            .includes(cls)
        )
          return kid;
        const deeper = inside(kid, cls);
        if (deeper !== null) return deeper;
      }
      return null;
    };
    drive(
      <Entries kind="skills" dir={DIR} workspace="/ws" loaded={LOADED} />,
      [Entries],
      [
        (tree) => {
          const row = tree.find((el) => el.type === "li" && el.props["data-state"] === "disk-only");
          if (row === undefined) throw new Error("no disk-only row");
          inside(row, "pbb-remove")?.props.onClick?.();
        },
      ],
    );
    expect(bundleEditorState().confirm).toEqual({ kind: "skills", path: "skills/mine", listed: false });
    const out = renderToStaticMarkup(pane);
    expect(out).toMatch(/class="pbb-confirm"[\s\S]*?skills\/mine is not listed in contents/);
    expect(calls().some((c) => c.url.startsWith("/api/playbooks/file?"))).toBe(false);
    drive(
      <RemoveConfirm dir={DIR} workspace="/ws" />,
      [RemoveConfirm],
      [(tree) => one(tree, "button", "pbb-confirm-go").props.onClick?.()],
    );
    for (let i = 0; i < 6; i++) await settle();
    const order = calls()
      .filter(
        (c) =>
          (c.url.startsWith("/api/playbooks/file?") && c.init?.method === "PUT") ||
          c.url === "/api/playbooks/remove-content",
      )
      .map((c) => c.url.replace(/\?.*/, ""));
    expect(order).toEqual(["/api/playbooks/file", "/api/playbooks/remove-content"]);
    const put = calls().find((c) => c.url.startsWith("/api/playbooks/file?") && c.init?.method === "PUT");
    expect(JSON.parse(String(put?.init?.body)).playbook.contents.skills).toEqual([
      "skills/spectropowers",
      "skills/mine",
    ]);
    const sent = calls().find((c) => c.url === "/api/playbooks/remove-content");
    expect(JSON.parse(String(sent?.init?.body))).toEqual({ dir: DIR, kind: "skills", path: "skills/mine" });
  });

  it("Remove on an entry on disk only stops when listing it is refused", async () => {
    await ready("skills");
    routes.push((u, init) =>
      u.startsWith("/api/playbooks/file?") && init?.method === "PUT"
        ? answer(400, {
            reason: "playbook-findings",
            message: "m",
            findings: [{ path: "contents.skills[1]", message: "no SKILL.md" }],
          })
        : undefined,
    );
    askRemove("skills", "skills/mine", false);
    drive(
      <RemoveConfirm dir={DIR} workspace="/ws" />,
      [RemoveConfirm],
      [(tree) => one(tree, "button", "pbb-confirm-go").props.onClick?.()],
    );
    for (let i = 0; i < 6; i++) await settle();
    expect(calls().some((c) => c.url === "/api/playbooks/remove-content")).toBe(false);
    expect(renderToStaticMarkup(pane)).toMatch(
      new RegExp(`class="pbb-refusal" role="alert">${dict["pbb.reason.playbook-findings"].en}<`),
    );
  });

  it("Workflows lists the files and says that running them comes later", async () => {
    await ready("workflows");
    const out = renderToStaticMarkup(pane);
    expect(out).toContain(dict["pbb.workflows.later"].en);
    expect(out).not.toContain('class="pbb-new"');
  });

  it("the parts a tab draws come from BundleTab.tsx", () => {
    expect(
      [BundleTab, KindTools, NewEntryForm, RemoveConfirm, SkillPicker].every((f) => typeof f === "function"),
    ).toBe(true);
  });
});

describe("Export and Import ZIP end every toolbar (criterion 5)", () => {
  it("on every tab, the Playbook tab and New included", async () => {
    await ready("playbook");
    for (const tab of PANE_TABS) {
      showFolder(DIR, tab.id);
      const out = renderToStaticMarkup(pane);
      const bar = out.match(/<div class="pb-toolbar"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
      const buttons = [...bar.matchAll(/<button[^>]*class="([^"]+)"[^>]*>([^<]*)</g)].map((m) => [
        m[1],
        m[2],
      ]);
      expect(buttons.slice(-2), tab.id).toEqual([
        ["pb-export", "Export"],
        ["pb-import", "Import ZIP"],
      ]);
    }
  });
});

describe("where the pane lands (criterion 6)", () => {
  it("after New playbook it shows the Skills tab of the new folder", async () => {
    routes.push((u) =>
      u.startsWith("/api/playbooks/bundled/spectro/copy")
        ? answer(200, { dir: "/pb/new", written: ["playbook.json"] })
        : undefined,
    );
    showFolder(DIR, "lyzr");
    chooseKind("playbook");
    choose({ playbookDir: "/pb/new" });
    const result = await generatePlaybook();
    expect(result.kind).toBe("written");
    expect(paneView()).toEqual({ tab: "skills", picked: "/pb/new" });
  });

  it("after Import ZIP it shows the Playbook tab of the imported folder", async () => {
    await ready("skills");
    const enc = new TextEncoder();
    await openBundle(
      new Blob([
        handZip([
          {
            name: "spectro/playbook.json",
            data: enc.encode(JSON.stringify({ schema_version: 1, id: "spectro", name: "spectro" })),
          },
        ]) as BlobPart,
      ]),
    );
    drive(
      pane,
      [PlaybookPane, BundleImport],
      [(tree) => one(tree, "button", "pb-bundle-pick").props.onClick?.()],
    );
    await settle();
    await settle();
    expect(paneView()).toEqual({ tab: "playbook", picked: "/picked/empty" });
  });
});

describe("light does not load the pane (criterion 7)", () => {
  it("the surface table keeps the playbook developer only, with its three chunks (card 554 adds the sheet)", () => {
    expect(SURFACES.playbook).toEqual({
      modes: { learn: "gone", light: "gone", developer: "open" },
      chunks: [
        "playbook/PlaybookPane.tsx",
        "playbook/spectrolyzr/SpectrolyzrPage.tsx",
        "playbook/PlaybookStartSheet.tsx",
      ],
    });
  });

  it("the bundle tabs live in the pane's chunk: no source but PlaybookPane.tsx imports BundleTab", () => {
    const src = fileURLToPath(new URL("..", import.meta.url));
    const sources: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const at = `${dir}/${name}`;
        if (statSync(at).isDirectory()) walk(at);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) sources.push(at.slice(src.length));
      }
    };
    walk(src.replace(/\/$/, ""));
    expect(sources.length).toBeGreaterThan(100);
    const importers = sources.filter((rel) =>
      /(?:from|import)\s*\(?\s*["'][^"']*\/BundleTab(?:\.tsx)?["']/.test(
        stripComments(read(`../${rel.replace(/^\//, "")}`, import.meta.url)),
      ),
    );
    expect(importers.map((r) => r.replace(/^\//, ""))).toEqual(["playbook/PlaybookPane.tsx"]);
  });

  it("every pbb key is read by the pane, its store or a reason family", () => {
    const code = ["./BundleTab.tsx", "./PlaybookPane.tsx", "../state/bundleEditor.ts"]
      .map((f) => stripComments(read(f, import.meta.url)))
      .join("\n");
    // Keys built from a code at run time: the entry state, the done notice and the refusal reason.
    const families = ["pbb.state.", "pbb.done.", "pbb.reason."];
    for (const f of families) expect(code, f).toContain("`" + f + "${");
    const unused = Object.keys(dict)
      .filter((k) => k.startsWith("pbb."))
      .filter((k) => !families.some((f) => k.startsWith(f)))
      .filter((k) => !code.includes(`"${k}"`));
    expect(unused).toEqual([]);
  });

  it("every new string has both languages", () => {
    const keys = Object.keys(dict).filter((k) => k.startsWith("pbb."));
    expect(keys.length).toBeGreaterThan(20);
    for (const k of keys) {
      expect(dict[k].en.trim(), k).not.toBe("");
      expect(dict[k].de.trim(), k).not.toBe("");
      expect(dict[k].en, k).not.toMatch(/[\u2013\u2014]/);
      expect(dict[k].de, k).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe("the pane's words after the humanizer and criticism passes (fix round 3)", () => {
  const pbb = Object.keys(dict).filter((k) => k.startsWith("pbb."));
  const both = (key: string): string[] => [dict[key].en, dict[key].de];

  it("no pane string names the loader or promises a release", () => {
    expect(pbb.length).toBeGreaterThan(80);
    for (const key of pbb) {
      for (const text of both(key)) {
        expect(text, key).not.toMatch(/loader|Lader/);
        expect(text, key).not.toMatch(/later release|späteren Release/i);
      }
    }
  });

  it("the workflows sentence says what is true today", () => {
    // Card 554 fix round 3: the pane starts nothing, a workflow starts from
    // the chat; the first tab is Steps.
    expect(dict["pbb.workflows.later"].en).toBe(
      "You can list and edit workflows here. To run one, type /playbook workflow and its name in the chat of a session.",
    );
    expect(dict["pbb.workflows.later"].de).toBe(
      "Hier kannst du Workflows aufführen und bearbeiten. Ausführen kannst du einen im Chat einer Session mit /playbook workflow und seinem Namen.",
    );
    for (const text of [dict["pbb.workflows.later"].en, dict["pbb.workflows.later"].de]) {
      expect(text).not.toMatch(/Playbook tab|Tab Playbook/);
    }
  });

  it("the refusals name who acts and use the verb of the button pressed", () => {
    expect(dict["pbb.reason.protected"].en).toMatch(/so the app does not delete them\.$/);
    expect(dict["pbb.reason.protected"].de).toMatch(/deshalb löscht die App sie nicht\.$/);
    expect(dict["pbb.reason.changed"].en).toMatch(/since you opened it\.$/);
    expect(dict["pbb.reason.changed"].de).toMatch(/seit du sie geöffnet hast\.$/);
    expect(dict["pbb.reason.own-route"].en).toMatch(/^Edit playbook\.json in the graph editor/);
    expect(dict["pbb.reason.own-route"].de).toMatch(/^playbook\.json bearbeitest du im Graph-Editor/);
    expect(dict["pbb.reason.taken"].en).toBe("The playbook already has a different skill with that name.");
    expect(dict["pbb.reason.taken"].de).toBe("Das Playbook hat schon einen anderen Skill mit diesem Namen.");
    expect(dict["pbb.reason.too-deep"].en).toBe(
      "The path lies deeper than six levels. The app reads a playbook to six levels only.",
    );
    expect(dict["pbb.reason.too-deep"].de).toBe(
      "Der Pfad liegt tiefer als sechs Ebenen. Die App liest ein Playbook nur bis zur sechsten Ebene.",
    );
  });

  it("the confirms and the hooks hint say who does what", () => {
    expect(dict["pbb.confirm.remove"].en).toBe(
      "Remove {path} from the playbook? This also deletes its files in the folder.",
    );
    expect(dict["pbb.confirm.remove"].de).toBe(
      "{path} aus dem Playbook entfernen? Das löscht auch seine Dateien im Ordner.",
    );
    expect(dict["pbb.confirm.removeUnlisted"].en).toBe(
      "{path} is not listed in contents. Remove it? The app lists it first, then deletes it and its files from the folder.",
    );
    expect(dict["pbb.confirm.removeUnlisted"].de).toBe(
      "{path} steht nicht in contents. Entfernen? Die App führt den Eintrag erst auf und löscht ihn dann mit seinen Dateien aus dem Ordner.",
    );
    expect(dict["pbb.hooks.hint"].en).toMatch(/^The import copies the hooks of your user settings/);
    expect(dict["pbb.hooks.hint"].de).toMatch(/^Der Import kopiert die Hooks deiner Benutzereinstellungen/);
  });
});
