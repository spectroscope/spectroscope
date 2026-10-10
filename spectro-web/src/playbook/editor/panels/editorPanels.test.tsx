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
afterEach(() => __resetPlaybookEditor());

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
});
