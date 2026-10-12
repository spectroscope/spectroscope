// Card 524: a playbook travels as a ZIP. The browser reads the file with the
// session import's reader, checks it against the rules the server applies
// again, and posts the entries; the export saves what the server streams.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handZip, type HandEntry } from "../testkit/handZip";
import {
  BUNDLE_MAX_BYTES,
  __resetBundle,
  __setSaver,
  bundlePathOk,
  clearBundle,
  exportBundle,
  getBundleState,
  importBundleInto,
  openBundle,
  readPlaybookBundle,
  type BundleRefusal,
} from "./playbookBundle";
import { __resetPlaybooks, usePlaybookFolders } from "./playbooks";
import { setLang } from "./lang";
import { t } from "../i18n/i18n";
import { BundleImport } from "../playbook/BundleImport";

const enc = new TextEncoder();
const text = (s: string): Uint8Array => enc.encode(s);

const PLAYBOOK = JSON.stringify({
  schema_version: 1,
  id: "spectro",
  name: "spectro",
  description: "d",
  contents: { skills: ["skills/spectropowers"], hooks: ["hooks/hooks.json"], agents: [] },
});

function bundle(extra: HandEntry[] = [], top = "spectro"): Blob {
  return new Blob([
    handZip([
      { name: `${top}/playbook.json`, data: text(PLAYBOOK) },
      { name: `${top}/skills/spectropowers/brainstorming/SKILL.md`, data: text("---\nname: b\n---\n") },
      { name: `${top}/hooks/hooks.json`, data: text("[]\n") },
      ...extra,
    ]) as BlobPart,
  ]);
}

async function refusalOf(blob: Blob): Promise<BundleRefusal> {
  try {
    await readPlaybookBundle(blob);
  } catch (e) {
    return e as BundleRefusal;
  }
  throw new Error("the bundle was read, a refusal was expected");
}

function answer(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
    blob: () => Promise.resolve(new Blob(["zipbytes"])),
  } as unknown as Response;
}

beforeEach(() => {
  __resetBundle();
  __resetPlaybooks();
});

afterEach(() => {
  __resetBundle();
  __resetPlaybooks();
  vi.unstubAllGlobals();
});

