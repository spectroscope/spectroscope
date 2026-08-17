// Card 249: the file viewer's tabs — shellTabs' sibling, keyed by PATH
// because a file's identity is its path: opening an open file focuses it.
// The consumer pins at the end exist because a pure fold nobody consults
// ships dead (the sessionRowDensity lesson, bitten again on card 247).

import { describe, expect, it } from "vitest";
import {
  MAX_FILE_TABS,
  closeAllFiles,
  closeFile,
  emptyFileTabs,
  fileTabLabel,
  openFile,
  selectFile,
  setFileView,
  sourceOffered,
} from "./fileTabs";
import { read, stripComments } from "../testkit/source";

const openMany = (paths: string[]) => paths.reduce((s, p) => openFile(s, p), emptyFileTabs());

describe("opening files as tabs", () => {
  it("opens, activates, and keeps earlier tabs", () => {
    const s = openMany(["a.md", "b.js"]);
    expect(s.tabs.map((t) => t.path)).toEqual(["a.md", "b.js"]);
    expect(s.active).toBe("b.js");
  });

  it("re-opening an open file focuses it instead of doubling it", () => {
    const s = openFile(openMany(["a.md", "b.js"]), "a.md");
    expect(s.tabs.map((t) => t.path)).toEqual(["a.md", "b.js"]);
    expect(s.active).toBe("a.md");
  });

  it("re-opening the active file is a no-op — the same object back", () => {
    const s = openMany(["a.md"]);
    expect(openFile(s, "a.md")).toBe(s);
  });

  it("at the cap the oldest inactive tab makes room", () => {
    const s = openFile(openMany(Array.from({ length: MAX_FILE_TABS }, (_, i) => `f${i}.ts`)), "new.ts");
    expect(s.tabs).toHaveLength(MAX_FILE_TABS);
    expect(s.tabs.some((t) => t.path === "f0.ts")).toBe(false);
    expect(s.active).toBe("new.ts");
  });
});

describe("closing", () => {
  it("closing the active tab moves right, then left, then empty", () => {
    const s = openMany(["a.md", "b.js", "c.py"]);
    const atB = selectFile(s, "b.js");
    const closedB = closeFile(atB, "b.js");
    expect(closedB.active).toBe("c.py");
    const closedC = closeFile(closedB, "c.py");
    expect(closedC.active).toBe("a.md");
    expect(closeFile(closedC, "a.md").active).toBeNull();
  });

  it("closing an inactive tab keeps the active one", () => {
    const s = closeFile(openMany(["a.md", "b.js"]), "a.md");
    expect(s.active).toBe("b.js");
  });

  it("close-all empties the viewer, and is a no-op when already empty", () => {
    const s = openMany(["a.md", "b.js"]);
    expect(closeAllFiles(s).tabs).toEqual([]);
    const empty = emptyFileTabs();
    expect(closeAllFiles(empty)).toBe(empty);
  });
});

describe("the per-tab reading", () => {
  it("defaults to rendered and toggles per tab, not globally", () => {
    const s = setFileView(openMany(["a.html", "b.md"]), "a.html", "source");
    expect(s.tabs.find((t) => t.path === "a.html")?.view).toBe("source");
    expect(s.tabs.find((t) => t.path === "b.md")?.view).toBe("rendered");
  });

  it("setting the view a tab already has returns the same object", () => {
    const s = openMany(["a.html"]);
    expect(setFileView(s, "a.html", "rendered")).toBe(s);
  });

  it("offers source wherever a source READS differently — never for binary images", () => {
    expect(sourceOffered("index.html")).toBe(true);
    expect(sourceOffered("README.md")).toBe(true);
    expect(sourceOffered("logo.svg")).toBe(true);
    expect(sourceOffered("app.js")).toBe(true);
    expect(sourceOffered("photo.png")).toBe(false);
  });

  it("labels a tab by its basename", () => {
    expect(fileTabLabel({ path: "deep/dir/index.html", view: "rendered" })).toBe("index.html");
    expect(fileTabLabel({ path: "flat.md", view: "rendered" })).toBe("flat.md");
  });
});

describe("the consumers — the fold is consulted, not just exported", () => {
  const tab = stripComments(read("./WorkspaceTab.tsx", import.meta.url));

  it("the tree opens tabs and the strip closes them", () => {
    expect(tab).toContain("openFile(");
    expect(tab).toContain("closeFile(");
    expect(tab).toContain("setFiles(closeAllFiles)");
    expect(tab).toContain('"ws-tabs"');
  });

  it("the source reading reaches the pane", () => {
    expect(tab).toContain("<SourceView");
    expect(tab).toContain("sourceOffered(");
  });
});
