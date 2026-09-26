// Card 416: the names rtk's rewrite rides the wire under, held to the Java source.
//
// RtkFilter.apply writes the executed line into `command` and adds the model's
// line and the rewriter's name beside it. The web reads those three fields off
// the permission_request to keep the rewrite on the tool card. A field renamed
// in Java would leave the card showing one line again without any test going
// red, so the names are read here from RtkFilter's constants.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RTK_COMMAND_FIELD,
  RTK_ORIGINAL_FIELD,
  RTK_REWRITER_FIELD,
  RTK_TOOL,
  rtkRewriteOf,
} from "./rtkRewrite";

const FILTER = "spectro-core/src/main/java/dev/spectroscope/core/tools/RtkFilter.java";

const java = readFileSync(fileURLToPath(new URL(`../../../${FILTER}`, import.meta.url)), "utf8");

function stringConstant(name: string): string {
  const m = new RegExp(`public static final String ${name}\\s*=\\s*"([^"]*)";`).exec(java);
  if (m === null) throw new Error(`${FILTER} no longer declares ${name}`);
  return m[1];
}

describe("the rewrite fields match RtkFilter", () => {
  it("names the tool, the executed line, the original and the rewriter as Java does", () => {
    expect({
      tool: RTK_TOOL,
      command: RTK_COMMAND_FIELD,
      original: RTK_ORIGINAL_FIELD,
      rewriter: RTK_REWRITER_FIELD,
    }).toEqual({
      tool: stringConstant("TOOL"),
      command: stringConstant("COMMAND_FIELD"),
      original: stringConstant("ORIGINAL_FIELD"),
      rewriter: stringConstant("REWRITER_FIELD"),
    });
  });

  it("reads the rewriter's value Java writes", () => {
    const by = stringConstant("REWRITER");
    const input = { [RTK_COMMAND_FIELD]: "rtk ls", [RTK_ORIGINAL_FIELD]: "ls", [RTK_REWRITER_FIELD]: by };
    expect(rtkRewriteOf(RTK_TOOL, input)).toEqual({ command: "rtk ls", original: "ls", rewrittenBy: by });
  });
});

describe("rtkRewriteOf", () => {
  const rewritten = { command: "rtk git status", originalCommand: "git status", rewrittenBy: "rtk" };

  it("keeps every other field out of the answer and reads the three it knows", () => {
    expect(rtkRewriteOf("run_command", { ...rewritten, timeoutSeconds: 30 })).toEqual({
      command: "rtk git status",
      original: "git status",
      rewrittenBy: "rtk",
    });
  });

  it("answers null for a call rtk left alone", () => {
    expect(rtkRewriteOf("run_command", { command: "git status" })).toBeNull();
  });

  it("answers null for any other tool, whatever it carries (owner call 2)", () => {
    expect(rtkRewriteOf("run_in_terminal", rewritten)).toBeNull();
    expect(rtkRewriteOf("Bash", rewritten)).toBeNull();
  });

  it("answers null when a field is missing or not text", () => {
    expect(rtkRewriteOf("run_command", { ...rewritten, rewrittenBy: undefined })).toBeNull();
    expect(rtkRewriteOf("run_command", { ...rewritten, originalCommand: 7 })).toBeNull();
    expect(rtkRewriteOf("run_command", { ...rewritten, command: null })).toBeNull();
    expect(rtkRewriteOf("run_command", null)).toBeNull();
    expect(rtkRewriteOf("run_command", "rtk ls")).toBeNull();
    expect(rtkRewriteOf("run_command", [rewritten])).toBeNull();
  });

  it("answers null when the two lines are the same, since nothing was changed", () => {
    expect(rtkRewriteOf("run_command", { ...rewritten, command: "git status" })).toBeNull();
  });
});
