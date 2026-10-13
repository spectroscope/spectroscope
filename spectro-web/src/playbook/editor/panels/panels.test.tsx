// Card 483, Task 10: the panels of the playbook editor, rendered statically
// (no React Flow inside). Each negative case has a positive twin.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { dict } from "../../../i18n/i18n";
import type { Command } from "../commands";
import type { PlaybookDoc, Selection } from "../doc";
import { ChecksPanel } from "./ChecksPanel";
import { DocumentsPanel } from "./DocumentsPanel";
import { FindingsList } from "./FindingsList";
import { SelectionPanel, type SelectionPanelProps } from "./SelectionPanel";

const MINIMAL: PlaybookDoc = {
  schema_version: 1,
  id: "p",
  name: "P",
  description: "d",
  models: { fast: { primary: { provider: "ollama", model: "qwen3:8b" }, fallbacks: [] } },
  documents: {
    spec: { name: "Spec", purpose: "design", location: "docs/{slug}.md", sections: ["Goal", "Scope"] },
    plan: { name: "Plan", purpose: "tasks", location: "docs/plan.md", template: "plan.md", sections: [] },
  },
  checks: {
    spec_ok: { kind: "sections", documents: ["spec"], forbid: ["TBD"] },
    tests_green: { kind: "command", run: "make test" },
  },
  vars: { test: "make test" },
  start: "write",
  nodes: [
    {
      kind: "step",
      id: "write",
      name: "Write",
      performer: "chat",
      skills: ["a:one", "a:gone"],
      model: "fast",
      privacy: "cheap",
      permission: "inherit",
      consumes: [],
      produces: ["spec"],
      nod: false,
    },
    { kind: "decision", id: "ok", name: "Spec ok", check: "spec_ok", max_rounds: 2 },
    { kind: "end", id: "done", result: "done" },
  ],
  arrows: [
    { from: "write", to: "ok" },
    { from: "ok", to: "done", on: "pass" },
    { from: "ok", to: "write", on: "fail" },
    { from: "ok", to: "done", on: "exhausted" },
  ],
  contents: { skills: ["x"], agents: [], hooks: [], commands: [], workflows: [] },
};

const CHILD: PlaybookDoc = {
  ...MINIMAL,
  nodes: MINIMAL.nodes.map((n) =>
    n.id === "write" && n.kind === "step" ? { ...n, performer: "child", role: "builder" } : n,
  ),
};

const CHOICES = [{ choice: "fast", provider: "ollama", model: "qwen3:8b", state: "ready", reason: null }];
// Card 558: the skills the playbook folder holds, as the contents list names
// them, and the server's resolution of the step's named skills (the source of
// the Steps table). a:gone is named, and the folder does not hold it.
const FOLDER_SKILLS = ["a:one", "a:two"];
const STEPS: SelectionPanelProps["steps"] = [
  {
    id: "write",
    skills: [
      { name: "a:one", installed: false, disabled: false, inPlaybook: true },
      { name: "a:gone", installed: true, disabled: false, inPlaybook: false },
    ],
    model: null,
  },
];

function panel(doc: PlaybookDoc, selection: Selection, extra: Partial<SelectionPanelProps> = {}): string {
  const calls: Command[] = [];
  return renderToStaticMarkup(
    <SelectionPanel
      doc={doc}
      selection={selection}
      choices={CHOICES}
      folderSkills={FOLDER_SKILLS}
      steps={STEPS}
      refused={null}
      dispatch={(c) => calls.push(c)}
      {...extra}
    />,
  );
}

const rootClass = (html: string): string => /^<[a-z]+ class="([^"]*)"/.exec(html)?.[1] ?? "";
const count = (html: string, needle: string): number => html.split(needle).length - 1;

