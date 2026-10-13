// Card 558: the session's skills, commands and agents (session_items).
//
// The server reads them for the session's next turn: the workspace's, the
// picked playbook's (read in place) and the user's, a doubled name kept in
// every source under its namespace. The page folds the socket-only frame and
// a later frame replaces the earlier one, so a pick changed in the dropdown
// takes the old playbook's items out of the picker when the new list arrives
// (criterion 3).

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { initialState, reduce, type UiState } from "./reducer";
import { parseSessionItems, sessionItemsOf, slashItems, wantsItems, type SessionItems } from "./sessionItems";
import { NON_WIRE_TYPES } from "../wire/nonWire";

const PICKED = {
  type: "session_items",
  playbook: { dir: "/pb/spectro", id: "spectro", name: "spectro" },
  items: [
    {
      kind: "agent",
      name: "reviewer",
      plain: "reviewer",
      source: "playbook",
      namespace: "spectro",
      description: "Reviews",
    },
    {
      kind: "command",
      name: "ship",
      plain: "ship",
      source: "playbook",
      namespace: "spectro",
      description: "Ship it",
    },
    {
      kind: "skill",
      name: "spectro:brainstorming",
      plain: "brainstorming",
      source: "playbook",
      namespace: "spectro",
      description: "Team brainstorming",
    },
    {
      kind: "skill",
      name: "lint",
      plain: "lint",
      source: "workspace",
      namespace: "workspace",
      description: "Lint",
    },
    {
      kind: "skill",
      name: "user:brainstorming",
      plain: "brainstorming",
      source: "user",
      namespace: "user",
      description: "My brainstorming",
    },
  ],
};

const NONE = {
  type: "session_items",
  playbook: null,
  items: [
    {
      kind: "skill",
      name: "brainstorming",
      plain: "brainstorming",
      source: "user",
      namespace: "user",
      description: "My brainstorming",
    },
    {
      kind: "skill",
      name: "lint",
      plain: "lint",
      source: "workspace",
      namespace: "workspace",
      description: "Lint",
    },
  ],
};

function fold(...frames: unknown[]): UiState {
  return frames.reduce<UiState>((s, f) => reduce(s, f as RunEvent), initialState);
}

describe("session_items", () => {
  it("is a socket-only frame, and so is the page's ask for it", () => {
    expect(NON_WIRE_TYPES.has("session_items")).toBe(true);
    expect(NON_WIRE_TYPES.has("get_session_items")).toBe(true);
  });

  it("reads the picked playbook and every item, and leaves out a row it cannot read", () => {
    const read = parseSessionItems({
      ...PICKED,
      items: [...PICKED.items, { kind: "macro", name: "x", source: "user" }],
    });
    expect(read?.playbook).toEqual({ dir: "/pb/spectro", id: "spectro", name: "spectro" });
    expect(read?.items.map((i) => i.name)).toEqual([
      "reviewer",
      "ship",
      "spectro:brainstorming",
      "lint",
      "user:brainstorming",
    ]);
    expect(parseSessionItems({ type: "session_items" })).toBeNull();
    expect(parseSessionItems(NONE)?.playbook).toBeNull();
  });

  it("is folded into the state, and a later frame replaces it: a changed pick takes the old items out", () => {
    const picked = fold(PICKED);
    expect(picked.sessionItems?.items.map((i) => i.name)).toContain("spectro:brainstorming");

    const none = fold(PICKED, NONE);
    expect(none.sessionItems?.playbook).toBeNull();
    expect(none.sessionItems?.items.map((i) => i.name)).toEqual(["brainstorming", "lint"]);

    expect(fold(PICKED, { type: "session_items" }).sessionItems).toEqual(picked.sessionItems);
    expect(initialState.sessionItems).toBeNull();
  });

  it("offers skills and commands as slash items with their source, and no agent", () => {
    const options = slashItems(parseSessionItems(PICKED) as SessionItems);
    expect(options.map((o) => o.name)).toEqual([
      "ship",
      "spectro:brainstorming",
      "lint",
      "user:brainstorming",
    ]);
    const playbookSkill = options.find((o) => o.name === "spectro:brainstorming");
    expect(playbookSkill).toMatchObject({
      folder: "brainstorming",
      pack: null,
      kind: "skill",
      source: "playbook",
      sourceName: "spectro",
    });
    expect(options.find((o) => o.name === "ship")?.kind).toBe("command");
    expect(options.find((o) => o.name === "lint")?.sourceName).toBeUndefined();
  });

  it("belongs to the session in view: live, or a woken stored session that can be continued", () => {
    const items = parseSessionItems(NONE);
    expect(
      sessionItemsOf({ viewingLive: true, liveItems: items, continuable: false, wokenItems: null }),
    ).toBe(items);
    expect(
      sessionItemsOf({ viewingLive: false, liveItems: items, continuable: true, wokenItems: null }),
    ).toBeNull();
    expect(
      sessionItemsOf({ viewingLive: false, liveItems: null, continuable: false, wokenItems: items }),
    ).toBeNull();
  });

  it("is asked for once, when something that shows it is open and nothing has arrived", () => {
    expect(wantsItems(true, null, false)).toBe(true);
    expect(wantsItems(true, null, true)).toBe(false);
    expect(wantsItems(false, null, false)).toBe(false);
    expect(wantsItems(true, parseSessionItems(NONE), false)).toBe(false);
  });
});
