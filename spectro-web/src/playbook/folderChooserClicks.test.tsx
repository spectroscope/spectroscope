// Card 512, fix round: the three folder buttons of the Playbook segment are
// pressed, not only drawn. Each test takes the onClick the component built and
// calls it, then checks three things: the request went to
// POST /api/pick-workspace, the button named its own field's slot (the slot
// decides which note appears beside which field), and the picked path reached
// that field. The suite has no DOM, so the drive kit (testkit/driveComponent)
// runs each component's hooks inside a probe on the server renderer.
//
// The helper is the real one. The mock below only records which slot and
// which apply each press handed it, and what the helper delivered to that
// apply once the answer came back.
//
// The pane keeps its path in local state, and the server renderer drops a set
// that lands after the render has finished. So the pane tests hand the path to
// the button's own apply in the next pass, as the helper does once the answer
// is back, and check separately that the helper delivered exactly that path to
// that apply. The wizard keeps its folders in a store, so its tests wait for
// the real answer and read the field afterwards.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PickSlot } from "../state/folderPick";
import { __resetFolderPick } from "../state/folderPick";
import { setLang } from "../state/lang";
import { __resetPlaybookEditor } from "../state/playbookEditor";
import { __resetPlaybooks } from "../state/playbooks";
import { __resetLyzr, choose, goTo, loadCatalog, type LyzrCatalog } from "../state/spectrolyzr";
import { drive, type El } from "../testkit/driveComponent";
import { PlaybookPane } from "./PlaybookPane";
import { StepAddons } from "./spectrolyzr/StepAddons";
import { StepReview } from "./spectrolyzr/StepReview";

type Press = { slot: PickSlot; apply: (path: string) => void; delivered: string[]; done: Promise<void> };

const presses = vi.hoisted(() => [] as Press[]);

vi.mock("../state/folderPick", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/folderPick")>();
  return {
    ...actual,
    chooseFolder: (slot: PickSlot, apply: (path: string) => void): Promise<void> => {
      const delivered: string[] = [];
      const done = actual.chooseFolder(slot, (path) => {
        delivered.push(path);
        apply(path);
      });
      presses.push({ slot, apply, delivered, done });
      return done;
    },
  };
});

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

let pickAnswer: () => Promise<Response> = () => Promise.resolve(answer(204));

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** The calls fetch saw, as [url, init] pairs. */
const calls = (): [string, RequestInit | undefined][] =>
  vi.mocked(fetch).mock.calls.map(([u, i]) => [String(u), i as RequestInit | undefined]);

/** The bodies sent to routes that start with `prefix`, parsed. */
const bodies = (prefix: string): unknown[] =>
  calls()
    .filter(([u]) => u.startsWith(prefix))
    .map(([, i]) => JSON.parse(String(i?.body)));

/** The one element of a pass that carries `cls` among its classes. */
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

/** The requests to the chooser so far; each must be a POST. */
function pickRequests(): number {
  const picks = calls().filter(([u]) => u === PICK);
  for (const [, init] of picks) expect(init?.method).toBe("POST");
  return picks.length;
}

beforeEach(async () => {
  presses.length = 0;
  __resetFolderPick();
  __resetPlaybooks();
  __resetPlaybookEditor();
  __resetLyzr();
  setLang("en");
  pickAnswer = () => Promise.resolve(answer(204));
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL | Request) => {
      const u = String(url);
      if (u === PICK) return pickAnswer();
      if (u === "/api/spectrolyzr") return Promise.resolve(answer(200, CATALOG));
      if (u.startsWith("/api/spectrolyzr/preview"))
        return Promise.resolve(answer(200, { files: [], commands: { test: "t", check: "c" } }));
      return Promise.resolve(answer(404));
    }),
  );
  await loadCatalog();
});

afterEach(() => {
  presses.length = 0;
  __resetFolderPick();
  __resetPlaybooks();
  __resetPlaybookEditor();
  __resetLyzr();
  setLang("en");
  vi.unstubAllGlobals();
});

