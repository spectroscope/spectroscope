// Card 515, decision E: with the switch on Playbook, Generate makes a new
// playbook and no project. The page copies the shipped spectro pack through
// the copy route, reads the copy through the draft route, and writes the
// owner's model choices (fast, standard, strong, judge, offered from the
// provider registry's rows) through the file route, which stores the
// canonical form. The folder is registered by the copy and listed in the
// Playbook tab; nothing is pinned and the generate route of a project is never
// called. Static render with fetch stubbed, the house idiom.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dict } from "../../i18n/i18n";
import { setLang } from "../../state/lang";
import { __resetPlaybooks, usePlaybookFolders } from "../../state/playbooks";
import { __resetProviderRegistry, __seedProviderRows, type ProviderRow } from "../../state/providerRegistry";
import {
  __resetLyzr,
  choose,
  chooseKind,
  chooseModel,
  generatePlaybook,
  loadCatalog,
  MODEL_ROLES,
  type LyzrCatalog,
} from "../../state/spectrolyzr";
import { SpectrolyzrPage } from "./SpectrolyzrPage";

const CATALOG: LyzrCatalog = {
  archetypes: [
    {
      id: "service",
      name: { en: "Service", de: "Dienst" },
      description: { en: "A server", de: "Ein Server" },
    },
  ],
  languages: [{ id: "java", name: "Java" }],
  addons: [],
};

const ROOT = "/real/w/pb";

/** The canonical tree the draft route answers for the fresh copy, shortened to what the page touches. */
function doc(): Record<string, unknown> {
  return {
    schema_version: 1,
    id: "spectro",
    name: "spectro",
    description: "d",
    models: {
      fast: { primary: { provider: "ollama", model: "qwen3.5:27b-q4_K_M" }, fallbacks: [] },
      standard: { primary: { provider: "anthropic", model: "claude-sonnet-5-5" }, fallbacks: [] },
      strong: { primary: { provider: "anthropic", model: "claude-opus-5-5" }, fallbacks: [] },
      judge: {
        primary: { provider: "anthropic", model: "claude-fable-5-1" },
        fallbacks: [{ provider: "ollama", model: "qwen3:8b" }],
      },
    },
    documents: {},
    checks: {},
    vars: {},
    start: "a",
    nodes: [],
    arrows: [],
    contents: { skills: [], agents: [], hooks: [], commands: [], workflows: [] },
  };
}

const ROWS: ProviderRow[] = [
  {
    id: "ollama",
    kind: "local",
    state: "reachable",
    keyPresent: false,
    endpoint: "http://localhost:11434",
    models: ["qwen2.5:7b", "qwen3:8b"],
    live: true,
    reason: null,
    checkedAt: 1,
  },
  {
    id: "anthropic",
    kind: "cloud",
    state: "needs-key",
    keyPresent: false,
    endpoint: null,
    models: ["claude-sonnet-5-5"],
    live: false,
    reason: null,
    checkedAt: 0,
  },
  {
    id: "openai",
    kind: "cloud",
    state: "needs-key",
    keyPresent: false,
    endpoint: null,
    models: [],
    live: false,
    reason: null,
    checkedAt: 0,
  },
];

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[] = [];
let copyAnswer: { status: number; body: unknown } = {
  status: 200,
  body: { dir: ROOT, written: ["LICENSE", "playbook.json", "skills/spectropowers/brainstorming/SKILL.md"] },
};
let putAnswer: { status: number; body: unknown } = { status: 200, body: {} };

function answer(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** The page's markup with the apostrophe React escapes read back, so dictionary text compares as written. */
const html = (): string => renderToStaticMarkup(<SpectrolyzrPage />).replace(/&#x27;/g, "'");
const GENERATE = /<button[^>]*class="lyzr-generate"/;
const GENERATE_OFF = /<button[^>]*class="lyzr-generate"[^>]*disabled=""/;

/** The known folders as the Playbook tab reads them. */
function listedFolders(): string[] {
  function Probe() {
    return createElement("i", { "data-v": usePlaybookFolders().folders.join("|") });
  }
  return (/data-v="([^"]*)"/.exec(renderToStaticMarkup(createElement(Probe)))?.[1] ?? "")
    .split("|")
    .filter((f) => f !== "");
}

beforeEach(async () => {
  __resetLyzr();
  __resetPlaybooks();
  __resetProviderRegistry();
  setLang("en");
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      calls.push({
        url: u,
        method,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      if (u === "/api/spectrolyzr") return Promise.resolve(answer(200, CATALOG));
      if (u === "/api/playbooks/bundled/spectro/copy" && method === "POST")
        return Promise.resolve(answer(copyAnswer.status, copyAnswer.body));
      if (u.startsWith("/api/playbooks/draft?") && method === "GET")
        return Promise.resolve(answer(200, { document: doc(), diskHash: "h-copy", editable: true }));
      if (u.startsWith("/api/playbooks/file?") && method === "PUT")
        return Promise.resolve(answer(putAnswer.status, putAnswer.body));
      return Promise.resolve(answer(404, {}));
    }),
  );
  await loadCatalog();
  calls = [];
  chooseKind("playbook");
});

