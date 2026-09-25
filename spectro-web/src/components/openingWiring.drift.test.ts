// Card 431, criteria 1 and 5: where App raises and lowers the loading sign.
//
// No DOM in this suite (house rule), and App cannot be rendered here, so its
// wiring is read off disk, the idiom skillsBesideTheList.test.tsx uses for the
// same two functions. The pure halves (the ticket listener, the surface, the
// titles) are pinned by behaviour in their own files.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const app = stripComments(read("../App.tsx", import.meta.url));
const sidebar = stripComments(read("./Sidebar.tsx", import.meta.url));

/** The body of `const name = ...` in App, up to its closing `};` line. */
function fn(name: string): string {
  const at = app.indexOf(`  const ${name} = `);
  if (at < 0) throw new Error(`App declares no ${name}`);
  return app.slice(at, app.indexOf("\n  };\n", at));
}

/** The try block of a function body, without its catch. */
function tryBlock(body: string): string {
  const from = body.indexOf("try {");
  const to = body.indexOf("} catch");
  if (from < 0 || to < 0) throw new Error("no try/catch");
  return body.slice(from, to);
}

const catchBlock = (body: string): string => body.slice(body.indexOf("} catch"));

describe("the sign is App state that a newer ticket clears", () => {
  it("holds the sign as state, so it lands in the same commit as the view", () => {
    expect(app).toMatch(/const \[opening, setOpening\] = useState<SessionOpening \| null>\(null\);/);
  });

  it("lets every new navigation ticket take an older open's sign down", () => {
    expect(app).toMatch(
      /const navNonce = useRef\(\s*createNavNonce\(\(ticket\) => setOpening\(\(o\) => openingAfterIssue\(o, ticket\)\)\),?\s*\)\.current;/,
    );
  });

  it("draws the sign inside the main column, over the view", () => {
    const col = app.slice(app.indexOf('<div className="main-col">'), app.indexOf("<SettingsPanel"));
    // Card 435 draws the trace build's sign in the same slot; the open's sign
    // wins while both could show (archiveTraceWiring.drift.test.ts).
    expect(app).toMatch(/const sign = opening \?\? traceBuilding;/);
    expect(col).toMatch(/\{sign !== null && \(\s*<OpeningSurface[^>]*opening=\{sign\}/);
  });
});

for (const name of ["openSession", "resumeSession"]) {
  describe(`${name} raises the sign at the click and lowers it with the view`, () => {
    const body = fn(name);
    const tried = tryBlock(body);

    it("raises it before the first await, so it is up in the frame after the click", () => {
      const raise = body.indexOf("setOpening({ ticket, sessionId: id, title: sessionTitleOf(id) });");
      expect(raise).toBeGreaterThan(-1);
      expect(raise).toBeGreaterThan(body.indexOf("const ticket = navNonce.issue();"));
      expect(raise).toBeLessThan(body.indexOf("await "));
    });

    it("lowers it after the last await, with no await between it and the view", () => {
      const lower = tried.indexOf("setOpening(null);");
      expect(lower).toBeGreaterThan(tried.lastIndexOf("await "));
      const shows = name === "openSession" ? "setReplay({" : "setLive(seedResumedLive(seeded));";
      const view = tried.indexOf(shows);
      expect(view).toBeGreaterThan(lower);
      expect(tried.slice(lower, view)).not.toContain("await");
    });

    it("lowers it when the open fails, if the open still holds the ticket", () => {
      const failed = catchBlock(body);
      const guard = failed.indexOf("if (!navNonce.isCurrent(ticket)) return;");
      expect(guard).toBeGreaterThan(-1);
      expect(failed.indexOf("setOpening(null);")).toBeGreaterThan(guard);
    });

    it("sends a bad status to that same failure path", () => {
      expect(tried).toContain("if (!res.ok) throw new Error(String(res.status));");
    });
  });
}

describe("the sign knows the row's words", () => {
  it("the sidebar hands every list it loads to the title store", () => {
    const load = sidebar.slice(sidebar.indexOf("const load = async"), sidebar.indexOf("void load();"));
    expect(load).toContain("rememberSessionTitles(list);");
  });
});
