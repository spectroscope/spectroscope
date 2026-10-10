// Card 485, task 10 (plan numbering): the confirmation, the contents list and
// the contents row of the playbook module.
//
// House style: renderToStaticMarkup, no DOM. Markup shows what is drawn. A
// handler is reached through the element tree the view returns (the view holds
// no hooks), the way MomentList.test.tsx reaches its button. The container's
// opening state (the tick off) is read from the markup of the container itself.

import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dict } from "../i18n/i18n";
import {
  __resetPlaybookContents,
  loadContents,
  type ContentItem,
  type ContentsPreview,
} from "../state/playbookContents";
import { __resetPlaybooks, loadPlaybook, type LoadedPlaybook } from "../state/playbooks";
import { ContentsConfirm, ContentsConfirmView, confirmInstall, confirmRemove } from "./ContentsConfirm";
import { ContentsList } from "./ContentsList";
import { PlaybookPane } from "./PlaybookPane";

const HASH = "0123456789abcdef".repeat(4);

function item(over: Partial<ContentItem> & Pick<ContentItem, "kind" | "name">): ContentItem {
  return {
    source: `${over.kind}s/${over.name}`,
    sha256: HASH,
    state: "new",
    scope: "sessions",
    bytes: 10,
    target: null,
    command: null,
    files: [],
    ...over,
  };
}

const SKILL = item({
  kind: "skill",
  name: "spectropowers",
  source: "skills/spectropowers",
  target: "~/.spectro/skills/spectropowers",
});
const COMMAND = item({ kind: "command", name: "ship", source: "commands/ship.md" });
const HOOK = item({
  kind: "hook",
  name: "guard",
  source: "hooks/hooks.json",
  scope: "tool-calls",
  command: "/home/u/.spectro/playbook-hooks/p/guard.sh",
  files: [
    { path: "hooks/hooks.json", text: '{"hooks":[]}' },
    { path: "hooks/guard.sh", text: "#!/bin/sh\necho guard-ran\nexit 0\n" },
  ],
});
const AGENT = item({ kind: "agent", name: "reviewer", source: "agents/reviewer.md", scope: "runs" });
const WORKFLOW = item({
  kind: "workflow",
  name: "nightly.js",
  source: "workflows/nightly.js",
  scope: "none",
  state: "not-run",
});

function preview(over: Partial<ContentsPreview> = {}): ContentsPreview {
  return {
    playbook: "p",
    dir: "/p",
    contentsHash: HASH,
    // Deliberately not in display order: the list sorts by kind.
    items: [WORKFLOW, AGENT, HOOK, COMMAND, SKILL],
    promptChars: 2390,
    hooksOrigin: null,
    findings: [],
    ...over,
  };
}

const LOADED: LoadedPlaybook = {
  playbook: {
    id: "p",
    name: "P",
    description: "d",
    start: "write",
    nodes: [{ kind: "end", id: "done", result: "done" }],
    arrows: [],
    models: {},
    documents: {},
    contents: {
      skills: ["skills/spectropowers"],
      agents: ["agents/reviewer.md"],
      hooks: ["hooks/hooks.json"],
      commands: ["commands/ship.md"],
      workflows: ["workflows/nightly.js"],
    },
  },
  topology: { entry: "write", nodes: [], edges: [] },
  findings: [],
  steps: [],
  dir: "/p",
};

