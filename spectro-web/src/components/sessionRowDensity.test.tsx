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
import { t } from "../i18n/i18n";
import type { SessionMeta } from "../events";

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

/** The row as a reader gets it, at one density. */
function rowAt(at: Density): string {
  return renderToStaticMarkup(
    <SessionRow
      s={META}
      parts={rowParts(at)}
      lang="en"
      active={false}
      state={storedRunState({ row: META, live: [], resumeId: null, liveRunning: false })}
      onSelect={() => {}}
    />,
  );
}

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

const normal = rowAt("normal");
const extended = rowAt("extended");

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
  it("keeps the state dot at BOTH densities", () => {
    // Criterion 6 lives here: with no metadata line the dot is the only thing
    // left that can say a session is running, so rowParts() may never cut it.
    for (const [name, html] of [
      ["normal", normal],
      ["extended", extended],
    ] as const) {
      expect(html.match(/class="dot[^"]*"/g) ?? [], name).toHaveLength(1);
    }
  });

  it("keeps ONE hover string, byte-identical at either density", () => {
    // The non-functional criterion, measured on the output rather than counted
    // in the source: the hover carries what normal cut, and a density-aware
    // second string would be a second thing to keep in step with the DTO.
    const hover = (html: string): string => {
      const m = html.match(/<button[^>]*class="session-row[^"]*"[^>]*title="([^"]*)"/);
      if (m === null) throw new Error("the row has no hover string at all");
      return m[1];
    };
    expect(hover(normal)).toBe(hover(extended));
    expect(hover(normal)).toContain("summarise the release notes");
    expect(hover(normal)).toContain("qwen2.5:7b");
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
        onSelectLive={() => {}}
        onSelectSession={() => {}}
        onNewChat={() => {}}
        onSettings={() => {}}
        liveRunning={false}
        resumeId={null}
        onImport={() => {}}
        onScenarios={() => {}}
        onStarters={() => {}}
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

  const sub = t("en", "nav.liveSub");

  it("goes quiet when the store says normal", () => {
    setDensity("normal");
    expect(rail()).not.toContain(sub);
  });

  it("says it again when the store says extended", () => {
    setDensity("extended");
    expect(rail()).toContain(sub);
    setDensity("normal");
  });
});
