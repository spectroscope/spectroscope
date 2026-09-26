// Card 389 criterion 4, card 288 criteria 1, 5 and 6: the workspace modes the
// browser knows, held against the modes the server writes, read off the
// server's own source.
//
// The server names its modes as bare string literals in two places:
// SessionConnection.workspacePick() returns `new WorkspacePick(path, "<mode>",
// unavailable)` for what it ANNOUNCES, and onSetWorkspace switches on
// `case "<mode>" ->` for what it ACCEPTS from a click. The browser declared
// three announced modes while the server could send four, so a resumed session
// announcing "recorded" matched no button. Nothing here types the server's
// list: it is read from the Java file, so a fifth mode added there turns this
// file red before any web file is touched.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";
import { WORKSPACE_MODES } from "./paneState";
import { CHOOSER_OPTIONS, optionFor, preselectedOption } from "./chooserMode";

const java = read(
  "../../../spectro-server/src/main/java/dev/spectroscope/server/session/SessionConnection.java",
  import.meta.url,
);

/** Every mode literal inside a `new WorkspacePick(...)`: what the server announces. */
function announcedModes(): string[] {
  const found = new Set<string>();
  for (const call of java.matchAll(/new WorkspacePick\(([^)]*)\)/g)) {
    for (const lit of call[1].matchAll(/"([a-z]+)"/g)) found.add(lit[1]);
  }
  return [...found];
}

/** Every `case "<mode>" ->` label inside onSetWorkspace: what the server accepts. */
function acceptedModes(): string[] {
  const start = java.indexOf("public void onSetWorkspace(");
  if (start < 0) throw new Error("SessionConnection.java no longer declares onSetWorkspace");
  const end = java.indexOf("default ->", start);
  if (end < 0) throw new Error("onSetWorkspace no longer ends its switch with a default arm");
  return [...java.slice(start, end).matchAll(/case "([a-z]+)" ->/g)].map((m) => m[1]);
}

describe("the workspace modes are the server's, read off its source", () => {
  it("reads lists the server actually has", () => {
    // A walker that quietly matches nothing makes every assertion below vacuous.
    expect(announcedModes().length).toBeGreaterThan(1);
    expect(acceptedModes().length).toBeGreaterThan(1);
  });

  it("admits every mode the server can announce", () => {
    const known = new Set<string>(WORKSPACE_MODES);
    const missing = announcedModes().filter((m) => !known.has(m));
    expect(missing, `the server announces these and the web type has no word for them`).toEqual([]);
  });

  it("admits no mode the server never announces", () => {
    const announced = new Set(announcedModes());
    const extra = WORKSPACE_MODES.filter((m) => !announced.has(m));
    expect(extra, `the web type admits these and no WorkspacePick ever carries them`).toEqual([]);
  });

  it("draws every announced mode as one of the options it renders", () => {
    const rendered = new Set<string>(CHOOSER_OPTIONS);
    for (const mode of WORKSPACE_MODES) {
      expect(rendered.has(optionFor(mode)), `${mode} maps to ${optionFor(mode)}`).toBe(true);
    }
  });

  it("offers only modes the server accepts from a click", () => {
    const accepted = new Set(acceptedModes());
    const refused = CHOOSER_OPTIONS.filter((o) => !accepted.has(o));
    expect(refused, `onSetWorkspace answers "Unknown workspace mode" for these`).toEqual([]);
  });

  it("checks one option for the frame a resume sends", () => {
    // Card 288 criterion 1, on membership: "recorded" is non-null today, so a
    // null check would be green for the defect it is meant to catch.
    const option = preselectedOption({
      resolved: true,
      mode: "recorded",
      configured: true,
      path: "/Users/you/particle",
      exists: true,
      sessionId: "s1",
    });
    expect(CHOOSER_OPTIONS as readonly string[]).toContain(option);
  });
});

/** Every non-test .ts and .tsx file under src, as [path, text]. */
function sources(): [string, string][] {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const out: [string, string][] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push([p, read(p, import.meta.url)]);
    }
  };
  walk(root);
  return out;
}

describe("the mode set is declared once on the web side", () => {
  it("finds no second union of the server's mode words", () => {
    // Card 288 criterion 6. WorkspaceChooser.tsx declared its own three value
    // `Mode`, and events.ts a third for the client frame. The alternation is
    // built from the Java literals, so this pattern follows the server.
    const words = [...new Set([...announcedModes(), ...acceptedModes()])].join("|");
    const union = new RegExp(`"(?:${words})"\\s*\\|\\s*"(?:${words})"`);
    const copies = sources()
      .filter(([, text]) => union.test(stripComments(text)))
      .map(([p]) => p.slice(p.indexOf("/src/") + 1));
    expect(copies).toEqual([]);
  });
});