afterEach(() => {
  __resetLyzr();
  __resetPlaybooks();
  __resetProviderRegistry();
  setLang("en");
  copyAnswer = {
    status: 200,
    body: { dir: ROOT, written: ["LICENSE", "playbook.json", "skills/spectropowers/brainstorming/SKILL.md"] },
  };
  putAnswer = { status: 200, body: {} };
  vi.unstubAllGlobals();
});

describe("Generate on Playbook writes a copy of the spectro pack", () => {
  it("copies, reads the copy and writes the chosen models through the file route, in that order", async () => {
    choose({ playbookDir: "/w/pb" });
    chooseModel("fast", { provider: "ollama", model: "qwen2.5:7b" });
    chooseModel("judge", { provider: "anthropic", model: "claude-sonnet-5-5" });

    const result = await generatePlaybook();

    expect(calls.map((c) => `${c.method} ${c.url.split("?")[0]}`)).toEqual([
      "POST /api/playbooks/bundled/spectro/copy",
      "GET /api/playbooks/draft",
      "PUT /api/playbooks/file",
    ]);
    expect(calls[0].body).toEqual({ dir: "/w/pb" });
    expect(calls[1].url).toBe(`/api/playbooks/draft?dir=${encodeURIComponent(ROOT)}`);
    expect(calls[2].url).toBe(`/api/playbooks/file?dir=${encodeURIComponent(ROOT)}`);
    const put = calls[2].body as { baseHash: string; playbook: ReturnType<typeof doc> };
    expect(put.baseHash).toBe("h-copy");
    const want = doc();
    (want.models as Record<string, unknown>).fast = {
      primary: { provider: "ollama", model: "qwen2.5:7b" },
      fallbacks: [],
    };
    (want.models as Record<string, unknown>).judge = {
      primary: { provider: "anthropic", model: "claude-sonnet-5-5" },
      fallbacks: [{ provider: "ollama", model: "qwen3:8b" }],
    };
    expect(put.playbook).toEqual(want);
    expect(result).toEqual({
      kind: "written",
      project: null,
      playbook: {
        dir: ROOT,
        written: ["LICENSE", "playbook.json", "skills/spectropowers/brainstorming/SKILL.md"],
      },
      pinned: false,
    });
  });

  it("writes the pack's own models when no role was chosen, still through the file route", async () => {
    choose({ playbookDir: "/w/pb" });
    await generatePlaybook();
    const put = calls.find((c) => c.method === "PUT")?.body as { playbook: unknown };
    expect(put.playbook).toEqual(doc());
  });

  it("lists the folder in the Playbook tab, pins nothing and never calls the project generator", async () => {
    choose({
      playbookDir: "/w/pb",
      dir: "/w/project",
      name: "ledger-api",
      archetype: "service",
      language: "java",
    });
    expect(listedFolders()).toEqual([]);
    await generatePlaybook();
    expect(listedFolders()).toEqual([ROOT]);
    expect(calls.some((c) => c.url.startsWith("/api/playbooks/active"))).toBe(false);
    expect(calls.some((c) => c.url.startsWith("/api/spectrolyzr/generate"))).toBe(false);
    expect(calls.some((c) => c.method !== "GET" && JSON.stringify(c.body).includes("/w/project"))).toBe(
      false,
    );
  });

  it("asks for a folder before it sends anything", async () => {
    const result = await generatePlaybook();
    expect(result).toEqual({
      kind: "invalid",
      field: "playbookDir",
      message: "Choose a playbook folder first.",
    });
    expect(calls).toEqual([]);
  });

  it("shows a 409 of the copy route as the project side shows conflicts, and stops there", async () => {
    choose({ playbookDir: "/w/pb" });
    copyAnswer = {
      status: 409,
      body: {
        message: "Some files already exist in the folder; nothing was written.",
        conflicts: ["LICENSE", "playbook.json"],
      },
    };
    const result = await generatePlaybook();
    expect(result).toEqual({ kind: "conflicts", project: [], playbook: ["LICENSE", "playbook.json"] });
    expect(calls).toHaveLength(1);
    const out = html();
    expect(out).toContain(dict["lyzr.conflicts"].en);
    expect((out.match(/<ul class="lyzr-conflicts"/g) ?? []).length).toBe(1);
    expect(out).toMatch(
      /<p class="lyzr-label">Playbook folder<\/p><ul class="lyzr-conflicts"><li>LICENSE<\/li><li>playbook\.json<\/li>/,
    );
    expect(listedFolders()).toEqual([]);
  });

  it("marks the playbook folder when the copy route answers 400", async () => {
    choose({ playbookDir: "/w/nowhere" });
    copyAnswer = { status: 400, body: { message: "Not a folder: /w/nowhere" } };
    const result = await generatePlaybook();
    expect(result).toEqual({ kind: "invalid", field: "playbookDir", message: "Not a folder: /w/nowhere" });
    const out = html();
    expect(out).toMatch(/<input[^>]*class="lyzr-playbook-dir[^"]*is-invalid/);
    expect(out).toContain("Not a folder: /w/nowhere");
  });

  it("says the copy is there with the pack's models when the file route refuses the choices", async () => {
    choose({ playbookDir: "/w/pb" });
    chooseModel("fast", { provider: "ollama", model: "qwen2.5:7b" });
    putAnswer = { status: 400, body: { findings: [{ path: "models.fast", message: "unknown provider" }] } };
    const result = await generatePlaybook();
    expect(result.kind).toBe("failed");
    const message = result.kind === "failed" ? result.message : "";
    expect(message).toContain(ROOT);
    expect(message).toContain("models.fast: unknown provider");
    expect(listedFolders()).toEqual([ROOT]);
    expect(html()).toContain("models.fast: unknown provider");
  });
});

