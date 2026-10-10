// Card 512: the native folder chooser in the Playbook segment. The pane's path
// field and the wizard's playbook folder field get a Choose button, the
// wizard's project folder keeps its Pick button, and all three go through one
// helper (state/folderPick.ts) that posts to POST /api/pick-workspace, the
// endpoint the folder chip uses. A pick fills the field and nothing else; a
// 409 says a dialog is already open; a 501 or any other failure says to paste
// an absolute path, and the field stays editable. The markup is read through a
// static render, the house idiom of the web suite (no DOM environment).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dict } from "../i18n/i18n";
import { __resetFolderPick, chooseFolder } from "../state/folderPick";
import { setLang } from "../state/lang";
import { __resetPlaybookEditor } from "../state/playbookEditor";
import { __resetPlaybooks, copyBundled, registerFolder } from "../state/playbooks";
import { __resetLyzr, choose, generate, loadCatalog, type LyzrCatalog } from "../state/spectrolyzr";
import { PlaybookPane } from "./PlaybookPane";
import { SpectrolyzrPage } from "./spectrolyzr/SpectrolyzrPage";

const PICK = "/api/pick-workspace";

const CATALOG: LyzrCatalog = {
  archetypes: [
    {
      id: "service",
      name: { en: "Service", de: "Dienst" },
      description: { en: "A server", de: "Ein Server" },
    },
  ],
  languages: [{ id: "java", name: "Java" }],
  addons: [
    {
      id: "spectro-playbook",
      name: { en: "spectro playbook", de: "spectro-Playbook" },
      description: { en: "A playbook folder", de: "Ein Playbook-Ordner" },
    },
  ],
};

function answer(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** What the chooser answers next, and what every other route answers. */
let pickAnswer: () => Promise<Response> = () => Promise.resolve(answer(204));
let otherAnswer: (url: string, init?: RequestInit) => Response = () => answer(404);

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const pane = (): string =>
  renderToStaticMarkup(<PlaybookPane workspace="/ws" sessionId={null} onStartPlaybook={() => false} />);

const wizard = (): string => renderToStaticMarkup(<SpectrolyzrPage />);

/** The calls fetch saw, as [url, init] pairs. */
const calls = (): [string, RequestInit | undefined][] =>
  vi.mocked(fetch).mock.calls.map(([u, i]) => [String(u), i as RequestInit | undefined]);

beforeEach(async () => {
  __resetFolderPick();
  __resetPlaybooks();
  __resetPlaybookEditor();
  __resetLyzr();
  setLang("en");
  pickAnswer = () => Promise.resolve(answer(204));
  otherAnswer = () => answer(404);
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u === PICK) return pickAnswer();
      if (u === "/api/spectrolyzr") return Promise.resolve(answer(200, CATALOG));
      if (u.startsWith("/api/spectrolyzr/preview"))
        return Promise.resolve(answer(200, { files: [], commands: { test: "t", check: "c" } }));
      return Promise.resolve(otherAnswer(u, init));
    }),
  );
  await loadCatalog();
});

afterEach(() => {
  __resetFolderPick();
  __resetPlaybooks();
  __resetPlaybookEditor();
  __resetLyzr();
  setLang("en");
  vi.unstubAllGlobals();
});

describe("the shared chooser helper", () => {
  it("posts to the folder chip's endpoint and hands the picked path to the field", async () => {
    pickAnswer = () => Promise.resolve(answer(200, { path: "/picked/pb" }));
    const apply = vi.fn();
    await chooseFolder("pane", apply);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith("/picked/pb");
    const picks = calls().filter(([u]) => u === PICK);
    expect(picks).toHaveLength(1);
    expect(picks[0][1]?.method).toBe("POST");
  });

  it("leaves the field as it was on a cancel, with no note", async () => {
    pickAnswer = () => Promise.resolve(answer(204));
    const apply = vi.fn();
    await chooseFolder("pane", apply);
    expect(apply).not.toHaveBeenCalled();
    const out = pane();
    expect(out).not.toContain(dict["pick.busy"].en);
    expect(out).not.toContain(dict["pick.paste"].en);
  });

  it("fills nothing on a 409, a 501, a 500 or a network failure", async () => {
    const apply = vi.fn();
    for (const next of [
      () => Promise.resolve(answer(409)),
      () => Promise.resolve(answer(501)),
      () => Promise.resolve(answer(500)),
      () => Promise.reject(new Error("offline")),
    ]) {
      pickAnswer = next;
      await chooseFolder("pane", apply);
    }
    expect(apply).not.toHaveBeenCalled();
  });

  it("clears the last note when the next pick starts", async () => {
    pickAnswer = () => Promise.resolve(answer(501));
    await chooseFolder("pane", () => {});
    expect(pane()).toContain(dict["pick.paste"].en);
    pickAnswer = () => Promise.resolve(answer(200, { path: "/x" }));
    await chooseFolder("pane", () => {});
    expect(pane()).not.toContain(dict["pick.paste"].en);
  });

  it("holds the button label and both notes in English and German", () => {
    for (const k of ["pick.choose", "pick.busy", "pick.paste"]) {
      expect(dict[k]?.en, k).toBeTruthy();
      expect(dict[k]?.de, k).toBeTruthy();
      expect(dict[k].de, k).not.toBe(dict[k].en);
    }
    expect(dict["pick.paste"].en).toMatch(/paste an absolute path/i);
    expect(dict["pick.paste"].de).toMatch(/absoluten Pfad/);
  });
});

