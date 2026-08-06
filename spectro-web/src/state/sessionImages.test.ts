import { describe, expect, it } from "vitest";
import { collectImages, imageLines, indexOf, step, withSourceLines } from "./sessionImages";
import { initialState, type UiState, type UserAttachment } from "./reducer";

const shot = (name: string): UserAttachment => ({ name, mediaType: "image/png", dataBase64: name });

function stateWith(turns: UiState["turns"], cards: UiState["cards"]): UiState {
  return { ...initialState, turns, cards };
}

describe("the session's pictures, in order", () => {
  it("walks turns, so a bubble and a card interleave the way they happened", () => {
    const s = stateWith(
      [
        { kind: "user", text: "look", attachments: [shot("a"), shot("b")] },
        { kind: "tool", callId: "t1" },
        { kind: "user", text: "and this", attachments: [shot("d")] },
      ],
      {
        t1: {
          callId: "t1",
          agentId: "main",
          name: "screenshot",
          input: {},
          status: "ok",
          startedAt: 0,
          images: [shot("c")],
        },
      },
    );
    expect(collectImages(s).map((g) => g.name)).toEqual(["a", "b", "c", "d"]);
  });

  it("says where each one came from, because a reader wants to know", () => {
    const s = stateWith(
      [
        { kind: "user", text: "", attachments: [shot("a")] },
        { kind: "tool", callId: "t1" },
      ],
      {
        t1: {
          callId: "t1",
          agentId: "main",
          name: "Bash",
          input: {},
          status: "ok",
          startedAt: 0,
          images: [shot("b")],
        },
      },
    );
    const g = collectImages(s);
    expect(g[0].from).toBe("message");
    expect(g[1].from).toBe("tool");
    expect(g[1].toolName).toBe("Bash");
  });

  it("is empty for a session with no pictures, rather than throwing", () => {
    expect(collectImages(initialState)).toEqual([]);
    expect(collectImages(stateWith([{ kind: "user", text: "hi" }], {}))).toEqual([]);
  });

  it("survives a tool turn whose card is gone", () => {
    expect(collectImages(stateWith([{ kind: "tool", callId: "missing" }], {}))).toEqual([]);
  });
});

describe("finding the picture that was clicked", () => {
  const gallery = collectImages(
    stateWith([{ kind: "user", text: "", attachments: [shot("a"), shot("b"), shot("c")] }], {}),
  );

  it("matches on the bytes, not on an index the caller carried", () => {
    expect(indexOf(gallery, shot("b"))).toBe(1);
  });

  it("opens at the start rather than refusing when it cannot find one", () => {
    expect(indexOf(gallery, shot("zzz"))).toBe(0);
    expect(indexOf([], shot("a"))).toBe(0);
  });
});

describe("walking with the arrow keys", () => {
  it("wraps at both ends — there is no scrollbar here to say where you are", () => {
    expect(step(2, 3, 1)).toBe(0);
    expect(step(0, 3, -1)).toBe(2);
  });

  it("moves one at a time in the middle", () => {
    expect(step(1, 3, 1)).toBe(2);
    expect(step(1, 3, -1)).toBe(0);
  });

  it("stays put when there is nothing to walk", () => {
    expect(step(0, 0, 1)).toBe(0);
    expect(step(0, 1, 1)).toBe(0);
  });
});

// The join that lets the lightbox show the file: which LINE brought each
// picture in. The import already knows both halves — the file's lines and
// origin[i] per event — so this is a lookup, not a second read of anything.
describe("which line of the file each picture came from", () => {
  const ev = (type: string, dataBase64?: string) => ({ type, ...(dataBase64 ? { dataBase64 } : {}) });

  it("keys on the bytes, which is the key a click uses too", () => {
    const events = [ev("run_start"), ev("attachment_image", "AAA"), ev("attachment_image", "BBB")];
    const origin = Int32Array.from([0, 4, 9]);
    expect([...imageLines(events, origin)]).toEqual([
      ["AAA", 4],
      ["BBB", 9],
    ]);
  });

  it("ignores a frame the importer built itself", () => {
    const events = [ev("attachment_image", "AAA")];
    expect(imageLines(events, Int32Array.from([-1])).size).toBe(0);
  });

  it("points a duplicated picture at where it FIRST appeared", () => {
    const events = [ev("attachment_image", "AAA"), ev("attachment_image", "AAA")];
    expect(imageLines(events, Int32Array.from([3, 8])).get("AAA")).toBe(3);
  });

  it("reads no further than the shorter of the two arrays", () => {
    const events = [ev("attachment_image", "AAA"), ev("attachment_image", "BBB")];
    expect(imageLines(events, Int32Array.from([2])).size).toBe(1);
  });

  it("stamps the line onto the gallery, and leaves a picture without one alone", () => {
    const g = [
      { name: "a", mediaType: "image/png", dataBase64: "AAA", from: "message" as const, turn: 0 },
      { name: "b", mediaType: "image/png", dataBase64: "BBB", from: "message" as const, turn: 1 },
    ];
    const out = withSourceLines(g, new Map([["AAA", 7]]));
    expect(out[0].sourceLine).toBe(7);
    expect(out[1].sourceLine).toBeUndefined();
  });
});
