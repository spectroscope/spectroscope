// Card 445: what the rail does with a session's title and pin. Pure folds over
// the list the sidebar already holds, plus the three calls that change them.

import { afterEach, describe, expect, it } from "vitest";
import type { SessionMeta } from "../events";
import { read } from "../testkit/source";
import {
  TITLE_MAX_CHARS,
  TITLE_POLL_MS,
  TITLE_WAIT_MS,
  __setTestHooks,
  deleteStoredSession,
  deletionLeavesView,
  orderSessions,
  pinSession,
  renameSession,
  suggestSessionTitle,
  titleFieldsOf,
  titlePending,
  withTitleFields,
  withoutSession,
} from "./sessionMeta";

function row(id: string, startedAt: number, over: Partial<SessionMeta> = {}): SessionMeta {
  return { id, startedAt, firstPrompt: `prompt ${id}`, tokens: 1, ...over };
}

/** A fetch double that records each call and answers with the given status and body. */
function recorder(status: number, body: unknown = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

afterEach(() => __setTestHooks({}));

describe("the pinned group", () => {
  it("puts pinned sessions first, each group newest first", () => {
    const list = [
      row("a", 100),
      row("b", 400, { pinned: true }),
      row("c", 300),
      row("d", 200, { pinned: true }),
      row("e", 500),
    ];
    const groups = orderSessions(list);
    expect(groups.pinned.map((s) => s.id)).toEqual(["b", "d"]);
    expect(groups.rest.map((s) => s.id)).toEqual(["e", "c", "a"]);
  });

  it("puts an unpinned session back in its place by date", () => {
    const list = [row("a", 100), row("b", 400, { pinned: true }), row("c", 300)];
    const unpinned = withTitleFields(list, "b", { pinned: false });
    const groups = orderSessions(unpinned);
    expect(groups.pinned).toEqual([]);
    expect(groups.rest.map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  it("leaves the list it was given alone", () => {
    const list = [row("a", 100), row("b", 400, { pinned: true })];
    orderSessions(list);
    expect(list.map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("what an answer does to a row", () => {
  it("reads the title fields off the server's answer", () => {
    expect(titleFieldsOf({ title: "Release 0.14.0", titleSource: "manual", pinned: true })).toEqual({
      title: "Release 0.14.0",
      titleSource: "manual",
      pinned: true,
    });
    expect(titleFieldsOf({ pinned: false })).toEqual({ pinned: false });
    expect(titleFieldsOf({ title: 5, titleSource: "made-up", pinned: "yes" })).toEqual({ pinned: false });
    expect(titleFieldsOf(null)).toBeNull();
    expect(titleFieldsOf([])).toBeNull();
  });

  it("replaces the row's title fields and nothing else", () => {
    const list = [row("a", 100, { title: "Old", titleSource: "suggested" }), row("b", 200)];
    const next = withTitleFields(list, "a", { title: "New", titleSource: "manual", pinned: true });
    expect(next[0]).toMatchObject({
      id: "a",
      title: "New",
      titleSource: "manual",
      pinned: true,
      firstPrompt: "prompt a",
    });
    expect(next[1]).toBe(list[1]);
  });

  it("drops a title the answer no longer carries", () => {
    const list = [row("a", 100, { title: "Old", titleSource: "manual", pinned: true })];
    const next = withTitleFields(list, "a", { pinned: true });
    expect(next[0].title).toBeUndefined();
    expect(next[0].titleSource).toBeUndefined();
    expect(next[0].pinned).toBe(true);
  });

  it("takes a deleted session out of the list", () => {
    const list = [row("a", 100), row("b", 200)];
    expect(withoutSession(list, "a").map((s) => s.id)).toEqual(["b"]);
  });
});

describe("a delete and the view on screen", () => {
  it("leaves the replay only when it shows the deleted session", () => {
    expect(deletionLeavesView({ id: "a" }, "a")).toBe(true);
    expect(deletionLeavesView({ id: "b" }, "a")).toBe(false);
    expect(deletionLeavesView(null, "a")).toBe(false);
  });
});

describe("waiting for a fresh session's title", () => {
  const now = 1_000_000;

  it("waits while a young session has no title", () => {
    expect(titlePending([row("a", now - 5_000)], now)).toBe(true);
  });

  it("stops once the title is there, once the session is too old, or for an empty prompt", () => {
    expect(titlePending([row("a", now - 5_000, { title: "Release notes" })], now)).toBe(false);
    expect(titlePending([row("a", now - TITLE_WAIT_MS - 1)], now)).toBe(false);
    expect(titlePending([row("a", now - 5_000, { firstPrompt: "" })], now)).toBe(false);
    expect(titlePending([], now)).toBe(false);
  });

  it("polls a few times within the wait, not continuously", () => {
    expect(TITLE_POLL_MS).toBeGreaterThanOrEqual(1_000);
    expect(TITLE_WAIT_MS / TITLE_POLL_MS).toBeLessThanOrEqual(20);
  });

  it("waits longer than the server gives the model", () => {
    // SessionTitles.TIME_LIMIT is the server's bound on one suggestion. A wait
    // shorter than it would stop looking before a slow answer lands.
    const java = read(
      "../../../spectro-server/src/main/java/dev/spectroscope/server/session/SessionTitles.java",
      import.meta.url,
    );
    const m = java.match(/TIME_LIMIT = Duration\.ofSeconds\((\d+)\)/);
    expect(m).not.toBeNull();
    expect(TITLE_WAIT_MS).toBeGreaterThan(Number(m![1]) * 1000);
  });

  it("caps the field at the length the server cuts a title at", () => {
    const java = read(
      "../../../spectro-server/src/main/java/dev/spectroscope/server/session/SessionMetaStore.java",
      import.meta.url,
    );
    const m = java.match(/TITLE_MAX_CHARS = (\d+);/);
    expect(m).not.toBeNull();
    expect(TITLE_MAX_CHARS).toBe(Number(m![1]));
  });
});

describe("the calls", () => {
  it("renames with one PATCH carrying the title", async () => {
    const fake = recorder(200, { title: "Release 0.14.0", titleSource: "manual", pinned: false });
    __setTestHooks({ fetch: fake.fetch });
    const answer = await renameSession("20260925-a", "Release 0.14.0");
    expect(answer).toEqual({ title: "Release 0.14.0", titleSource: "manual", pinned: false });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].url).toBe("/api/sessions/20260925-a");
    expect(fake.calls[0].init?.method).toBe("PATCH");
    expect(JSON.parse(String(fake.calls[0].init?.body))).toEqual({ title: "Release 0.14.0" });
    expect(new Headers(fake.calls[0].init?.headers).get("Content-Type")).toBe("application/json");
  });

  it("pins with one PATCH carrying pinned", async () => {
    const fake = recorder(200, { pinned: true });
    __setTestHooks({ fetch: fake.fetch });
    expect(await pinSession("20260925-a", true)).toEqual({ pinned: true });
    expect(JSON.parse(String(fake.calls[0].init?.body))).toEqual({ pinned: true });
  });

  it("asks for a suggestion with one POST", async () => {
    const fake = recorder(200, {
      title: "Release notes",
      titleSource: "suggested",
      pinned: false,
      suggested: true,
    });
    __setTestHooks({ fetch: fake.fetch });
    const answer = await suggestSessionTitle("20260925-a");
    expect(answer).toEqual({
      fields: { title: "Release notes", titleSource: "suggested", pinned: false },
      suggested: true,
    });
    expect(fake.calls[0].url).toBe("/api/sessions/20260925-a/title/suggest");
    expect(fake.calls[0].init?.method).toBe("POST");
  });

  it("encodes the id into the path", async () => {
    const fake = recorder(200, { pinned: true });
    __setTestHooks({ fetch: fake.fetch });
    await pinSession("a/b", true);
    expect(fake.calls[0].url).toBe("/api/sessions/a%2Fb");
  });

  it("answers null when the server refuses or cannot be reached", async () => {
    __setTestHooks({ fetch: recorder(404).fetch });
    expect(await renameSession("x", "y")).toBeNull();
    __setTestHooks({
      fetch: (async () => {
        throw new TypeError("offline");
      }) as unknown as typeof globalThis.fetch,
    });
    expect(await pinSession("x", true)).toBeNull();
    expect(await suggestSessionTitle("x")).toBeNull();
  });

  it("deletes through the existing endpoint, and a session already gone counts as deleted", async () => {
    const gone = recorder(204);
    __setTestHooks({ fetch: gone.fetch });
    expect(await deleteStoredSession("20260925-a")).toBe("deleted");
    expect(gone.calls[0].url).toBe("/api/sessions/20260925-a");
    expect(gone.calls[0].init?.method).toBe("DELETE");

    __setTestHooks({ fetch: recorder(404).fetch });
    expect(await deleteStoredSession("20260925-a")).toBe("deleted");

    __setTestHooks({ fetch: recorder(500).fetch });
    expect(await deleteStoredSession("20260925-a")).toBe("failed");
  });
});