describe("the selection panel for a step", () => {
  const html = panel(MINIMAL, { kind: "node", id: "write" });

  it("is a nokey root, so Delete in a field never deletes the node", () => {
    expect(rootClass(html).split(" ")).toContain("nokey");
  });

  it("renders every field of a chat step with its English label", () => {
    for (const f of [
      "id",
      "name",
      "goal",
      "performer",
      "skills",
      "model",
      "privacy",
      "permission",
      "consumes",
      "produces",
      "nod",
    ]) {
      expect(html, f).toContain(`data-field="${f}"`);
      expect(html, f).toContain(dict[`pbe.field.${f}`].en);
    }
  });

  it("shows the role field for a child step and not for a chat step", () => {
    expect(html).not.toContain('data-field="role"');
    const child = panel(CHILD, { kind: "node", id: "write" });
    expect(child).toContain('data-field="role"');
    expect(child).toContain('value="builder"');
  });

  // Card 558: a run reads a step's skills from the playbook folder in place,
  // so the panel offers the folder's skills and marks each one as the Steps
  // table does; whether this machine has a copy installed plays no part.
  it("offers the folder's skills, marks each in the playbook or missing in the playbook, and checks the step's own", () => {
    const option = (out: string, name: string): string => {
      const from = out.indexOf(`data-option="${name}"`);
      expect(from, name).toBeGreaterThan(-1);
      return out.slice(from, out.indexOf("</li>", from));
    };
    const note = (key: string): string => `<span class="pbe-note"> ${dict[key].en}</span>`;
    expect(count(html, 'data-option="a:one"')).toBe(1);
    expect(option(html, "a:one")).toContain(note("pb.run.skillPlaybook"));
    expect(option(html, "a:two")).toContain(note("pb.run.skillPlaybook"));
    expect(option(html, "a:gone")).toContain(note("pb.run.skillMissing"));
    expect(html).not.toContain(dict["pb.notInstalled"].en);
    expect(/data-option="a:one"[^>]*checked/.test(html) || /checked[^>]*data-option="a:one"/.test(html)).toBe(
      true,
    );
    expect(/data-option="a:two"[^>]*checked/.test(html) || /checked[^>]*data-option="a:two"/.test(html)).toBe(
      false,
    );

    // A bare name the folder holds under a pack: the server's resolution says so.
    const bare: PlaybookDoc = {
      ...MINIMAL,
      nodes: MINIMAL.nodes.map((n) =>
        n.id === "write" && n.kind === "step" ? { ...n, skills: ["one"] } : n,
      ),
    };
    const resolved = panel(
      bare,
      { kind: "node", id: "write" },
      {
        steps: [
          {
            id: "write",
            skills: [{ name: "one", installed: false, disabled: false, inPlaybook: true }],
            model: null,
          },
        ],
      },
    );
    expect(option(resolved, "one")).toContain(note("pb.run.skillPlaybook"));
    // Without a resolution and outside the folder's list, the skill is missing.
    const unresolved = panel(bare, { kind: "node", id: "write" }, { steps: [] });
    expect(option(unresolved, "one")).toContain(note("pb.run.skillMissing"));
  });

  it("shows the chosen model's provider state", () => {
    expect(html).toContain("ollama: ready");
  });

  it("states the privacy options in words", () => {
    expect(html).toContain(dict["pbe.privacy.private"].en);
    expect(html).toContain(dict["pbe.privacy.cheap"].en);
  });

  it("offers a start button for a node that is not the start and the sentence for the one that is", () => {
    const other = panel(MINIMAL, { kind: "node", id: "ok" });
    expect(other).toContain(dict["pbe.startHere"].en);
    expect(html).toContain(dict["pbe.isStart"].en);
    expect(html).not.toContain(dict["pbe.startHere"].en);
  });
});

describe("the selection panel for a decision", () => {
  const html = panel(MINIMAL, { kind: "node", id: "ok" });

  it("renders three outcome rows, the check's labels as placeholders plus exhausted", () => {
    expect(count(html, "data-outcome-row")).toBe(3);
    expect(html).toContain('placeholder="pass"');
    expect(html).toContain('placeholder="fail"');
    expect(html).toContain('value="exhausted"');
  });

  it("renders declared outcomes as values with a remove button each", () => {
    const declared: PlaybookDoc = {
      ...MINIMAL,
      nodes: MINIMAL.nodes.map((n) =>
        n.id === "ok" && n.kind === "decision" ? { ...n, outcomes: ["pass", "fail"] } : n,
      ),
    };
    const out = panel(declared, { kind: "node", id: "ok" });
    expect(count(out, "data-outcome-row")).toBe(3);
    expect(out).toContain('value="pass"');
    expect(count(out, `>${dict["pbe.remove"].en}<`)).toBe(2);
  });

  it("offers the check, max rounds and the name", () => {
    for (const f of ["id", "name", "check", "outcomes", "maxRounds"])
      expect(html, f).toContain(`data-field="${f}"`);
    expect(html).toContain('value="2"');
    expect(html).toContain('<option value="spec_ok" selected');
  });
});

