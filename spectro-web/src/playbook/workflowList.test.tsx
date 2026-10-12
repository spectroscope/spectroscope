// Card 506, criterion 5: the playbook module lists the workflows of the loaded
// playbook with a Run control. A workflow that reads as a step list can run;
// Run sends the file, the hash the list shows and the text typed beside it.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { dict } from "../i18n/i18n";
import { setLang } from "../state/lang";
import type { ContentItem } from "../state/playbookContents";
import { drive, type El } from "../testkit/driveComponent";
import { WorkflowList } from "./WorkflowList";

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

const SKILL: ContentItem = { ...item("brainstorming", "new"), kind: "skill", source: "skills/x" };
const ITEMS = [
  SKILL,
  item("fanout-research.json", "runnable"),
  item("fanout-review.json", "runnable"),
  item("build.js", "not-run"),
];

function byClass(tree: El[], cls: string): El[] {
  return tree.filter((el) =>
    String(el.props.className ?? "")
      .split(" ")
      .includes(cls),
  );
}

afterEach(() => setLang("en"));

describe("WorkflowList", () => {
  it("lists every workflow of the playbook with its hash and a Run only for the ones that run", () => {
    const out = renderToStaticMarkup(<WorkflowList items={ITEMS} canRun onRun={() => true} />);
    expect(out).toContain("fanout-research.json");
    expect(out).toContain("fanout-review.json");
    expect(out).toContain("build.js");
    expect(out).not.toContain("brainstorming");
    expect(out).toContain("sha-fanout-r");
    expect(out.match(/class="wf-run"/g)?.length).toBe(2);
    expect(out).toContain(dict["wf.notRunnable"].en);
  });

  it("Run sends the file, the hash and the typed text, and says the run shows in the chat", () => {
    const sent: unknown[][] = [];
    const tree = drive(
      <WorkflowList
        items={ITEMS}
        canRun
        onRun={(...args) => {
          sent.push(args);
          return true;
        }}
      />,
      [WorkflowList],
      [
        (t) =>
          byClass(t, "wf-input")[0].props.onChange?.({
            target: { value: "why does the parser drop lines?" },
          }),
        (t) => byClass(t, "wf-run")[0].props.onClick?.(),
      ],
    );
    expect(sent).toEqual([
      ["workflows/fanout-research.json", "sha-fanout-research.json", "why does the parser drop lines?"],
    ]);
    expect(byClass(tree, "wf-notice").length).toBe(1);
  });

  it("without a live session and workspace the Run controls are off and say why", () => {
    const out = renderToStaticMarkup(<WorkflowList items={ITEMS} canRun={false} onRun={() => true} />);
    expect(out.match(/class="wf-run" disabled=""/g)?.length).toBe(2);
    expect(out).toContain(dict["wf.needsSession"].en);
  });

  it("draws nothing when the playbook declares no workflow", () => {
    expect(renderToStaticMarkup(<WorkflowList items={[SKILL]} canRun onRun={() => true} />)).toBe("");
  });

  it("speaks German", () => {
    setLang("de");
    const out = renderToStaticMarkup(<WorkflowList items={ITEMS} canRun onRun={() => true} />);
    expect(out).toContain(dict["wf.title"].de);
    expect(out).toContain(dict["wf.run"].de);
  });
});
