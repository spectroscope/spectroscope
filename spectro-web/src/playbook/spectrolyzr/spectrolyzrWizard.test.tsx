// Card 484, Task 11: the Spectrolyzr wizard. Three steps on one rail: the
// project (archetype, language, name), the add-ons (with the playbook folder
// only when the playbook add-on is on), and the review (tree, Why sentence,
// summary, project folder, Generate). The store is seeded through its own
// functions with fetch stubbed; the markup is read through a static render,
// the house idiom of the web suite (no DOM environment).

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dict } from "../../i18n/i18n";
import { setLang } from "../../state/lang";
import {
  __resetLyzr,
  choose,
  generate,
  goTo,
  loadCatalog,
  suggestPlaybookDir,
  type LyzrCatalog,
  type LyzrPreview,
} from "../../state/spectrolyzr";
import { followingPlaybookDir } from "./folders";
import { SpectrolyzrWizard } from "./SpectrolyzrWizard";

const CATALOG: LyzrCatalog = {
  archetypes: [
    {
      id: "service",
      name: { en: "Service", de: "Dienst" },
      description: { en: "A server", de: "Ein Server" },
    },
    {
      id: "library",
      name: { en: "Library", de: "Bibliothek" },
      description: { en: "A function", de: "Eine Funktion" },
    },
    {
      id: "cli",
      name: { en: "Command line tool", de: "Kommandozeilenprogramm" },
      description: { en: "A command", de: "Ein Befehl" },
    },
  ],
  languages: [
    { id: "typescript", name: "TypeScript" },
    { id: "python", name: "Python" },
    { id: "java", name: "Java" },
  ],
  addons: [
    {
      id: "quality-gate",
      name: { en: "Quality gate", de: "Quality Gate" },
      description: { en: "QG", de: "QG de" },
    },
    { id: "ci", name: { en: "CI", de: "CI" }, description: { en: "Workflow", de: "Workflow de" } },
    {
      id: "spectro-playbook",
      name: { en: "spectro playbook", de: "spectro-Playbook" },
      description: { en: "A playbook folder", de: "Ein Playbook-Ordner" },
    },
  ],
};

const PREVIEW: LyzrPreview = {
  files: [
    {
      root: "project",
      path: "README.md",
      why: { en: "Explains how to run the tests.", de: "Erklärt, wie die Tests laufen." },
      size: 12,
      content: "# ledger-api\n",
    },
    {
      root: "project",
      path: "src/main/java/App.java",
      why: { en: "The server.", de: "Der Server." },
      size: 10,
      content: "class App {}\n",
    },
    {
      root: "playbook",
      path: "playbook.json",
      why: { en: "The playbook.", de: "Das Playbook." },
      size: 2,
      content: "{}\n",
    },
  ],
  commands: { test: "gradle test", check: "gradle gate" },
};

let generateAnswer: { status: number; body: unknown } = { status: 200, body: {} };

function answer(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const html = (): string => renderToStaticMarkup(<SpectrolyzrWizard />);

const count = (out: string, re: RegExp): number => [...out.matchAll(re)].length;

async function chooseAll(extra: Parameters<typeof choose>[0] = {}): Promise<void> {
  choose({ archetype: "service", language: "java", name: "ledger-api", ...extra });
  await flush();
}

beforeEach(async () => {
  __resetLyzr();
  setLang("en");
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL | Request) => {
      const u = String(url);
      if (u === "/api/spectrolyzr") return Promise.resolve(answer(200, CATALOG));
      if (u.startsWith("/api/spectrolyzr/preview")) return Promise.resolve(answer(200, PREVIEW));
      if (u === "/api/spectrolyzr/generate")
        return Promise.resolve(answer(generateAnswer.status, generateAnswer.body));
      return Promise.resolve(answer(404, {}));
    }),
  );
  await loadCatalog();
});

afterEach(() => {
  __resetLyzr();
  setLang("en");
  generateAnswer = { status: 200, body: {} };
  vi.unstubAllGlobals();
});