describe("the Playbook pane", () => {
  it("draws a Choose button on the path field's row", () => {
    const out = pane();
    const row = /<div class="pb-path-field">([\s\S]*?)<\/div>/.exec(out)?.[1] ?? "";
    expect(row).toMatch(/<input[^>]*class="pb-path"/);
    expect(row).toMatch(/<button[^>]*class="pb-choose"[^>]*>Choose<\/button>/);
    expect(out).toMatch(/<button[^>]*class="pb-add"/);
    expect(out).toMatch(/<button[^>]*class="pb-copy"/);
  });

  it("says a folder dialog is already open after a 409", async () => {
    pickAnswer = () => Promise.resolve(answer(409));
    await chooseFolder("pane", () => {});
    const out = pane();
    expect(out).toContain(dict["pick.busy"].en);
    expect(out).not.toContain(dict["pick.paste"].en);
  });

  it("says to paste an absolute path after a 501 and keeps the field editable", async () => {
    pickAnswer = () => Promise.resolve(answer(501));
    await chooseFolder("pane", () => {});
    const out = pane();
    expect(out).toContain(dict["pick.paste"].en);
    expect(out).not.toContain(dict["pick.busy"].en);
    const input = /<input[^>]*class="pb-path"[^>]*>/.exec(out)?.[0] ?? "";
    expect(input).not.toBe("");
    expect(input).not.toContain("disabled");
    expect(input).not.toContain("readonly");
  });

  it("says both notes in German", async () => {
    setLang("de");
    expect(pane()).toMatch(new RegExp(`class="pb-choose"[^>]*>${dict["pick.choose"].de}<`));
    pickAnswer = () => Promise.resolve(answer(409));
    await chooseFolder("pane", () => {});
    expect(pane()).toContain(dict["pick.busy"].de);
    pickAnswer = () => Promise.resolve(answer(501));
    await chooseFolder("pane", () => {});
    expect(pane()).toContain(dict["pick.paste"].de);
  });

  it("keeps the notes of the pane and the wizard apart", async () => {
    pickAnswer = () => Promise.resolve(answer(409));
    await chooseFolder("lyzrPlaybook", () => {});
    expect(pane()).not.toContain(dict["pick.busy"].en);
  });
});

describe("the wizard's playbook folder", () => {
  async function withPlaybookAddon(): Promise<void> {
    choose({ archetype: "service", language: "java", name: "ledger-api", dir: "/w/ledger-api" });
    choose({ addons: ["spectro-playbook"] });
    await flush();
  }

  it("draws a Choose button on the playbook folder field's row", async () => {
    await withPlaybookAddon();
    const out = wizard();
    const row =
      [...out.matchAll(/<div class="lyzr-target">([\s\S]*?)<\/div>/g)]
        .map((m) => m[1])
        .find((r) => r.includes("lyzr-playbook-dir")) ?? "";
    expect(row).toMatch(/<input[^>]*class="lyzr-playbook-dir[^"]*"/);
    expect(row).toMatch(/<button[^>]*class="lyzr-choose"[^>]*>Choose<\/button>/);
  });

  it("puts the picked folder into the field", async () => {
    await withPlaybookAddon();
    pickAnswer = () => Promise.resolve(answer(200, { path: "/picked/pb" }));
    await chooseFolder("lyzrPlaybook", (path) => choose({ playbookDir: path }));
    expect(wizard()).toMatch(/<input[^>]*class="lyzr-playbook-dir[^"]*"[^>]*value="\/picked\/pb"/);
  });

  it("says a folder dialog is already open after a 409", async () => {
    await withPlaybookAddon();
    pickAnswer = () => Promise.resolve(answer(409));
    await chooseFolder("lyzrPlaybook", () => {});
    const out = wizard();
    expect(out).toContain(dict["pick.busy"].en);
    expect(out).not.toContain(dict["pick.paste"].en);
  });

  it("says to paste an absolute path after a 501 and keeps the field editable", async () => {
    await withPlaybookAddon();
    pickAnswer = () => Promise.resolve(answer(501));
    await chooseFolder("lyzrPlaybook", () => {});
    const out = wizard();
    expect(out).toContain(dict["pick.paste"].en);
    const input = /<input[^>]*class="lyzr-playbook-dir[^"]*"[^>]*>/.exec(out)?.[0] ?? "";
    expect(input).not.toBe("");
    expect(input).not.toContain("disabled");
    expect(input).not.toContain("readonly");
  });
});

