// Card 481: the playbook module's pane. With no folder it offers the picker,
// the path field and the copy button; with a loaded playbook it draws the
// graph, the step table and, when there are any, the findings. Card 482: it
// says what a run does and offers Build by this once a playbook is loaded and
// a session is open.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dict } from "../i18n/i18n";
import { __resetPlaybooks, loadPlaybook, refreshFolders, type LoadedPlaybook } from "../state/playbooks";
import { PlaybookPane } from "./PlaybookPane";

const LOADED: LoadedPlaybook = {
  playbook: {
    id: "p",
    name: "P",
    description: "d",
    start: "write",
    nodes: [
      {
        kind: "step",
        id: "write",
        name: "Write",
        performer: "child",
        skills: ["spectropowers:brainstorming", "spectropowers:missing"],
        model: "fast",
        privacy: "private",
        consumes: ["ticket"],
        produces: ["spec"],
        nod: true,
      },
      { kind: "decision", id: "ok", name: "Spec ok", check: "spec_ok", outcomes: [], maxRounds: 2 },
      { kind: "end", id: "done", result: "done" },
    ],
    arrows: [
      { from: "write", to: "ok", on: null },
      { from: "ok", to: "done", on: "pass" },
      { from: "ok", to: "write", on: "fail" },
      { from: "ok", to: "done", on: "exhausted" },
    ],
    models: { fast: { primary: { provider: "ollama", model: "qwen3:8b" }, fallbacks: [] } },
    documents: {},
  },
  topology: {
    entry: "write",
    nodes: [
      { id: "__start__", label: "__start__" },
      { id: "write", label: "Write" },
      { id: "ok", label: "Spec ok" },
      { id: "__end__", label: "__end__" },
    ],
    edges: [
      { from: "__start__", to: "write", kind: "direct" },
      { from: "write", to: "ok", kind: "direct" },
      { from: "ok", to: "__end__", kind: "conditional", branch: "ok" },
      { from: "ok", to: "write", kind: "conditional", branch: "ok" },
      { from: "ok", to: "__end__", kind: "conditional", branch: "ok" },
    ],
  },
  findings: [],
  steps: [
    {
      id: "write",
      skills: [
        { name: "spectropowers:brainstorming", installed: true },
        { name: "spectropowers:missing", installed: false },
      ],
      model: { choice: "fast", provider: "ollama", model: "qwen3:8b", state: "local", reason: null },
    },
  ],
  dir: "/p",
};

