// Card 546, fix round 2: what the host does when its session changes. The
// host's first effect hands its whole body to loadCodeGraphSession, so the
// function is tested here and a source guard pins that the host calls it.
// Without the call the rows would keep the previous session's status until
// the new answer lands, and Show would open the previous session's graph.

import { afterEach, describe, expect, it } from "vitest";
import type { CodeGraphStatus } from "./codeGraphModel";
import {
  codeGraphState,
  loadCodeGraphSession,
  resetCodeGraphForTest,
  setCodeGraphStatus,
} from "./codeGraphStore";
import { read, stripComments } from "../testkit/source";

const WITH_GRAPH = {
  installed: true,
  binary: "/opt/tools/graphify",
  searched: [],
  install: "uv tool install graphifyy",
  folder: "/work/one",
  graph: { exists: true, modifiedAt: "2026-10-12T09:00:00Z" },
  job: null,
  backends: [],
} satisfies CodeGraphStatus;
const SECOND: CodeGraphStatus = { ...WITH_GRAPH, folder: "/work/two" };

/** A fetch whose answer the test releases by hand. */
function heldFetch(body: CodeGraphStatus) {
  let release: () => void = () => {};
  const urls: string[] = [];
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchFn = (async (url: string) => {
    urls.push(url);
    await gate;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, release: () => release(), urls };
}

afterEach(() => resetCodeGraphForTest());

describe("loadCodeGraphSession", () => {
  it("drops the previous session's status before the new answer lands", async () => {
    setCodeGraphStatus("s-1", WITH_GRAPH);
    const held = heldFetch(SECOND);

    const done = loadCodeGraphSession("s-2", () => true, held.fetchFn);

    expect(codeGraphState().sessionId).toBe("s-2");
    expect(codeGraphState().status).toBeNull();
    expect(held.urls).toEqual(["/api/codegraph/status?sessionId=s-2"]);
    held.release();
    await done;
    expect(codeGraphState().status?.folder).toBe("/work/two");
  });

  it("lands nothing once the effect that asked is gone", async () => {
    setCodeGraphStatus("s-1", WITH_GRAPH);
    const held = heldFetch(SECOND);
    let alive = true;

    const done = loadCodeGraphSession("s-2", () => alive, held.fetchFn);
    alive = false;
    held.release();
    await done;

    expect(codeGraphState().status).toBeNull();
  });
});

describe("the host", () => {
  it("runs loadCodeGraphSession in the effect keyed on the session and the refresh", () => {
    const host = stripComments(read("./CodeGraphHost.tsx", import.meta.url));
    const effect = /useEffect\(\(\) => \{[\s\S]*?\}, \[sessionId, refresh\]\);/.exec(host);
    expect(effect, "no effect keyed on [sessionId, refresh]").not.toBeNull();
    expect(effect?.[0]).toMatch(/loadCodeGraphSession\(sessionId, /);
  });
});
