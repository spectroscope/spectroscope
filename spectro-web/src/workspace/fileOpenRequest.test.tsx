// Card 586: the Files panel opens a file the run view asked for.
//
// WorkspaceTab runs under HookHost, so its effects run as in the window and a
// fetch answer renders it again. The preview of an open tab is a component of
// its own; the test runs it in a second host and reads what it fetched.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../events";
import { initialState, reduceAll } from "../state/reducer";
import { __resetFileOpenRequestForTests, requestOpenFile } from "../state/fileOpenRequest";
import { flatten, type El } from "../testkit/chatHost";
import { HookHost } from "../testkit/hookHost";
import { WorkspaceTab } from "./WorkspaceTab";
import { fileUrl, runDocumentUrl } from "./preview";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeHooks } = await import("../testkit/hookHost");
  return { ...actual, ...fakeHooks };
});

const SESSION = "20261013-120000-a1b2";
const workspace = reduceAll(initialState, [
  {
    type: "workspace_info",
    ts: 1,
    resolved: true,
    mode: "set",
    configured: true,
    exists: true,
    sessionId: SESSION,
    path: "/work/frogger",
  } as unknown as RunEvent,
]).workspace;

let fetched: string[] = [];

beforeEach(() => {
  __resetFileOpenRequestForTests();
  fetched = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      fetched.push(url);
      if (url.startsWith("/api/files?")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ root: "frogger", truncated: false, entries: [] }),
        });
      }
      return new Promise(() => {});
    }),
  );
  vi.stubGlobal("window", {
    setTimeout: (task: () => void, ms: number) => setTimeout(task, ms),
    clearTimeout: (id: number) => clearTimeout(id),
    setInterval: () => 0,
    clearInterval: () => {},
  });
});

afterEach(() => vi.unstubAllGlobals());

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** The Files panel, after its tree arrived. */
async function pane(): Promise<HookHost<unknown>> {
  const host = new HookHost(() => WorkspaceTab({ workspace }));
  await flush();
  return host;
}

function previews(host: HookHost<unknown>): El[] {
  return flatten(host.value as El).filter(
    (el) => typeof el.type === "function" && (el.type as { name: string }).name === "Preview",
  );
}

/** Runs a preview element as its own component and returns what it fetched. */
async function previewFetch(el: El): Promise<string[]> {
  fetched = [];
  const host = new HookHost(() => (el.type as (p: unknown) => unknown)(el.props));
  await flush();
  host.unmount();
  return fetched;
}

describe("the Files panel opens what the run view asks for (card 586)", () => {
  it("a request made before the panel mounts opens a tab, and its preview fetches the run's document url", async () => {
    const url = runDocumentUrl(SESSION, "abcdefabcdef", ".superpowers/spec.md");
    requestOpenFile(".superpowers/spec.md", url, SESSION);
    const host = await pane();
    const shown = previews(host);
    expect(shown.map((el) => el.props.path)).toEqual([".superpowers/spec.md"]);
    expect(await previewFetch(shown[0])).toEqual([url]);
    host.unmount();
  });

  it("a request made while it is mounted opens the tab, and a path without a url fetches /api/file", async () => {
    const host = await pane();
    expect(previews(host), "premise: no tab yet").toEqual([]);
    requestOpenFile("docs/plan.md", undefined, SESSION);
    host.invalidate();
    const shown = previews(host);
    expect(shown.map((el) => el.props.path)).toEqual(["docs/plan.md"]);
    expect(await previewFetch(shown[0])).toEqual([fileUrl("docs/plan.md", SESSION)]);
    host.unmount();
  });

  it("a panel that mounts again does not open the same request again", async () => {
    requestOpenFile("docs/plan.md", undefined, SESSION);
    const first = await pane();
    expect(previews(first)).toHaveLength(1);
    first.unmount();
    const second = await pane();
    expect(previews(second)).toEqual([]);
    second.unmount();
  });

  it("a request made for another session's panel is dropped, not opened (final fix round)", async () => {
    requestOpenFile("docs/plan.md", undefined, "20261013-000000-other");
    const host = await pane();
    expect(previews(host)).toEqual([]);
    host.unmount();
  });
});
