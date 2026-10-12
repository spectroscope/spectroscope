// Card 471: /compact and /clear are commands of the web chat, not prompts.
//
// The rules are pure and pinned here in node. A command is decided from the
// WHOLE draft on the client: the draft is exactly the command, give or take
// surrounding whitespace. Text that merely contains "/clear" somewhere is a
// prompt and goes to the model as written (the card's security criterion).

import { describe, expect, it } from "vitest";
import {
  CHAT_COMMANDS,
  commandFrame,
  composerSubmit,
  loopFrame,
  loopStopFrame,
  matchCommands,
  parseCommand,
  parseLoop,
} from "./chatCommands";

describe("parseCommand", () => {
  it("reads the two commands from a draft that is exactly the command", () => {
    expect(parseCommand("/compact")).toBe("compact");
    expect(parseCommand("/clear")).toBe("clear");
  });

  it("forgives the whitespace around the command, as the composer trims a prompt", () => {
    expect(parseCommand("  /clear\n")).toBe("clear");
    expect(parseCommand("\t/compact ")).toBe("compact");
  });

  it("leaves a sentence that mentions a command a prompt", () => {
    expect(parseCommand("please /clear the cache")).toBeNull();
    expect(parseCommand("/clear the cache")).toBeNull();
    expect(parseCommand("why does /compact exist")).toBeNull();
    expect(parseCommand("and/clear")).toBeNull();
    expect(parseCommand("/clear\n/compact")).toBeNull();
  });

  it("knows no command it does not have", () => {
    expect(parseCommand("/clearer")).toBeNull();
    expect(parseCommand("/compactor")).toBeNull();
    expect(parseCommand("/")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("/CLEAR")).toBeNull();
  });
});

describe("matchCommands", () => {
  it("offers the three commands, compact first, on a bare slash at the start of the draft", () => {
    // Card 504 adds /loop, which takes a prompt and is written into the draft, not run.
    expect(matchCommands("", 0).map((c) => c.name)).toEqual(["compact", "clear", "loop"]);
    expect(matchCommands("l", 0).map((c) => c.name)).toEqual(["loop"]);
    expect(CHAT_COMMANDS.find((c) => c.name === "loop")?.takesArgs).toBe(true);
  });

  it("narrows by the front of the name", () => {
    expect(matchCommands("cl", 0).map((c) => c.name)).toEqual(["clear"]);
    expect(matchCommands("co", 0).map((c) => c.name)).toEqual(["compact"]);
    expect(matchCommands("c", 0).map((c) => c.name)).toEqual(["compact", "clear"]);
    expect(matchCommands("x", 0)).toEqual([]);
  });

  it("offers nothing to a slash that does not open the draft", () => {
    expect(matchCommands("", 7)).toEqual([]);
    expect(matchCommands("cl", 12)).toEqual([]);
  });
});

describe("commandFrame", () => {
  it("names one socket frame per command, and neither is a user_message", () => {
    expect(commandFrame("compact")).toEqual({ type: "compact_context" });
    expect(commandFrame("clear")).toEqual({ type: "clear_context" });
  });

  it("has a frame and a help key for every command it lists", () => {
    for (const command of CHAT_COMMANDS) {
      // Card 504: /loop takes words and leaves through loopFrame, not commandFrame.
      const frame = command.takesArgs
        ? loopFrame({ intervalSeconds: null, prompt: "x" })
        : commandFrame(command.name as "compact" | "clear");
      expect(frame.type).not.toBe("user_message");
      expect(command.helpKey).toMatch(/^cmd\./);
    }
  });
});

describe("composerSubmit", () => {
  it("turns a draft that is a command into the command", () => {
    expect(composerSubmit(" /clear ")).toEqual({ kind: "command", name: "clear" });
    expect(composerSubmit("/compact")).toEqual({ kind: "command", name: "compact" });
  });

  it("sends anything else as the trimmed prompt, slashes and all", () => {
    expect(composerSubmit("  fix the /clear handling  ")).toEqual({
      kind: "prompt",
      text: "fix the /clear handling",
    });
    expect(composerSubmit("/clean-code tidy this")).toEqual({
      kind: "prompt",
      text: "/clean-code tidy this",
    });
  });

  it("sends nothing for a blank draft", () => {
    expect(composerSubmit("   ")).toBeNull();
  });
});

describe("/loop (card 504)", () => {
  it("reads a leading interval in seconds, minutes and hours", () => {
    expect(parseLoop("/loop 2m check the CI")).toEqual({ intervalSeconds: 120, prompt: "check the CI" });
    expect(parseLoop("/loop 90s x")).toEqual({ intervalSeconds: 90, prompt: "x" });
    expect(parseLoop("/loop 1h x")).toEqual({ intervalSeconds: 3600, prompt: "x" });
  });

  it("is self paced without an interval", () => {
    expect(parseLoop("/loop watch the build")).toEqual({ intervalSeconds: null, prompt: "watch the build" });
  });

  it("hands the server an empty prompt, which it answers with the usage", () => {
    expect(parseLoop("/loop")).toEqual({ intervalSeconds: null, prompt: "" });
    expect(parseLoop("/loop 5m")).toEqual({ intervalSeconds: 300, prompt: "" });
  });

  it("is not a sentence that mentions it, nor a longer word", () => {
    expect(parseLoop("please /loop x")).toBeNull();
    expect(parseLoop("/looping x")).toBeNull();
    expect(parseCommand("/loop x")).toBeNull();
  });

  it("ends the loop on /loop stop, as the REPL does (fix round 1)", () => {
    expect(composerSubmit("/loop stop")).toEqual({ kind: "loopStop" });
    expect(composerSubmit("  /loop   stop  ")).toEqual({ kind: "loopStop" });
    expect(loopStopFrame()).toEqual({ type: "set_loop", action: "stop" });
    // A task that only starts with the word is still a loop.
    expect(composerSubmit("/loop stop the flaky test")).toEqual({
      kind: "loop",
      intervalSeconds: null,
      prompt: "stop the flaky test",
    });
    expect(composerSubmit("/loop 5m stop")).toEqual({ kind: "loop", intervalSeconds: 300, prompt: "stop" });
  });

  it("is decided by the composer and leaves as set_loop", () => {
    expect(composerSubmit("/loop 2m check")).toEqual({ kind: "loop", intervalSeconds: 120, prompt: "check" });
    expect(loopFrame({ intervalSeconds: 120, prompt: "check" })).toEqual({
      type: "set_loop",
      action: "start",
      prompt: "check",
      intervalSeconds: 120,
    });
    expect(loopFrame({ intervalSeconds: null, prompt: "watch" })).toEqual({
      type: "set_loop",
      action: "start",
      prompt: "watch",
    });
  });
});
