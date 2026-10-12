// Card 525, criterion 2: one file browser for the Files panel and the
// playbook pane. The rows are the Files panel's own (Tree), lifted out of
// WorkspaceTab.tsx; FileBrowser adds the keyboard of the Spectrolyzr tree and
// opens the selected file. The suite has no DOM: rows are rendered on the
// server renderer and pressed through the drive kit.

import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drive, type El } from "../testkit/driveComponent";
import { read } from "../testkit/source";
import { FileBrowser, moveAmong, Tree, visibleFiles, type FileNode } from "./FileBrowser";

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

const NODES: FileNode[] = [
  folder("skills/spectropowers", [
    folder("skills/spectropowers/brainstorming", [file("skills/spectropowers/brainstorming/SKILL.md")]),
    file("skills/spectropowers/README.md"),
  ]),
  file("skills/notes.md"),
];

describe("the shared tree", () => {
  it("is the one the Files panel draws: WorkspaceTab imports it and keeps no tree of its own", () => {
    const tab = read("./WorkspaceTab.tsx", import.meta.url);
    expect(tab).toMatch(/import \{[^}]*\bTree\b[^}]*\} from "\.\/FileBrowser"/);
    expect(tab).not.toMatch(/function Tree\(/);
    expect(tab).not.toMatch(/interface FileNode/);
  });

  it("is the one the playbook pane draws", () => {
    const pane = read("../playbook/BundleTab.tsx", import.meta.url);
    expect(pane).toMatch(/from "\.\.\/workspace\/FileBrowser"/);
    expect(pane).toMatch(/<FileBrowser\b/);
  });

  it("draws the Files panel's rows: a caret per folder, a size per file", () => {
    const out = renderToStaticMarkup(
      <Tree
        nodes={NODES}
        depth={0}
        open={new Set(["skills/spectropowers"])}
        onToggle={() => {}}
        selected={null}
        onSelect={() => {}}
      />,
    );
    expect(out).toContain('class="ws-row"');
    expect(out).toContain(">brainstorming<");
    expect(out).toContain(">README.md<");
    expect(out).not.toContain(">SKILL.md<");
  });
});

describe("FileBrowser", () => {
  it("opens the top folders and keeps the deeper ones shut until pressed", () => {
    const out = renderToStaticMarkup(
      <FileBrowser nodes={NODES} selected={null} onSelect={() => {}} label="t" />,
    );
    expect(out).toMatch(/role="tree"/);
    expect(out).toContain(">brainstorming<");
    expect(out).not.toContain(">SKILL.md<");
  });

  it("a folder collapses and opens on a press", () => {
    const rowNamed =
      (name: string) =>
      (tree: El[]): void => {
        const row = tree.find(
          (el) => el.type === "button" && renderToStaticMarkup(el).includes(`class="ws-row-name">${name}<`),
        );
        if (row === undefined) throw new Error(`no row ${name}`);
        row.props.onClick?.();
      };
    const open = drive(
      <FileBrowser nodes={NODES} selected={null} onSelect={() => {}} label="t" />,
      [FileBrowser, Tree],
      [rowNamed("brainstorming")],
    );
    expect(
      open.some(
        (el) => el.type === "button" && el.props.title === "skills/spectropowers/brainstorming/SKILL.md",
      ),
    ).toBe(true);
    const shut = drive(
      <FileBrowser nodes={NODES} selected={null} onSelect={() => {}} label="t" />,
      [FileBrowser, Tree],
      [rowNamed("spectropowers")],
    );
    expect(
      shut.some((el) => el.type === "button" && el.props.title === "skills/spectropowers/brainstorming"),
    ).toBe(false);
  });

  it("a pressed file is handed to onSelect", () => {
    const picked: string[] = [];
    drive(
      <FileBrowser nodes={NODES} selected={null} onSelect={(n) => picked.push(n.path)} label="t" />,
      [FileBrowser, Tree],
      [(tree) => tree.find((el) => el.props.title === "skills/notes.md")?.props.onClick?.()],
    );
    expect(picked).toEqual(["skills/notes.md"]);
  });

  it("the arrow keys, Home and End move over the visible files and open the one they reach", () => {
    const picked: string[] = [];
    const press =
      (key: string) =>
      (tree: El[]): void => {
        const box = tree.find((el) => el.props.role === "tree");
        // The key lands on the box itself, as when the tree has the focus.
        const self = { querySelector: () => null };
        (box?.props.onKeyDown as (e: unknown) => void)({
          key,
          preventDefault: () => {},
          target: self,
          currentTarget: self,
        });
      };
    drive(
      <FileBrowser
        nodes={NODES}
        selected="skills/spectropowers/README.md"
        onSelect={(n) => picked.push(n.path)}
        label="t"
      />,
      [FileBrowser, Tree],
      [press("ArrowDown"), press("End"), press("Enter")],
    );
    drive(
      <FileBrowser
        nodes={NODES}
        selected="skills/notes.md"
        onSelect={(n) => picked.push(n.path)}
        label="t"
      />,
      [FileBrowser, Tree],
      [press("Home")],
    );
    expect(picked).toEqual(["skills/notes.md", "skills/notes.md", "skills/spectropowers/README.md"]);
  });
});

