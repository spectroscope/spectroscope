import { describe, expect, it } from "vitest";
import {
  composeHook,
  hookReadingKey,
  hooksOrigin,
  inForce,
  rawHooks,
  reachKey,
  runsBeforeTheGate,
  scopeIsInForce,
  timeoutNoteKey,
  withHook,
  withoutHook,
  type HookEntry,
  type HooksView,
} from "./hooksSetup";

/** One entry with the fields a test does not care about already filled in.
 *  @param over the fields this test is about
 *  @return the entry as the server would have answered it */
function entry(over: Partial<HookEntry>): HookEntry {
  return {
    event: "pre_tool_use",
    matcher: "*",
    rawMatcher: null,
    command: "guard.sh",
    redactionRule: "",
    timeoutSeconds: null,
    effectiveTimeoutSeconds: 10,
    ...over,
  };
}

const view: HooksView = {
  tier: "eval-execute",
  defaultTimeoutSeconds: 10,
  events: ["pre_tool_use", "post_tool_use"],
  scopes: {
    user: [
      entry({}),
      entry({
        event: "post_tool_use",
        matcher: "write_*",
        rawMatcher: "write_*",
        command: "notify.sh",
        timeoutSeconds: 3,
        effectiveTimeoutSeconds: 3,
      }),
    ],
  },
  effective: [entry({}), entry({ event: "post_tool_use", command: "notify.sh" })],
  origin: { winner: "user", shadowed: [] },
  session: null,
  workspace: null,
  files: { user: "/home/x/.spectro/settings.json" },
};

// ---- what actually runs (review finding 1) ---------------------------------
//
// The block this whole file exists under. `hooks` is a WHOLE-BLOCK field: the
// highest layer that sets it replaces every layer below, they do not add up. A
// page that lists the scopes and leaves the reader to add them up states the
// wrong guards with full confidence — measured in a live session, where a
// workspace hook blocked every tool call while the page listed a user hook that
// never ran once.

describe("which hooks a run would actually load", () => {
  const layered: HooksView = {
    ...view,
    scopes: {
      user: [entry({ command: "user-guard.sh" })],
      project: [entry({ command: "workspace-guard.sh" })],
    },
    effective: [entry({ command: "workspace-guard.sh" })],
    origin: { winner: "project", shadowed: ["user"] },
    session: "abc-123",
    workspace: "/w",
  };

  it("is the folded list, not the scopes added together", () => {
    expect(inForce(layered).map((e) => e.command)).toEqual(["workspace-guard.sh"]);
  });

  it("names the layer in force and the layers it silenced", () => {
    expect(hooksOrigin(layered)).toEqual({ winner: "project", shadowed: ["user"] });
  });

  it("marks a listed scope as running or as silenced", () => {
    // The one a reader acts on: "Your settings" listing a guard that cannot fire
    // is worse than not listing it, because the reader now believes they have it.
    expect(scopeIsInForce(layered, "project")).toBe(true);
    expect(scopeIsInForce(layered, "user")).toBe(false);
  });

  it("answers the no-hooks-anywhere case as defaults rather than as a missing field", () => {
    const bare: HooksView = { ...view, scopes: {}, effective: [], origin: undefined as never };
    expect(hooksOrigin(bare)).toEqual({ winner: "defaults", shadowed: [] });
    expect(hooksOrigin(null)).toEqual({ winner: "defaults", shadowed: [] });
    expect(inForce(null)).toEqual([]);
    expect(scopeIsInForce(bare, "user")).toBe(false);
  });

  it("says whether the answer covers a running session or only this machine", () => {
    // Without a session id the workspace layers never join the chain, so the
    // answer is machine-wide — and the page saying "this is what runs" over a
    // list that has not seen the running session's own settings is the exact
    // wrong claim. Two sentences, one per case, chosen here and never guessed.
    expect(reachKey(layered)).toBe("set.hkReachSession");
    expect(reachKey(view)).toBe("set.hkReachProcess");
    expect(reachKey(null)).toBe("set.hkReachProcess");
  });
});

