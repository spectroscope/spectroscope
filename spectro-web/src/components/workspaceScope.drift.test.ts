// What the composer gear may offer to write into the sandbox — held against the
// server's own list, read off the server's own source.
//
// Card 222, review finding F11. The workspace-scope rule is "the workspace is
// the folder the AGENT writes into, so a key that steers the agent's own
// machinery cannot be honoured from inside it". SpectroConfig owns the list;
// SettingsWriter takes a copy of that object rather than re-typing it, because
// card 199 already paid for the two-lists version. And then workspaceGear.ts
// carried a THIRD copy — in a comment, naming workspace and logLevel and
// nothing else, three keys behind the rule it was describing.
//
// The popover writes to the LOCAL scope, which is a workspace scope, so every
// field it offers is a field the server may refuse. Nothing was stopping a
// forbidden key from being added to OVERRIDE_SPECS and shipping a row that
// always fails. This test is that stop, and it re-reads the real list rather
// than keeping a fourth copy of it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { overridableFields } from "./workspaceGear";

/** The keys SpectroConfig refuses in a workspace scope, off its own source.
 *  Read rather than repeated: a copy is the defect being pinned. */
function forbiddenKeys(): string[] {
  const java = readFileSync(
    fileURLToPath(
      new URL(
        "../../../spectro-core/src/main/java/dev/spectroscope/core/config/SpectroConfig.java",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  return [...java.matchAll(/new ProcessGlobal\("([A-Za-z][A-Za-z0-9]*)"/g)].map((m) => m[1] as string);
}

describe("the composer gear's machine-local overrides", () => {
  it("reads a list the server actually has", () => {
    // A walker that quietly finds nothing would make every assertion below
    // vacuous — the failure mode that makes source-reading guards worthless.
    const forbidden = forbiddenKeys();
    expect(forbidden.length).toBeGreaterThanOrEqual(5);
    expect(new Set(forbidden).size).toBe(forbidden.length);
  });

  it("offers no field the server refuses in a workspace scope", () => {
    const forbidden = new Set(forbiddenKeys());
    const offered = overridableFields().filter((field) => forbidden.has(field));
    expect(
      offered,
      `the popover writes these into the workspace's own settings.local.json and ` +
        `SpectroConfig refuses them there — the row would always fail: ${offered.join(", ")}`,
    ).toEqual([]);
  });
});