function answer(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

async function seed(p: ContentsPreview): Promise<void> {
  vi.mocked(fetch).mockResolvedValueOnce(answer(200, p));
  await loadContents(p.dir, null);
}

beforeEach(() => {
  __resetPlaybookContents();
  __resetPlaybooks();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  __resetPlaybookContents();
  __resetPlaybooks();
  vi.unstubAllGlobals();
});

/** Every element of a returned tree for which the test says yes. */
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

const viewProps = (
  over: Partial<Parameters<typeof ContentsConfirmView>[0]> = {},
): Parameters<typeof ContentsConfirmView>[0] => ({
  lang: "en",
  mode: "install",
  preview: preview(),
  loading: false,
  hooks: false,
  busy: false,
  outcome: null,
  onHooks: () => {},
  onInstall: () => {},
  onRemove: () => {},
  onClose: () => {},
  ...over,
});

const html = (p: ContentsPreview, extra: Partial<Parameters<typeof ContentsList>[0]> = {}): string =>
  renderToStaticMarkup(<ContentsList preview={p} readOnly={false} onlyChanged={false} {...extra} />);

describe("the contents list", () => {
  it("draws one section per kind in the order skills, commands, hooks, agents, workflows", () => {
    const out = html(preview());
    const at = ["skill", "command", "hook", "agent", "workflow"].map((k) => out.indexOf(`data-kind="${k}"`));
    expect(at.every((i) => i > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const k of ["skill", "command", "hook", "agent", "workflow"]) {
      expect(out).toContain(dict[`pc.kind.${k}`].en);
    }
  });

  it("shows name, source, state word, twelve hash characters with the full hash in the title, and the scope sentence", () => {
    const out = html(preview({ items: [SKILL] }));
    expect(out).toContain("spectropowers");
    expect(out).toContain("skills/spectropowers");
    expect(out).toContain(dict["pc.state.new"].en);
    expect(out).toContain(`title="${HASH}"`);
    expect(out).toContain(`>${HASH.slice(0, 12)}<`);
    expect(out).not.toContain(`>${HASH.slice(0, 13)}`);
    expect(out).toContain(dict["pc.scope.sessions"].en);
  });

  it("says a taken item's target", () => {
    const out = html(
      preview({ items: [item({ kind: "skill", name: "x", state: "taken", target: "/u/skills/x" })] }),
    );
    expect(out).toContain(dict["pc.state.taken"].en.replace("{target}", "/u/skills/x"));
  });

  it("gives every state its own word", () => {
    const states = ["new", "same", "source-changed", "copy-changed", "not-run"] as const;
    const words = states.map((state) => {
      const out = html(preview({ items: [item({ kind: "skill", name: "x", state })] }));
      return /class="pc-state"[^>]*>([^<]*)</.exec(out)?.[1] ?? "";
    });
    expect(words.every((w) => w !== "")).toBe(true);
    expect(new Set(words).size).toBe(states.length);
  });

  it("shows a hook's resolved command and every file in full in a pre block", () => {
    const out = html(preview({ items: [HOOK] }));
    expect(out).toContain("/home/u/.spectro/playbook-hooks/p/guard.sh");
    const pres = out.match(/<pre\b[^>]*>[\s\S]*?<\/pre>/g) ?? [];
    expect(pres).toHaveLength(2);
    expect(pres.join("")).toContain("#!/bin/sh\necho guard-ran\nexit 0\n");
    expect(out).toContain("hooks/guard.sh");
  });

  it("lists only the changed items when asked to", () => {
    const all = [
      item({ kind: "skill", name: "same-one", state: "same" }),
      item({ kind: "skill", name: "src-one", state: "source-changed" }),
      item({ kind: "command", name: "copy-one", state: "copy-changed" }),
    ];
    const out = html(preview({ items: all }), { onlyChanged: true });
    expect(out).toContain("src-one");
    expect(out).toContain("copy-one");
    expect(out).not.toContain("same-one");
  });
});

describe("the install confirmation", () => {
  it("opens with the hooks tick unchecked and labelled", async () => {
    await seed(preview());
    const out = renderToStaticMarkup(<ContentsConfirm dir="/p" mode="install" onClose={() => {}} />);
    const box = /<input\b[^>]*type="checkbox"[^>]*>/.exec(out)?.[0] ?? "";
    expect(box).not.toBe("");
    expect(box).not.toContain("checked");
    expect(out).toContain(dict["pc.hooks.tick"].en);
  });

  it("draws the tick from the state it is given and reports a change", () => {
    const calls: boolean[] = [];
    const view = ContentsConfirmView(viewProps({ hooks: true, onHooks: (v) => calls.push(v) }));
    const box = find(view, (el) => el.type === "input" && el.props.type === "checkbox")[0];
    expect(box.props.checked).toBe(true);
    (box.props.onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: false } });
    expect(calls).toEqual([false]);
    const off = ContentsConfirmView(viewProps({ hooks: false }));
    expect(find(off, (el) => el.type === "input" && el.props.type === "checkbox")[0].props.checked).toBe(
      false,
    );
  });

  it("offers no tick when the playbook has no hook", () => {
    const out = renderToStaticMarkup(
      ContentsConfirmView(viewProps({ preview: preview({ items: [SKILL] }) })),
    );
    expect(out).not.toContain('type="checkbox"');
  });

  it("sends the hash it rendered and hooks false until the tick is on", async () => {
    vi.mocked(fetch).mockResolvedValue(answer(200, { installed: ["spectropowers"] }));
    await confirmInstall("en", "/p", preview(), false, null);
    const first = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)) as Record<string, unknown>;
    expect(first).toEqual({ dir: "/p", contentsHash: HASH, hooks: false });
    await confirmInstall("en", "/p", preview(), true, null);
    const second = JSON.parse(
      String(vi.mocked(fetch).mock.calls.find((c) => String(c[1]?.body).includes('"hooks":true'))?.[1]?.body),
    ) as Record<string, unknown>;
    expect(second.hooks).toBe(true);
  });

  it("says what the install wrote and when it reaches, then reads the list again", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(answer(200, { installed: ["spectropowers", "ship"] }))
      .mockResolvedValueOnce(answer(200, preview()));
    const outcome = await confirmInstall("en", "/p", preview(), false, null);
    expect(outcome.done).toBe(true);
    expect(outcome.names).toEqual(["spectropowers", "ship"]);
    expect(outcome.message).toBe(dict["pc.reach"].en);
    expect(String(vi.mocked(fetch).mock.calls[1][0])).toContain("/api/playbooks/contents?dir=%2Fp");
  });

  it("reads the playbook again after a write, so the step table stops offering what was installed", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(answer(200, { installed: ["spectropowers"] }))
      .mockResolvedValueOnce(answer(200, preview()))
      .mockResolvedValueOnce(answer(200, LOADED));
    await confirmInstall("en", "/p", preview(), false, "/ws");
    const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(
      urls.some((u) => u.startsWith("/api/playbooks/load?dir=%2Fp") && u.includes("workspace=%2Fws")),
    ).toBe(true);

    vi.mocked(fetch).mockReset();
    vi.mocked(fetch)
      .mockResolvedValueOnce(answer(200, { removed: ["spectropowers"], kept: [] }))
      .mockResolvedValueOnce(answer(200, preview()))
      .mockResolvedValueOnce(answer(200, LOADED));
    await confirmRemove("en", "/p", "/ws");
    expect(
      vi.mocked(fetch).mock.calls.some((c) => String(c[0]).startsWith("/api/playbooks/load?dir=%2Fp")),
    ).toBe(true);
  });

  it("does not read the playbook again after a refusal", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      answer(413, { reason: "TOO_LARGE", message: "Over the ceiling.", names: [] }),
    );
    await confirmInstall("en", "/p", preview(), false, null);
    expect(vi.mocked(fetch).mock.calls.some((c) => String(c[0]).includes("/api/playbooks/load"))).toBe(false);
  });

  it("disables install with one taken item, and enables it for the same list without one", () => {
    const taken = preview({
      items: [SKILL, item({ kind: "command", name: "ship", state: "taken", target: "/t" })],
    });
    const blocked = find(
      ContentsConfirmView(viewProps({ preview: taken })),
      (el) => el.props["data-action"] === "install",
    )[0];
    expect(blocked.props.disabled).toBe(true);
    const free = find(ContentsConfirmView(viewProps()), (el) => el.props["data-action"] === "install")[0];
    expect(free.props.disabled).toBe(false);
  });

  it("disables install while the list loads and while findings exist", () => {
    const loading = find(
      ContentsConfirmView(viewProps({ preview: null, loading: true })),
      (el) => el.props["data-action"] === "install",
    )[0];
    expect(loading.props.disabled).toBe(true);
    const found = find(
      ContentsConfirmView(
        viewProps({ preview: preview({ findings: [{ path: "contents.skills[0]", message: "bad" }] }) }),
      ),
      (el) => el.props["data-action"] === "install",
    )[0];
    expect(found.props.disabled).toBe(true);
  });

  it("runs the install handler from the install button", () => {
    const calls: string[] = [];
    const view = ContentsConfirmView(viewProps({ onInstall: () => calls.push("install") }));
    (find(view, (el) => el.props["data-action"] === "install")[0].props.onClick as () => void)();
    expect(calls).toEqual(["install"]);
  });

  it("shows the prompt cost, the hook origin warning and the findings", () => {
    const out = renderToStaticMarkup(
      ContentsConfirmView(
        viewProps({
          preview: preview({
            hooksOrigin: "project",
            findings: [{ path: "contents.hooks[0]", message: "no such file" }],
          }),
        }),
      ),
    );
    expect(out).toContain(dict["pc.promptCost"].en.replace("{n}", "2390"));
    expect(out).toContain(dict["pc.hooks.silenced"].en);
    expect(out).toContain("contents.hooks[0]");
    expect(out).toContain("no such file");
    const quiet = renderToStaticMarkup(ContentsConfirmView(viewProps()));
    expect(quiet).not.toContain(dict["pc.hooks.silenced"].en);
  });

  it("answers a changed folder with the reason and the reloaded list", async () => {
    const newer = preview({
      items: [SKILL, item({ kind: "command", name: "brand-new" })],
      contentsHash: "f".repeat(64),
    });
    vi.mocked(fetch).mockResolvedValueOnce(answer(200, preview()));
    await loadContents("/p", "/ws");
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        answer(409, {
          reason: "CHANGED",
          message: "The folder changed since the list was shown; nothing was written.",
          names: [],
        }),
      )
      .mockResolvedValueOnce(answer(200, newer));
    const outcome = await confirmInstall("en", "/p", preview(), false, "/ws");
    expect(outcome.done).toBe(false);
    expect(outcome.message).toBe(dict["pc.changed"].en);
    const reload = String(vi.mocked(fetch).mock.calls.at(-1)?.[0]);
    expect(reload).toContain("/api/playbooks/contents?dir=%2Fp");
    expect(reload).toContain("workspace=%2Fws");
    const out = renderToStaticMarkup(<ContentsConfirm dir="/p" mode="install" onClose={() => {}} />);
    expect(out).toContain("brand-new");
  });

  it("shows the notice in the dialog", () => {
    const out = renderToStaticMarkup(
      ContentsConfirmView(viewProps({ outcome: { message: dict["pc.changed"].en, names: [], done: false } })),
    );
    expect(out).toContain(dict["pc.changed"].en);
  });

  it("turns an already installed refusal into the localised sentence, other refusals into the server's words", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      answer(409, {
        reason: "ALREADY",
        message: "p is already installed from /old on 2026-10-01; remove it first.",
        names: [],
      }),
    );
    const already = await confirmInstall("en", "/p", preview(), false, null);
    expect(already.message).toBe(
      dict["pc.already"].en.replace("{dir}", "/old").replace("{date}", "2026-10-01"),
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      answer(413, { reason: "TOO_LARGE", message: "Over the ceiling.", names: [] }),
    );
    const large = await confirmInstall("en", "/p", preview(), false, null);
    expect(large.message).toBe("Over the ceiling.");
    expect(large.done).toBe(false);
  });
});

