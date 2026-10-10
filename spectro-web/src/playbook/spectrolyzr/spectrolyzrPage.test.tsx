// Card 515, decisions A and C: Spectrolyzr as one page in the shape of an
// initializr. Every choice is in sight at once (archetype, language, name,
// add-ons, the folders), the file tree with the Why sentence sits beside them,
// Generate is at the bottom, and a switch at the top says whether the page
// makes a new project or a new playbook. The tests of the three step wizard
// (card 484) moved here. The store is seeded through its own functions with
// fetch stubbed; the markup is read through a static render, the house idiom
// of the web suite (no DOM environment).

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dict } from "../../i18n/i18n";
import { setLang } from "../../state/lang";
import {
  __resetLyzr,
  choose,
  chooseKind,
  generate,
  loadCatalog,
  suggestPlaybookDir,
  type LyzrCatalog,
  type LyzrPreview,
} from "../../state/spectrolyzr";
import { followingPlaybookDir } from "./folders";
import { SpectrolyzrPage } from "./SpectrolyzrPage";

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

const html = (): string => renderToStaticMarkup(<SpectrolyzrPage />);

const count = (out: string, re: RegExp): number => [...out.matchAll(re)].length;

/** Where a pattern first matches, or -1. */
const at = (out: string, re: RegExp): number => out.search(re);

/** The markup inside the first element that opens with `open`, up to its matching close. */
function block(out: string, open: RegExp): string {
  const m = open.exec(out);
  if (m === null) return "";
  const tag = /^<([a-z0-9]+)/.exec(m[0])?.[1] ?? "div";
  let depth = 0;
  const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, "g");
  re.lastIndex = m.index;
  for (let t = re.exec(out); t !== null; t = re.exec(out)) {
    depth += t[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return out.slice(m.index, t.index + t[0].length);
  }
  return out.slice(m.index);
}

const GENERATE = /<button[^>]*class="lyzr-generate"/;
const GENERATE_OFF = /<button[^>]*class="lyzr-generate"[^>]*disabled=""/;

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

describe("one page, every choice in sight", () => {
  it("draws archetypes, languages, the name, the add-ons and the project folder at once, with no steps", () => {
    const out = html();
    expect(count(out, /<button[^>]*class="lyzr-card[ "]/g)).toBe(3);
    expect(count(out, /<button[^>]*class="lyzr-lang[ "]/g)).toBe(3);
    expect(out).toMatch(/<input[^>]*class="lyzr-name[ "]/);
    expect(count(out, /<input[^>]*type="checkbox"[^>]*class="lyzr-addon"/g)).toBe(3);
    expect(out).toMatch(/<input[^>]*class="lyzr-dir[ "]/);
    expect(out).toMatch(/<button[^>]*class="lyzr-pick"/);
    for (const a of CATALOG.archetypes) expect(out).toContain(a.name.en);
    for (const l of CATALOG.languages) expect(out).toContain(l.name);
    for (const a of CATALOG.addons) expect(out).toContain(a.description.en);
    expect(out).toContain(dict["lyzr.nameRule"].en);
    expect(out).not.toContain("lyzr-rail");
    expect(out).not.toContain("lyzr-next");
    expect(out).not.toContain("lyzr-back");
  });

  it("puts the choices in one column and the file tree beside them, Generate below both", async () => {
    await chooseAll({ addons: ["ci", "spectro-playbook"], dir: "/w/ledger-api" });
    const out = html();
    const form = block(out, /<div class="lyzr-form"/);
    const files = block(out, /<aside class="lyzr-files"/);
    expect(form).toContain('class="lyzr-card');
    expect(form).toContain('class="lyzr-addon"');
    expect(form).toContain('class="lyzr-dir');
    expect(form).toContain('class="lyzr-playbook-dir');
    expect(form).not.toContain('role="tree"');
    expect(files).toContain('role="tree"');
    expect(files).toContain(dict["lyzr.why"].en);
    expect(files).toContain(PREVIEW.files[0].why.en);
    const page = block(out, /<div class="lyzr-page"/);
    expect(page).toContain(form);
    expect(page).toContain(files);
    expect(at(out, GENERATE)).toBeGreaterThan(at(out, /<\/aside>/));
    expect(at(out, GENERATE)).toBeGreaterThan(at(out, /class="lyzr-dir/));
  });

  it("says where the files will appear before the choices are complete", () => {
    const files = block(html(), /<aside class="lyzr-files"/);
    expect(files).toContain(dict["lyzr.treeEmpty"].en);
    expect(files).not.toContain('role="tree"');
  });

  it("keeps Generate disabled until archetype, language, a valid name and the folder are set", async () => {
    expect(html()).toMatch(GENERATE_OFF);
    choose({ archetype: "service", language: "java" });
    choose({ name: "Ledger API" });
    await flush();
    expect(html()).toMatch(GENERATE_OFF);
    choose({ name: "ledger-api" });
    await flush();
    expect(html()).toMatch(GENERATE_OFF);
    choose({ dir: "/w/ledger-api" });
    const out = html();
    expect(out).toMatch(GENERATE);
    expect(out).not.toMatch(GENERATE_OFF);
  });

  it("marks the chosen archetype and language", async () => {
    await chooseAll();
    const out = html();
    expect(out).toMatch(/class="lyzr-card is-on"[^>]*aria-pressed="true"[^>]*>[\s\S]*?Service/);
    expect(out).toMatch(/class="lyzr-lang is-on"[^>]*aria-pressed="true"[^>]*>Java</);
  });
});

