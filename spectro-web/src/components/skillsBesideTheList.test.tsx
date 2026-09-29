// Card 409: pressing Skills opens the catalogue BESIDE the session list, not
// instead of it. The owner, 2026-09-24: "wenn man in Skills geht, kann man
// nicht mehr auf seine letzte Session gehen, ohne auf Sessions vorher geklickt
// zu haben. Und das ist sehr unintuitiv."
//
// Two seams carried the defect, and this file pins both. The rail: Skills was
// a fourth segment, so opening it swapped the lower list for a note. The
// surface: one `nav` value drove the rail AND the right-hand pane, and opening
// a session never reset it, so even a session row would not have brought the
// chat back. Skills now sits in the upper group with New chat, Scenarios and
// Starters, and the view is a flag of its own that every opened place closes.
//
// No DOM here (house rule), so the rail is rendered to static markup and App's
// wiring is read off disk, the idiom fleetLobby.drift.test.ts and
// skillsPane.test.tsx already use for App.tsx.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Sidebar } from "./Sidebar";
import { SkillsPane } from "./SkillsPane";
import { navActionRows, navSegmentRows } from "./navRows";
import { dict } from "../i18n/i18n";
import { read, stripComments } from "../testkit/source";

type Segment = "sessions" | "fleets" | "stategraph";
const SEGMENTS: Segment[] = ["sessions", "fleets", "stategraph"];

/** The rail as a reader gets it: one segment, the skills view open or not. */
function rail(nav: Segment, skillsOpen: boolean): string {
  return renderToStaticMarkup(
    <Sidebar
      activeId={null}
      refreshToken={0}
      onSelectSession={() => {}}
      onNewChat={() => {}}
      onSettings={() => {}}
      held={[]}
      onImport={() => {}}
      onScenarios={() => {}}
      onStarters={() => {}}
      skillsOpen={skillsOpen}
      onSkills={() => {}}
      onSelectScenario={() => {}}
      stateGraphSource={null}
      onStateGraphScenario={() => {}}
      activeFleet={null}
      onSelectFleet={() => {}}
      onSpawnNode={() => {}}
      nav={nav}
      onNav={() => {}}
    />,
  );
}

/** The one `<button>` whose label span reads `label`, opening tag to close.
 *  Throws when there is none or more than one: a row found twice is a row the
 *  assertion cannot be about. */
function rowOf(html: string, label: string): string {
  const needle = `<span class="nav-row-label">${label}</span>`;
  const at = html.indexOf(needle);
  if (at < 0) throw new Error(`no nav row is labelled ${label}`);
  if (html.indexOf(needle, at + 1) >= 0) throw new Error(`two nav rows are labelled ${label}`);
  const open = html.lastIndexOf("<button", at);
  const close = html.indexOf("</button>", at);
  return html.slice(open, close + "</button>".length);
}

/** The markup of the first `<div class="…">` carrying exactly `cls`, nesting
 *  counted, the same walk sidebarScrollSeam.test.tsx uses. */
function divBlock(html: string, cls: string): string {
  const at = html.indexOf(`class="${cls}"`);
  if (at < 0) throw new Error(`no element carries class="${cls}"`);
  const open = html.lastIndexOf("<div", at);
  let i = open;
  let depth = 0;
  for (;;) {
    const nextOpen = html.indexOf("<div", i + 1);
    const nextClose = html.indexOf("</div>", i + 1);
    if (nextClose < 0) throw new Error(`class="${cls}" is never closed`);
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth += 1;
      i = nextOpen;
    } else if (depth === 0) {
      return html.slice(open, nextClose + "</div>".length);
    } else {
      depth -= 1;
      i = nextClose;
    }
  }
}

describe("Skills sits in the upper group (criterion 4)", () => {
  it("lists Skills after Starters, last in the group (owner call 1's default)", () => {
    expect(navActionRows({ skillsOpen: false }).map((r) => r.id)).toEqual([
      "newChat",
      "scenarios",
      "starters",
      "skills",
    ]);
  });

  it("offers no skills segment any more", () => {
    const ids = navSegmentRows({ active: "sessions", fleetsLocked: false, fleetCount: 0 }).map((r) => r.id);
    expect(ids).toEqual(["sessions", "fleets", "stategraph"]);
  });

  it("marks the Skills row active while the view is open, and no other upper row ever", () => {
    for (const skillsOpen of [false, true]) {
      const rows = navActionRows({ skillsOpen });
      expect(rows.filter((r) => r.active).map((r) => r.id)).toEqual(skillsOpen ? ["skills"] : []);
    }
  });

  it("draws the Skills row in the upper group and not in the tablist", () => {
    const html = rail("sessions", false);
    const upper = divBlock(html, "sidebar-nav");
    const tabs = divBlock(html, "sidebar-nav sidebar-nav-seg");
    expect(upper).toContain('<span class="nav-row-label">Skills</span>');
    expect(tabs).not.toContain('<span class="nav-row-label">Skills</span>');
    expect(upper.indexOf(">Starters<")).toBeLessThan(upper.indexOf(">Skills<"));
    // An upper row is a plain button: no tab role to announce a segment it is not.
    expect(rowOf(html, "Skills")).not.toContain('role="tab"');
  });
});