describe("the Playbook side of the page", () => {
  const SELECT = (role: string): RegExp =>
    new RegExp(`<select[^>]*class="lyzr-model"[^>]*data-role="${role}"[^>]*>([\\s\\S]*?)</select>`);

  it("offers the four roles, each with the pack's choice first and one option per model the registry lists", () => {
    __seedProviderRows(ROWS);
    const out = html();
    expect(MODEL_ROLES).toEqual(["fast", "standard", "strong", "judge"]);
    for (const role of MODEL_ROLES) {
      const m = SELECT(role).exec(out);
      expect(m, role).not.toBeNull();
      const options = [...(m?.[1] ?? "").matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map(
        (o) => [o[1], o[2]],
      );
      expect(options).toEqual([
        ["", dict["lyzr.model.keep"].en],
        ["ollama/qwen2.5:7b", "ollama qwen2.5:7b"],
        ["ollama/qwen3:8b", "ollama qwen3:8b"],
        ["anthropic/claude-sonnet-5-5", "anthropic claude-sonnet-5-5"],
      ]);
      expect(out).toContain(dict[`lyzr.model.${role}`].en);
    }
    expect(out).toContain(dict["lyzr.models"].en);
  });

  it("shows the chosen model selected with its provider's state, as the step panel does", () => {
    __seedProviderRows(ROWS);
    chooseModel("strong", { provider: "anthropic", model: "claude-sonnet-5-5" });
    const out = html();
    const strong = SELECT("strong").exec(out)?.[0] ?? "";
    expect(strong).toMatch(/<option value="anthropic\/claude-sonnet-5-5" selected="">/);
    expect(out).toContain("anthropic: needs-key");
    expect(SELECT("fast").exec(out)?.[0]).toMatch(/<option value="" selected="">/);
  });

  it("says the pack's choices stay when no provider has listed a model", () => {
    const out = html();
    expect(out).toContain(dict["lyzr.modelsNone"].en);
    for (const role of MODEL_ROLES)
      expect(SELECT(role).exec(out)?.[1]).toBe(
        `<option value="" selected="">${dict["lyzr.model.keep"].en}</option>`,
      );
  });

  it("enables Generate once a playbook folder is set", () => {
    expect(html()).toMatch(GENERATE_OFF);
    choose({ playbookDir: "/w/pb" });
    const out = html();
    expect(out).toMatch(GENERATE);
    expect(out).not.toMatch(GENERATE_OFF);
  });

  it("names the written folder, says it is in the Playbook tab and claims no pin", async () => {
    choose({ playbookDir: "/w/pb" });
    await generatePlaybook();
    const out = html();
    expect(out).toContain(`Wrote 3 files into ${ROOT}`);
    expect(out).toContain(dict["lyzr.playbookListed"].en);
    expect(out).not.toContain(dict["lyzr.pinned"].en);
    expect((out.match(/<button[^>]*class="lyzr-copy"/g) ?? []).length).toBe(1);
  });

  it("keeps the model choices off the project side", () => {
    __seedProviderRows(ROWS);
    chooseKind("project");
    expect(html()).not.toContain('class="lyzr-model"');
  });

  it("speaks German", async () => {
    __seedProviderRows(ROWS);
    setLang("de");
    choose({ playbookDir: "/w/pb" });
    await generatePlaybook();
    const out = html();
    for (const k of [
      "lyzr.models",
      "lyzr.model.keep",
      "lyzr.model.fast",
      "lyzr.model.judge",
      "lyzr.playbookListed",
    ])
      expect(out, k).toContain(dict[k].de);
  });
});
