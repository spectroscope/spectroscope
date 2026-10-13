// What a session row RENDERS at each density (card 214) — the wiring, not the
// fold.
//
// This file exists because of what the review of card 214 measured. `rowParts()`
// was pinned nine ways as a pure fold, and the ROW that is supposed to consult
// it was pinned by nothing: reverting Sidebar.tsx to its pre-card unconditional
// row — dropping `{parts.sigil && …}` and `{parts.meta && (…)}`, prettier run
// over the result so it read like real code — left the full gate at exit 0 with
// 240 files and 3562 tests green. The one feature the card exists for could ship
// completely dead and nothing said a word.
//
// So the assertions here are about output, not source. `renderToStaticMarkup`
// is the same idiom `stategraph/edgeGrammar.test.tsx` and `viewState.test.tsx`
// already use; it needs no DOM, so the house rule that this suite runs in plain
// Node still holds. Delete a density gate from the markup and the counts below
// stop matching.
//
// One link cannot be reached from here and is named rather than pretended away:
// the stored rows arrive from a `fetch` in an effect, and no server render runs
// effects, so `<Sidebar>` renders with an empty list. The chain is therefore
// pinned at both ends — the store decides what `<Sidebar>` draws (the live row
// below), and `<SessionRow>` draws what its `parts` say — with the link in the
// middle read off the source in sidebarShape.drift.test.ts, where that file says
// so out loud.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionRow, Sidebar } from "./Sidebar";
import { storedRunState } from "./runIndicator";
import { rowParts, setDensity, __resetForTests, __setTestHooks, type Density } from "../state/density";
import { liveSessionsPushLive, __resetForTests as resetLiveSessions } from "../state/liveSessions";
import type { RunEvent, SessionMeta } from "../events";

// The store never touches a real localStorage in this suite.
const written = new Map<string, string>();
__setTestHooks({
  get: (k) => written.get(k) ?? null,
  set: (k, v) => void written.set(k, v),
});
__resetForTests();

/** A stored session with every optional field filled: a row that has the most
 *  to lose when density cuts it. */
const META: SessionMeta = {
  id: "sess-1",
  startedAt: Date.UTC(2026, 7, 11, 9, 0, 0),
  firstPrompt: "summarise the release notes",
  tokens: 6900,
  agentCount: 3,
  turnCount: 4,
  provider: "ollama",
  model: "qwen2.5:7b",
  stopReason: "end_turn",
  endedAt: Date.UTC(2026, 7, 11, 9, 2, 3),
};

/** The row as a reader gets it, at one density. `extra` adds what only a live
 *  or held session carries: the folder and state line (card 503) and the
 *  attention badge (card 459). */
function rowAt(at: Density, extra: { liveLine?: string; attention?: "answer" | "model" } = {}): string {
  return renderToStaticMarkup(
    <SessionRow
      s={META}
      parts={rowParts(at)}
      lang="en"
      active={false}
      state={storedRunState({ row: META, live: [], resumeId: null, liveRunning: false })}
      attention={extra.attention ?? null}
      onSelect={() => {}}
      liveLine={extra.liveLine}
    />,
  );
}

/** What card 503 draws under a live session's name. */
const LIVE_LINE = "ForgeDemo · idle";

/** How often `needle` occurs in `hay`. */
function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

/** Only what a reader SEES in the row — tags and their attributes dropped, so
 *  the hover string (a `title` attribute, and the whole point of normal
 *  density) does not count as text in the rail. */