describe("reading a bundle", () => {
  it("lists the entries without the top folder, the name, the id and the contents", async () => {
    const read = await readPlaybookBundle(bundle());
    expect(read.entries.map((e) => e.path)).toEqual([
      "playbook.json",
      "skills/spectropowers/brainstorming/SKILL.md",
      "hooks/hooks.json",
    ]);
    expect(read.name).toBe("spectro");
    expect(read.id).toBe("spectro");
    expect(read.contents.skills).toEqual(["skills/spectropowers"]);
    expect(read.contents.hooks).toEqual(["hooks/hooks.json"]);
    expect(read.contents.commands).toEqual([]);
  });

  it("sends a text file as text and keeps its bytes, a byte order mark included", async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...text("Grüße\r\n")]);
    const read = await readPlaybookBundle(bundle([{ name: "spectro/templates/bom.md", data: bom }]));
    const entry = read.entries.find((e) => e.path === "templates/bom.md");
    expect(entry && "text" in entry).toBe(true);
    expect(Array.from(enc.encode((entry as { text: string }).text))).toEqual(Array.from(bom));
  });

  it("sends a binary file under docs/ as base64", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]);
    const read = await readPlaybookBundle(bundle([{ name: "spectro/docs/logo.png", data: png }]));
    const entry = read.entries.find((e) => e.path === "docs/logo.png");
    expect(entry).toEqual({ path: "docs/logo.png", base64: Buffer.from(png).toString("base64") });
  });

  it("refuses a binary file outside docs/ and one over 2 MB", async () => {
    expect(
      await refusalOf(bundle([{ name: "spectro/templates/a.bin", data: new Uint8Array([0, 1]) }])),
    ).toEqual({
      key: "pb.bundle.err.binary",
      vars: { path: "templates/a.bin" },
    });
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    expect(await refusalOf(bundle([{ name: "spectro/docs/big.bin", data: big }]))).toEqual({
      key: "pb.bundle.err.binary",
      vars: { path: "docs/big.bin" },
    });
  });

  it("refuses a bundle without playbook.json at depth one", async () => {
    const flat = new Blob([handZip([{ name: "playbook.json", data: text(PLAYBOOK) }]) as BlobPart]);
    expect((await refusalOf(flat)).key).toBe("pb.bundle.err.noTop");
    const deep = new Blob([handZip([{ name: "a/b/playbook.json", data: text(PLAYBOOK) }]) as BlobPart]);
    expect((await refusalOf(deep)).key).toBe("pb.bundle.err.noTop");
    const two = bundle([{ name: "other/x.md", data: text("x") }]);
    expect((await refusalOf(two)).key).toBe("pb.bundle.err.noTop");
  });

  it("refuses more than 200 entries", async () => {
    const extra: HandEntry[] = [];
    for (let i = 0; i < 197; i++) extra.push({ name: `spectro/templates/t${i}.md`, data: text("x") });
    expect((await readPlaybookBundle(bundle(extra))).entries).toHaveLength(200);
    extra.push({ name: "spectro/templates/last.md", data: text("x") });
    expect((await refusalOf(bundle(extra))).key).toBe("pb.bundle.err.tooMany");
  });

  it("refuses a file over 24 MB before reading it", async () => {
    const huge = new Blob([new Uint8Array(BUNDLE_MAX_BYTES + 1) as BlobPart]);
    expect((await refusalOf(huge)).key).toBe("pb.bundle.err.tooLarge");
  });

  it("refuses entries that unpack to more than 24 MB", async () => {
    const extra: HandEntry[] = [];
    for (let i = 0; i < 13; i++)
      extra.push({ name: `spectro/templates/big${i}.md`, data: new Uint8Array(2 * 1024 * 1024).fill(120) });
    expect((await refusalOf(bundle(extra))).key).toBe("pb.bundle.err.tooLarge");
  });

  it("refuses a path with '..', an absolute path, a backslash or a name the loader refuses", async () => {
    for (const bad of [
      "spectro/../evil.md",
      "/spectro/evil.md",
      "spectro/templates\\evil.md",
      "spectro/templates/.hidden.md",
      "spectro/temp lates/a.md",
      "spectro//a.md",
      "spectro/./a.md",
      "C:/spectro/a.md",
    ]) {
      const refusal = await refusalOf(bundle([{ name: bad, data: text("x") }]));
      expect(["pb.bundle.err.path", "pb.bundle.err.noTop"], bad).toContain(refusal.key);
    }
    expect(await refusalOf(bundle([{ name: "spectro/templates/../../evil.md", data: text("x") }]))).toEqual({
      key: "pb.bundle.err.path",
      vars: { path: "spectro/templates/../../evil.md" },
    });
  });

  it("refuses two entries that name one file in any case", async () => {
    const refusal = await refusalOf(bundle([{ name: "spectro/Playbook.json", data: text("{}") }]));
    expect(refusal.key).toBe("pb.bundle.err.duplicate");
  });

  it("leaves out what Finder adds when it zips a folder", async () => {
    const read = await readPlaybookBundle(
      bundle([
        { name: "__MACOSX/spectro/._playbook.json", data: new Uint8Array([0, 5, 22, 7]) },
        { name: "spectro/.DS_Store", data: new Uint8Array([0, 0, 0, 1]) },
      ]),
    );
    expect(read.entries.map((e) => e.path)).not.toContain(".DS_Store");
    expect(read.entries).toHaveLength(3);
  });

  it("refuses a playbook.json that is not JSON", async () => {
    const blob = new Blob([handZip([{ name: "spectro/playbook.json", data: text("{ nope") }]) as BlobPart]);
    expect((await refusalOf(blob)).key).toBe("pb.bundle.err.json");
  });

  it("names the path rule the server keeps", () => {
    expect(bundlePathOk("skills/spectropowers/writing-skills/examples/CLAUDE_MD_TESTING.md")).toBe(true);
    expect(bundlePathOk("skills/a/scripts/review-package")).toBe(true);
    expect(bundlePathOk("docs/index.html")).toBe(true);
    expect(bundlePathOk("a/../b")).toBe(false);
    expect(bundlePathOk("a/.b")).toBe(false);
    expect(bundlePathOk("a.b/c")).toBe(false);
  });
});

