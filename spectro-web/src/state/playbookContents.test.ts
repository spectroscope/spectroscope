import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetPlaybookContents,
  changedItems,
  installContents,
  loadContents,
  removeContents,
  usePlaybookContents,
  type ContentItem,
  type ContentState,
  type ContentsPreview,
} from "./playbookContents";

let fetchMock: ReturnType<typeof vi.fn>;

/** What the hook answers right now, read through a real render. */
function probe(): ContentsPreview | null {
  function Probe() {
    return createElement("i", { "data-v": JSON.stringify(usePlaybookContents()) });
  }
  const html = renderToStaticMarkup(createElement(Probe));
  const raw = /data-v="([^"]*)"/.exec(html)?.[1] ?? "null";
  return JSON.parse(
    raw
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&#x27;/g, "'"),
  );
}

function item(name: string, state: ContentState): ContentItem {
  return {
    kind: "skill",
    name,
    source: `skills/p/${name}`,
    sha256: "a".repeat(64),
    state,
    scope: "sessions",
    bytes: 10,
    target: `/h/.spectro/skills/p/${name}`,
    command: null,
    files: [],
  };
}

function preview(items: ContentItem[], hash = "h1"): ContentsPreview {
  return {
    playbook: "spectro",
    dir: "/p/spectro",
    contentsHash: hash,
    items,
    promptChars: 42,
    hooksOrigin: null,
    findings: [],
  };
}

function reply(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  __resetPlaybookContents();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadContents", () => {
  it("reads the preview from the contents route with dir and workspace and publishes it", async () => {
    const p = preview([item("a", "new")]);
    fetchMock.mockResolvedValue(reply(200, p));
    await loadContents("/p/spectro", "/w space");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/playbooks/contents?dir=%2Fp%2Fspectro&workspace=%2Fw%20space",
    );
    expect(probe()).toEqual(p);
  });

  it("leaves the workspace out of the query when there is none", async () => {
    fetchMock.mockResolvedValue(reply(200, preview([])));
    await loadContents("/p/spectro", null);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/playbooks/contents?dir=%2Fp%2Fspectro");
  });

  it("clears the preview and throws the server's words on a refusal", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, preview([item("a", "new")])));
    await loadContents("/p/spectro", null);
    expect(probe()).not.toBeNull();
    fetchMock.mockResolvedValueOnce(reply(400, { message: "Not a registered playbook folder: /x" }));
    await expect(loadContents("/x", null)).rejects.toThrow("Not a registered playbook folder: /x");
    expect(probe()).toBeNull();
  });
});

describe("installContents", () => {
  it("posts dir, contentsHash and hooks and answers the installed names", async () => {
    fetchMock.mockResolvedValue(reply(200, { installed: ["p:a", "p:b"] }));
    const answer = await installContents("/p/spectro", "h1", true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/playbooks/contents/install");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ dir: "/p/spectro", contentsHash: "h1", hooks: true });
    expect(answer).toEqual({ ok: true, installed: ["p:a", "p:b"] });
  });

  it("maps a 409 to a failure with status, reason, message, names and leftover", async () => {
    fetchMock.mockResolvedValue(
      reply(409, { reason: "TAKEN", message: "a target exists", names: ["/h/.spectro/skills/p"] }),
    );
    const answer = await installContents("/p/spectro", "h1", false);
    expect(answer).toEqual({
      ok: false,
      status: 409,
      reason: "TAKEN",
      message: "a target exists",
      names: ["/h/.spectro/skills/p"],
      leftover: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reloads the list once for the same folder when the reason is CHANGED", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, preview([item("a", "new")])));
    await loadContents("/p/spectro", "/w");
    fetchMock.mockClear();
    const fresh = preview([item("a", "source-changed")], "h2");
    fetchMock
      .mockResolvedValueOnce(reply(409, { reason: "CHANGED", message: "the folder changed", names: [] }))
      .mockResolvedValueOnce(reply(200, fresh));
    const answer = await installContents("/p/spectro", "h1", false);
    expect(answer.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/playbooks/contents?dir=%2Fp%2Fspectro&workspace=%2Fw");
    expect(probe()).toEqual(fresh);
  });

  it.each(["ALREADY", "TAKEN"])("does not reload on a 409 with reason %s", async (reason) => {
    fetchMock.mockResolvedValue(reply(409, { reason, message: "no", names: [] }));
    await installContents("/p/spectro", "h1", false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not reload on a CHANGED reason that arrives with another status", async () => {
    fetchMock.mockResolvedValue(reply(500, { reason: "CHANGED", message: "odd", leftover: ["/x"] }));
    const answer = await installContents("/p/spectro", "h1", false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(answer).toMatchObject({ ok: false, status: 500, leftover: ["/x"] });
  });

  it("answers a failure with status 0 when the request never arrived", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    const answer = await installContents("/p/spectro", "h1", false);
    expect(answer).toMatchObject({ ok: false, status: 0, reason: "NETWORK" });
  });
});

describe("removeContents", () => {
  it("posts the folder and answers removed and kept", async () => {
    fetchMock.mockResolvedValue(reply(200, { removed: ["p:a"], kept: ["p:b"] }));
    const answer = await removeContents("/p/spectro");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/playbooks/contents/remove");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ dir: "/p/spectro" });
    expect(answer).toEqual({ ok: true, removed: ["p:a"], kept: ["p:b"] });
  });

  it("maps a 404 to a failure", async () => {
    fetchMock.mockResolvedValue(reply(404, { reason: "NOT_INSTALLED", message: "not installed" }));
    expect(await removeContents("/p/spectro")).toEqual({
      ok: false,
      status: 404,
      reason: "NOT_INSTALLED",
      message: "not installed",
      names: [],
      leftover: [],
    });
  });
});

describe("changedItems", () => {
  it("returns exactly the source-changed and copy-changed items, in order", () => {
    const p = preview([
      item("n", "new"),
      item("s", "source-changed"),
      item("same", "same"),
      item("t", "taken"),
      item("c", "copy-changed"),
      item("w", "not-run"),
    ]);
    expect(changedItems(p).map((i) => i.name)).toEqual(["s", "c"]);
  });

  it("is empty when nothing changed", () => {
    expect(changedItems(preview([item("n", "new"), item("same", "same")]))).toEqual([]);
  });
});
