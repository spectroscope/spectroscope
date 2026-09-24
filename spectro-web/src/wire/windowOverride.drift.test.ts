// Card 390: two facts the web restates from Java, held to the Java source.
//
// 1. The names a threshold's source rides the wire under. Java writes
//    `CompactionThreshold.Source.wireName()`, which is the enum constant
//    lowercased. The web had the four older names typed by hand in three
//    unions, and the reverted first build of the override added a fifth in
//    Java that no union knew: the ring compared its "on" state against the
//    wrong word and never promoted the window (review 2026-09-24, E3 and E4).
//    So the list is read here from the enum, and a sixth name added in Java
//    turns this file red until the web knows it.
//
// 2. The range a person may set as the window of a session. The server owns
//    it (WindowOverrideRequest.FLOOR and CEILING); the web mirrors it to
//    disable its button, and a mirror that drifted would disable a value the
//    server takes or offer one it refuses.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { THRESHOLD_SOURCES } from "./thresholdSources";
import { WINDOW_OVERRIDE_CEILING, WINDOW_OVERRIDE_FLOOR } from "./windowOverride";

const java = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${name}`, import.meta.url)), "utf8");

const THRESHOLD = "spectro-core/src/main/java/dev/spectroscope/core/session/CompactionThreshold.java";
const REQUEST = "spectro-server/src/main/java/dev/spectroscope/server/session/WindowOverrideRequest.java";

/** The constants of `enum Source`, in declaration order, javadoc stripped. */
function sourceConstants(): string[] {
  const src = java(THRESHOLD);
  const open = src.indexOf("public enum Source {");
  if (open < 0) throw new Error(`${THRESHOLD} no longer declares enum Source`);
  // Comments first: a javadoc above a constant may hold a semicolon of its own.
  const body = src
    .slice(open + "public enum Source {".length)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const names = body
    .slice(0, body.indexOf(";"))
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (names.length === 0) throw new Error(`${THRESHOLD} enum Source has no constants`);
  return names;
}

function intConstant(src: string, name: string): number {
  const m = new RegExp(`static final int ${name}\\s*=\\s*([0-9_]+);`).exec(src);
  if (m === null) throw new Error(`${REQUEST} no longer declares ${name}`);
  return Number(m[1].replace(/_/g, ""));
}

describe("the web knows every threshold source Java can write (card 390)", () => {
  it("the wire name is still the constant lowercased", () => {
    // The derivation below leans on this one line; if it changes, so must the test.
    expect(java(THRESHOLD)).toContain("return name().toLowerCase(Locale.ROOT);");
  });

  it("the TypeScript list is the Java enum, name for name", () => {
    const fromJava = sourceConstants().map((n) => n.toLowerCase());
    expect([...THRESHOLD_SOURCES].sort()).toEqual([...fromJava].sort());
  });

  it("and the session window is one of them", () => {
    expect(sourceConstants()).toContain("WINDOW_OVERRIDE");
    expect(THRESHOLD_SOURCES).toContain("window_override");
  });
});

describe("the web's range for a session window is the server's (card 390)", () => {
  it("floor and ceiling are the numbers WindowOverrideRequest refuses outside of", () => {
    const src = java(REQUEST);
    expect(WINDOW_OVERRIDE_FLOOR).toBe(intConstant(src, "FLOOR"));
    expect(WINDOW_OVERRIDE_CEILING).toBe(intConstant(src, "CEILING"));
    expect(WINDOW_OVERRIDE_FLOOR).toBe(8_000);
    expect(WINDOW_OVERRIDE_CEILING).toBe(10_000_000);
  });
});