describe("the import", () => {
  it("opens a file into the preview and a refusal into the refusal", async () => {
    await openBundle(bundle());
    expect(getBundleState().preview?.id).toBe("spectro");
    await openBundle(new Blob([text("not a zip at all, longer than twenty-two bytes")]));
    expect(getBundleState().preview).toBeNull();
    expect(getBundleState().refusal?.key).toBe("pb.bundle.err.notZip");
    clearBundle();
    expect(getBundleState().refusal).toBeNull();
  });

  it("posts the entries to the folder and registers it on success", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(answer(200, { dir: "/picked/pb", playbook: { id: "spectro" }, findings: [] })),
    );
    vi.stubGlobal("fetch", fetchMock);
    await openBundle(bundle());

    expect(await importBundleInto("/picked/pb", "/ws")).toBe("/picked/pb");

    expect(fetchMock.mock.calls[0][0]).toBe("/api/playbooks/import");
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as {
      dir: string;
      workspace: string;
      entries: unknown[];
    };
    expect(body.dir).toBe("/picked/pb");
    expect(body.workspace).toBe("/ws");
    expect(body.entries).toHaveLength(3);
    expect(getBundleState().preview).toBeNull();
    expect(getBundleState().imported).toBe("/picked/pb");
    expect(foldersNow()).toContain("/picked/pb");
  });

  it("keeps the server's refusal sentence verbatim and the preview open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          answer(409, {
            reason: "not-empty",
            message: "The target folder is not empty. A playbook is imported only into an empty folder.",
          }),
        ),
      ),
    );
    await openBundle(bundle());

    expect(await importBundleInto("/busy", null)).toBeNull();

    expect(getBundleState().server?.message).toBe(
      "The target folder is not empty. A playbook is imported only into an empty folder.",
    );
    expect(getBundleState().preview?.id).toBe("spectro");
  });

  it("lists the findings of a 422", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          answer(422, {
            reason: "findings",
            message: "The playbook in the bundle does not load cleanly; nothing was written.",
            findings: [{ path: "apiKey", message: "refused: a playbook may not carry keys" }],
          }),
        ),
      ),
    );
    await openBundle(bundle());
    await importBundleInto("/t", null);
    expect(getBundleState().server?.findings).toEqual([
      { path: "apiKey", message: "refused: a playbook may not carry keys" },
    ]);
  });
});

describe("the export", () => {
  it("saves the stream under the name the server gives", async () => {
    const saved: string[] = [];
    __setSaver((_blob, name) => saved.push(name));
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        answer(200, {}, { "Content-Disposition": 'attachment; filename="spectro.playbook.zip"' }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await exportBundle("/pb/spectro");

    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(
      `/api/playbooks/export?dir=${encodeURIComponent("/pb/spectro")}`,
    );
    expect(saved).toEqual(["spectro.playbook.zip"]);
    expect(getBundleState().exportRefusal).toBeNull();
  });

  it("shows a refused export with the server's sentence and findings", async () => {
    __setSaver(() => {
      throw new Error("nothing is saved");
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          answer(409, {
            reason: "refused",
            message: "This folder cannot travel as a bundle; the import would refuse it.",
            findings: [{ path: "templates/link.md", message: "a symbolic link" }],
          }),
        ),
      ),
    );

    await exportBundle("/pb/spectro");

    expect(getBundleState().exportRefusal).toEqual({
      reason: "refused",
      message: "This folder cannot travel as a bundle; the import would refuse it.",
      findings: [{ path: "templates/link.md", message: "a symbolic link" }],
    });
  });

  for (const lang of ["en", "de"] as const) {
    it(`a credential in a hook command is told in ${lang} with the file, the line and the pattern`, async () => {
      setLang(lang);
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(
            answer(422, {
              reason: "token",
              message: "hooks/hooks.json line 4: the hook command matches the credential pattern bearer.",
              findings: [
                {
                  path: "hooks/hooks.json:4",
                  message: "line 4: a hook command matches the credential pattern bearer",
                },
              ],
            }),
          ),
        ),
      );

      await exportBundle("/pb/spectro");
      const out = renderToStaticMarkup(
        createElement(BundleImport, { workspace: null, onImported: () => undefined }),
      );

      expect(out).toContain(t(lang, "pb.bundle.tokenExport", { file: "hooks/hooks.json" }));
      expect(out).toContain(t(lang, "pb.bundle.tokenLine", { line: 4, rule: "bearer" }));
      expect(out, "the English server sentence is not shown").not.toContain("the hook command matches");
      setLang("en");
    });
  }
});

/** The folders the playbook store knows now, read through its hook on the server renderer. */
function foldersNow(): string[] {
  let out: string[] = [];
  const Probe = (): null => {
    out = usePlaybookFolders().folders;
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  return out;
}