describe("the remove confirmation", () => {
  const installed = preview({
    items: [
      item({ kind: "skill", name: "goes-same", state: "same" }),
      item({ kind: "command", name: "goes-moved", state: "source-changed" }),
      item({ kind: "skill", name: "stays-edited", state: "copy-changed" }),
      item({ kind: "skill", name: "never-installed", state: "new" }),
      WORKFLOW,
    ],
  });

  it("lists what goes and what stays, and leaves out what was never installed", () => {
    const out = renderToStaticMarkup(ContentsConfirmView(viewProps({ mode: "remove", preview: installed })));
    const goes = out.slice(out.indexOf('data-group="goes"'), out.indexOf('data-group="stays"'));
    const stays = out.slice(out.indexOf('data-group="stays"'));
    expect(goes).toContain("goes-same");
    expect(goes).toContain("goes-moved");
    expect(goes).not.toContain("stays-edited");
    expect(stays).toContain("stays-edited");
    expect(stays).not.toContain("goes-same");
    expect(out).not.toContain("never-installed");
    expect(out).not.toContain("nightly.js");
    expect(out).toContain(dict["pc.removeGoes"].en);
    expect(out).toContain(dict["pc.removeStays"].en);
  });

  it("has a remove button wired to its handler and no install button", () => {
    const calls: string[] = [];
    const view = ContentsConfirmView(
      viewProps({ mode: "remove", preview: installed, onRemove: () => calls.push("remove") }),
    );
    expect(find(view, (el) => el.props["data-action"] === "install")).toHaveLength(0);
    (find(view, (el) => el.props["data-action"] === "remove")[0].props.onClick as () => void)();
    expect(calls).toEqual(["remove"]);
  });

  it("names the copies the server kept", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(answer(200, { removed: ["goes-same"], kept: ["stays-edited"] }))
      .mockResolvedValueOnce(answer(200, installed));
    const outcome = await confirmRemove("en", "/p", null);
    expect(outcome.done).toBe(true);
    expect(outcome.names).toEqual(["goes-same"]);
    expect(outcome.message).toBe(dict["pc.kept"].en.replace("{names}", "stays-edited"));
  });

  it("says nothing is installed when nothing is", () => {
    const out = renderToStaticMarkup(ContentsConfirmView(viewProps({ mode: "remove", preview: preview() })));
    expect(out).toContain(dict["pc.removeNothing"].en);
    const btn = find(
      ContentsConfirmView(viewProps({ mode: "remove", preview: preview() })),
      (el) => el.props["data-action"] === "remove",
    )[0];
    expect(btn.props.disabled).toBe(true);
  });
});