describe("the wizard's project folder", () => {
  it("keeps its Pick button and shows the shared helper's notes", async () => {
    choose({ archetype: "service", language: "java", name: "ledger-api", dir: "/w/ledger-api" });
    await flush();
    expect(wizard()).toMatch(/<button[^>]*class="lyzr-pick"/);
    pickAnswer = () => Promise.resolve(answer(409));
    await chooseFolder("lyzrDir", () => {});
    expect(wizard()).toContain(dict["pick.busy"].en);
    pickAnswer = () => Promise.resolve(answer(501));
    await chooseFolder("lyzrDir", () => {});
    expect(wizard()).toContain(dict["pick.paste"].en);
  });
});

describe("a picked folder is validated like a typed one", () => {
  async function picked(path: string): Promise<string> {
    pickAnswer = () => Promise.resolve(answer(200, { path }));
    let got = "";
    await chooseFolder("pane", (p) => {
      got = p;
    });
    return got;
  }

  it("Add sends the same request and gets the same refusal", async () => {
    otherAnswer = () => answer(400, { message: "no playbook.json in /picked/pb" });
    const fromPick = await picked("/picked/pb");
    const typed = "/picked/pb";
    const a = await registerFolder(fromPick).catch((e: unknown) => (e as Error).message);
    const b = await registerFolder(typed).catch((e: unknown) => (e as Error).message);
    expect(a).toBe("no playbook.json in /picked/pb");
    expect(a).toBe(b);
    const adds = calls().filter(([u]) => u === "/api/playbooks/folders");
    expect(adds).toHaveLength(2);
    expect(adds[0]).toEqual(adds[1]);
  });

  it("Copy sends the same request and gets the same conflict list", async () => {
    otherAnswer = () => answer(409, { conflicts: ["playbook.json"] });
    const fromPick = await picked("/picked/pb");
    const a = await copyBundled("spectro", fromPick);
    const b = await copyBundled("spectro", "/picked/pb");
    expect(a.ok).toBe(false);
    expect(a).toEqual(b);
    const copies = calls().filter(([u]) => u.startsWith("/api/playbooks/bundled/"));
    expect(copies).toHaveLength(2);
    expect(copies[0]).toEqual(copies[1]);
  });

  it("the wizard sends the same Generate body and shows the same field error", async () => {
    otherAnswer = () => answer(400, { message: "playbookDir is not empty", field: "playbookDir" });
    choose({ archetype: "service", language: "java", name: "ledger-api", dir: "/w/ledger-api" });
    choose({ addons: ["spectro-playbook"] });
    await flush();
    pickAnswer = () => Promise.resolve(answer(200, { path: "/picked/pb" }));
    await chooseFolder("lyzrPlaybook", (p) => choose({ playbookDir: p }));
    const a = await generate();
    choose({ playbookDir: "" });
    choose({ playbookDir: "/picked/pb" });
    const b = await generate();
    expect(a).toEqual({ kind: "invalid", field: "playbookDir", message: "playbookDir is not empty" });
    expect(a).toEqual(b);
    const gens = calls().filter(([u]) => u === "/api/spectrolyzr/generate");
    expect(gens).toHaveLength(2);
    expect(gens[0][1]?.body).toBe(gens[1][1]?.body);
    expect(JSON.parse(String(gens[0][1]?.body)).playbookDir).toBe("/picked/pb");
  });
});

describe("one request for the chooser", () => {
  const SRC = fileURLToPath(new URL("..", import.meta.url));

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it("is sent from the helper and the three callers that stay as they are, nowhere else", () => {
    const senders = sources(SRC)
      .filter((p) => readFileSync(p, "utf8").includes(PICK))
      .map((p) => relative(SRC, p).split("\\").join("/"))
      .sort();
    expect(senders).toEqual(
      [
        "App.tsx",
        "components/SettingsPanel.tsx",
        "components/StarterDialog.tsx",
        "state/folderPick.ts",
      ].sort(),
    );
  });
});
