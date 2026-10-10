// Card 484, Task 11: the file tree of the review step. Files grouped by root
// (project, then playbook) and then by folder; folders collapse; the arrow keys
// move the selection over the files that are visible. The collapse and the key
// handling are pure functions the component calls, so they are pinned here
// directly; the markup is read through a static render.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LyzrFile } from "../../state/spectrolyzr";
import { FileTree, fileKey, moveSelection, treeRows, type TreeRow } from "./FileTree";

function file(root: "project" | "playbook", path: string): LyzrFile {
  return { root, path, why: { en: `why ${path}`, de: `warum ${path}` }, size: 1, content: "x" };
}

const PROJECT = [
  file("project", "README.md"),
  file("project", "src/app.ts"),
  file("project", "src/util/greet.ts"),
];
const BOTH = [...PROJECT, file("playbook", "playbook.json"), file("playbook", "skills/s/SKILL.md")];

/** The open state of a folder row, or undefined when the key names no folder. */
const expandedOf = (rows: TreeRow[], key: string): boolean | undefined => {
  const row = rows.find((r) => r.key === key);
  return row?.kind === "folder" ? row.expanded : undefined;
};

const fileKeys = (rows: ReturnType<typeof treeRows>): string[] =>
  rows.filter((r) => r.kind === "file").map((r) => r.key);

describe("the roots", () => {
  it("draws two roots when a playbook file exists", () => {
    const out = renderToStaticMarkup(<FileTree files={BOTH} selected={null} onSelect={() => {}} />);
    expect([...out.matchAll(/class="lyzr-root"/g)].length).toBe(2);
    expect(out).toContain("playbook.json");
    expect(out).toContain("SKILL.md");
  });

  it("draws one root without the playbook", () => {
    const out = renderToStaticMarkup(<FileTree files={PROJECT} selected={null} onSelect={() => {}} />);
    expect([...out.matchAll(/class="lyzr-root"/g)].length).toBe(1);
  });

  it("marks the selected file", () => {
    const out = renderToStaticMarkup(
      <FileTree files={BOTH} selected={fileKey(BOTH[1])} onSelect={() => {}} />,
    );
    expect(out).toMatch(/aria-selected="true"[^>]*>[\s\S]*?app\.ts/);
    expect([...out.matchAll(/aria-selected="true"/g)].length).toBe(1);
  });
});

describe("folders", () => {
  it("list folders before files, the project root before the playbook root", () => {
    const keys = fileKeys(treeRows(BOTH, new Set()));
    expect(keys).toEqual([
      "project:src/util/greet.ts",
      "project:src/app.ts",
      "project:README.md",
      "playbook:skills/s/SKILL.md",
      "playbook:playbook.json",
    ]);
  });

  it("collapse and hide what they hold", () => {
    const open = treeRows(BOTH, new Set());
    expect(fileKeys(open)).toContain("project:src/app.ts");
    expect(expandedOf(open, "project:src/")).toBe(true);

    const shut = treeRows(BOTH, new Set(["project:src/"]));
    expect(fileKeys(shut)).not.toContain("project:src/app.ts");
    expect(fileKeys(shut)).not.toContain("project:src/util/greet.ts");
    expect(fileKeys(shut)).toContain("project:README.md");
    expect(expandedOf(shut, "project:src/")).toBe(false);
    expect(shut.find((r) => r.key === "project:src/util/")).toBeUndefined();
  });
});

describe("the arrow keys", () => {
  const rows = treeRows(BOTH, new Set());
  const keys = fileKeys(rows);

  it("move the selection down and up over the files", () => {
    expect(moveSelection(rows, keys[0], "ArrowDown")).toBe(keys[1]);
    expect(moveSelection(rows, keys[1], "ArrowUp")).toBe(keys[0]);
  });

  it("stop at the ends and jump with Home and End", () => {
    expect(moveSelection(rows, keys[0], "ArrowUp")).toBe(keys[0]);
    expect(moveSelection(rows, keys[keys.length - 1], "ArrowDown")).toBe(keys[keys.length - 1]);
    expect(moveSelection(rows, keys[2], "Home")).toBe(keys[0]);
    expect(moveSelection(rows, keys[0], "End")).toBe(keys[keys.length - 1]);
  });

  it("start at the first file when nothing is selected", () => {
    expect(moveSelection(rows, null, "ArrowDown")).toBe(keys[0]);
  });

  it("skip the files of a collapsed folder", () => {
    const shut = treeRows(BOTH, new Set(["project:src/"]));
    expect(moveSelection(shut, "project:README.md", "ArrowUp")).toBe("project:README.md");
    expect(moveSelection(shut, "project:README.md", "ArrowDown")).toBe("playbook:skills/s/SKILL.md");
  });

  it("ignore any other key", () => {
    expect(moveSelection(rows, keys[1], "a")).toBe(keys[1]);
  });
});