describe("step 1, the project", () => {
  it("shows three archetype cards and three languages", () => {
    const out = html();
    expect(count(out, /<button[^>]*class="lyzr-card[ "]/g)).toBe(3);
    expect(count(out, /<button[^>]*class="lyzr-lang[ "]/g)).toBe(3);
    for (const a of CATALOG.archetypes) expect(out).toContain(a.name.en);
    for (const l of CATALOG.languages) expect(out).toContain(l.name);
    expect(out).toContain(dict["lyzr.nameRule"].en);
  });

  it("keeps Next disabled until archetype, language and a valid name are set", async () => {
    expect(html()).toMatch(/<button[^>]*class="lyzr-next"[^>]*disabled=""/);
    choose({ archetype: "service" });
    expect(html()).toMatch(/<button[^>]*class="lyzr-next"[^>]*disabled=""/);
    choose({ language: "java" });
    expect(html()).toMatch(/<button[^>]*class="lyzr-next"[^>]*disabled=""/);
    choose({ name: "Ledger API" });
    expect(html()).toMatch(/<button[^>]*class="lyzr-next"[^>]*disabled=""/);
    choose({ name: "ledger-api" });
    await flush();
    const out = html();
    expect(out).toMatch(/<button[^>]*class="lyzr-next"/);
    expect(out).not.toMatch(/<button[^>]*class="lyzr-next"[^>]*disabled=""/);
  });

  it("marks the chosen archetype and language", async () => {
    await chooseAll();
    const out = html();
    expect(out).toMatch(/class="lyzr-card is-on"[^>]*aria-pressed="true"[^>]*>[\s\S]*?Service/);
    expect(out).toMatch(/class="lyzr-lang is-on"[^>]*aria-pressed="true"[^>]*>Java</);
  });
});

describe("step 2, the add-ons", () => {
  it("shows three add-ons and no playbook folder field while the playbook add-on is off", async () => {
    await chooseAll({ dir: "/w/ledger-api" });
    goTo(2);
    const out = html();
    expect(count(out, /<input[^>]*type="checkbox"[^>]*class="lyzr-addon"/g)).toBe(3);
    for (const a of CATALOG.addons) expect(out).toContain(a.description.en);
    expect(out).not.toContain('class="lyzr-playbook-dir');
  });

  it("shows the playbook folder field with the playbook add-on, prefilled beside the project", async () => {
    await chooseAll({ dir: "/w/ledger-api", addons: ["spectro-playbook"] });
    goTo(2);
    const out = html();
    const suggested = suggestPlaybookDir("/w/ledger-api", "ledger-api");
    expect(suggested).toBe("/w/ledger-api-playbook");
    expect(out).toMatch(
      new RegExp(`<input[^>]*class="lyzr-playbook-dir[^"]*"[^>]*value="${suggested.replace(/[/]/g, "\\/")}"`),
    );
    expect(out).toContain(dict["lyzr.playbookDirHint"].en);
  });

  it("keeps a playbook folder the owner typed", async () => {
    await chooseAll({ dir: "/w/ledger-api", addons: ["spectro-playbook"], playbookDir: "/elsewhere/pb" });
    goTo(2);
    expect(html()).toMatch(/<input[^>]*class="lyzr-playbook-dir[^"]*"[^>]*value="\/elsewhere\/pb"/);
  });
});

