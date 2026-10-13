// Card 485, task 10 (plan numbering): what the step table says for a skill
// the harness lacks. Card 558 (owner decision): the table offers no install
// from the playbook any more. House style: renderToStaticMarkup and the
// element tree.

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
  skills: { name: string; installed: boolean; disabled: boolean; inPlaybook?: boolean }[],
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

const row = (loaded: LoadedPlaybook): string => {
  const out = renderToStaticMarkup(<StepTable loaded={loaded} />);
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

describe("the step table's word for a step's skill (card 558: read from the folder in place)", () => {
  const missing = {
    name: "spectropowers:brainstorming",
    installed: false,
    disabled: false,
    inPlaybook: false,
  };
  const held = { ...missing, inPlaybook: true };

  it("says a skill the playbook folder holds is in the playbook", () => {
    const r = row(loadedWith([held], ["skills/spectropowers"]));
    expect(r).toContain(dict["pb.run.skillPlaybook"].en);
    expect(r).not.toContain(dict["pb.run.skillMissing"].en);
  });

  it("says a skill the folder does not hold is missing in the playbook, even when the user has it installed", () => {
    const r = row(loadedWith([{ ...missing, installed: true }], ["skills/spectropowers"]));
    expect(r).toContain(dict["pb.run.skillMissing"].en);
  });

  it("uses no install word: not installed, installed, disabled or not in this playbook", () => {
    for (const k of [missing, held, { ...missing, disabled: true }, { ...held, installed: true }]) {
      const r = row(loadedWith([k], ["skills/other"]));
      expect(r).not.toContain(dict["pb.notInstalled"].en);
      expect(r).not.toContain(`>${dict["pb.installed"].en}<`);
      expect(r).not.toContain(dict["pb.disabled"].en);
      expect(r).not.toContain(dict["pc.notInPlaybook"].en);
    }
    expect(dict["pc.installFromPlaybook"], "the key is retired").toBeUndefined();
  });

  it("draws no control in the row", () => {
    const tree = StepTable({ loaded: loadedWith([missing, held], ["skills/spectropowers"]) });
    expect(find(tree, (el) => el.type === "button")).toEqual([]);
  });
});
