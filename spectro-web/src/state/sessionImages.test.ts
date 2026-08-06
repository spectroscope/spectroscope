import { describe, expect, it } from "vitest";
import { collectImages, indexOf, step } from "./sessionImages";
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