describe("the session list survives opening Skills (criteria 1 and 2)", () => {
  it("keeps the session list on screen while the view is open", () => {
    const open = rail("sessions", true);
    // Card 458: there is no hardwired live row any more; a held session is a
    // row of the list itself.
    expect(open).not.toContain("live-row");
    expect(open).toContain('<nav class="session-list"');
    expect(open).toContain("scenario-list");
  });

  it("draws the rail exactly as the sessions segment draws it, except the Skills row's mark", () => {
    // Criterion 2's "unchanged": the stored rows come from a fetch in an
    // effect, which no server render runs, so they cannot be counted here.
    // What can be proven is that the open rail IS the closed rail, byte for
    // byte, once the one row that says "open" is set back. The stored rows
    // render inside that same branch.
    const open = rail("sessions", true);
    const closed = rail("sessions", false);
    const openRow = rowOf(open, "Skills");
    const closedRow = rowOf(closed, "Skills");
    expect(openRow).toContain('class="nav-row active"');
    expect(closedRow).toContain('class="nav-row"');
    expect(open.replace(openRow, closedRow)).toBe(closed);
  });

  it("leaves whichever list was showing alone, on every segment", () => {
    for (const nav of SEGMENTS) {
      const open = rail(nav, true);
      expect(open.replace(rowOf(open, "Skills"), rowOf(rail(nav, false), "Skills")), nav).toBe(
        rail(nav, false),
      );
    }
  });

  it("puts the rail's old skills note nowhere in the rail", () => {
    // The facts the dashed note carried now live in the view's head (below).
    for (const nav of SEGMENTS) {
      for (const skillsOpen of [false, true]) {
        const html = rail(nav, skillsOpen);
        expect(html, `${nav} ${skillsOpen}`).not.toContain("namespace and enabled state");
        expect(html, `${nav} ${skillsOpen}`).not.toContain("Namespace und Schalter-Stand");
      }
    }
  });
});

describe("the hint moves into the skills view's head (criterion 6, owner call 2's default)", () => {
  it("says what the rail's note said, in both languages, inside the head", () => {
    // Merged into the view's own claim rather than drawn twice: the note ended
    // "in the view on the right", which is false inside that view, and the
    // claim already says where switching happens.
    expect(dict["skv.claim"].en).toContain("namespace and enabled state");
    expect(dict["skv.claim"].de).toContain("Namespace und Schalter-Stand");
    const html = renderToStaticMarkup(<SkillsPane />);
    const head = html.slice(html.indexOf('<header class="skills-head">'), html.indexOf("</header>"));
    expect(head).toContain("namespace and enabled state");
  });

  it("retires the rail's key, so nothing can draw the note in the rail again", () => {
    expect(dict["nav.skillsNote"]).toBeUndefined();
  });
});

