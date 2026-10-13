// Card 483, Task 10: the connected panels read the store's draft, switch
// between selection, documents and checks, and show the validator's findings.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dict } from "../../../i18n/i18n";
import {
  __resetPlaybookEditor,
  __setEditorSeams,
  openEditor,
  select,
  type EditorViewWire,
} from "../../../state/playbookEditor";
import { __resetPlaybookContents, loadContents, type ContentsPreview } from "../../../state/playbookContents";
import type { PlaybookDoc } from "../doc";
import { EditorPanels } from "./EditorPanels";

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

const VIEW = {
  loaded: {
    playbook: null,
    topology: null,
    findings: [{ path: "nodes[0].goal", message: "goal is empty" }],
    steps: [],
    dir: "/pb",
  },
  document: DOC,
  diskHash: "h0",
  canonical: true,
  editable: true,
  outcomes: { write: [""], done: [] },
  choices: [],
} as unknown as EditorViewWire;

beforeEach(() => {
  __setEditorSeams({
    fetch: vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(VIEW) }) as never,
  });
});
afterEach(() => {
  __resetPlaybookEditor();
  __resetPlaybookContents();
  vi.unstubAllGlobals();
});

/** The contents route's answer for a folder that holds one skill. */
function folderWithSkill(dir: string, name: string): ContentsPreview {
  return {
    playbook: "tiny",
    dir,
    contentsHash: "c0",
    items: [
      {
        kind: "skill",
        name,
        source: `skills/${name.replace(":", "/")}`,
        sha256: "0".repeat(64),
        state: "in-playbook",
        scope: "sessions",
        bytes: 1,
        target: null,
        command: null,
        files: [],
      },
    ],
    promptChars: 0,
    hooksOrigin: null,
    findings: [],
  };
}

async function readContents(preview: ContentsPreview): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(preview) }),
  );
  await loadContents(preview.dir, null);
}

describe("the connected panels", () => {
  it("render nothing while no draft is open", () => {
    expect(renderToStaticMarkup(<EditorPanels />)).toBe("");
  });

  it("show the three tabs, the selection panel and the findings of the open draft", async () => {
    await openEditor("/pb", null);
    const html = renderToStaticMarkup(<EditorPanels />);
    for (const k of ["selection", "documents", "checks"]) expect(html).toContain(dict[`pbe.tab.${k}`].en);
    expect(html).toContain(dict["pbe.nothingSelected"].en);
    expect(html).toContain("goal is empty");
  });

  it("show the fields of the selected node", async () => {
    await openEditor("/pb", null);
    select({ kind: "node", id: "write" });
    const html = renderToStaticMarkup(<EditorPanels />);
    expect(html).toContain('data-field="goal"');
    expect(html).not.toContain(dict["pbe.nothingSelected"].en);
  });

  // Card 558: the step's skill options come from the folder the editor has
  // open, read from the contents list, never from this machine's installed skills.
  it("offer the skills of the open folder's contents, marked in the playbook", async () => {
    await readContents(folderWithSkill("/pb", "tiny:review"));
    await openEditor("/pb", null);
    select({ kind: "node", id: "write" });
    const html = renderToStaticMarkup(<EditorPanels />);
    const from = html.indexOf('data-option="tiny:review"');
    expect(from).toBeGreaterThan(-1);
    expect(html.slice(from, html.indexOf("</li>", from))).toContain(
      `<span class="pbe-note"> ${dict["pb.run.skillPlaybook"].en}</span>`,
    );
  });

  it("offer no skill of another folder's contents", async () => {
    await readContents(folderWithSkill("/other", "other:review"));
    await openEditor("/pb", null);
    select({ kind: "node", id: "write" });
    const html = renderToStaticMarkup(<EditorPanels />);
    expect(html).toContain('data-field="skills"');
    expect(html).not.toContain('data-option="other:review"');
  });
});
