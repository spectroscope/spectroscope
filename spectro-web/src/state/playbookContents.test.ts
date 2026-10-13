import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetPlaybookContents,
  loadContents,
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

describe("the store's writes", () => {
  // Owner answer of 2026-10-13 (card 558): the server has no install or
  // remove route, so the store carries no write that would call one.
  it("carries no install or remove call, only the read of the contents", async () => {
    const store: Record<string, unknown> = await import("./playbookContents");
    expect(typeof store.loadContents).toBe("function");
    expect(store.installContents).toBeUndefined();
    expect(store.removeContents).toBeUndefined();
  });
});

describe("loadContents", () => {
  it("reads the preview from the contents route with dir and workspace and publishes it", async () => {
    const p = preview([item("a", "in-playbook")]);
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
    fetchMock.mockResolvedValueOnce(reply(200, preview([item("a", "in-playbook")])));
    await loadContents("/p/spectro", null);
    expect(probe()).not.toBeNull();
    fetchMock.mockResolvedValueOnce(reply(400, { message: "Not a registered playbook folder: /x" }));
    await expect(loadContents("/x", null)).rejects.toThrow("Not a registered playbook folder: /x");
    expect(probe()).toBeNull();
  });
});
