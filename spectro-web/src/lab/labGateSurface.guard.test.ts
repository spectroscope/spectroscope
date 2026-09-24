// Card 382, criteria 2, 1 and 14: where a permission may be asked, and where
// it may not.
//
// The set is derived from the file system rather than typed out. A hand list of
// lab files guarded by a test that types the same hand list is two copies of
// one claim, and the day somebody adds lab/SomethingNew.tsx with a gate in it,
// a typed list stays green. This walks the directory instead, so a new lab file
// is covered the day it is written.

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "../testkit/source";

const labDir = dirname(fileURLToPath(import.meta.url));
const appPath = join(labDir, "..", "App.tsx");

/** Every source file under lab/, tests excluded, at any depth. */
function labFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...labFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/** What a permission surface looks like in source, whatever it is called. */
const GATE_MARKS = ["pendingPermissions", "PermissionDialog", "onDecide"];

describe("the Lab holds no gate surface of its own", () => {
  it("walks the whole directory rather than naming files", () => {
    const files = labFiles(labDir);
    // A guard over an empty set is green and worthless.
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.endsWith("LabView.tsx"))).toBe(true);
  });

  it("has no file that reads the permission queue, mounts the window or takes a decision prop", () => {
    const offenders: string[] = [];
    for (const file of labFiles(labDir)) {
      const src = stripComments(readFileSync(file, "utf8"));
      for (const mark of GATE_MARKS) {
        if (src.includes(mark)) offenders.push(`${file.slice(labDir.length + 1)}: ${mark}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the chat asks in a window", () => {
  const app = stripComments(readFileSync(appPath, "utf8"));

  it("App mounts the window component", () => {
    expect(app).toContain("PermissionDialog");
    expect(app).toMatch(/<PermissionDialog/);
  });

  it("the window is fed from the live fold, not from a stepper", () => {
    // The whole point of the move. If this mount ever reads a folded prefix
    // again, the resurrection of card 382 comes straight back.
    expect(app).toContain("gateQueue(");
    expect(app).toContain("live.pendingPermissions");
  });

  it("the sender consults the queue before it posts an answer", () => {
    // A pure refusal nobody calls ships dead. This pins the call site.
    expect(app).toContain("routeGateAnswer(");
  });

  it("the window is drawn only where gateSurface says window", () => {
    // Fix round 2026-09-24: the Lab draws no window, not even for a live gate.
    const at = app.indexOf("<PermissionDialog");
    expect(app.slice(Math.max(0, at - 200), at)).toContain('gateShown === "window"');
  });

  it("the Lab term reads the tab App actually renders", () => {
    const term = app.slice(app.indexOf("const labOnScreen"));
    expect(term.slice(0, term.indexOf(";"))).toContain('tab === "lab"');
    expect(app).toMatch(/gateSurface\(gateQ, labOnScreen\)/);
  });

  it("the chat tab carries the notice while the Lab is on screen", () => {
    const chatTab = app.slice(app.indexOf('onClick={() => changeTab("chat")}'));
    const body = chatTab.slice(0, chatTab.indexOf("</button>"));
    expect(body).toContain('gateShown === "notice"');
    expect(body).toContain("sp.gateOpen");
  });
});

describe("the bar's fate is decided, not drifted (criterion 14)", () => {
  // Fix round 2026-09-24. The owner, verbatim: "Also unten dieses kleine,
  // schmale Ding unter dem Message Ding, das ist kacke. Das braucht man nicht."
  // The first build kept the bar as the window's collapsed form. It is gone:
  // the file is deleted and nothing under src/ may mount it again.
  const srcDir = join(labDir, "..");

  /** Every source file under src/, tests excluded, at any depth. */
  function srcFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== "node_modules") out.push(...srcFiles(full));
        continue;
      }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      out.push(full);
    }
    return out;
  }

  it("GateBar is deleted", () => {
    expect(existsSync(join(srcDir, "components", "GateBar.tsx"))).toBe(false);
  });

  it("no source file imports or mounts it", () => {
    const files = srcFiles(srcDir);
    expect(files.length).toBeGreaterThan(100);
    const offenders = files
      .filter((file) => /\bGateBar\b/.test(stripComments(readFileSync(file, "utf8"))))
      .map((file) => file.slice(srcDir.length + 1));
    expect(offenders).toEqual([]);
  });

  it("App keeps no set-aside state for the window", () => {
    const app = stripComments(readFileSync(appPath, "utf8"));
    expect(app).not.toContain("gateAside");
    expect(app).not.toContain("onLater");
  });
});