describe("the playbook folder of a new project", () => {
  it("is absent while the playbook add-on is off", async () => {
    await chooseAll({ dir: "/w/ledger-api" });
    expect(html()).not.toContain('class="lyzr-playbook-dir');
  });

  it("appears with the playbook add-on, prefilled beside the project", async () => {
    await chooseAll({ dir: "/w/ledger-api", addons: ["spectro-playbook"] });
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
    expect(html()).toMatch(/<input[^>]*class="lyzr-playbook-dir[^"]*"[^>]*value="\/elsewhere\/pb"/);
  });
});

describe("the files and the summary", () => {
  it("shows the tree, the Why sentence of the selected file, the commands and both folders", async () => {
    await chooseAll({ addons: ["ci", "spectro-playbook"], dir: "/w/ledger-api" });
    const out = html();
    expect(out).toContain("README.md");
    expect(out).toContain("App.java");
    expect(out).toContain("playbook.json");
    expect(out).toContain(dict["lyzr.summary"].en);
    expect(out).toContain("gradle test");
    expect(out).toContain("gradle gate");
    expect(out).toContain(dict["lyzr.testCommand"].en);
    expect(out).toContain(dict["lyzr.checkCommand"].en);
    expect(out).toContain("/w/ledger-api-playbook");
  });

  it("lists both conflict lists after a 409", async () => {
    await chooseAll({ addons: ["spectro-playbook"], dir: "/w/ledger-api" });
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
    expect(at(out, /class="lyzr-result/)).toBeGreaterThan(at(out, GENERATE));
  });

  it("marks the field a 400 names, on the same page", async () => {
    await chooseAll({ dir: "relative/path" });
    generateAnswer = { status: 400, body: { message: "dir must be absolute", field: "dir" } };
    await generate();
    let out = html();
    expect(out).toMatch(/<input[^>]*class="lyzr-dir[^"]*is-invalid/);
    expect(out).toContain("dir must be absolute");

    generateAnswer = { status: 400, body: { message: "bad name", field: "name" } };
    await generate();
    out = html();
    expect(out).toMatch(/<input[^>]*class="lyzr-name[^"]*is-invalid/);
    expect(out).toContain("bad name");
  });

  it("names both folders, says the playbook is pinned and offers Copy path when done", async () => {
    await chooseAll({ addons: ["spectro-playbook"], dir: "/w/ledger-api" });
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

describe("the switch Project or Playbook", () => {
  const SWITCH = /<div class="lyzr-kind"[^>]*role="group"/;

  it("sits at the top with Project pressed", () => {
    const out = html();
    expect(out).toMatch(SWITCH);
    const sw = block(out, SWITCH);
    expect(sw).toMatch(/<button[^>]*class="lyzr-kind-option is-on"[^>]*aria-pressed="true"[^>]*>Project</);
    expect(sw).toMatch(/<button[^>]*class="lyzr-kind-option"[^>]*aria-pressed="false"[^>]*>Playbook</);
    expect(at(out, SWITCH)).toBeLessThan(at(out, /class="lyzr-card/));
  });

  it("on Playbook hides the project's choices and keeps the playbook folder with its Choose button", async () => {
    await chooseAll({ addons: ["spectro-playbook"], dir: "/w/ledger-api", playbookDir: "/w/pb" });
    chooseKind("playbook");
    const out = html();
    expect(block(out, SWITCH)).toMatch(/aria-pressed="true"[^>]*>Playbook</);
    expect(out).not.toContain('class="lyzr-card');
    expect(out).not.toContain('class="lyzr-lang');
    expect(out).not.toMatch(/class="lyzr-name[ "]/);
    expect(out).not.toContain('class="lyzr-addon"');
    expect(out).not.toMatch(/class="lyzr-dir[ "]/);
    expect(out).not.toContain('class="lyzr-pick"');
    expect(out).not.toContain('role="tree"');
    const form = block(out, /<div class="lyzr-form"/);
    expect(form).toMatch(/<input[^>]*class="lyzr-playbook-dir[^"]*"[^>]*value="\/w\/pb"/);
    expect(form).toMatch(/<button[^>]*class="lyzr-choose"[^>]*>Choose<\/button>/);
    expect(out).toContain(dict["lyzr.playbookOnlyHint"].en);
    expect(out).not.toContain(dict["lyzr.playbookDirHint"].en);
    expect(out).toMatch(GENERATE);
    expect(out).toMatch(GENERATE_OFF);
  });

  it("does not offer the project folder's sibling as a playbook folder on Playbook", async () => {
    await chooseAll({ addons: ["spectro-playbook"], dir: "/w/ledger-api" });
    chooseKind("playbook");
    expect(html()).toMatch(/<input[^>]*class="lyzr-playbook-dir[^"]*"[^>]*value=""/);
  });

  it("gives every choice back when switched to Project again", async () => {
    await chooseAll({ addons: ["ci"], dir: "/w/ledger-api" });
    chooseKind("playbook");
    chooseKind("project");
    const out = html();
    expect(out).toMatch(/class="lyzr-card is-on"[^>]*aria-pressed="true"[^>]*>[\s\S]*?Service/);
    expect(out).toMatch(/<input[^>]*class="lyzr-name[^"]*"[^>]*value="ledger-api"/);
    expect(out).toMatch(/<input[^>]*class="lyzr-dir[^"]*"[^>]*value="\/w\/ledger-api"/);
    expect(out).toContain('role="tree"');
  });
});

describe("the language", () => {
  it("changes every label and the Why sentence when switched to German", async () => {
    await chooseAll({ addons: ["spectro-playbook"], dir: "/w/ledger-api" });
    setLang("de");
    const out = html();
    for (const k of [
      "lyzr.kind.project",
      "lyzr.kind.playbook",
      "lyzr.archetype",
      "lyzr.language",
      "lyzr.name",
      "lyzr.nameRule",
      "lyzr.addons",
      "lyzr.dir",
      "lyzr.pick",
      "lyzr.playbookDir",
      "pick.choose",
      "lyzr.why",
      "lyzr.summary",
      "lyzr.testCommand",
      "lyzr.checkCommand",
      "lyzr.generate",
    ])
      expect(out, k).toContain(dict[k].de);
    expect(out).toContain("Dienst");
    expect(out).not.toContain(">Service<");
    expect(out).toContain("Ein Playbook-Ordner");
    expect(out).toContain(PREVIEW.files[0].why.de);
    expect(out).not.toContain(PREVIEW.files[0].why.en);

    chooseKind("playbook");
    expect(html()).toContain(dict["lyzr.playbookOnlyHint"].de);
  });
});

describe("the playbook folder follows the project", () => {
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
