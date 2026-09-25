// Card 421 reads the folder of a stored session off `run_start.workspace`.
// The name is the Java record component's, serialized by Jackson, so a rename
// on the server would leave storedFolderOf finding nothing and the pane back on
// "no workspace yet" with every test here still green. This holds the name.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const UNION = "spectro-core/src/main/java/dev/spectroscope/core/events/RunEvent.java";

/** The canonical component list of RunStart, up to its `implements` clause. */
function runStartComponents(): string {
  const src = readFileSync(fileURLToPath(new URL(`../../../${UNION}`, import.meta.url)), "utf8");
  const start = src.indexOf("record RunStart(");
  if (start < 0) throw new Error(`${UNION} no longer declares record RunStart`);
  const end = src.indexOf("implements RunEvent", start);
  if (end < 0) throw new Error(`${UNION}: RunStart has no implements clause`);
  return src.slice(start, end);
}

describe("run_start.workspace, the field storedFolderOf reads", () => {
  it("is a String component named workspace on the Java record", () => {
    expect(runStartComponents()).toMatch(/\bString\s+workspace\s*,/);
  });
});