describe("the contents row of the playbook module", () => {
  async function pane(p: ContentsPreview): Promise<string> {
    vi.mocked(fetch).mockResolvedValueOnce(answer(200, LOADED));
    await loadPlaybook("/p", "/ws");
    await seed(p);
    return renderToStaticMarkup(
      <PlaybookPane workspace="/ws" sessionId={null} onStartPlaybook={() => false} />,
    );
  }

  it("counts each kind and offers install and remove", async () => {
    const out = await pane(preview());
    const row = /<section[^>]*class="pb-section pc-row"[\s\S]*?<\/section>/.exec(out)?.[0] ?? "";
    expect(row).not.toBe("");
    expect(row).toContain(dict["pc.title"].en);
    expect(row).toContain(
      dict["pc.row"].en
        .replace("{skills}", "1")
        .replace("{commands}", "1")
        .replace("{hooks}", "1")
        .replace("{agents}", "1")
        .replace("{workflows}", "1"),
    );
    expect(row).toContain(dict["pc.install"].en);
    expect(row).toContain(dict["pc.remove"].en);
  });

  it("disables remove while nothing is installed and enables it once something is", async () => {
    const none = await pane(preview());
    expect(/<button[^>]*data-action="remove"[^>]*>/.exec(none)?.[0]).toContain("disabled");
    __resetPlaybookContents();
    const some = await pane(preview({ items: [item({ kind: "skill", name: "x", state: "same" })] }));
    expect(/<button[^>]*data-action="remove"[^>]*>/.exec(some)?.[0]).not.toContain("disabled");
  });

  it("draws no row for a contents list of another folder", async () => {
    const out = await pane(preview({ dir: "/other" }));
    expect(out).not.toContain("pc-row");
  });
});
