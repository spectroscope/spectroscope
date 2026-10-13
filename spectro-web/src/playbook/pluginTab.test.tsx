// Card 526: the Plugin tab of the playbook pane lists the Claude Code
// plugins of this home (GET /api/playbooks/plugin-sources) with a checkbox
// per kind and an Import button, sends the ticked kinds to
// POST /api/playbooks/import-plugin, shows what the server left out word for
// word, and turns to the Skills tab afterwards. No DOM: the pane is rendered on
// the server renderer from the stores and pressed through the drive kit.

import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dict, t } from "../i18n/i18n";
import { __resetBundleEditor, loadTree, PANE_TABS, type TreeView } from "../state/bundleEditor";
import { setLang } from "../state/lang";
import { __resetPlaybookEditor } from "../state/playbookEditor";
import {
  __resetPlaybooks,
  loadPlaybook,
  paneView,
  refreshFolders,
  showFolder,
  type LoadedPlaybook,
} from "../state/playbooks";
import {
  __resetPluginImport,
  importPlugin,
  loadPluginSources,
  pluginImportState,
  type PluginRow,
} from "../state/pluginImport";
import { drive, type El } from "../testkit/driveComponent";
import { read, stripComments } from "../testkit/source";
import { PlaybookPane } from "./PlaybookPane";
import { PluginReport, PluginRowView } from "./PluginTab";

const DIR = "/pb/spectro";

const TREE: TreeView = {
  root: "spectro",
  truncated: false,
  capped: false,
  deeper: [],
  findings: [],
  entries: [],
};

const LOADED: LoadedPlaybook = {
  playbook: {
    id: "spectro",
    name: "spectro",
    description: "",
    start: "s",
    nodes: [{ kind: "end", id: "s", result: "done" }],
    arrows: [],
    models: {},
    documents: {},
    contents: { skills: [], agents: [], hooks: [], commands: [], workflows: [] },
  },
  topology: null,
  findings: [],
  steps: [],
  dir: DIR,
};

const FIXTURE: PluginRow = {
  root: "cache",
  marketplace: "test",
  name: "fixture",
  version: "1.0.0",
  description: "A small plugin for the tests.",
  kinds: { skills: 2, agents: 2, commands: 3, hooks: 0 },
  mcp: true,
  licensed: true,
};

const UNLICENSED: PluginRow = {
  ...FIXTURE,
  root: "marketplace",
  marketplace: "market",
  name: "nolicence",
  version: "",
  mcp: false,
  licensed: false,
};

const REPORT = {
  imported: {
    skills: ["skills/fixture/alpha", "skills/fixture/beta"],
    agents: ["agents/critic.md"],
    commands: [],
    hooks: ["hooks/hooks.json"],
    scripts: ["hooks/guard.sh"],
  },
  already: ["commands/ship.md"],
  dropped: [
    { path: "agents/critic.md", field: "model", reason: "set-by-others" },
    { path: "agents/critic.md", field: "mcpServers", reason: "refused" },
    { path: "agents/critic.md", field: "color", reason: "not-a-playbook-field" },
    { path: "commands/ns/deep.md", field: null, reason: "nested" },
  ],
  droppedHooks: [
    { event: "SessionStart", matcher: "startup", command: "echo hi", reason: "event" },
    { event: "PreToolUse", matcher: "Bash", command: null, reason: "type" },
  ],
  notCopied: [".claude-plugin/plugin.json#mcpServers", ".mcp.json"],
  sha256: "h",
  contents: {},
};

function answer(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

type Route = (url: string, init: RequestInit | undefined) => Response | undefined;
let routes: Route[] = [];

const calls = (): { url: string; init: RequestInit | undefined }[] =>
  vi.mocked(fetch).mock.calls.map(([u, i]) => ({ url: String(u), init: i as RequestInit | undefined }));

beforeEach(() => {
  __resetBundleEditor();
  __resetPlaybooks();
  __resetPlaybookEditor();
  __resetPluginImport();
  setLang("en");
  routes = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      for (const r of routes) {
        const hit = r(u, init);
        if (hit !== undefined) return Promise.resolve(hit);
      }
      if (u.startsWith("/api/playbooks?"))
        return Promise.resolve(answer(200, { folders: [DIR], active: DIR }));
      if (u.startsWith("/api/playbooks/load")) return Promise.resolve(answer(200, LOADED));
      if (u.startsWith("/api/playbooks/tree")) return Promise.resolve(answer(200, TREE));
      if (u.startsWith("/api/playbooks/plugin-sources"))
        return Promise.resolve(answer(200, { plugins: [FIXTURE, UNLICENSED] }));
      return Promise.resolve(answer(404));
    }),
  );
});

