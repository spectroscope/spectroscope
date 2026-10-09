// Card 471: /compact and /clear are commands of the web chat, not prompts.
//
// The rules are pure and pinned here in node. A command is decided from the
// WHOLE draft on the client: the draft is exactly the command, give or take
// surrounding whitespace. Text that merely contains "/clear" somewhere is a
// prompt and goes to the model as written (the card's security criterion).

import { describe, expect, it } from "vitest";
import { CHAT_COMMANDS, commandFrame, composerSubmit, matchCommands, parseCommand } from "./chatCommands";

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
  it("offers both commands, compact first, on a bare slash at the start of the draft", () => {
    expect(matchCommands("", 0).map((c) => c.name)).toEqual(["compact", "clear"]);
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
      expect(commandFrame(command.name).type).not.toBe("user_message");
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
