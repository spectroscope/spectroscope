// Card 453, criteria 8 and 10: the permission modes are listed once, in
// SpectroConfig.PERMISSION_MODES. The web list, its hints in both languages,
// the command line flags, scheduled jobs and the server's live switch are held
// against that list, read off the Java source rather than copied here.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dict } from "../i18n/i18n";
import { MODES } from "./workspaceGear";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), "utf8");
}

/** The string literals of one `NAME = List.of(...)` declaration. */
function listOf(java: string, name: string): string[] {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:java\\.util\\.)?List\\.of\\(([^)]*)\\)`).exec(java);
  if (match === null) throw new Error(`no ${name} = List.of(...) in the source`);
  const body = match[1] as string;
  return [...body.matchAll(/"([a-z]+)"|\b(READONLY|AUTO|EXTENDED)\b/g)].map((m) =>
    m[1] !== undefined ? m[1] : (m[2] as string).toLowerCase(),
  );
}

const CORE = "spectro-core/src/main/java/dev/spectroscope/core";

function knownModes(): string[] {
  return listOf(source(`${CORE}/config/SpectroConfig.java`), "PERMISSION_MODES");
}

const sorted = (list: string[]): string[] => [...list].sort();

/** Every string literal list in `java` that names two or more known modes, in
 *  any order: a hand copy of the mode list, whatever collection wraps it. */
function handListedModes(java: string): string[] {
  const mode = `"(?:${knownModes().join("|")})"`;
  const pair = new RegExp(`${mode}\\s*,\\s*${mode}`, "g");
  return [...java.matchAll(pair)].map((m) => m[0]);
}

describe("the permission modes, one list", () => {
  it("reads a list the server actually has", () => {
    const known = knownModes();
    expect(known.length).toBeGreaterThanOrEqual(4);
    expect(known).toContain("extended");
  });

  it("the web switch lists exactly the known modes, in their order", () => {
    expect(MODES.map((m) => m.id)).toEqual(knownModes());
  });

  it("every mode has a hint in English and German", () => {
    for (const mode of knownModes()) {
      const hint = dict[`wsg.mode.${mode}.hint`];
      expect(hint, `wsg.mode.${mode}.hint is missing`).toBeDefined();
      expect(hint?.en.trim()).not.toBe("");
      expect(hint?.de.trim()).not.toBe("");
    }
  });

  it("spectro node accepts every known mode", () => {
    const node = listOf(
      source("spectro-cli/src/main/java/dev/spectroscope/cli/NodeCommand.java"),
      "PERMISSIONS",
    );
    expect(sorted(node)).toEqual(sorted(knownModes()));
  });

  it("spectro run and scheduled jobs accept every known mode except ask", () => {
    const headless = sorted(knownModes().filter((m) => m !== "ask"));
    const run = listOf(
      source("spectro-cli/src/main/java/dev/spectroscope/cli/RunCommand.java"),
      "PERMISSIONS",
    );
    const job = listOf(source(`${CORE}/scheduler/Job.java`), "PERMISSIONS");
    expect(sorted(run)).toEqual(headless);
    expect(sorted(job)).toEqual(headless);
  });

  it("the server's live switch reads the core list instead of a copy", () => {
    const java = source(
      "spectro-server/src/main/java/dev/spectroscope/server/session/SessionConnection.java",
    );
    const start = java.indexOf("public void onSetPermissionMode(");
    expect(start).toBeGreaterThan(0);
    const body = java.slice(start, java.indexOf("\n    }\n", start));
    expect(body).toContain("SpectroConfig.knownPermissionModes()");
    expect(handListedModes(java), "a hand copy of the mode list in SessionConnection").toEqual([]);
  });
});

describe("the extended hint", () => {
  it("says the agent reaches anywhere the account can, without asking, in both languages", () => {
    const hint = dict["wsg.mode.extended.hint"];
    expect(hint?.en).toMatch(/anywhere/);
    expect(hint?.en).toMatch(/without asking/);
    expect(hint?.de).toMatch(/überall/);
    expect(hint?.de).toMatch(/ohne (zu fragen|Rückfrage)/);
  });

  // Review finding 3: a pick in the switch lasts until the window reconnects,
  // and extended from the user settings is not session-bound at all.
  it("says how long a pick lasts and where to keep it, and claims no session scope", () => {
    const hint = dict["wsg.mode.extended.hint"];
    expect(hint?.en).toMatch(/until this window reconnects/);
    expect(hint?.en).toMatch(/user settings/);
    expect(hint?.de).toMatch(/bis sich dieses Fenster neu verbindet/);
    expect(hint?.de).toMatch(/Benutzereinstellungen/);
    for (const text of [hint?.en ?? "", hint?.de ?? ""]) {
      expect(text).not.toMatch(/session only|diese Sitzung/i);
    }
  });

  it("carries no dash characters", () => {
    const hint = dict["wsg.mode.extended.hint"];
    for (const text of [hint?.en ?? "", hint?.de ?? ""]) {
      expect(text).not.toMatch(/[‒–—―]/);
      expect(text).not.toMatch(/--/);
    }
  });
});