describe("step 3, the review", () => {
  it("shows the tree, the Why sentence of the selected file, the summary and Generate", async () => {
    await chooseAll({ addons: ["ci", "spectro-playbook"], dir: "/w/ledger-api" });
    goTo(3);
    const out = html();
    expect(out).toContain('role="tree"');
    expect(out).toContain("README.md");
    expect(out).toContain("App.java");
    expect(out).toContain("playbook.json");
    expect(out).toContain(dict["lyzr.why"].en);
    expect(out).toContain(PREVIEW.files[0].why.en);
    expect(out).toContain(dict["lyzr.summary"].en);
    expect(out).toContain("gradle test");
    expect(out).toContain("gradle gate");
    expect(out).toContain(dict["lyzr.testCommand"].en);
    expect(out).toContain(dict["lyzr.checkCommand"].en);
    expect(out).toContain("/w/ledger-api-playbook");
    expect(out).toMatch(/<button[^>]*class="lyzr-generate"/);
    expect(out).toMatch(/<button[^>]*class="lyzr-pick"/);
  });

  it("lists both conflict lists after a 409", async () => {
    await chooseAll({ addons: ["spectro-playbook"], dir: "/w/ledger-api" });
    goTo(3);
    generateAnswer = {
      status: 409,
      body: { message: "exists", conflicts: { project: ["README.md"], playbook: ["playbook.json"] } },
    };
    await generate();
    const out = html();
    expect(out).toContain(dict["lyzr.conflicts"].en);
    expect(out).toMatch(/class="lyzr-conflicts"[\s\S]*?README\.md[\s\S]*?<\/ul>/);
    expect(count(out, /<ul class="lyzr-conflicts"/g)).toBe(2);
    expect(out).toMatch(/<ul class="lyzr-conflicts"[^>]*>[\s\S]*?playbook\.json/);
  });

  it("marks the field a 400 names", async () => {
    await chooseAll({ dir: "relative/path" });
    goTo(3);
    generateAnswer = { status: 400, body: { message: "dir must be absolute", field: "dir" } };
    await generate();
    const out = html();
    expect(out).toMatch(/<input[^>]*class="lyzr-dir[^"]*is-invalid/);
    expect(out).toContain("dir must be absolute");

    generateAnswer = { status: 400, body: { message: "bad name", field: "name" } };
    await generate();
    goTo(1);
    expect(html()).toMatch(/<input[^>]*class="lyzr-name[^"]*is-invalid/);
  });

  it("names both folders, says the playbook is pinned and offers Copy path when done", async () => {
    await chooseAll({ addons: ["spectro-playbook"], dir: "/w/ledger-api" });
    goTo(3);
    generateAnswer = {
      status: 200,
      body: {
        project: { dir: "/w/ledger-api", written: ["README.md", "src/main/java/App.java"] },
        playbook: { dir: "/w/ledger-api-playbook", written: ["playbook.json"] },
        pinned: true,
      },
    };
    await generate();
    const out = html();
    expect(out).toContain("Wrote 2 files into /w/ledger-api");
    expect(out).toContain("Wrote 1 files into /w/ledger-api-playbook");
    expect(out).toContain(dict["lyzr.pinned"].en);
    expect(count(out, /<button[^>]*class="lyzr-copy"/g)).toBe(2);
  });
});

describe("the language", () => {
  it("changes every label and the Why sentence when switched to German", async () => {
    await chooseAll({ addons: ["spectro-playbook"], dir: "/w/ledger-api" });
    setLang("de");
    const step1 = html();
    for (const k of [
      "lyzr.step.project",
      "lyzr.step.addons",
      "lyzr.step.review",
      "lyzr.language",
      "lyzr.name",
    ])
      expect(step1, k).toContain(dict[k].de);
    expect(step1).toContain(dict["lyzr.nameRule"].de);
    expect(step1).toContain(dict["lyzr.next"].de);
    expect(step1).toContain("Dienst");
    expect(step1).not.toContain(">Service<");

    goTo(2);
    const step2 = html();
    expect(step2).toContain(dict["lyzr.playbookDir"].de);
    expect(step2).toContain(dict["lyzr.back"].de);
    expect(step2).toContain("Ein Playbook-Ordner");

    goTo(3);
    const step3 = html();
    for (const k of [
      "lyzr.why",
      "lyzr.summary",
      "lyzr.testCommand",
      "lyzr.checkCommand",
      "lyzr.generate",
      "lyzr.pick",
    ])
      expect(step3, k).toContain(dict[k].de);
    expect(step3).toContain(PREVIEW.files[0].why.de);
    expect(step3).not.toContain(PREVIEW.files[0].why.en);
  });
});

describe("the playbook folder", () => {
  const base = {
    archetype: "service",
    language: "java",
    addons: ["spectro-playbook"],
    name: "ledger-api",
    dir: "/w/a/ledger-api",
    playbookDir: "",
  };

  it("follows the project folder while it holds the suggestion", () => {
    const held = { ...base, playbookDir: "/w/a/ledger-api-playbook" };
    expect(followingPlaybookDir(held, { dir: "/w/b/ledger-lib" })).toEqual({
      dir: "/w/b/ledger-lib",
      playbookDir: "/w/b/ledger-api-playbook",
    });
    expect(followingPlaybookDir(held, { name: "ledger-lib" })).toEqual({
      name: "ledger-lib",
      playbookDir: "/w/a/ledger-lib-playbook",
    });
  });

  it("keeps a folder the owner typed, and an empty one", () => {
    expect(followingPlaybookDir({ ...base, playbookDir: "/elsewhere/pb" }, { dir: "/w/b/x" })).toEqual({
      dir: "/w/b/x",
    });
    expect(followingPlaybookDir(base, { dir: "/w/b/x" })).toEqual({ dir: "/w/b/x" });
  });
});
