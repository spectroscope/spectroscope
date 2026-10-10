import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetLyzr,
  choose,
  chooseKind,
  generate,
  loadCatalog,
  suggestPlaybookDir,
  useLyzr,
  type LyzrCatalog,
} from "./spectrolyzr";

let fetchMock: ReturnType<typeof vi.fn>;

type Snapshot = ReturnType<typeof useLyzr>;

/** What the hook answers right now, read through a real render. */
function probe(): Snapshot {
  function Probe() {
    return createElement("i", { "data-v": JSON.stringify(useLyzr()) });
  }
  const html = renderToStaticMarkup(createElement(Probe));
  const raw = /data-v="([^"]*)"/.exec(html)?.[1] ?? "";
  return JSON.parse(
    raw
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&#x27;/g, "'"),
  ) as Snapshot;
}

function answer(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const CATALOG: LyzrCatalog = {
  archetypes: [
    {
      id: "service",
      name: { en: "Service", de: "Dienst" },
      description: { en: "A service", de: "Ein Dienst" },
    },
    {
      id: "library",
      name: { en: "Library", de: "Bibliothek" },
      description: { en: "A library", de: "Eine Bibliothek" },
    },
    {
      id: "cli",
      name: { en: "Command line tool", de: "Kommandozeilenwerkzeug" },
      description: { en: "A tool", de: "Ein Werkzeug" },
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
      name: { en: "Quality gate", de: "Qualitätstor" },
      description: { en: "q", de: "q" },
    },
    { id: "ci", name: { en: "CI", de: "CI" }, description: { en: "c", de: "c" } },
    { id: "spectro-playbook", name: { en: "Playbook", de: "Playbook" }, description: { en: "p", de: "p" } },
  ],
};

const PREVIEW = {
  files: [
    {
      root: "project",
      path: "build.gradle.kts",
      why: { en: "The build.", de: "Der Build." },
      size: 12,
      content: "plugins {}\n",
    },
  ],
  commands: { test: "gradle test", check: "gradle test" },
};

const PREVIEW_URL = "/api/spectrolyzr/preview?archetype=service&language=java&addons=ci&name=ledger-api";

/** Fetch answers by URL; any call not listed fails the test. */
function serve(routes: Record<string, () => Response>): void {
  fetchMock.mockImplementation((url: string) => {
    const route = routes[url];
    if (route === undefined) return Promise.reject(new Error(`unexpected fetch ${url}`));
    return Promise.resolve(route());
  });
}

beforeEach(() => {
  __resetLyzr();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the catalog", () => {
  it("loads from GET /api/spectrolyzr into the store", async () => {
    serve({ "/api/spectrolyzr": () => answer(200, CATALOG) });
    expect(probe().catalog).toBeNull();
    await loadCatalog();
    expect(fetchMock).toHaveBeenCalledWith("/api/spectrolyzr");
    expect(probe().catalog).toEqual(CATALOG);
  });

  it("throws the server's words for a refused catalog and keeps none", async () => {
    serve({ "/api/spectrolyzr": () => answer(500, { message: "manifest broken" }) });
    await expect(loadCatalog()).rejects.toThrow("manifest broken");
    expect(probe().catalog).toBeNull();
  });
});

describe("choices and the preview", () => {
  beforeEach(async () => {
    serve({ "/api/spectrolyzr": () => answer(200, CATALOG), [PREVIEW_URL]: () => answer(200, PREVIEW) });
    await loadCatalog();
  });

  it("starts empty, on a new project", () => {
    const s = probe();
    expect(s.kind).toBe("project");
    expect(s.choices).toEqual({
      archetype: null,
      language: null,
      addons: [],
      name: "",
      dir: "",
      playbookDir: "",
    });
    expect(s.preview).toBeNull();
    expect(s.result).toBeNull();
  });

  it("fetches the preview once archetype, language and a name are set", async () => {
    choose({ archetype: "service", language: "java", addons: ["ci"], name: "ledger-api" });
    await vi.waitFor(() => expect(probe().preview).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(PREVIEW_URL);
    expect(probe().preview).toEqual(PREVIEW);
  });

  it("fetches nothing while a choice is missing", async () => {
    fetchMock.mockClear();
    choose({ archetype: "service" });
    choose({ language: "java" });
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(probe().preview).toBeNull();
  });

  it("joins the add-ons in catalog order whatever the click order", async () => {
    const url =
      "/api/spectrolyzr/preview?archetype=service&language=java&addons=ci,spectro-playbook&name=ledger-api";
    serve({ [url]: () => answer(200, PREVIEW) });
    choose({ archetype: "service", language: "java", name: "ledger-api" });
    choose({ addons: ["spectro-playbook", "ci"] });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(url));
    expect(probe().choices.addons).toEqual(["ci", "spectro-playbook"]);
  });

  it("refetches on a change of name and not on a change of a folder", async () => {
    choose({ archetype: "service", language: "java", addons: ["ci"], name: "ledger-api" });
    await vi.waitFor(() => expect(probe().preview).not.toBeNull());
    fetchMock.mockClear();
    choose({ dir: "/w/ledger-api", playbookDir: "/w/ledger-api-playbook" });
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    const other = "/api/spectrolyzr/preview?archetype=service&language=java&addons=ci&name=other";
    serve({ [other]: () => answer(200, PREVIEW) });
    choose({ name: "other" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(other));
  });

  it("drops the preview when the server refuses the choices", async () => {
    choose({ archetype: "service", language: "java", addons: ["ci"], name: "ledger-api" });
    await vi.waitFor(() => expect(probe().preview).not.toBeNull());
    const bad = "/api/spectrolyzr/preview?archetype=service&language=java&addons=ci&name=class";
    serve({ [bad]: () => answer(400, { message: "no", field: "name" }) });
    choose({ name: "class" });
    await vi.waitFor(() => expect(probe().preview).toBeNull());
  });

  it("keeps the answer of the newest choice when an older one arrives late", async () => {
    let releaseFirst: (r: Response) => void = () => {};
    const first = new Promise<Response>((resolve) => (releaseFirst = resolve));
    const second = "/api/spectrolyzr/preview?archetype=service&language=java&addons=ci&name=second";
    const newest = { ...PREVIEW, commands: { test: "newest", check: "newest" } };
    fetchMock.mockImplementation((url: string) =>
      url === PREVIEW_URL
        ? first
        : url === second
          ? Promise.resolve(answer(200, newest))
          : Promise.reject(new Error(url)),
    );
    choose({ archetype: "service", language: "java", addons: ["ci"], name: "ledger-api" });
    choose({ name: "second" });
    await vi.waitFor(() => expect(probe().preview?.commands.test).toBe("newest"));
    releaseFirst(answer(200, PREVIEW));
    await Promise.resolve();
    await Promise.resolve();
    expect(probe().preview?.commands.test).toBe("newest");
  });

  it("switches between a new project and a new playbook, keeps the choices and clears the last answer", async () => {
    choose({ archetype: "service", language: "java", addons: ["ci"], name: "ledger-api", dir: "relative" });
    await vi.waitFor(() => expect(probe().preview).not.toBeNull());
    serve({
      "/api/spectrolyzr/generate": () => answer(400, { message: "dir must be absolute", field: "dir" }),
    });
    await generate();
    expect(probe().result).not.toBeNull();
    chooseKind("playbook");
    const s = probe();
    expect(s.kind).toBe("playbook");
    expect(s.result).toBeNull();
    expect(s.choices.archetype).toBe("service");
    expect(s.choices.name).toBe("ledger-api");
    chooseKind("project");
    expect(probe().kind).toBe("project");
  });

  it("keeps its choices after the subscribers unmount and a new one mounts", async () => {
    choose({ archetype: "service", language: "java", addons: ["ci"], name: "ledger-api" });
    chooseKind("playbook");
    await vi.waitFor(() => expect(probe().preview).not.toBeNull());
    // renderToStaticMarkup mounts and unmounts a subscriber per probe: a second
    // one reads what the first left.
    const again = probe();
    expect(again.kind).toBe("playbook");
    expect(again.choices.archetype).toBe("service");
    expect(again.choices.name).toBe("ledger-api");
    expect(again.catalog).toEqual(CATALOG);
    expect(again.preview).toEqual(PREVIEW);
  });
});

describe("generate", () => {
  const BODY = {
    archetype: "service",
    language: "java",
    addons: ["ci", "spectro-playbook"],
    name: "ledger-api",
    dir: "/w/ledger-api",
    playbookDir: "/w/ledger-api-playbook",
  };

  beforeEach(async () => {
    serve({
      "/api/spectrolyzr": () => answer(200, CATALOG),
      "/api/spectrolyzr/preview?archetype=service&language=java&addons=ci,spectro-playbook&name=ledger-api":
        () => answer(200, PREVIEW),
    });
    await loadCatalog();
    choose({
      archetype: "service",
      language: "java",
      addons: ["spectro-playbook", "ci"],
      name: "ledger-api",
    });
    choose({ dir: "/w/ledger-api", playbookDir: "/w/ledger-api-playbook" });
  });

  function post(status: number, body: unknown): void {
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      url === "/api/spectrolyzr/generate" && init?.method === "POST"
        ? Promise.resolve(answer(status, body))
        : Promise.resolve(answer(200, PREVIEW)),
    );
  }

  it("posts the choices and both folders as JSON", async () => {
    post(200, { project: { dir: "/w/ledger-api", written: ["a"] }, playbook: null, pinned: false });
    await generate();
    const call = fetchMock.mock.calls.find((c) => c[0] === "/api/spectrolyzr/generate");
    expect(call).toBeDefined();
    const init = call![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual(BODY);
  });

  it("maps 200 to written and keeps the result in the store", async () => {
    const wire = {
      project: { dir: "/w/ledger-api", written: ["build.gradle.kts"] },
      playbook: { dir: "/w/ledger-api-playbook", written: ["playbook.json"] },
      pinned: true,
    };
    post(200, wire);
    const result = await generate();
    expect(result).toEqual({ kind: "written", ...wire });
    expect(probe().result).toEqual(result);
  });

  it("maps 200 without a playbook to written with none", async () => {
    post(200, { project: { dir: "/w/p", written: [] }, playbook: null, pinned: false });
    const result = await generate();
    expect(result).toEqual({
      kind: "written",
      project: { dir: "/w/p", written: [] },
      playbook: null,
      pinned: false,
    });
  });

  it("maps 409 to both conflict lists", async () => {
    post(409, { message: "exists", conflicts: { project: ["a", "b"], playbook: ["playbook.json"] } });
    expect(await generate()).toEqual({ kind: "conflicts", project: ["a", "b"], playbook: ["playbook.json"] });
  });

  it("maps 409 with one side missing to an empty list", async () => {
    post(409, { message: "exists", conflicts: { project: ["a"] } });
    expect(await generate()).toEqual({ kind: "conflicts", project: ["a"], playbook: [] });
  });

  it("maps 400 to invalid with the named field", async () => {
    post(400, { message: "Not a folder", field: "dir" });
    expect(await generate()).toEqual({ kind: "invalid", field: "dir", message: "Not a folder" });
  });

  it("maps 500 to failed with the server's message", async () => {
    post(500, { message: "disk full", written: { project: [], playbook: [] } });
    expect(await generate()).toEqual({ kind: "failed", message: "disk full" });
  });

  it("maps a network error to failed", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(await generate()).toEqual({ kind: "failed", message: "offline" });
  });

  it("refuses without a request while the archetype or the language is unset", async () => {
    __resetLyzr();
    fetchMock.mockClear();
    const result = await generate();
    expect(result.kind).toBe("invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("suggestPlaybookDir", () => {
  it("is a sibling of the project folder named after the project", () => {
    expect(suggestPlaybookDir("/w/ledger-api", "ledger-api")).toBe("/w/ledger-api-playbook");
    expect(suggestPlaybookDir("/w/deep/ledger-api/", "ledger-api")).toBe("/w/deep/ledger-api-playbook");
    expect(suggestPlaybookDir("/ledger-api", "ledger-api")).toBe("/ledger-api-playbook");
  });

  it("is empty while the folder or the name is not set", () => {
    expect(suggestPlaybookDir("", "ledger-api")).toBe("");
    expect(suggestPlaybookDir("/w/x", "")).toBe("");
  });
});