describe("a file the keys may not open", () => {
  const press =
    (key: string) =>
    (tree: El[]): void => {
      const box = tree.find((el) => el.props.role === "tree");
      // The key lands on the box itself, as when the tree has the focus.
      const self = { querySelector: () => null };
      (box?.props.onKeyDown as (e: unknown) => void)({
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

  it("is selected by the arrows without being handed to onSelect, and opened by Enter", () => {
    const picked: string[] = [];
    const seen: string[][] = [];
    drive(
      <FileBrowser
        nodes={NODES}
        selected="skills/spectropowers/README.md"
        onSelect={(n) => picked.push(n.path)}
        openOnMove={(n) => n.path !== "skills/notes.md"}
        label="t"
      />,
      [FileBrowser, Tree],
      [
        press("ArrowDown"),
        (tree) => {
          seen.push(selectedRow(tree));
          expect(picked).toEqual([]);
          press("Enter")(tree);
        },
      ],
    );
    expect(seen).toEqual([["skills/notes.md"]]);
    expect(picked).toEqual(["skills/notes.md"]);
  });

  it("the arrows step back from it to the open file without opening that again", () => {
    const picked: string[] = [];
    const seen: string[][] = [];
    drive(
      <FileBrowser
        nodes={NODES}
        selected="skills/spectropowers/README.md"
        onSelect={(n) => picked.push(n.path)}
        openOnMove={(n) => n.path !== "skills/notes.md"}
        label="t"
      />,
      [FileBrowser, Tree],
      [
        press("ArrowDown"),
        press("ArrowUp"),
        (tree) => {
          seen.push(selectedRow(tree));
        },
      ],
    );
    expect(seen).toEqual([["skills/spectropowers/README.md"]]);
    expect(picked).toEqual([]);
  });

  it("the arrows still open every other file they reach, and Enter on the open file does nothing", () => {
    const picked: string[] = [];
    drive(
      <FileBrowser
        nodes={NODES}
        selected="skills/notes.md"
        onSelect={(n) => picked.push(n.path)}
        openOnMove={(n) => n.path !== "skills/notes.md"}
        label="t"
      />,
      [FileBrowser, Tree],
      [press("ArrowUp"), press("Enter")],
    );
    expect(picked).toEqual(["skills/spectropowers/README.md"]);
  });
});

describe("the keyboard rule, pure", () => {
  it("lists the files a reader sees, in order, and none inside a shut folder", () => {
    expect(visibleFiles(NODES, new Set(["skills/spectropowers"]))).toEqual([
      "skills/spectropowers/README.md",
      "skills/notes.md",
    ]);
    expect(
      visibleFiles(NODES, new Set(["skills/spectropowers", "skills/spectropowers/brainstorming"])),
    ).toEqual([
      "skills/spectropowers/brainstorming/SKILL.md",
      "skills/spectropowers/README.md",
      "skills/notes.md",
    ]);
  });

  it("steps and stops at the ends, as the Spectrolyzr tree does", () => {
    const files = ["a", "b", "c"];
    expect(moveAmong(files, null, "ArrowDown")).toBe("a");
    expect(moveAmong(files, "a", "ArrowDown")).toBe("b");
    expect(moveAmong(files, "c", "ArrowDown")).toBe("c");
    expect(moveAmong(files, "a", "ArrowUp")).toBe("a");
    expect(moveAmong(files, "b", "End")).toBe("c");
    expect(moveAmong(files, "c", "Home")).toBe("a");
    expect(moveAmong(files, "b", "x")).toBe("b");
    expect(moveAmong([], "b", "ArrowDown")).toBe("b");
  });
});

describe("the tree roles", () => {
  it("FileBrowser's rows are tree items: level, expanded on folders, selected on files", () => {
    const out = renderToStaticMarkup(
      <FileBrowser nodes={NODES} selected="skills/notes.md" onSelect={() => {}} label="t" />,
    );
    expect(out).toMatch(/<div[^>]*role="tree"/);
    const rows = [...out.matchAll(/<button[^>]*class="ws-row[^"]*"[^>]*>/g)].map((m) => m[0]);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toContain('role="treeitem"');
    const folderRow = rows.find((r) => r.includes('title="skills/spectropowers"')) ?? "";
    expect(folderRow).toContain('aria-level="1"');
    expect(folderRow).toContain('aria-expanded="true"');
    const deeper = rows.find((r) => r.includes('title="skills/spectropowers/brainstorming"')) ?? "";
    expect(deeper).toContain('aria-level="2"');
    expect(deeper).toContain('aria-expanded="false"');
    const picked = rows.find((r) => r.includes('title="skills/notes.md"')) ?? "";
    expect(picked).toContain('aria-selected="true"');
    expect(picked).not.toContain("aria-expanded");
    const other = rows.find((r) => r.includes('title="skills/spectropowers/README.md"')) ?? "";
    expect(other).toContain('aria-selected="false"');
    // The wrapper of each row and its children carries no role of its own.
    expect(out).not.toMatch(/<div>/);
  });

  it("the Files panel's rows keep their markup: no role on a row", () => {
    const out = renderToStaticMarkup(
      <Tree
        nodes={NODES}
        depth={0}
        open={new Set(["skills/spectropowers"])}
        onToggle={() => {}}
        selected={null}
        onSelect={() => {}}
      />,
    );
    expect(out).not.toContain("role=");
    expect(out).not.toMatch(/aria-(level|expanded|selected)/);
    expect(out.startsWith("<div><button")).toBe(true);
  });
});

describe("a parked file and the focused row (fix round 3)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A key on the box, or on a row button inside it; prevented says whether the handler took it.
  const key =
    (
      name: string,
      on: "box" | "row",
      log: { prevented: number },
      box: object = { querySelector: () => null },
    ) =>
    (tree: El[]): void => {
      const el = tree.find((e) => e.props.role === "tree");
      (el?.props.onKeyDown as (e: unknown) => void)({
        key: name,
        preventDefault: () => {
          log.prevented += 1;
        },
        target: on === "box" ? box : { tagName: "BUTTON" },
        currentTarget: box,
      });
    };
  const selectedRow = (tree: El[]): string[] =>
    tree
      .filter((el) => el.props.role === "treeitem" && el.props["aria-selected"] === true)
      .map((el) => String(el.props.title));
  const parkOnNotes = { openOnMove: (n: FileNode) => n.path !== "skills/notes.md" };

  it("Enter on a focused row button is left to that row and never opens the parked file", () => {
    const picked: string[] = [];
    const log = { prevented: 0 };
    drive(
      <FileBrowser
        nodes={NODES}
        selected="skills/spectropowers/README.md"
        onSelect={(n) => picked.push(n.path)}
        {...parkOnNotes}
        label="t"
      />,
      [FileBrowser, Tree],
      [key("ArrowDown", "box", log), key("Enter", "row", log)],
    );
    expect(picked).toEqual([]);
    expect(log.prevented).toBe(1);
  });

  it("Enter on the box still opens the parked file", () => {
    const picked: string[] = [];
    const log = { prevented: 0 };
    drive(
      <FileBrowser
        nodes={NODES}
        selected="skills/spectropowers/README.md"
        onSelect={(n) => picked.push(n.path)}
        {...parkOnNotes}
        label="t"
      />,
      [FileBrowser, Tree],
      [key("ArrowDown", "box", log), key("Enter", "box", log)],
    );
    expect(picked).toEqual(["skills/notes.md"]);
    expect(log.prevented).toBe(2);
  });

  it("a press on a folder clears the parked file", () => {
    const seen: string[][] = [];
    const log = { prevented: 0 };
    drive(
      <FileBrowser
        nodes={NODES}
        selected="skills/spectropowers/README.md"
        onSelect={() => {}}
        {...parkOnNotes}
        label="t"
      />,
      [FileBrowser, Tree],
      [
        key("ArrowDown", "box", log),
        (tree) => {
          seen.push(selectedRow(tree));
          tree.find((el) => el.props.title === "skills/spectropowers/brainstorming")?.props.onClick?.();
        },
        (tree) => {
          seen.push(selectedRow(tree));
        },
      ],
    );
    expect(seen).toEqual([["skills/notes.md"], ["skills/spectropowers/README.md"]]);
  });

  it("a change of the open file clears the parked file, also when the old one comes back", () => {
    const seen: string[][] = [];
    const log = { prevented: 0 };
    let setOpenFile: (path: string | null) => void = () => {};
    function Host() {
      const [openFile, set] = useState<string | null>("skills/spectropowers/README.md");
      setOpenFile = set;
      return <FileBrowser nodes={NODES} selected={openFile} onSelect={() => {}} {...parkOnNotes} label="t" />;
    }
    drive(
      <Host />,
      [Host, FileBrowser, Tree],
      [
        key("ArrowDown", "box", log),
        (tree) => {
          seen.push(selectedRow(tree));
          setOpenFile(null);
        },
        (tree) => {
          seen.push(selectedRow(tree));
          setOpenFile("skills/spectropowers/README.md");
        },
        (tree) => {
          seen.push(selectedRow(tree));
        },
      ],
    );
    expect(seen).toEqual([["skills/notes.md"], [], ["skills/spectropowers/README.md"]]);
  });

  it("the focus follows the keys from a row to the row they reach, and stays on the box otherwise", () => {
    vi.stubGlobal("requestAnimationFrame", (run: (t: number) => void) => {
      run(0);
      return 0;
    });
    const focused: string[] = [];
    const row = { scrollIntoView: () => {}, focus: () => focused.push("row") };
    const box = { querySelector: (sel: string) => (sel === ".ws-row--active" ? row : null) };
    const log = { prevented: 0 };
    drive(
      <FileBrowser
        nodes={NODES}
        selected="skills/spectropowers/README.md"
        onSelect={() => {}}
        {...parkOnNotes}
        label="t"
      />,
      [FileBrowser, Tree],
      [key("ArrowDown", "box", log, box), key("ArrowUp", "row", log, box)],
    );
    expect(focused).toEqual(["row"]);
  });
});
