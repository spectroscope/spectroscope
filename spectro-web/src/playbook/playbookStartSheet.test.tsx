// Card 482: the confirmation before a playbook run. It shows every step with
// the provider and model it runs on, every command verbatim, the skills with
// their source and the short hash, and Start stays disabled while the server
// names any reason the run may not start.
//
// Card 554 (criterion 8b): the sheet opens in the chat of the session after
// /run-with-playbook, drawn from the socket-only playbook_confirm frame, and
// names the task the run was asked. The pane no longer opens it.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dict } from "../i18n/i18n";
import { setLang } from "../state/lang";
import { __resetPlaybookContents, type ContentItem, type ContentsPreview } from "../state/playbookContents";
import type { StartPreview } from "../state/playbookRuns";
import type { PlaybookDoc } from "./editor/doc";
import { PlaybookStartSheet, readSheetExtras } from "./PlaybookStartSheet";
import { parsePlaybookConfirm } from "../state/playbookChat";
import { startPlaybookFrame } from "../state/chatCommands";

const DOC: PlaybookDoc = {
  schema_version: 1,
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
      permission: "inherit",
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
      permission: "inherit",
      consumes: [],
      produces: [],
      nod: false,
    },
    { kind: "end", id: "done", result: "done" },
  ],
  arrows: [
    { from: "spec", to: "build" },
    { from: "build", to: "done" },
  ],
  models: {},
  documents: {},
  checks: {},
  vars: {},
  contents: { skills: [], agents: [], hooks: [], commands: [], workflows: [] },
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
    { name: "tdd", source: "missing" },
  ],
  commands: ["python3 -m unittest -q"],
  refusals: [],
};

const render = (preview: StartPreview, contents: ContentsPreview | null = null): string =>
  renderToStaticMarkup(
    <PlaybookStartSheet
      doc={DOC}
      preview={preview}
      contents={contents}
      onStart={() => {}}
      onClose={() => {}}
    />,
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

  // Card 558: a run reads a step's skills from the folder in place, so a skill
  // is in the playbook or missing in it; there is no installed source.
  it("names each skill as in the playbook or missing in the playbook", () => {
    const html = render(PREVIEW);
    expect(html).toMatch(/spectropowers:brainstorming[\s\S]*?in the playbook/);
    expect(html).toMatch(/tdd[\s\S]*?missing in the playbook/);
    expect(dict["pb.run.skillPlaybook"].en).toBe("in the playbook");
    expect(dict["pb.run.skillMissing"].en).toBe("missing in the playbook");
    expect(html).not.toContain(">installed<");
  });
});

// Card 485 (plan P6, Task 11): the confirmation lists what the playbook brings,
// read only, and says in words which items changed since the install.

const CONTENTS_HASH = "fedcba9876543210".repeat(4);

function content(over: Partial<ContentItem> & Pick<ContentItem, "kind" | "name">): ContentItem {
  return {
    source: `${over.kind}s/${over.name}`,
    sha256: "0123456789abcdef".repeat(4),
    state: "in-playbook",
    scope: "sessions",
    bytes: 10,
    target: null,
    command: null,
    files: [],
    ...over,
  };
}

function contents(items: ContentItem[]): ContentsPreview {
  return {
    playbook: "p",
    dir: "/pb",
    contentsHash: CONTENTS_HASH,
    items,
    promptChars: 120,
    hooksOrigin: null,
    findings: [],
  };
}

const CHANGED_SKILL = content({
  kind: "skill",
  name: "spectropowers:brainstorming",
  source: "skills/spectropowers/brainstorming",
});
const SAME_AGENT = content({ kind: "agent", name: "reviewer", source: "agents/reviewer.md", scope: "runs" });

/** The sheet from the contents section to the footer, or "" when there is no contents section. */
const section = (html: string): string => {
  const from = html.indexOf('class="pb-sheet-section pb-run-contents"');
  return from < 0 ? "" : html.slice(from, html.indexOf("<footer", from));
};

