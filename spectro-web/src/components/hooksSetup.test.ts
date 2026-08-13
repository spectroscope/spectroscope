import { describe, expect, it } from "vitest";
import {
  composeHook,
  hookReadingKey,
  rawHooks,
  runsBeforeTheGate,
  timeoutNoteKey,
  withHook,
  withoutHook,
  type HooksView,
} from "./hooksSetup";

const view: HooksView = {
  tier: "eval-execute",
  defaultTimeoutSeconds: 10,
  events: ["pre_tool_use", "post_tool_use"],
  scopes: {
    user: [
      {
        event: "pre_tool_use",
        matcher: "*",
        rawMatcher: null,
        command: "guard.sh",
        redactedBy: "",
        timeoutSeconds: null,
        effectiveTimeoutSeconds: 10,
      },
      {
        event: "post_tool_use",
        matcher: "write_*",
        rawMatcher: "write_*",
        command: "notify.sh",
        redactedBy: "",
        timeoutSeconds: 3,
        effectiveTimeoutSeconds: 3,
      },
    ],
  },
  effective: [],
  files: { user: "/home/x/.spectro/settings.json" },
};

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

  it("answers an empty array for a scope nothing configured", () => {
    expect(rawHooks(view, "project")).toEqual([]);
    expect(rawHooks(null, "user")).toEqual([]);
  });

  it("refuses to write back a hook whose command the server would not show", () => {
    // A redacted command comes back as "". Writing that array would replace the
    // operator's real command with an empty string — a hook silently disarmed by
    // opening its own settings page.
    const redacted: HooksView = {
      ...view,
      scopes: {
        user: [
          {
            event: "pre_tool_use",
            matcher: "*",
            rawMatcher: null,
            command: "",
            redactedBy: "bearer",
            timeoutSeconds: null,
            effectiveTimeoutSeconds: 10,
          },
        ],
      },
    };
    expect(rawHooks(redacted, "user")).toBeNull();
  });
});

describe("composing one hook", () => {
  it("writes the event and the command, and omits what the operator left blank", () => {
    expect(composeHook("pre_tool_use", "", "guard.sh", "")).toEqual({
      event: "pre_tool_use",
      command: "guard.sh",
    });
  });

  it("carries a matcher and a timeout when they were given", () => {
    expect(composeHook("post_tool_use", " write_* ", " notify.sh ", "5")).toEqual({
      event: "post_tool_use",
      matcher: "write_*",
      command: "notify.sh",
      timeoutSeconds: 5,
    });
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
