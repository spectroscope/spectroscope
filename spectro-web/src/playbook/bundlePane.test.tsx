// Card 524: Export and Import in the playbook pane. The suite has no DOM, so
// the pane is rendered on the server renderer and pressed through the drive
// kit, as folderChooserClicks.test.tsx does for the Choose buttons.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PickSlot } from "../state/folderPick";
import { __resetFolderPick } from "../state/folderPick";
import { setLang } from "../state/lang";
import { __resetBundle, __setSaver, openBundle } from "../state/playbookBundle";
import { __resetPlaybookEditor } from "../state/playbookEditor";
import { __resetPlaybooks, pinFolder } from "../state/playbooks";
import { drive, type El } from "../testkit/driveComponent";
import { handZip } from "../testkit/handZip";
import { BundleImport } from "./BundleImport";
import { PlaybookPane } from "./PlaybookPane";

type Press = { slot: PickSlot; done: Promise<void> };
const presses = vi.hoisted(() => [] as Press[]);

vi.mock("../state/folderPick", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/folderPick")>();
  return {
    ...actual,
    chooseFolder: (slot: PickSlot, apply: (path: string) => void): Promise<void> => {
      const done = actual.chooseFolder(slot, apply);
      presses.push({ slot, done });
      return done;
    },
  };
});

const enc = new TextEncoder();
const PLAYBOOK = JSON.stringify({
  schema_version: 1,
  id: "spectro",
  name: "spectro",
  contents: { skills: ["skills/spectropowers"], hooks: ["hooks/hooks.json"] },
});
const BUNDLE = new Blob([
  handZip([
    { name: "spectro/playbook.json", data: enc.encode(PLAYBOOK) },
    { name: "spectro/skills/spectropowers/brainstorming/SKILL.md", data: enc.encode("---\nname: b\n---\n") },
    { name: "spectro/hooks/hooks.json", data: enc.encode("[]\n") },
  ]) as BlobPart,
]);

const NOT_EMPTY = "The target folder is not empty. A playbook is imported only into an empty folder.";

function answer(status: number, body: unknown = {}, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
    blob: () => Promise.resolve(new Blob(["zip"])),
  } as unknown as Response;
}

let importAnswer: () => Promise<Response> = () => Promise.resolve(answer(200, { dir: "/picked/empty" }));

const calls = (): [string, RequestInit | undefined][] =>
  vi.mocked(fetch).mock.calls.map(([u, i]) => [String(u), i as RequestInit | undefined]);

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

const press =
  (cls: string) =>
  (tree: El[]): void =>
    one(tree, "button", cls).props.onClick?.();

const pane = <PlaybookPane workspace="/ws" sessionId={null} onStartPlaybook={() => false} />;

beforeEach(() => {
  presses.length = 0;
  __resetFolderPick();
  __resetPlaybooks();
  __resetPlaybookEditor();
  __resetBundle();
  setLang("en");
  importAnswer = () => Promise.resolve(answer(200, { dir: "/picked/empty" }));
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL | Request) => {
      const u = String(url);
      if (u === "/api/pick-workspace") return Promise.resolve(answer(200, { path: "/picked/empty" }));
      if (u === "/api/playbooks/active")
        return Promise.resolve(answer(200, { folders: ["/pb/spectro"], active: "/pb/spectro" }));
      if (u === "/api/playbooks/import") return importAnswer();
      if (u.startsWith("/api/playbooks/export"))
        return Promise.resolve(
          answer(200, {}, { "Content-Disposition": 'attachment; filename="spectro.playbook.zip"' }),
        );
      return Promise.resolve(answer(404));
    }),
  );
});

afterEach(() => {
  presses.length = 0;
  __resetFolderPick();
  __resetPlaybooks();
  __resetPlaybookEditor();
  __resetBundle();
  setLang("en");
  vi.unstubAllGlobals();
});