afterEach(() => {
  __resetBundleEditor();
  __resetPlaybooks();
  __resetPlaybookEditor();
  __resetPluginImport();
  setLang("en");
  vi.unstubAllGlobals();
});

const pane = <PlaybookPane workspace="/ws" sessionId={null} />;

async function ready(tab: (typeof PANE_TABS)[number]["id"]): Promise<void> {
  await refreshFolders("/ws");
  await loadPlaybook(DIR, "/ws");
  await loadTree(DIR);
  showFolder(DIR, tab);
}

const tabLabels = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*role="tab"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

function one(tree: El[], type: string, cls: string): El {
  const found = tree.filter(
    (el) =>
      el.type === type &&
      String(el.props.className ?? "")
        .split(/\s+/)
        .includes(cls),
  );
  if (found.length !== 1) throw new Error(`expected one <${type} class="${cls}">, found ${found.length}`);
  return found[0];
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the Plugin tab (criterion 4)", () => {
  it("sits between Workflows and Files and is called Plugin in both languages", () => {
    const ids = PANE_TABS.map((x) => x.id);
    expect(ids.indexOf("plugin")).toBe(ids.indexOf("workflows") + 1);
    expect(ids.indexOf("files")).toBe(ids.indexOf("plugin") + 1);
    expect(tabLabels(renderToStaticMarkup(pane))).toContain("Plugin");
    setLang("de");
    expect(tabLabels(renderToStaticMarkup(pane))).toContain("Plugin");
  });

  it("is what the Skills hint points at: the hint names the tab by its label", () => {
    const label = PANE_TABS.find((x) => x.id === "plugin")?.label ?? "";
    expect(dict[label], "the Plugin tab has a label of its own").toBeDefined();
    expect(t("en", label)).toBe("Plugin");
    expect(dict["pbb.skills.hint"].en).toContain(`${t("en", label)} tab`);
    expect(dict["pbb.skills.hint"].de).toContain(`${t("de", label)}-Tab`);
  });

  it("is disabled with a title until a playbook is loaded", () => {
    expect(renderToStaticMarkup(pane)).toMatch(
      /<button[^>]*role="tab"[^>]*disabled=""[^>]*title="Load a playbook first[^"]*"[^>]*>Plugin</,
    );
  });

  it("lists each plugin with its labels, a checkbox per kind and an Import button", async () => {
    await ready("plugin");
    await loadPluginSources(DIR);
    const out = renderToStaticMarkup(pane);
    expect(out).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Plugin</);
    expect(out).toContain("fixture");
    expect(out).toContain("1.0.0");
    expect(out).toContain("plugin cache, test");
    expect(out).toContain("A small plugin for the tests.");
    const key = "cache:test:fixture:1.0.0";
    for (const kind of ["skills", "agents", "commands", "hooks"])
      expect(out).toMatch(new RegExp(`<input[^>]*type="checkbox"[^>]*data-kind="${key}#${kind}"`));
    expect(out).toContain("Skills (2)");
    expect(out).toContain("Commands (3)");
    expect(out).toMatch(
      /<input[^>]*type="checkbox"[^>]*disabled=""[^>]*data-kind="cache:test:fixture:1.0.0#hooks"/,
    );
    expect(out).toMatch(/<input[^>]*type="checkbox"[^>]*data-kind="cache:test:fixture:1.0.0#skills"/);
    expect(out).not.toMatch(/<input[^>]*disabled=""[^>]*data-kind="cache:test:fixture:1.0.0#skills"/);
    expect(out).toContain(dict["pbp.mcp"].en);
    expect(out).toMatch(/class="pbp-go"[^>]*data-plugin="cache:test:fixture:1.0.0"[^>]*>Import</);
    expect(
      calls().some((c) => c.url === `/api/playbooks/plugin-sources?dir=${encodeURIComponent(DIR)}`),
    ).toBe(true);
  });

  it("an unlicensed plugin is shown with the reason and cannot be imported", async () => {
    await ready("plugin");
    await loadPluginSources(DIR);
    const out = renderToStaticMarkup(pane);
    expect(out).toContain("marketplace market");
    expect(out).toContain(dict["pbp.unlicensed"].en);
    expect(out).toMatch(/<input[^>]*disabled=""[^>]*data-kind="marketplace:market:nolicence:#skills"/);
    const tree = drive(
      <PluginRowView row={UNLICENSED} dir={DIR} workspace="/ws" />,
      [PluginRowView],
      [
        (t) =>
          t
            .find((el) => el.props["data-kind"] === "marketplace:market:nolicence:#skills")
            ?.props.onChange?.({ target: { value: "" } }),
      ],
    );
    expect(one(tree, "button", "pbp-go").props.disabled).toBe(true);
    const licensed = drive(
      <PluginRowView row={FIXTURE} dir={DIR} workspace="/ws" />,
      [PluginRowView],
      [
        (t) =>
          t
            .find((el) => el.props["data-kind"] === "cache:test:fixture:1.0.0#skills")
            ?.props.onChange?.({ target: { value: "" } }),
      ],
    );
    expect(one(licensed, "button", "pbp-go").props.disabled).toBe(false);
  });

  it("a home without plugins says so", async () => {
    routes.push((u) =>
      u.startsWith("/api/playbooks/plugin-sources") ? answer(200, { plugins: [] }) : undefined,
    );
    await ready("plugin");
    await loadPluginSources(DIR);
    expect(renderToStaticMarkup(pane)).toContain(dict["pbp.none"].en);
    setLang("de");
    expect(renderToStaticMarkup(pane)).toContain(dict["pbp.none"].de);
  });

  it("Import sends the plugin's labels and the ticked kinds", async () => {
    routes.push((u) => (u === "/api/playbooks/import-plugin" ? answer(200, REPORT) : undefined));
    await ready("plugin");
    await loadPluginSources(DIR);
    drive(
      <PluginRowView row={FIXTURE} dir={DIR} workspace="/ws" />,
      [PluginRowView],
      [
        (tree) =>
          tree
            .find((el) => el.props["data-kind"] === "cache:test:fixture:1.0.0#skills")
            ?.props.onChange?.({ target: { value: "" } }),
        (tree) =>
          tree
            .find((el) => el.props["data-kind"] === "cache:test:fixture:1.0.0#commands")
            ?.props.onChange?.({ target: { value: "" } }),
        (tree) => one(tree, "button", "pbp-go").props.onClick?.(),
      ],
    );
    await settle();
    await settle();
    const sent = calls().find((c) => c.url === "/api/playbooks/import-plugin");
    expect(sent?.init?.method).toBe("POST");
    expect(JSON.parse(String(sent?.init?.body))).toEqual({
      dir: DIR,
      plugin: { root: "cache", marketplace: "test", name: "fixture", version: "1.0.0" },
      kinds: ["skills", "commands"],
    });
  });

  it("Import without a ticked kind is not offered", () => {
    const tree = drive(<PluginRowView row={FIXTURE} dir={DIR} workspace="/ws" />, [PluginRowView], []);
    expect(one(tree, "button", "pbp-go").props.disabled).toBe(true);
  });

  it("after the import the pane turns to Skills and shows what was left out, word for word", async () => {
    routes.push((u) => (u === "/api/playbooks/import-plugin" ? answer(200, REPORT) : undefined));
    await ready("plugin");
    await loadPluginSources(DIR);
    expect(await importPlugin(DIR, "/ws", FIXTURE, ["skills", "agents", "hooks"])).toBe(true);
    expect(paneView().tab).toBe("skills");
    const out = renderToStaticMarkup(pane);
    expect(out).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Skills</);
    expect(out).toContain('class="pbp-report"');
    for (const word of [
      "model",
      "mcpServers",
      "color",
      "commands/ns/deep.md",
      "SessionStart",
      "startup",
      "PreToolUse",
      ".mcp.json",
      ".claude-plugin/plugin.json#mcpServers",
      "skills/fixture/alpha",
      "hooks/guard.sh",
      "commands/ship.md",
    ])
      expect(out, word).toContain(word);
    expect(out).toContain(dict["pbp.why.setByOthers"].en);
    expect(out).toContain(dict["pbp.why.refused"].en);
    expect(out).toContain(dict["pbp.why.event"].en);
    setLang("de");
    const de = renderToStaticMarkup(pane);
    expect(de).toContain(dict["pbp.why.setByOthers"].de);
    expect(de).toContain(dict["pbp.why.hookType"].de);
    expect(de).toContain(dict["pbp.report.notCopied"].de);
  });

  it("the report belongs to its folder: another folder does not draw it", async () => {
    routes.push((u) => (u === "/api/playbooks/import-plugin" ? answer(200, REPORT) : undefined));
    await ready("plugin");
    await importPlugin(DIR, "/ws", FIXTURE, ["skills"]);
    expect(renderToStaticMarkup(<PluginReport dir={DIR} />)).toContain('class="pbp-report"');
    expect(renderToStaticMarkup(<PluginReport dir="/pb/other" />)).toBe("");
  });

  it("the report closes", async () => {
    routes.push((u) => (u === "/api/playbooks/import-plugin" ? answer(200, REPORT) : undefined));
    await ready("plugin");
    await importPlugin(DIR, "/ws", FIXTURE, ["skills"]);
    drive(
      <PluginReport dir={DIR} />,
      [PluginReport],
      [(tree) => one(tree, "button", "pbp-close").props.onClick?.()],
    );
    expect(pluginImportState().report).toBe(null);
    expect(renderToStaticMarkup(pane)).not.toContain('class="pbp-report"');
  });

  it("a refusal stays on the Plugin tab and shows the reason in the language shown", async () => {
    routes.push((u) =>
      u === "/api/playbooks/import-plugin"
        ? answer(400, { reason: "unlicensed", message: "The plugin fixture has no LICENSE at its root." })
        : undefined,
    );
    await ready("plugin");
    await loadPluginSources(DIR);
    expect(await importPlugin(DIR, "/ws", FIXTURE, ["skills"])).toBe(false);
    expect(paneView().tab).toBe("plugin");
    setLang("de");
    const out = renderToStaticMarkup(pane);
    expect(out).toContain(dict["pbb.reason.unlicensed"].de);
    expect(out).not.toContain('class="pbp-report"');
  });

  it("the import reads the tree and the playbook again", async () => {
    routes.push((u) => (u === "/api/playbooks/import-plugin" ? answer(200, REPORT) : undefined));
    await ready("plugin");
    const before = calls().filter((c) => c.url.startsWith("/api/playbooks/tree")).length;
    await importPlugin(DIR, "/ws", FIXTURE, ["skills"]);
    expect(calls().filter((c) => c.url.startsWith("/api/playbooks/tree")).length).toBe(before + 1);
    expect(calls().filter((c) => c.url.startsWith("/api/playbooks/load")).length).toBeGreaterThan(1);
  });
});

