// Card 445, criterion 4 and review finding 2: a delete from the row menu of the
// session open on screen falls back the way the archive bar's delete does.
// Both deletes end in App's sessionDeleted, and the decision inside it is the
// pure deletionLeavesView (sessionMeta.test.ts). No DOM in this suite (house
// rule), so the wiring is read off disk, the idiom of openingWiring.drift.test.ts.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const app = stripComments(read("../App.tsx", import.meta.url));
const sidebar = stripComments(read("./Sidebar.tsx", import.meta.url));

/** The body of `const name = ...` in a component, up to its closing `};` line. */
function fn(src: string, name: string): string {
  const at = src.indexOf(`  const ${name} = `);
  if (at < 0) throw new Error(`no ${name}`);
  return src.slice(at, src.indexOf("\n  };\n", at));
}

describe("a delete from either place moves the view the same way", () => {
  it("sessionDeleted leaves the replay for the live view when the deleted session is on screen", () => {
    const body = fn(app, "sessionDeleted");
    const guard = body.indexOf("if (deletionLeavesView(replay, id)) {");
    expect(guard).toBeGreaterThan(-1);
    const end = body.indexOf("\n    }\n", guard);
    const block = body.slice(guard, end);
    expect(block).toContain("setReplay(null);");
    expect(block).toContain('commitUrl({ kind: "live", tab: null }, "apply");');
    expect(body.slice(end)).toContain("setRefreshToken((n) => n + 1);");
  });

  it("the archive bar's delete reaches it once the server said yes", () => {
    const body = fn(app, "deleteSession");
    const refused = body.indexOf("if (!res.ok) return;");
    expect(refused).toBeGreaterThan(-1);
    expect(body.indexOf("sessionDeleted(id);")).toBeGreaterThan(refused);
  });

  it("App hands it to the sidebar", () => {
    const from = app.indexOf("        <Sidebar\n");
    expect(from).toBeGreaterThan(-1);
    const element = app.slice(from, app.indexOf("\n        />\n", from));
    expect(element).toContain("onSessionDeleted={sessionDeleted}");
  });

  it("the row menu's delete reaches it once the server deleted the session", () => {
    const body = fn(sidebar, "confirmDelete");
    const failed = body.indexOf('if (outcome === "failed") {');
    expect(failed).toBeGreaterThan(-1);
    expect(body.indexOf("props.onSessionDeleted?.(row.id);")).toBeGreaterThan(
      body.indexOf("return;", failed),
    );
  });
});
