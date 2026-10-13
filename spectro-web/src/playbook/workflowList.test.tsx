// Card 506, criterion 5: the playbook module lists the workflows of the loaded
// playbook. Card 554 (criterion 8a): a workflow starts from the chat of a
// session with /playbook workflow <name> <input>, so the list keeps the
// listing and loses its input and its Run. Each runnable workflow shows the
// command that runs it; the name is the file below workflows/ without its
// extension, as the server reads it.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { dict } from "../i18n/i18n";
import { setLang } from "../state/lang";
import type { ContentItem } from "../state/playbookContents";
import { WorkflowList, workflowCommand } from "./WorkflowList";

function item(name: string, state: ContentItem["state"], sha = "sha-" + name): ContentItem {
  return {
    kind: "workflow",
    name,
    source: `workflows/${name}`,
    sha256: sha,
    state,
    scope: state === "runnable" ? "runs" : "none",
    bytes: 100,
    target: null,
    command: null,
    files: [],
  };
}

const SKILL: ContentItem = { ...item("brainstorming", "in-playbook"), kind: "skill", source: "skills/x" };
const ITEMS = [
  SKILL,
  item("fanout-research.json", "runnable"),
  item("fanout-review.json", "runnable"),
  item("build.js", "not-run"),
];

afterEach(() => setLang("en"));

describe("WorkflowList", () => {
  it("lists every workflow of the playbook with its hash, and the chat command of each that runs", () => {
    const out = renderToStaticMarkup(<WorkflowList items={ITEMS} />);
    expect(out).toContain("fanout-research.json");
    expect(out).toContain("fanout-review.json");
    expect(out).toContain("build.js");
    expect(out).not.toContain("brainstorming");
    expect(out).toContain("sha-fanout-r");
    expect(out).toContain('<code class="wf-command">/playbook workflow fanout-research</code>');
    expect(out).toContain('<code class="wf-command">/playbook workflow fanout-review</code>');
    expect(out.match(/class="wf-command"/g)?.length).toBe(2);
    expect(out).toContain(dict["wf.notRunnable"].en);
  });

  it("offers no input and no Run: a workflow starts from the chat (card 554)", () => {
    const out = renderToStaticMarkup(<WorkflowList items={ITEMS} />);
    expect(out).not.toContain("wf-input");
    expect(out).not.toContain("wf-run");
    expect(out).not.toContain("<button");
    expect(out).toContain(
      "A workflow starts in the chat of a session: /playbook workflow &lt;name&gt; &lt;input&gt;.",
    );
    for (const key of ["wf.run", "wf.input", "wf.hint", "wf.needsSession", "wf.started"]) {
      expect(dict[key], `${key} is retired`).toBeUndefined();
    }
  });

  it("names a workflow by its file below workflows/ without the extension", () => {
    expect(workflowCommand("workflows/fanout-review.json")).toBe("/playbook workflow fanout-review");
    expect(workflowCommand("workflows/team/check.json")).toBe("/playbook workflow team/check");
  });

  it("draws nothing when the playbook declares no workflow", () => {
    expect(renderToStaticMarkup(<WorkflowList items={[SKILL]} />)).toBe("");
  });

  it("speaks German", () => {
    setLang("de");
    const out = renderToStaticMarkup(<WorkflowList items={ITEMS} />);
    expect(out).toContain(dict["wf.title"].de);
    expect(out).toContain("Ein Workflow startet im Chat einer Session");
  });
});