// Card 525 moved both into the toolbar every tab ends with and named the
// second one Import ZIP.
describe("Export and Import ZIP in the toolbar", () => {
  it("are drawn in English and in German", () => {
    const en = renderToStaticMarkup(pane);
    expect(en).toMatch(/<button[^>]*class="pb-export"[^>]*>Export<\/button>/);
    expect(en).toMatch(/<button[^>]*class="pb-import"[^>]*>Import ZIP<\/button>/);
    expect(en).toMatch(/<input[^>]*class="pb-bundle-file"[^>]*accept=".zip,application\/zip"/);
    setLang("de");
    const de = renderToStaticMarkup(pane);
    expect(de).toMatch(/class="pb-export"[^>]*>Exportieren</);
    expect(de).toMatch(/class="pb-import"[^>]*>ZIP importieren</);
  });

  it("Export waits for a folder to be shown", () => {
    expect(renderToStaticMarkup(pane)).toMatch(/<button[^>]*class="pb-export"[^>]*disabled=""/);
  });

  it("Export asks the server for the folder shown and saves the file it names", async () => {
    const saved: string[] = [];
    __setSaver((_b, name) => saved.push(name));
    await pinFolder("/ws", "/pb/spectro");

    drive(pane, [PlaybookPane], [press("pb-export")]);
    await new Promise((r) => setTimeout(r, 0));

    expect(calls().map(([u]) => u)).toContain(
      `/api/playbooks/export?dir=${encodeURIComponent("/pb/spectro")}`,
    );
    expect(saved).toEqual(["spectro.playbook.zip"]);
  });
});

describe("a chosen bundle", () => {
  it("shows its files, its name and id and the contents it declares", async () => {
    await openBundle(BUNDLE);

    const out = renderToStaticMarkup(pane);

    expect(out).toContain("spectro (spectro), 3 files");
    expect(out).toContain("skills/spectropowers/brainstorming/SKILL.md");
    expect(out).toContain("hooks/hooks.json");
    expect(out).toMatch(/class="pb-bundle-kind">skills</);
    expect(out).toMatch(/class="pb-bundle-kind">hooks</);
    expect(out).toContain("It installs nothing");
    expect(out).toMatch(/class="pb-bundle-pick"[^>]*>Choose an empty folder and import</);
  });

  it("shows the browser's refusal in the chosen language", async () => {
    await openBundle(
      new Blob([handZip([{ name: "playbook.json", data: enc.encode(PLAYBOOK) }]) as BlobPart]),
    );
    setLang("de");
    expect(renderToStaticMarkup(pane)).toContain("Das Bündel muss genau einen obersten Ordner haben");
  });

  it("the import button opens the chooser for its own slot and writes into the folder picked", async () => {
    await openBundle(BUNDLE);

    drive(pane, [PlaybookPane, BundleImport], [press("pb-bundle-pick")]);
    expect(presses.map((p) => p.slot)).toEqual(["pbImport"]);
    await presses[0].done;
    await new Promise((r) => setTimeout(r, 0));

    const posted = calls().filter(([u]) => u === "/api/playbooks/import");
    expect(posted).toHaveLength(1);
    const body = JSON.parse(String(posted[0][1]?.body)) as { dir: string; entries: { path: string }[] };
    expect(body.dir).toBe("/picked/empty");
    expect(body.entries.map((e) => e.path)).toContain("playbook.json");
    expect(renderToStaticMarkup(pane)).toContain("The playbook was imported into /picked/empty.");
  });

  it("shows the server's refusal word for word", async () => {
    importAnswer = () => Promise.resolve(answer(409, { reason: "not-empty", message: NOT_EMPTY }));
    await openBundle(BUNDLE);

    drive(pane, [PlaybookPane, BundleImport], [press("pb-bundle-pick")]);
    await presses[0].done;
    await new Promise((r) => setTimeout(r, 0));

    setLang("de");
    expect(renderToStaticMarkup(pane)).toContain(NOT_EMPTY);
  });
});
