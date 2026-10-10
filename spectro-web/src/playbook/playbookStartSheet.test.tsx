// Card 482: the confirmation before a playbook run. It shows every step with
// the provider and model it runs on, every command verbatim, the skills with
// their source and the short hash, and Start stays disabled while the server
// names any reason the run may not start.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dict } from "../i18n/i18n";
import { setLang } from "../state/lang";
import { __resetPlaybookContents, type ContentItem, type ContentsPreview } from "../state/playbookContents";
import type { StartPreview } from "../state/playbookRuns";
import type { PlaybookDoc } from "./editor/doc";
import { PlaybookStartSheet, readConfirmation } from "./PlaybookStartSheet";

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
    { name: "tdd", source: "installed" },
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

// Card 485 (plan P6, Task 11): the confirmation lists what the playbook brings,
// read only, and says in words which items changed since the install.

const CONTENTS_HASH = "fedcba9876543210".repeat(4);

function content(over: Partial<ContentItem> & Pick<ContentItem, "kind" | "name">): ContentItem {
  return {
    source: `${over.kind}s/${over.name}`,
    sha256: "0123456789abcdef".repeat(4),
    state: "same",
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
  state: "source-changed",
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

  it("lists what the playbook brings read only, names the changed item and shows the full contents hash", () => {
    const html = render(PREVIEW, contents([CHANGED_SKILL, SAME_AGENT]));
    const part = section(html);
    expect(part).not.toBe("");
    expect(part).toContain(dict["pc.runTitle"].en);
    expect(part).toContain("pc-list--readonly");
    expect(part).toContain('data-name="spectropowers:brainstorming"');
    expect(part).toContain('data-name="reviewer"');
    expect(part).toContain(dict["pc.state.sourceChanged"].en);
    expect(part).toContain(dict["pc.runChanged"].en.replace("{names}", "spectropowers:brainstorming"));
    expect(part).toContain(`>${CONTENTS_HASH}<`);
    // The list is for reading: no control inside it.
    expect(part).not.toMatch(/<(button|input)\b/);
  });

  it("names every changed item, an edited installed copy as well, and no unchanged one", () => {
    const edited = content({
      kind: "command",
      name: "p:ship",
      source: "commands/ship.md",
      state: "copy-changed",
    });
    const part = section(render(PREVIEW, contents([CHANGED_SKILL, SAME_AGENT, edited])));
    expect(part).toContain(
      dict["pc.runChanged"].en.replace("{names}", "spectropowers:brainstorming, p:ship"),
    );
  });

  it("with no changed item draws no changed line and still lists the contents", () => {
    const part = section(render(PREVIEW, contents([SAME_AGENT])));
    expect(part).toContain(dict["pc.runTitle"].en);
    expect(part).toContain('data-name="reviewer"');
    expect(part).not.toContain(dict["pc.runChanged"].en.replace(": {names}", ""));
  });

  it("says how many contents are not installed, with the singular for one", () => {
    const one = section(
      render(PREVIEW, contents([content({ kind: "skill", name: "a", state: "new" }), SAME_AGENT])),
    );
    expect(one).toContain(dict["pc.notInstalledOne"].en);
    const two = section(
      render(
        PREVIEW,
        contents([
          content({ kind: "skill", name: "a", state: "new" }),
          content({ kind: "skill", name: "b", state: "new" }),
        ]),
      ),
    );
    expect(two).toContain(dict["pc.notInstalled"].en.replace("{n}", "2"));
    const none = section(render(PREVIEW, contents([SAME_AGENT])));
    expect(none).not.toContain(dict["pc.notInstalledOne"].en);
    expect(none).not.toContain(dict["pc.notInstalled"].en.replace("{n} ", ""));
  });

  it("says the change in German as well", () => {
    setLang("de");
    const part = section(render(PREVIEW, contents([CHANGED_SKILL])));
    expect(part).toContain(dict["pc.runTitle"].de);
    expect(part).toContain(dict["pc.runChanged"].de.replace("{names}", "spectropowers:brainstorming"));
    expect(part).toContain(dict["pc.state.sourceChanged"].de);
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

describe("reading the confirmation (card 485)", () => {
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

  it("reads the start preview and the contents of the same folder again, so a file changed since the pane opened shows", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        urls.push(url);
        return Promise.resolve(
          url.startsWith("/api/playbooks/contents?")
            ? reply(200, contents([CHANGED_SKILL]))
            : reply(200, PREVIEW),
        );
      }),
    );
    const read = await readConfirmation("/pb", "/ws");
    expect(read.preview).toEqual(PREVIEW);
    expect(read.contents?.items.map((i) => i.state)).toEqual(["source-changed"]);
    expect(urls.some((u) => u.startsWith("/api/playbooks/start-preview?"))).toBe(true);
    expect(urls).toContain("/api/playbooks/contents?dir=%2Fpb&workspace=%2Fws");
  });

  it("still opens the sheet when the contents cannot be read, without a list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          url.startsWith("/api/playbooks/contents?")
            ? reply(400, { message: "not a registered folder" })
            : reply(200, PREVIEW),
        ),
      ),
    );
    const read = await readConfirmation("/pb", "/ws");
    expect(read.preview).toEqual(PREVIEW);
    expect(read.contents).toBeNull();
  });
});