function visible(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const minimal = rowAt("minimal");
const normal = rowAt("normal");
const extended = rowAt("extended");

describe("a stored row at minimal density (card 555)", () => {
  it("shows the name and nothing else a reader can read, even for a live session", () => {
    // The owner's words: "Ich will da nur den Namen sehen." A live session is
    // the hard case, because it is the one that carries the folder and state
    // line; that line has to be gone from the markup, not hidden in it.
    const html = rowAt("minimal", { liveLine: LIVE_LINE });
    expect(visible(html)).toBe("summarise the release notes");
    expect(count(html, "session-live-line")).toBe(0);
    expect(html).not.toContain("ForgeDemo");
    // The owner kept the dot ("Name und Punkt"): exactly one.
    expect(html.match(/class="dot[^"]*"/g) ?? []).toHaveLength(1);
    // And the rest of what normal and extended cut stays cut.
    for (const cut of ["session-meta", "session-facts", "session-sigil", "session-model"]) {
      expect(count(html, cut), cut).toBe(0);
    }
  });

  it("keeps the attention badge, because it asks for an action", () => {
    // Owner decision of 2026-10-12: the badge stays in minimal.
    expect(visible(rowAt("minimal", { attention: "answer" }))).toBe(
      "summarise the release notes waiting for you",
    );
    expect(visible(rowAt("minimal", { attention: "model" }))).toBe(
      "summarise the release notes waiting for the model",
    );
  });

  it("draws a different row from normal once the session is live", () => {
    // For a stored session nobody holds, minimal and normal draw the same
    // bytes: the live line is the whole difference, so that is where it shows.
    expect(rowAt("minimal", { liveLine: LIVE_LINE })).not.toBe(rowAt("normal", { liveLine: LIVE_LINE }));
  });
});

describe("the folder and state line of a live session (card 503)", () => {
  it("is drawn at normal and at extended", () => {
    for (const at of ["normal", "extended"] as const) {
      const html = rowAt(at, { liveLine: LIVE_LINE });
      expect(count(html, 'class="session-live-line"'), at).toBe(1);
      expect(visible(html), at).toContain(LIVE_LINE);
    }
  });

  it("is absent at every density when the session is not live", () => {
    for (const [name, html] of [
      ["minimal", minimal],
      ["normal", normal],
      ["extended", extended],
    ] as const) {
      expect(count(html, "session-live-line"), name).toBe(0);
    }
  });
});

describe("a stored row at normal density", () => {
  it("renders the session name and the state dot, and nothing else", () => {
    // Criterion 3, read off the markup. The name and the dot are IN…
    expect(normal).toContain("summarise the release notes");
    expect(normal).toMatch(/class="dot[^"]*"/);
    expect(normal).toContain('class="session-name"');
    // …and every part the card cuts is absent from the output, not hidden in it.
    expect(count(normal, "session-meta")).toBe(0);
    expect(count(normal, "session-facts")).toBe(0);
    expect(count(normal, "session-sigil")).toBe(0);
    expect(count(normal, "session-model")).toBe(0);
  });

  it("carries none of the numbers the metadata line spells out", () => {
    // Not just the containers: the values themselves are gone from the rail.
    // Read off the visible text, because the hover keeps every one of them —
    // that is the trade the card made, and it must not silence this assertion.
    const seen = visible(normal);
    expect(seen).toBe("summarise the release notes");
    for (const cut of ["4 turns", "6.9k tokens", "qwen2.5:7b"]) {
      expect(seen, cut).not.toContain(cut);
    }
    // …while extended shows exactly those, in the same place it always did.
    expect(visible(extended)).toContain("4 turns");
  });
});

describe("a stored row at extended density", () => {
  it("renders the comb, the counted line and the model", () => {
    // Criterion 3's other half: extended is the row as it was before the card.
    expect(extended).toContain('class="session-sigil"');
    expect(extended).toContain("session-meta session-meta-line tabular");
    expect(extended).toContain('class="session-facts"');
    expect(extended).toContain("4 turns");
    expect(extended).toContain("6.9k tokens");
    expect(extended).toContain("qwen2.5:7b");
  });

  it("draws a different row from normal", () => {
    // The blunt one. Two densities that render the same bytes are one density.
    expect(extended).not.toBe(normal);
  });
});

describe("what density may not cut", () => {
  it("keeps the state dot at EVERY density", () => {
    // Criterion 6 lives here: with no metadata line the dot is the only thing
    // left that can say a session is running, so rowParts() may never cut it.
    for (const [name, html] of [
      ["minimal", minimal],
      ["normal", normal],
      ["extended", extended],
    ] as const) {
      expect(html.match(/class="dot[^"]*"/g) ?? [], name).toHaveLength(1);
    }
  });

  it("keeps ONE hover string, byte-identical at every density", () => {
    // The non-functional criterion, measured on the output rather than counted
    // in the source: the hover carries what normal and minimal cut, and a
    // density-aware second string would be a second thing to keep in step with
    // the DTO. Card 555 criterion 4: a live row, so the live line is cut too.
    const hover = (html: string): string => {
      const m = html.match(/<button[^>]*class="session-row[^"]*"[^>]*title="([^"]*)"/);
      if (m === null) throw new Error("the row has no hover string at all");
      return m[1];
    };
    const [atMinimal, atNormal, atExtended] = (["minimal", "normal", "extended"] as const).map((at) =>
      hover(rowAt(at, { liveLine: LIVE_LINE })),
    );
    expect(atMinimal).toBe(atNormal);
    expect(atNormal).toBe(atExtended);
    expect(hover(normal)).toBe(hover(extended));
    expect(atMinimal).toContain("summarise the release notes");
    expect(atMinimal).toContain("qwen2.5:7b");
  });
});

describe("the rail asks the store how much to say", () => {
  // The other end of the chain: <Sidebar> must read the live value rather than
  // a constant. The stored rows are out of reach here (their fetch lives in an
  // effect, and no server render runs effects), so this rides on the live row's
  // subline, which is under the same gate.
  const rail = (): string =>
    renderToStaticMarkup(
      <Sidebar
        activeId={null}
        refreshToken={0}
        onSelectSession={() => {}}
        onNewChat={() => {}}
        onSettings={() => {}}
        held={[{ id: "s-held", firstPrompt: "held one", startedAt: 1_000, running: false, attention: null }]}
        onImport={() => {}}
        onScenarios={() => {}}
        onStarters={() => {}}
        skillsOpen={false}
        onSkills={() => {}}
        onSelectScenario={() => {}}
        stateGraphSource={null}
        onStateGraphScenario={() => {}}
        activeFleet={null}
        onSelectFleet={() => {}}
        onSpawnNode={() => {}}
        nav="sessions"
        onNav={() => {}}
      />,
    );

  // Card 458: the live row and its "this browser tab" subline are gone; a held
  // session is a row of the list, and its metadata line obeys the density.
  const sub = "session-meta-line";

  it("goes quiet when the store says normal", () => {
    setDensity("normal");
    expect(rail()).toContain("held one");
    expect(rail()).not.toContain(sub);
  });

  it("says it again when the store says extended", () => {
    setDensity("extended");
    expect(rail()).toContain(sub);
    setDensity("normal");
  });

  it("drops a live session's folder and state line when the store says minimal (card 555)", () => {
    // The live line rides the live set, which the server render does read, so
    // this pins the whole chain from the store through <Sidebar> to the row.
    liveSessionsPushLive([
      {
        type: "live_sessions",
        sessions: [{ id: "s-held", running: false, since: 1, folder: "/w/ForgeDemo", statusLine: "idle" }],
      } as unknown as RunEvent,
    ]);
    try {
      setDensity("normal");
      expect(rail()).toContain(LIVE_LINE);
      setDensity("minimal");
      expect(rail()).toContain("held one");
      expect(rail()).not.toContain(LIVE_LINE);
      expect(rail()).not.toContain("session-live-line");
      setDensity("extended");
      expect(rail()).toContain(LIVE_LINE);
    } finally {
      setDensity("normal");
      resetLiveSessions();
    }
  });

  it("hands the same rule to the rows of other processes (card 555)", () => {
    // The peer roster rides the store as well, so this pins the link from
    // <Sidebar> to <PeerRoster>: at minimal a peer row is its name.
    liveSessionsPushLive([
      {
        type: "peer_roster",
        sessions: [
          {
            id: "s9",
            running: true,
            since: 1,
            folder: "/w/ForgeDemo",
            name: "ForgeDemo-7f",
            statusLine: "working",
            face: "repl",
            pid: 4711,
          },
        ],
      } as unknown as RunEvent,
    ]);
    try {
      setDensity("minimal");
      expect(rail()).toContain("ForgeDemo-7f");
      expect(rail()).not.toContain("ForgeDemo · working");
      expect(rail()).not.toContain("peer-row-line");
      for (const at of ["normal", "extended"] as const) {
        setDensity(at);
        expect(rail(), at).toContain("ForgeDemo · working");
      }
    } finally {
      setDensity("normal");
      resetLiveSessions();
    }
  });
});
