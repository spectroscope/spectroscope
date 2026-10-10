// Card 482: the confirmation before a playbook run. It shows every step with
// the provider and model it runs on, every command verbatim, the skills with
// their source and the short hash, and Start stays disabled while the server
// names any reason the run may not start.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { dict } from "../i18n/i18n";
import type { LoadedPlaybook } from "../state/playbooks";
import type { StartPreview } from "../state/playbookRuns";
import { PlaybookStartSheet } from "./PlaybookStartSheet";

const LOADED: LoadedPlaybook = {
  playbook: {
    id: "p",
    name: "P",
    description: "",
    start: "spec",
    nodes: [
      {
        kind: "step",
        id: "spec",
        name: "Write the spec",
        performer: "chat",
        skills: [],
        model: "strong",
        privacy: "cheap",
        consumes: [],
        produces: [],
        nod: true,
      },
      {
        kind: "step",
        id: "build",
        name: "Build it",
        performer: "child",
        skills: [],
        model: "fast",
        privacy: "private",
        consumes: [],
        produces: [],
        nod: false,
      },
      { kind: "end", id: "done", result: "done" },
    ],
    arrows: [
      { from: "spec", to: "build", on: null },
      { from: "build", to: "done", on: null },
    ],
    models: {},
    documents: {},
  },
  topology: {
    entry: "spec",
    nodes: [
      { id: "__start__", label: "__start__" },
      { id: "spec", label: "Write the spec" },
      { id: "build", label: "Build it" },
      { id: "__end__", label: "__end__" },
    ],
    edges: [
      { from: "__start__", to: "spec", kind: "direct" },
      { from: "spec", to: "build", kind: "direct" },
      { from: "build", to: "__end__", kind: "direct" },
    ],
  },
  findings: [],
  steps: [],
  dir: "/pb",
};

const HASH = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const PREVIEW: StartPreview = {
  dir: "/pb",
  hash: HASH,
  findings: [],
  steps: [
    {
      id: "spec",
      name: "Write the spec",
      performer: "chat",
      role: null,
      choice: "strong",
      provider: "anthropic",
      model: "claude-opus-4",
      providerKind: "cloud",
      providerState: "ready",
      privacy: "cheap",
      permission: "inherit",
      nod: true,
    },
    {
      id: "build",
      name: "Build it",
      performer: "child",
      role: "implementer",
      choice: "fast",
      provider: "ollama",
      model: "qwen2.5:7b",
      providerKind: "local",
      providerState: "reachable",
      privacy: "private",
      permission: "ask",
      nod: false,
    },
  ],
  skills: [
    { name: "spectropowers:brainstorming", source: "playbook" },
    { name: "tdd", source: "installed" },
  ],
  commands: ["python3 -m unittest -q"],
  refusals: [],
};

const render = (preview: StartPreview): string =>
  renderToStaticMarkup(
    <PlaybookStartSheet loaded={LOADED} preview={preview} onStart={() => {}} onClose={() => {}} />,
  );

const startButton = (html: string): string => /<button[^>]*class="pb-run-start"[^>]*>/.exec(html)?.[0] ?? "";

describe("the confirmation sheet", () => {
  it("is a modal dialog that draws the playbook", () => {
    const html = render(PREVIEW);
    expect(html).toMatch(/role="dialog"/);
    expect(html).toMatch(/aria-modal="true"/);
    expect(html).toContain('class="pb-graph"');
  });

  it("lists both steps with their provider and model", () => {
    const html = render(PREVIEW);
    const row = (id: string) => new RegExp(`<tr data-step="${id}">([\\s\\S]*?)</tr>`).exec(html)?.[1] ?? "";
    expect(row("spec")).toContain("Write the spec");
    expect(row("spec")).toContain("anthropic");
    expect(row("spec")).toContain("claude-opus-4");
    expect(row("build")).toContain("Build it");
    expect(row("build")).toContain("ollama");
    expect(row("build")).toContain("qwen2.5:7b");
    expect(row("build")).toContain(dict["pb.run.private"].en);
  });

  it("shows every command verbatim inside code", () => {
    expect(render(PREVIEW)).toContain("<code>python3 -m unittest -q</code>");
  });

  it("shows the short hash and keeps the full one in the title", () => {
    const html = render(PREVIEW);
    expect(html).toContain(`sha256:${HASH.slice(7, 19)}`);
    expect(html).not.toContain(`>${HASH}<`);
    expect(html).toContain(`title="${HASH}"`);
  });

  it("enables Start when nothing refuses the run", () => {
    const button = startButton(render(PREVIEW));
    expect(button).not.toBe("");
    expect(button).not.toContain("disabled");
  });

  it("disables Start and lists the reason when the server refuses the run", () => {
    const html = render({ ...PREVIEW, refusals: ["skill not found: nowhere"] });
    expect(startButton(html)).toContain("disabled");
    expect(html).toContain(dict["pb.run.refusals"].en);
    expect(html).toContain("skill not found: nowhere");
  });

  it("names each skill's source, a missing one in words", () => {
    const html = render({
      ...PREVIEW,
      skills: [...PREVIEW.skills, { name: "nowhere", source: "missing" }],
    });
    expect(html).toContain(dict["pb.run.skillPlaybook"].en);
    expect(html).toContain(dict["pb.run.skillInstalled"].en);
    expect(html).toMatch(/nowhere[\s\S]*?missing/);
    expect(html).toContain(dict["pb.run.skillMissing"].en);
  });
});
