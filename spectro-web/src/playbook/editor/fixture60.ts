// Card 483: a deterministic 60 node playbook for the timing test and the
// browser measurement. Built by a loop with no randomness: 40 steps in a
// chain, a decision after every second step up to step 36, every fourth
// decision with max_rounds and a fail arrow back to its step (4 loops), every
// other fail and every exhausted into the end `cancelled`.

import type { DocArrow, DocNode, DocStep, PlaybookDoc } from "./doc";

function build(): PlaybookDoc {
  const chain: DocNode[] = [];
  let decisions = 0;
  for (let s = 1; s <= 40; s++) {
    const step: DocStep = {
      kind: "step",
      id: `s${s}`,
      name: `Step ${s}`,
      performer: "chat",
      skills: [],
      model: "fast",
      privacy: "cheap",
      permission: "inherit",
      consumes: [],
      produces: [],
      nod: false,
    };
    chain.push(step);
    if (s % 2 === 0 && decisions < 18) {
      decisions++;
      const loop = decisions % 4 === 0;
      chain.push({
        kind: "decision",
        id: `d${decisions}`,
        name: `Check ${decisions}`,
        check: "review",
        outcomes: ["pass", "fail"],
        ...(loop ? { max_rounds: 3 } : {}),
      });
    }
  }

  const arrows: DocArrow[] = [];
  chain.forEach((n, i) => {
    const next = chain[i + 1]?.id ?? "done";
    if (n.kind === "step") {
      arrows.push({ from: n.id, to: next });
      return;
    }
    if (n.kind !== "decision") return;
    arrows.push({ from: n.id, to: next, on: "pass" });
    if (n.max_rounds !== undefined) {
      arrows.push({ from: n.id, to: chain[i - 1].id, on: "fail" });
      arrows.push({ from: n.id, to: "cancelled", on: "exhausted" });
    } else {
      arrows.push({ from: n.id, to: "cancelled", on: "fail" });
    }
  });

  return {
    schema_version: 1,
    id: "fixture-60",
    name: "Sixty nodes",
    description: "A deterministic 60 node playbook for layout timing.",
    models: { fast: { primary: { provider: "ollama", model: "qwen3:8b" }, fallbacks: [] } },
    documents: {},
    checks: { review: { kind: "review", model: "fast", labels: ["pass", "fail"] } },
    vars: {},
    start: "s1",
    nodes: [
      ...chain,
      { kind: "end", id: "done", result: "done" },
      { kind: "end", id: "cancelled", result: "cancelled" },
    ],
    arrows,
    contents: { skills: [], agents: [], hooks: [], commands: [], workflows: [] },
  };
}

export const FIXTURE_60: PlaybookDoc = build();
