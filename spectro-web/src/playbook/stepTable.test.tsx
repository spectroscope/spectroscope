// Card 485, task 10 (plan numbering): what the step table offers for a skill
// the harness lacks. House style: renderToStaticMarkup, a handler reached
// through the element tree.

import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { dict } from "../i18n/i18n";
import type { LoadedPlaybook } from "../state/playbooks";
import { StepTable } from "./StepTable";

// StepTable holds no hook but the language. Pinning that to English lets the
// last test call it as a function and reach the link's own handler.
vi.mock("../state/lang", () => ({ useLang: () => "en" }));

function loadedWith(
  skills: { name: string; installed: boolean; disabled: boolean }[],
  listed: string[],
): LoadedPlaybook {
  return {
    playbook: {
      id: "p",
      name: "P",
      description: "",
      start: "write",
      nodes: [
        {
          kind: "step",
          id: "write",
          name: "Write",
          performer: "chat",
          skills: skills.map((s) => s.name),
          model: null,
          privacy: "private",
          consumes: [],
          produces: [],
          nod: false,
        },
      ],
      arrows: [],
      models: {},
      documents: {},
      contents: { skills: listed, agents: [], hooks: [], commands: [], workflows: [] },
    },
    topology: { entry: "write", nodes: [], edges: [] },
    findings: [],
    steps: [{ id: "write", skills, model: null }],
    dir: "/p",
  };
}

const row = (loaded: LoadedPlaybook, onInstall: () => void = () => {}): string => {
  const out = renderToStaticMarkup(<StepTable loaded={loaded} onInstall={onInstall} />);
  return /<tr data-step="write">([\s\S]*?)<\/tr>/.exec(out)?.[1] ?? "";
};

function find(
  node: ReactNode,
  yes: (el: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement<Record<string, unknown>>[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement(n)) return;
    const el = n as ReactElement<Record<string, unknown>>;
    if (yes(el)) out.push(el);
    walk(el.props.children as ReactNode);
  };
  walk(node);
  return out;
}

describe("the step table's offer for a missing skill", () => {
  const missing = { name: "spectropowers:brainstorming", installed: false, disabled: false };

  it("links to the install when the skill's pack is listed in this playbook's contents", () => {
    const r = row(loadedWith([missing], ["skills/spectropowers"]));
    expect(r).toContain(dict["pc.installFromPlaybook"].en);
    expect(r).not.toContain(dict["pc.notInPlaybook"].en);
  });

  it("says the skill is not in this playbook when the pack is not listed", () => {
    const r = row(loadedWith([missing], ["skills/other"]));
    expect(r).toContain(dict["pc.notInPlaybook"].en);
    expect(r).not.toContain(dict["pc.installFromPlaybook"].en);
  });

  it("matches the pack by its whole name, not by a prefix", () => {
    const r = row(loadedWith([missing], ["skills/spectropowers-extra"]));
    expect(r).not.toContain(dict["pc.installFromPlaybook"].en);
    expect(r).toContain(dict["pc.notInPlaybook"].en);
  });

  it("shows a disabled skill as disabled and offers no link", () => {
    const r = row(loadedWith([{ ...missing, disabled: true }], ["skills/spectropowers"]));
    expect(r).toContain(dict["pb.disabled"].en);
    expect(r).not.toContain(dict["pc.installFromPlaybook"].en);
    expect(r).not.toContain(dict["pc.notInPlaybook"].en);
  });

  it("offers nothing for an installed skill", () => {
    const r = row(loadedWith([{ ...missing, installed: true }], ["skills/spectropowers"]));
    expect(r).toContain(dict["pb.installed"].en);
    expect(r).not.toContain(dict["pc.installFromPlaybook"].en);
    expect(r).not.toContain(dict["pc.notInPlaybook"].en);
  });

  it("opens the install from the link", () => {
    const calls: string[] = [];
    const tree = StepTable({
      loaded: loadedWith([missing], ["skills/spectropowers"]),
      onInstall: () => calls.push("open"),
    });
    const links = find(tree, (el) => el.props["data-action"] === "install-from-playbook");
    expect(links).toHaveLength(1);
    (links[0].props.onClick as () => void)();
    expect(calls).toEqual(["open"]);
  });
});