describe("the contents in the confirmation sheet (card 485)", () => {
  afterEach(() => {
    setLang("en");
    __resetPlaybookContents();
    vi.unstubAllGlobals();
  });

  // Card 558: nothing is installed any more, so the list says nothing about an
  // install: no state from the install record, no changed line, no count of
  // items not installed. A workflow keeps whether it runs.
  it("lists what the playbook brings read only, with the full contents hash and no install word", () => {
    const workflow = content({
      kind: "workflow",
      name: "fanout-review.json",
      state: "runnable",
      scope: "runs",
    });
    const fresh = content({ kind: "skill", name: "a" });
    const part = section(render(PREVIEW, contents([CHANGED_SKILL, SAME_AGENT, fresh, workflow])));
    expect(part).not.toBe("");
    expect(part).toContain(dict["pc.runTitle"].en);
    expect(part).toContain("pc-list--readonly");
    expect(part).toContain('data-name="spectropowers:brainstorming"');
    expect(part).toContain('data-name="reviewer"');
    expect(part).toContain(`>${CONTENTS_HASH}<`);
    expect(part).toContain(dict["pc.state.runnable"].en);
    for (const word of [">installed<", ">new<", "since the install", "installed copy", "not installed"]) {
      expect(part).not.toContain(word);
    }
    // The list is for reading: no control inside it.
    expect(part).not.toMatch(/<(button|input)\b/);
  });

  // Nothing is installed (owner, 2026-10-13): every skill, command, hook and
  // agent of the list is shown as present in the playbook.
  it("marks every skill, command, hook and agent as in the playbook", () => {
    const items = [
      content({ kind: "skill", name: "s", state: "in-playbook" }),
      content({ kind: "command", name: "c", state: "in-playbook" }),
      content({ kind: "hook", name: "h", state: "in-playbook", scope: "tool-calls" }),
      content({ kind: "agent", name: "a", state: "in-playbook", scope: "runs" }),
    ];
    const part = section(render(PREVIEW, contents(items)));
    for (const name of ["s", "c", "h", "a"]) {
      const from = part.indexOf(`data-name="${name}"`);
      expect(from, name).toBeGreaterThan(-1);
      const row = part.slice(from, part.indexOf("</li>", from));
      expect(row, name).toContain('data-state="in-playbook"');
      expect(row, name).toContain(">in the playbook<");
    }
    expect(part).not.toContain(">installed<");
    expect(part).not.toContain("since the install");
    expect(part).not.toContain("not installed");
  });

  // Card 558: a playbook is read in place, so the line under each item names
  // what it reaches now: skills, commands and agents reach a session that
  // picks the playbook, from the pick; hooks reach no session yet; a workflow
  // starts in the chat with /playbook workflow and its name.
  it("says what each item reaches as the session that picks the playbook reads it, in English and German", () => {
    const items = [
      content({ kind: "skill", name: "s", scope: "sessions" }),
      content({ kind: "command", name: "c", scope: "sessions" }),
      content({ kind: "hook", name: "h", scope: "tool-calls" }),
      content({ kind: "agent", name: "a", scope: "runs" }),
      content({ kind: "workflow", name: "review/fanout.json", state: "runnable", scope: "runs" }),
      content({ kind: "workflow", name: "notes.md", state: "not-run", scope: "none" }),
    ];
    const scopeOf = (part: string, name: string): string => {
      const from = part.indexOf(`data-name="${name}"`);
      expect(from, name).toBeGreaterThan(-1);
      const row = part.slice(from, part.indexOf("</li>", from));
      return /<p class="pc-scope">([^<]*)<\/p>/.exec(row)?.[1] ?? "";
    };

    const en = section(render(PREVIEW, contents(items)));
    for (const name of ["s", "c"]) {
      expect(scopeOf(en, name), name).toBe("A session can use this as soon as it picks this playbook.");
    }
    expect(scopeOf(en, "a")).toContain("A session can start this agent as soon as it picks this playbook.");
    expect(scopeOf(en, "h")).toBe("Runs in no session yet, not even in one that picks this playbook.");
    expect(scopeOf(en, "review/fanout.json")).toBe(
      "Runs in the chat of a session with this playbook when you type /playbook workflow fanout.",
    );
    expect(scopeOf(en, "notes.md")).toBe(dict["pc.scope.none"].en);
    for (const stale of ["new session", "every tool call", "workflow list", "Only steps"]) {
      expect(en, stale).not.toContain(stale);
    }

    setLang("de");
    const de = section(render(PREVIEW, contents(items)));
    for (const name of ["s", "c"]) {
      expect(scopeOf(de, name), name).toBe("Eine Session kann das nutzen, sobald sie dieses Playbook wählt.");
    }
    expect(scopeOf(de, "a")).toContain(
      "Eine Session kann diesen Agenten starten, sobald sie dieses Playbook wählt.",
    );
    expect(scopeOf(de, "h")).toBe(
      "Läuft noch in keiner Session, auch nicht in einer, die dieses Playbook wählt.",
    );
    expect(scopeOf(de, "review/fanout.json")).toBe(
      "Läuft im Chat einer Session mit diesem Playbook, wenn du /playbook workflow fanout eingibst.",
    );
    expect(scopeOf(de, "notes.md")).toBe(dict["pc.scope.none"].de);
    for (const stale of [
      "neue Sitzung",
      "neuen Sitzung",
      "Werkzeugaufruf",
      "Workflow-Liste",
      "Nur Schritte",
    ]) {
      expect(de, stale).not.toContain(stale);
    }
  });

  it("draws no contents section while the contents are not read", () => {
    const html = render(PREVIEW, null);
    expect(html).not.toContain("pb-run-contents");
    expect(html).not.toContain(dict["pc.runTitle"].en);
  });

  it("does not add the contents hash to the hash the run pins", () => {
    const html = render(PREVIEW, contents([CHANGED_SKILL]));
    expect(html).toContain(`title="${HASH}"`);
    expect(html).toContain(`sha256:${HASH.slice(7, 19)}`);
  });
});

