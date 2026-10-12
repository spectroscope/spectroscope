// Card 503, criterion 9 at the app: a stored session opened or continued
// folds the frames of its .messages.jsonl among its events, so its message
// blocks come back. Both paths that fetch a session's events ask for them.

import { describe, expect, it } from "vitest";
import { read } from "../testkit/source";
import { fetchPeerFrames } from "./peerMessages";

describe("a stored session's messages", () => {
  it("are fetched and merged where the app opens a session and where it continues one", () => {
    const app = read("../App.tsx", import.meta.url);
    for (const start of ["const openSession = async", "const resumeSession = async"]) {
      const body = app.slice(app.indexOf(start), app.indexOf("} catch", app.indexOf(start)));
      expect(body, start).toContain("fetchPeerFrames(id)");
      expect(body, start).toContain("mergePeerFrames(");
    }
  });

  it("are read from GET /api/sessions/{id}/messages, and an answer that fails is no frames", async () => {
    const asked: string[] = [];
    const ok = await fetchPeerFrames("s 1", async (url) => {
      asked.push(String(url));
      return new Response(JSON.stringify([{ type: "peer_message", kind: "message", msgId: "m1", ts: 1 }]));
    });
    expect(asked).toEqual(["/api/sessions/s%201/messages"]);
    expect(ok).toHaveLength(1);
    expect(await fetchPeerFrames("s1", async () => new Response("nope", { status: 404 }))).toEqual([]);
    expect(
      await fetchPeerFrames("s1", async () => {
        throw new Error("offline");
      }),
    ).toEqual([]);
  });
});