describe("strings and chunks", () => {
  it("every pbp key has both languages and no dash", () => {
    const keys = Object.keys(dict).filter((k) => k.startsWith("pbp."));
    expect(keys.length).toBeGreaterThan(15);
    for (const k of keys) {
      expect(dict[k].en.trim(), k).not.toBe("");
      expect(dict[k].de.trim(), k).not.toBe("");
      expect(dict[k].en, k).not.toMatch(/[–—]/);
      expect(dict[k].de, k).not.toMatch(/[–—]/);
    }
    for (const k of ["unlicensed", "not-an-agent", "hooks-unreadable", "pack-is-playbook-id", "script-name"])
      expect(dict[`pbb.reason.${k}`], k).toBeDefined();
  });

  it("every reason the plugin reader answers has a sentence in both languages", () => {
    const java = read(
      "../../../spectro-server/src/main/java/dev/spectroscope/server/playbooks/PluginSources.java",
      import.meta.url,
    );
    const reasons = [...new Set([...java.matchAll(/new Refusal\(\d+, "([a-z-]+)"/g)].map((m) => m[1]))];
    expect(reasons).toContain("unlicensed");
    expect(reasons.length).toBeGreaterThan(6);
    for (const r of reasons) {
      const entry = dict[`pbb.reason.${r}`];
      expect(entry, r).toBeDefined();
      expect(entry.en.trim(), r).not.toBe("");
      expect(entry.de.trim(), r).not.toBe("");
    }
  });

  it("every pbp key is read by the Plugin tab, its store or the pane", () => {
    const code = [
      "./PluginTab.tsx",
      "./PlaybookPane.tsx",
      "../state/pluginImport.ts",
      "../state/bundleEditor.ts",
    ]
      .map((f) => stripComments(read(f, import.meta.url)))
      .join("\n");
    const unused = Object.keys(dict)
      .filter((k) => k.startsWith("pbp."))
      .filter((k) => !code.includes(`"${k}"`));
    expect(unused).toEqual([]);
  });

  it("the Plugin tab lives in the pane's chunk: no source but PlaybookPane.tsx imports PluginTab", () => {
    const src = fileURLToPath(new URL("..", import.meta.url));
    const sources: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const at = `${dir}/${name}`;
        if (statSync(at).isDirectory()) walk(at);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) sources.push(at.slice(src.length));
      }
    };
    walk(src.replace(/\/$/, ""));
    expect(sources.length).toBeGreaterThan(100);
    const importers = sources.filter((rel) =>
      /(?:from|import)\s*\(?\s*["'][^"']*\/PluginTab(?:\.tsx)?["']/.test(
        stripComments(read(`../${rel.replace(/^\//, "")}`, import.meta.url)),
      ),
    );
    expect(importers.map((r) => r.replace(/^\//, ""))).toEqual(["playbook/PlaybookPane.tsx"]);
  });
});
