// Card 554, task 13, criterion 8b: the start sheet the chat opens reads the
// drawing and the contents of the confirmed folder beside the frame
// (readSheetExtras), once per confirmation. Until they are in, the sheet
// draws without them; an answer for an earlier confirmation is not shown.

import { afterEach, describe, expect, it, vi } from "vitest";
import { HookHost } from "../testkit/hookHost";
import { useSheetExtras } from "./PlaybookStartSheet";
import type { PlaybookConfirm } from "../state/playbookChat";
import { __resetPlaybookContents } from "../state/playbookContents";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeHooks } = await import("../testkit/hookHost");
  return { ...actual, ...fakeHooks };
});

const PREVIEW = {
  dir: "/pb",
  hash: "sha256:ab",
  findings: [],
  steps: [],
  skills: [],
  commands: [],
  refusals: [],
};
const DOC = { nodes: [], arrows: [] };

afterEach(() => {
  __resetPlaybookContents();
  vi.unstubAllGlobals();
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

describe("what the chat's start sheet reads beside the frame", () => {
  it("reads the drawing and the contents of the confirmed folder in the session's workspace", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        urls.push(url);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () =>
            url.startsWith("/api/playbooks/draft") ? { document: DOC } : { items: [], contentsHash: "c" },
        });
      }),
    );
    const confirm = { dir: "/pb", prompt: "x", preview: PREVIEW } as unknown as PlaybookConfirm;
    const host = new HookHost(() => useSheetExtras(confirm, "/ws"));
    expect(host.value, "nothing before the answer").toEqual({ contents: null, doc: null });
    await settle();
    expect(host.value.doc).toEqual(DOC);
    expect(urls).toContain("/api/playbooks/draft?dir=%2Fpb&workspace=%2Fws");
    expect(urls.some((u) => u.startsWith("/api/playbooks/contents?dir=%2Fpb"))).toBe(true);
    host.unmount();
  });

  it("reads again for a new confirmation and never shows an earlier one's answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({ document: DOC }) })),
    );
    let confirm = { dir: "/pb", prompt: "x", preview: PREVIEW } as unknown as PlaybookConfirm;
    const host = new HookHost(() => useSheetExtras(confirm, null));
    await settle();
    expect(host.value.doc).toEqual(DOC);
    confirm = { ...confirm, prompt: "y" };
    host.invalidate();
    expect(host.value, "the answer for the first confirmation is not this one's").toEqual({
      contents: null,
      doc: null,
    });
    await settle();
    expect(host.value.doc).toEqual(DOC);
    host.unmount();
  });
});