function respond(body: unknown): void {
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

beforeEach(() => {
  __resetPlaybooks();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  __resetPlaybooks();
  vi.unstubAllGlobals();
});

describe("PlaybookPane with no folder", () => {
  const html = () =>
    renderToStaticMarkup(<PlaybookPane workspace="/ws" sessionId={null} onStartPlaybook={() => false} />);

  it("offers the picker, the path field and the copy button", () => {
    const out = html();
    expect(out).toContain('class="pb-folders"');
    expect(out).toMatch(/<input[^>]*class="pb-path"/);
    expect(out).toMatch(/<button[^>]*class="pb-copy"/);
    expect(out).toContain(dict["pb.copyBundled"].en);
  });

  it("says that a run follows the playbook step by step", () => {
    expect(html()).toContain(dict["pb.run.hint"].en);
  });

  it("offers Build by this only once a playbook is loaded", () => {
    expect(html()).not.toContain("pb-run-build");
  });

  it("draws no graph, no step table and no findings", () => {
    const out = html();
    expect(out).not.toContain("pb-graph");
    expect(out).not.toContain("pb-steps");
    expect(out).not.toContain("pb-findings");
  });
});

describe("PlaybookPane with a loaded playbook", () => {
  it("lists the known folders and marks the one pinned to the workspace", async () => {
    respond({ folders: ["/p", "/q"], active: "/p" });
    await refreshFolders("/ws");
    const out = renderToStaticMarkup(
      <PlaybookPane workspace="/ws" sessionId={null} onStartPlaybook={() => false} />,
    );
    expect(out).toContain("/p");
    expect(out).toContain("/q");
    expect(out).toMatch(/class="pb-folder is-active"[^>]*>[\s\S]*?\/p</);
  });

  it("draws the graph and the step table, and no findings list when there are none", async () => {
    respond(LOADED);
    await loadPlaybook("/p", "/ws");
    const out = renderToStaticMarkup(
      <PlaybookPane workspace="/ws" sessionId={null} onStartPlaybook={() => false} />,
    );
    expect(out).toContain('class="pb-graph"');
    expect(out).toContain('class="pb-steps"');
    expect(out).toContain('data-node="write"');
    expect(out).not.toContain("pb-findings");
    expect(out).toContain(dict["pb.run.hint"].en);
  });

  it("enables Build by this when a playbook is loaded and a session is open", async () => {
    respond(LOADED);
    await loadPlaybook("/p", "/ws");
    const button = (sessionId: string | null): string =>
      /<button[^>]*class="pb-run-build"[^>]*>/.exec(
        renderToStaticMarkup(
          <PlaybookPane workspace="/ws" sessionId={sessionId} onStartPlaybook={() => false} />,
        ),
      )?.[0] ?? "";
    expect(button("s1")).not.toBe("");
    expect(button("s1")).not.toContain("disabled");
    expect(button(null)).toContain("disabled");
  });

  it("lists each step's skills as installed or not, its model and provider state, privacy, documents and nod", async () => {
    respond(LOADED);
    await loadPlaybook("/p", "/ws");
    const out = renderToStaticMarkup(
      <PlaybookPane workspace="/ws" sessionId={null} onStartPlaybook={() => false} />,
    );
    const table = out.slice(out.indexOf('class="pb-steps"'));
    const row = /<tr data-step="write">([\s\S]*?)<\/tr>/.exec(table)?.[1] ?? "";
    expect(row).toContain("Write");
    expect(row).toContain(dict["pb.child"].en);
    expect(row).toMatch(/spectropowers:brainstorming[\s\S]*?installed/);
    expect(row).toMatch(/spectropowers:missing[\s\S]*?not installed/);
    expect(row).toContain("fast");
    expect(row).toContain("ollama");
    expect(row).toContain("qwen3:8b");
    expect(row).toContain("local");
    expect(row).toContain("ticket");
    expect(row).toContain("spec");
    expect(row).toContain('data-privacy="private"');
    expect(row).toContain('data-nod="true"');
    // One row per step: the decision and the end have none.
    expect(table.match(/<tr data-step=/g)).toHaveLength(1);
  });

  it("lists the findings, one line each with the path", async () => {
    respond({ ...LOADED, findings: [{ path: "nodes[1].baseUrl", message: "refused" }] });
    await loadPlaybook("/p", "/ws");
    const out = renderToStaticMarkup(
      <PlaybookPane workspace="/ws" sessionId={null} onStartPlaybook={() => false} />,
    );
    expect(out).toContain('class="pb-findings"');
    const items = out.match(/<li class="pb-finding">[\s\S]*?<\/li>/g) ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]).toContain("nodes[1].baseUrl");
    expect(items[0]).toContain("refused");
  });

  it("draws nothing from a file the reader refused, and lists why", async () => {
    respond({
      playbook: null,
      topology: null,
      findings: [{ path: "nodes[1].baseUrl", message: "refused: a shared folder may not route material" }],
      steps: [],
      dir: "/p",
    });
    await loadPlaybook("/p", "/ws");
    const out = renderToStaticMarkup(
      <PlaybookPane workspace="/ws" sessionId={null} onStartPlaybook={() => false} />,
    );
    expect(out).toContain('class="pb-findings"');
    expect(out).toContain("nodes[1].baseUrl");
    expect(out).not.toContain("pb-graph");
    expect(out).not.toContain("pb-steps");
  });
});