describe("the selection panel for an end and an arrow", () => {
  it("edits the result of an end", () => {
    const html = panel(MINIMAL, { kind: "node", id: "done" });
    expect(html).toContain('data-field="result"');
    expect(html).toContain('value="done"');
  });

  it("offers an arrow only its free outcomes and every node as the target", () => {
    const html = panel(MINIMAL, { kind: "arrow", key: "ok|fail" });
    expect(html).toContain('<option value="fail" selected');
    expect(html).not.toContain('<option value="pass"');
    for (const id of ["write", "ok", "done"]) expect(html).toContain(`<option value="${id}"`);
    expect(rootClass(html).split(" ")).toContain("nokey");
  });

  it("asks for a selection when there is none, and shows a refusal by its key", () => {
    expect(panel(MINIMAL, null)).toContain(dict["pbe.nothingSelected"].en);
    const taken = panel(MINIMAL, { kind: "node", id: "write" }, { refused: "pbe.renameTaken" });
    expect(taken).toContain(dict["pbe.renameTaken"].en);
    expect(panel(MINIMAL, { kind: "node", id: "write" })).not.toContain(dict["pbe.renameTaken"].en);
  });
});

describe("the documents panel", () => {
  const html = renderToStaticMarkup(<DocumentsPanel doc={MINIMAL} refused={null} dispatch={() => {}} />);

  it("renders one row per document type with its fields", () => {
    expect(count(html, "data-document=")).toBe(2);
    expect(html).toContain('data-document="spec"');
    expect(html).toContain('data-document="plan"');
    for (const f of ["name", "purpose", "location", "template", "sections"])
      expect(html, f).toContain(`data-field="${f}"`);
    expect(html).toContain(dict["pbe.add"].en);
  });

  it("shows the models, vars and contents read only, with the sentence that says so", () => {
    expect(rootClass(html).split(" ")).toContain("nokey");
    expect(html).toContain(dict["pbe.readOnlyParts"].en);
    expect(html).toContain("ollama");
    expect(html).toContain("qwen3:8b");
    expect(html).toContain("make test");
  });
});

describe("the checks panel", () => {
  const html = renderToStaticMarkup(<ChecksPanel doc={MINIMAL} refused={null} dispatch={() => {}} />);

  it("renders one row per check and only the fields its kind uses", () => {
    expect(count(html, "data-check=")).toBe(2);
    const sections = /data-check="spec_ok"[\s\S]*?(?=data-check="tests_green")/.exec(html)?.[0] ?? "";
    expect(sections).toContain('data-field="documents"');
    expect(sections).toContain('data-field="forbid"');
    expect(sections).not.toContain('data-field="run"');
    const command = html.slice(html.indexOf('data-check="tests_green"'));
    expect(command).toContain('data-field="run"');
    expect(command).toContain('value="make test"');
    expect(command).not.toContain('data-field="documents"');
  });

  it("is a nokey root", () => {
    expect(rootClass(html).split(" ")).toContain("nokey");
  });
});

describe("the findings list", () => {
  const findings = [
    { path: "nodes[1].check", message: "unknown check" },
    { path: "checks.x.run", message: "empty command" },
  ];
  const html = renderToStaticMarkup(<FindingsList doc={MINIMAL} findings={findings} onPick={() => {}} />);

  it("renders every finding and makes a button only of one that points at a node or arrow", () => {
    expect(html).toContain("unknown check");
    expect(html).toContain("empty command");
    expect(count(html, "<button")).toBe(1);
    expect(html).toContain("nodes[1].check");
  });

  it("renders the none sentence for an empty list", () => {
    const empty = renderToStaticMarkup(<FindingsList doc={MINIMAL} findings={[]} onPick={() => {}} />);
    expect(empty).toContain(dict["pbe.none"].en);
    expect(empty).not.toContain("<button");
  });
});