describe("the pane's Choose button", () => {
  const pane = <PlaybookPane workspace="/ws" sessionId={null} onStartPlaybook={() => false} />;

  it("posts to the chooser for the pane's slot and puts the picked path into the path field", async () => {
    pickAnswer = () => Promise.resolve(answer(200, { path: "/picked/pb" }));
    const before = pickRequests();
    const tree = drive(pane, [PlaybookPane], [press("pb-choose"), () => presses[0]?.apply("/picked/pb")]);
    expect(pickRequests()).toBe(before + 1);
    expect(presses.map((p) => p.slot)).toEqual(["pane"]);
    expect(one(tree, "input", "pb-path").props.value).toBe("/picked/pb");
    await presses[0].done;
    expect(presses[0].delivered).toEqual(["/picked/pb"]);
  });

  it("Add sends the picked path", async () => {
    pickAnswer = () => Promise.resolve(answer(200, { path: "/picked/pb" }));
    drive(pane, [PlaybookPane], [press("pb-choose"), () => presses[0]?.apply("/picked/pb"), press("pb-add")]);
    await presses[0].done;
    expect(presses[0].delivered).toEqual(["/picked/pb"]);
    expect(bodies("/api/playbooks/folders")).toEqual([{ dir: "/picked/pb" }]);
  });

  it("Copy sends the picked path", async () => {
    pickAnswer = () => Promise.resolve(answer(200, { path: "/picked/pb" }));
    drive(
      pane,
      [PlaybookPane],
      [press("pb-choose"), () => presses[0]?.apply("/picked/pb"), press("pb-copy")],
    );
    await presses[0].done;
    expect(presses[0].delivered).toEqual(["/picked/pb"]);
    expect(bodies("/api/playbooks/bundled/")).toEqual([{ dir: "/picked/pb" }]);
  });
});

describe("the wizard's Choose button on the playbook folder", () => {
  it("posts to the chooser for its own slot and puts the picked path into the playbook folder field", async () => {
    choose({ archetype: "service", language: "java", name: "ledger-api", dir: "/w/ledger-api" });
    choose({ addons: ["spectro-playbook"] });
    await flush();
    goTo(2);
    pickAnswer = () => Promise.resolve(answer(200, { path: "/picked/pb" }));
    const before = pickRequests();
    drive(<StepAddons invalid={null} />, [StepAddons], [press("lyzr-choose")]);
    expect(pickRequests()).toBe(before + 1);
    expect(presses.map((p) => p.slot)).toEqual(["lyzrPlaybook"]);
    await presses[0].done;
    expect(presses[0].delivered).toEqual(["/picked/pb"]);
    const out = renderToStaticMarkup(<StepAddons invalid={null} />);
    expect(out).toMatch(/<input[^>]*class="lyzr-playbook-dir[^"]*"[^>]*value="\/picked\/pb"/);
  });
});

describe("the wizard's Pick button on the project folder", () => {
  it("posts to the chooser for its own slot and puts the picked path into the project folder field", async () => {
    choose({ archetype: "service", language: "java", name: "ledger-api", dir: "/w/ledger-api" });
    await flush();
    goTo(3);
    pickAnswer = () => Promise.resolve(answer(200, { path: "/picked/project" }));
    const review = <StepReview invalid={null} busy={false} onGenerate={() => {}} />;
    const before = pickRequests();
    drive(review, [StepReview], [press("lyzr-pick")]);
    expect(pickRequests()).toBe(before + 1);
    expect(presses.map((p) => p.slot)).toEqual(["lyzrDir"]);
    await presses[0].done;
    expect(presses[0].delivered).toEqual(["/picked/project"]);
    expect(renderToStaticMarkup(review)).toMatch(
      /<input[^>]*class="lyzr-dir[^"]*"[^>]*value="\/picked\/project"/,
    );
  });
});