describe("what a scope writes back", () => {
  it("carries only what the FILE holds, never the server's resolved fields", () => {
    // The one that would bite silently. The read-out answers matcher "*" for a
    // hook whose file entry has no matcher at all, and an effectiveTimeoutSeconds
    // for one that set no timeout. Writing the reading back would persist both,
    // so removing hook B would quietly rewrite hook A — and the file would then
    // pin a default that used to follow the runner.
    expect(rawHooks(view, "user")).toEqual([
      { event: "pre_tool_use", command: "guard.sh" },
      { event: "post_tool_use", matcher: "write_*", command: "notify.sh", timeoutSeconds: 3 },
    ]);
  });

  it("writes the keys in the order the comment above it claims", () => {
    // toEqual does not read key order, and the file this produces is a file a
    // person opens: event, then what it matches, then what it runs, then how
    // long it may take. The review measured the code producing event, command,
    // matcher — the comment described an order the code did not have.
    expect(Object.keys(rawHooks(view, "user")[1])).toEqual(["event", "matcher", "command", "timeoutSeconds"]);
  });

  it("answers an empty array for a scope nothing configured", () => {
    expect(rawHooks(view, "project")).toEqual([]);
    expect(rawHooks(null, "user")).toEqual([]);
  });

  it("writes a command back verbatim even when the run will redact it", () => {
    // Replaces the test that asserted the opposite. A command carrying a
    // credential shape used to come back "" and turn the whole scope read-only,
    // so ONE ordinary email address in ONE notify hook disabled add and every
    // remove on the page — while GET /api/settings shipped the same bytes to
    // the same browser anyway. The rule now travels as a forecast beside the
    // command instead of in place of it.
    const notify: HooksView = {
      ...view,
      scopes: {
        user: [
          entry({
            event: "post_tool_use",
            command: "mail -s blocked chris@spectroscope.ai",
            redactionRule: "email",
          }),
        ],
      },
    };
    expect(rawHooks(notify, "user")).toEqual([
      { event: "post_tool_use", command: "mail -s blocked chris@spectroscope.ai" },
    ]);
  });
});

describe("composing one hook", () => {
  it("writes the event and the command, and omits what the operator left blank", () => {
    expect(composeHook("pre_tool_use", "", "guard.sh", "")).toEqual({
      event: "pre_tool_use",
      command: "guard.sh",
    });
  });

  it("carries a matcher and a timeout when they were given, in the written order", () => {
    const composed = composeHook("post_tool_use", " write_* ", " notify.sh ", "5");
    expect(composed).toEqual({
      event: "post_tool_use",
      matcher: "write_*",
      command: "notify.sh",
      timeoutSeconds: 5,
    });
    expect(Object.keys(composed!)).toEqual(["event", "matcher", "command", "timeoutSeconds"]);
  });

  it("is nothing at all without a command", () => {
    expect(composeHook("pre_tool_use", "*", "   ", "5")).toBeNull();
  });

  it("drops a timeout that is not a positive whole number of seconds", () => {
    // The core treats null and non-positive alike (timeoutOrDefault), so writing
    // 0 or -1 would produce a file that says something it does not mean.
    expect(composeHook("pre_tool_use", "", "guard.sh", "0")).toEqual({
      event: "pre_tool_use",
      command: "guard.sh",
    });
    expect(composeHook("pre_tool_use", "", "guard.sh", "abc")).toEqual({
      event: "pre_tool_use",
      command: "guard.sh",
    });
  });
});

describe("adding and removing", () => {
  it("appends, keeping order — a hook list is walked in order and the first block wins", () => {
    const current = [{ event: "pre_tool_use", command: "a.sh" }];
    expect(withHook(current, { event: "pre_tool_use", command: "b.sh" })).toEqual([
      { event: "pre_tool_use", command: "a.sh" },
      { event: "pre_tool_use", command: "b.sh" },
    ]);
  });

  it("removes by POSITION, because two hooks may legitimately be identical", () => {
    const current = [
      { event: "pre_tool_use", command: "a.sh" },
      { event: "pre_tool_use", command: "a.sh" },
    ];
    expect(withoutHook(current, 0)).toEqual([{ event: "pre_tool_use", command: "a.sh" }]);
  });

  it("refuses a position that is not in the list rather than writing the list back", () => {
    expect(withoutHook([{ event: "pre_tool_use", command: "a.sh" }], 4)).toBeNull();
    expect(withoutHook([{ event: "pre_tool_use", command: "a.sh" }], -1)).toBeNull();
  });
});

describe("how a hook reads", () => {
  it("says which phase it is, because only one of the two can stop a call", () => {
    expect(hookReadingKey(view.scopes.user[0])).toBe("set.hkPre");
    expect(hookReadingKey(view.scopes.user[1])).toBe("set.hkPost");
  });

  it("distinguishes a hook that set its own timeout from one that inherited it", () => {
    expect(timeoutNoteKey(view.scopes.user[0])).toBe("set.hkTimeoutInherited");
    expect(timeoutNoteKey(view.scopes.user[1])).toBe("set.hkTimeoutOwn");
  });

  it("flags exactly the phase that runs before the permission gate", () => {
    // The one judgement this file makes, and it is about what a reader should
    // look at twice, not about what the runner does. A post_tool_use hook cannot
    // stop anything; a pre_tool_use one runs ahead of the gate and can.
    expect(runsBeforeTheGate(view.scopes.user[0])).toBe(true);
    expect(runsBeforeTheGate(view.scopes.user[1])).toBe(false);
  });
});