describe("the sheet drawn from a playbook_confirm frame (card 554, criterion 8b)", () => {
  const FRAME = { type: "playbook_confirm", dir: "/pb", prompt: "add a CSV export", preview: PREVIEW };

  it("draws the frame's preview and names the task", () => {
    const confirm = parsePlaybookConfirm(FRAME);
    expect(confirm, "the frame reads").not.toBeNull();
    const html = renderToStaticMarkup(
      <PlaybookStartSheet
        doc={null}
        preview={confirm!.preview}
        prompt={confirm!.prompt}
        contents={null}
        onStart={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toMatch(/role="dialog"/);
    expect(html).toContain('<p class="pb-sheet-task">Asked: add a CSV export</p>');
    expect(html).toContain("python3 -m unittest -q");
    expect(html).toContain("sha256:0123456789ab");
    expect(startButton(html)).not.toContain("disabled");
    expect(html, "no drawing without a document").not.toContain('class="pb-graph"');
  });

  it("says the task in German too", () => {
    setLang("de");
    const html = renderToStaticMarkup(
      <PlaybookStartSheet
        doc={null}
        preview={PREVIEW}
        prompt="x"
        contents={null}
        onStart={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("Auftrag: x");
    setLang("en");
  });

  it("names no task line when none is given", () => {
    expect(render(PREVIEW)).not.toContain("pb-sheet-task");
  });

  it("starts with the frame's folder, the hash the sheet showed and the task", () => {
    const confirm = parsePlaybookConfirm(FRAME)!;
    expect(startPlaybookFrame(confirm.dir, confirm.preview.hash ?? "", confirm.prompt)).toEqual({
      type: "start_playbook",
      dir: "/pb",
      hash: HASH,
      prompt: "add a CSV export",
    });
  });
});

describe("reading what the sheet draws beside the frame (card 554)", () => {
  function reply(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as unknown as Response;
  }

  afterEach(() => {
    __resetPlaybookContents();
    vi.unstubAllGlobals();
  });

  it("reads the contents and the drawing of the folder again, and no preview: the frame brought it", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        urls.push(url);
        return Promise.resolve(
          url.startsWith("/api/playbooks/contents?")
            ? reply(200, contents([CHANGED_SKILL]))
            : reply(200, { document: DOC, editable: true }),
        );
      }),
    );
    const read = await readSheetExtras("/pb", "/ws");
    expect(read.contents?.items.map((i) => i.state)).toEqual(["in-playbook"]);
    expect(read.doc).toEqual(DOC);
    expect(urls).toContain("/api/playbooks/contents?dir=%2Fpb&workspace=%2Fws");
    expect(urls).toContain("/api/playbooks/draft?dir=%2Fpb&workspace=%2Fws");
    expect(urls.some((u) => u.startsWith("/api/playbooks/start-preview?"))).toBe(false);
  });

  it("gives null for a read the server refuses, so the sheet still opens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(reply(400, { message: "not a registered folder" }))),
    );
    const read = await readSheetExtras("/pb", null);
    expect(read).toEqual({ contents: null, doc: null });
  });
});