describe("App: the view is a flag of its own, and every opened place closes it (criteria 3 and 5)", () => {
  const app = stripComments(read("../App.tsx", import.meta.url));

  /** The body of a top-level arrow function in App, `const name` to its `};`. */
  const fn = (name: string): string => {
    const at = app.indexOf(`  const ${name} = `);
    if (at < 0) throw new Error(`App declares no ${name}`);
    return app.slice(at, app.indexOf("\n  };\n", at));
  };

  it("keeps skills out of the segment state and in a flag of its own", () => {
    expect(app).toMatch(
      /const \[nav, setNav\] = useState<"sessions" \| "fleets" \| "stategraph">\("sessions"\)/,
    );
    expect(app).toMatch(/const \[skillsOpen, setSkillsOpen\] = useState\(false\)/);
  });

  it("draws the skills view from the flag, ahead of every segment arm", () => {
    expect(app).toMatch(/\{skillsOpen \? \(\s*<SkillsPane \/>\s*\) : nav === "stategraph" \? \(/);
    expect(app).toMatch(/const wholeSurface = skillsOpen \|\| nav === "stategraph";/);
  });

  it("opens the view from the Skills row without touching the rail's segment", () => {
    const open = fn("openSkills");
    expect(open).toContain("setSkillsOpen(true)");
    expect(open).not.toContain("setNav(");
    expect(app).toMatch(/onSkills=\{openSkills\}/);
    expect(app).toMatch(/skillsOpen=\{skillsOpen\}/);
  });

  it("opens the same view through both older doors, the settings address and the plus menu", () => {
    const caseAt = app.indexOf('case "open-settings":');
    expect(caseAt).toBeGreaterThan(-1);
    const redirect = app.slice(caseAt, app.indexOf("setSettingsOpen(true);", caseAt));
    expect(redirect).toMatch(
      /section === "skills" \|\| action\.section === "skills-catalogue"\) \{\s*openSkills\(\);/,
    );
    const plus = app.slice(app.indexOf("onOpenSettingsSection:"));
    expect(plus.slice(0, plus.indexOf("setSettingsOpen(true)"))).toMatch(
      /section === "skills" \|\| section === "skills-catalogue"\) \{\s*openSkills\(\);/,
    );
    expect(app).not.toContain('setNav("skills")');
  });

  it("closes the view when a session opens, in the step that shows it (criterion 3)", () => {
    // openSession never touched `nav`, so a session row could not bring the
    // chat back while the pane read "skills". The close sits beside setReplay,
    // after the fetch: a session that fails to load leaves the view as it was.
    const body = fn("openSession");
    const shown = body.indexOf("setReplay({");
    expect(shown).toBeGreaterThan(-1);
    expect(body.indexOf("setSkillsOpen(false)")).toBeGreaterThan(shown);
    // Card 458: the rail's click goes through selectSession, which opens.
    expect(app).toMatch(/onSelectSession=\{selectSession\}/);
    expect(app).toMatch(/const selectSession = [\s\S]*?void openSession\(id\);/);
  });

  it("guards openSession's late close with a ticket that a later Skills press outdates", () => {
    // openSession closes the view after its await. Click a session, then Skills
    // before the events arrive: the fetch lands last, but the Skills press was
    // the later gesture, so the view must stay open. The two gestures share a
    // last-wins ticket of their own. It is not navNonce, because a ticket there
    // would also drop an in-flight resumeSession.
    expect(app).toMatch(/const skillsNonce = useRef\(createNavNonce\(\)\)\.current;/);
    const open = fn("openSkills");
    expect(open).toContain("skillsNonce.issue();");
    expect(open).not.toContain("navNonce");
    const body = fn("openSession");
    const take = body.indexOf("const skillsTicket = skillsNonce.issue();");
    expect(take).toBeGreaterThan(-1);
    expect(take).toBeLessThan(body.indexOf("await "));
    expect(body).toMatch(/if \(skillsNonce\.isCurrent\(skillsTicket\)\) setSkillsOpen\(false\);/);
    expect(body.split("setSkillsOpen(false)").length - 1).toBe(1);
  });

  it("closes it for every other place the rail or a dialog opens", () => {
    // The live row, a fleet, a new chat, a scenario, an import: each shows a
    // run on the surface the view covers, so each closes it.
    for (const name of ["leaveToLiveCore", "applyFleet", "newChat", "openScenario", "openImport"]) {
      expect(fn(name), name).toContain("setSkillsOpen(false)");
    }
    // The state graph rail's scenarios load a run under the view; so does a
    // segment press, from the rail or from the desktop menu.
    const sg = app.slice(app.indexOf("onStateGraphScenario={"), app.indexOf("onNewChat={newChat}"));
    expect(sg).toContain("setSkillsOpen(false)");
    const pick = fn("pickSegment");
    expect(pick).toContain("setSkillsOpen(false)");
    expect(pick).toContain("setNav(next)");
    expect(app).toMatch(/onNav=\{pickSegment\}/);
    expect(app).toMatch(/setNav: pickSegment,/);
  });

  it("does not count the trace or the Lab as on screen while the view covers them", () => {
    // Both terms read nav === "sessions", and the rail now stays on sessions
    // while the view is open. Without the flag the gate window would hide
    // behind a Lab nobody can see.
    const term = (name: string): string => {
      const at = app.indexOf(`const ${name} =`);
      return app.slice(at, app.indexOf(";", at));
    };
    // Card 430 moved the trace's term into state/modeWork.ts; App hands it the flag.
    expect(term("traceReachable")).toMatch(/traceReachableIn\(\{[\s\S]*\bskillsOpen,/);
    const work = read("../state/modeWork.ts", import.meta.url);
    const fn = work.slice(work.indexOf("export function traceReachableIn"));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toContain("!input.skillsOpen");
    expect(term("labOnScreen")).toContain("!skillsOpen");
  });
});

describe("no file calls Skills a segment any more", () => {
  // Since card 409 Skills is a row in the upper group that opens a view. A
  // comment or test that still says "skills segment" describes a rail that is
  // gone. This file is left out: it names the old segment to say it is gone.
  const SRC = fileURLToPath(new URL("..", import.meta.url));
  const self = fileURLToPath(import.meta.url);
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });

  it("finds the phrase in no source, test or stylesheet under src", () => {
    const files = walk(SRC).filter((f) => /\.(tsx?|css)$/.test(f) && f !== self);
    expect(files.length).toBeGreaterThan(100);
    const hits = files.flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .flatMap((line, i) => (/skills segment/i.test(line) ? [`${f.slice(SRC.length)}:${i + 1}`] : [])),
    );
    expect(hits).toEqual([]);
  });
});
