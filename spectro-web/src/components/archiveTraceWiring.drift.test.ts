// Card 435: where App asks for an archive's trace, and when.
//
// Criterion 4: every read of a trace goes through the one accessor
// (`useRecordedTrace` in state/archiveTrace.ts). The guard walks every source
// file and lists each read of a `trace` property; the reads it allows are named
// below with the reason, and each must still be there.
// Criterion 5: the session open neither fetches the llm-wire index nor builds
// a row; both start in effects, which run after the chat's commit.
// Criterion 6: a deep link lands on the trace tab and the view mounts with the
// rows, so its focus finds the event.
// Criterion 7, the source half: the press on the tab of an archive whose rows
// are not built shows card 431's sign with the build's own count.
//
// Read off disk: this suite has no DOM (house rule), and App cannot be
// rendered here. The behaviour of the pieces is pinned in
// state/archiveTrace.test.tsx and state/archiveOpenBuildsNoTrace.test.ts.

import { relative, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";
import { srcFiles, srcText } from "../testkit/tree";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const app = stripComments(read("../App.tsx", import.meta.url));

/** The body of `const name = ...` in App, up to its closing `};` line. */
function fn(name: string): string {
  const at = app.indexOf(`  const ${name} = `);
  if (at < 0) throw new Error(`App declares no ${name}`);
  return app.slice(at, app.indexOf("\n  };\n", at));
}

/** From an opening parenthesis to the one that closes it, skipping quoted text. */
function balanced(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error("unbalanced");
}

/** Every `useEffect(...)` call in App, its body and its dependency list. */
function effects(): string[] {
  const out: string[] = [];
  for (let at = app.indexOf("useEffect("); at !== -1; at = app.indexOf("useEffect(", at + 1)) {
    out.push(balanced(app, at + "useEffect".length));
  }
  return out;
}

/** Every .ts and .tsx file under `dir` that is not a test. */
function sourceFiles(dir: string): string[] {
  return srcFiles(dir).filter((full) => /\.tsx?$/.test(basename(full)) && !basename(full).includes(".test."));
}

/** A read of a `trace` property: `x.trace`, `x?.trace`, or `{ trace } =`. A
 *  CSS class in a string (`.trace-row`), a longer name (`traceDropped`) and a
 *  spread of a variable named trace (`...trace`) are not reads. A read through
 *  a computed key is not found. */
const READ = /(?<!\.)\.trace(?![\w$-])|\{[^}]*(?<![\w$.])trace(?![\w$])[^}]*\}\s*=[^=>]/;

/** Every read in the source tree, comments blanked, as `file:line:code`. */
function traceReads(): string[] {
  return sourceFiles(SRC).flatMap((file) =>
    stripComments(srcText(file))
      .split("\n")
      .map((line, i) => ({ at: `${relative(SRC, file)}:${i + 1}`, code: line.trim() }))
      .filter(({ code }) => READ.test(code))
      .map(({ at, code }) => `${at}:${code}`),
  );
}

/** The reads that stay, each with the reason. Nothing else may read a trace. */
const ALLOWED: Array<{ file: string; code: RegExp; why: string }> = [
  {
    file: "state/archiveTrace.ts",
    code: /^return archive === null \? live\.trace : built;$/,
    why: "the accessor itself: the live fold's rows, or an archive's once built",
  },
  {
    file: "state/reducer.ts",
    code: /^const last = s\.trace\[s\.trace\.length - 1\];$/,
    why: "appendTrace, the eager fold's own append (the live path and the resume)",
  },
  {
    file: "state/reducer.ts",
    code: /^return \{ \.\.\.s, trace: \[\.\.\.s\.trace, \{ seq: \(last\?\.seq \?\? 0\) \+ 1, \.\.\.entry \}\] \};$/,
    why: "appendTrace, the same append",
  },
  {
    file: "state/reducer.ts",
    code: /^const \{ trace \} = state;$/,
    why: "windowTrace, the live window (card 430's path)",
  },
  {
    file: "state/reducer.ts",
    code: /^if \(state\.trace\.length === 0 && state\.traceDropped === 0\) return state;$/,
    why: "stripLiveTrace, the live trace switch (card 430's path)",
  },
  {
    file: "App.tsx",
    code: /^wire\.length === 0 \? folded : \{ \.\.\.folded, trace: mergeLlmExchanges\(folded\.trace, wire\) \},$/,
    why: "resumeSession: that fold becomes the LIVE state, whose trace is card 430's",
  },
];

describe("every reader asks the one accessor (criterion 4)", () => {
  const reads = traceReads();
  const allowed = (entry: string): boolean =>
    ALLOWED.some((a) => {
      const [file, , ...code] = entry.split(":");
      return file === a.file && a.code.test(code.join(":"));
    });

  it("finds reads at all, so an empty list is not a broken walk", () => {
    expect(reads.length).toBeGreaterThanOrEqual(ALLOWED.length);
  });

  it("finds no read of a trace outside the allowed ones", () => {
    expect(reads.filter((entry) => !allowed(entry))).toEqual([]);
  });

  for (const a of ALLOWED) {
    it(`still finds the allowed read in ${a.file} (${a.why})`, () => {
      const hits = reads.filter((entry) => {
        const [file, , ...code] = entry.split(":");
        return file === a.file && a.code.test(code.join(":"));
      });
      expect(hits).toHaveLength(1);
    });
  }

  it("App takes the rows of the record on screen from the accessor", () => {
    expect(app).toMatch(/const archiveTrace = replay\?\.archiveTrace \?\? null;/);
    expect(app).toMatch(/const recordedRows = useRecordedTrace\(live, archiveTrace\);/);
    expect(app.split("useRecordedTrace(").length - 1).toBe(1);
  });

  it("every archive App shows carries its lazy trace and a state folded without rows", () => {
    const writes = [...app.matchAll(/setReplay\(\{([\s\S]*?)\}\);/g)].map((m) => m[1]);
    expect(writes).toHaveLength(3);
    for (const w of writes) {
      expect(w).toMatch(/state: folded\.state,/);
      expect(w).toMatch(/archiveTrace: createArchiveTrace\(folded\.recipe, (id|null|indexSession)\)/);
    }
    expect(fn("openSession")).toMatch(/archiveTrace: createArchiveTrace\(folded\.recipe, id\)/);
    // Card 473: an import merges the index of the wire it holds, and only that
    // one; without a held wire it asks for none, as before.
    expect(fn("openImport")).toMatch(/archiveTrace: createArchiveTrace\(folded\.recipe, indexSession\)/);
    expect(fn("openImport")).toMatch(
      /const indexSession = heldLlmWire\(sessionId\) !== null \? sessionId : null;/,
    );
    expect(fn("openScenario")).toMatch(/archiveTrace: createArchiveTrace\(folded\.recipe, null\)/);
  });

  it("the translated view folds without rows, and its rows are the recorded ones with payloads swapped", () => {
    const view = app.slice(
      app.indexOf("  const view = useMemo("),
      app.indexOf("  const shownRows = useMemo("),
    );
    expect(view).toContain("const folded = reduceAllUntraced(initialState, shownEvents);");
    expect(view).not.toMatch(/\breduceAll\(/);
    expect(app).toMatch(/return swapTracePayloads\(sourcedRows, tabEvents, shownEvents\);/);
  });
});

describe("the chat commits before the index is asked for and before a row is built (criterion 5)", () => {
  it("the session open fetches the events alone", () => {
    const open = fn("openSession");
    expect(open).not.toContain("fetchLlmWireIndex");
    expect(open).not.toContain("Promise.all");
    expect(open).toMatch(
      /const res = await fetch\(`\/api\/sessions\/\$\{encodeURIComponent\(id\)\}\/events`\);/,
    );
    expect(open).toMatch(/await foldArchiveDeferredSliced\(events, \{/);
  });

  it("an archive's index is fetched in one effect, after the commit, and handed to its trace and its link", () => {
    const calls = app.split("fetchLlmWireIndex(").length - 1;
    // The resume keeps its own fetch: its fold becomes the live state.
    expect(fn("resumeSession")).toContain("fetchLlmWireIndex(id)");
    expect(calls).toBe(2);
    const index = effects().filter((e) => e.includes("fetchLlmWireIndex("));
    expect(index).toHaveLength(1);
    expect(index[0]).toMatch(/const session = archiveTrace\.indexSession;/);
    expect(index[0]).toMatch(/archiveTrace\.supplyIndex\(wire\);/);
    expect(index[0]).toMatch(/setLlmWire\(/);
    // Card 430, gate 6: asked only where the trace is open, and once per
    // archive, so a return to learn asks then. The effect is keyed on both.
    // The ref keeps the archive's number, never the archive: holding the object
    // kept a left archive's built rows alive (card 430's measurement: after a
    // resume, learn held 70 MB more heap than light).
    expect(index[0]).toMatch(
      /if \(archiveTrace === null \|\| !wantIndex \|\| indexAsked\.current === archiveTrace\.id\) return;/,
    );
    expect(index[0]).toMatch(/indexAsked\.current = archiveTrace\.id;/);
    expect(app).toMatch(/const indexAsked = useRef<number \| null>\(null\);/);
    expect(index[0]).toMatch(/\}, \[archiveTrace, wantIndex\]\)$/);
    expect(app).toMatch(/const wantIndex = indexWanted\(viewMode\);/);
    // The stop left for an effect of its own, keyed on the archive alone: a
    // mode switch must not stop a build (a stopped build never starts again).
    const stop = effects().filter((e) => e.includes("archiveTrace.stop()"));
    expect(stop).toHaveLength(1);
    expect(stop[0]).toMatch(/return \(\) => archiveTrace\.stop\(\);/);
    expect(stop[0]).toMatch(/\}, \[archiveTrace\]\)$/);
  });

  it("the build is asked for in one effect: on the tab, or once the warm-up says the browser was idle", () => {
    expect(app.split(".request()").length - 1).toBe(1);
    const build = effects().filter((e) => e.includes(".request()"));
    expect(build).toHaveLength(1);
    expect(build[0]).toMatch(
      /if \(archiveTrace !== null && \(traceShowing \|\| traceWarm\)\) archiveTrace\.request\(\);/,
    );
    expect(build[0]).toMatch(/\}, \[archiveTrace, traceShowing, traceWarm\]\)$/);
    // The warm-up is the gate card 175 built: false on the render a record
    // arrives in, true once the browser has been idle (traceWarmup.test.ts).
    expect(app).toMatch(/const traceWarm = useTraceWarm\(traceRecord, traceReachable\)/);
  });
});

describe("a deep link lands on the event (criterion 6)", () => {
  it("the open still sets the event and the trace tab", () => {
    const open = fn("openSession");
    expect(open).toContain("setFocusEvent(target);");
    expect(open).toContain('landedTab = opts?.tab ?? "trace";');
  });

  it("the sessions trace mounts with its rows, never before them", () => {
    const at = app.indexOf("{(traceShowing || traceWarm) && shownRows !== null && (");
    expect(at).toBeGreaterThan(-1);
    // Nothing between the gate and the view it mounts but the div that hides
    // it and card 430's ChunkBoundary, which adds no condition of its own.
    const mount = app.slice(at, app.indexOf("<TraceView", at));
    expect(mount).toMatch(
      /^\{\(traceShowing \|\| traceWarm\) && shownRows !== null && \(\s*<div style=\{\{ display: traceShowing \? "contents" : "none" \}\}>\s*<ChunkBoundary>\s*$/,
    );
    expect(app).toMatch(
      /enteredFleet !== null \? traceFromEvents\(shownEvents\) : \(shownRows \?\? NO_ROWS\)/,
    );
  });
});

describe("the first open of the trace shows the sign (criterion 7)", () => {
  it("raises it while the tab shows an archive whose rows are not built", () => {
    const decl = app.slice(
      app.indexOf("const traceBuilding"),
      app.indexOf(";\n", app.indexOf("const traceBuilding")),
    );
    expect(decl).toMatch(/traceShowing && replay !== null && recordedRows === null/);
    expect(decl).toMatch(/ticket: replay\.archiveTrace\.id/);
    expect(decl).toMatch(/purpose: "trace"/);
  });

  // Review finding 1 (2026-09-25): the open's sign and the build's sat in two
  // slots. On a deep link, or an open while the trace tab shows, the commit
  // that lowered the one raised the other as a new element, and it faded in
  // again from nothing after 150 ms (styles/opening.css) over an empty trace.
  it("draws the open's sign and the build's in one slot, the open's first, each with its own count", () => {
    expect(app.split("<OpeningSurface").length - 1).toBe(1);
    expect(app).toMatch(/const sign = opening \?\? traceBuilding;/);
    const col = app.slice(app.indexOf('<div className="main-col">'), app.indexOf("<SettingsPanel"));
    expect(col).toMatch(
      /\{sign !== null && \(\s*<OpeningSurface\s+lang=\{lang\}\s+opening=\{sign\}\s+progress=\{opening !== null \? openProgress : traceProgress\}\s*\/>\s*\)\}/,
    );
  });
});

// Review finding 2 (2026-09-25): the trace tab's count used to come with the
// built rows, about 0.8 s after the chat (the evidence README, set B), and
// `.tab` reserves no width for it, so the tabs to its right moved sideways.
describe("the trace tab keeps its width from the open", () => {
  // Card 430: the tab buttons are one map over the surface table; the chip is
  // the trace tab's, so it is read in that map's body.
  const rowAt = app.indexOf("{tabsShown(viewMode, tutorial).map((id) => (");
  const tab = app.slice(rowAt, app.indexOf("</button>", rowAt));

  it("the tab shows the count the record knows, built rows or not, and holds its place before that", () => {
    expect(app).toMatch(/const archiveRowCount = useArchiveRowCount\(archiveTrace\);/);
    expect(app).toMatch(
      /const traceCount = recordedRows !== null \? recordedRows\.length : archiveRowCount;/,
    );
    expect(tab).toMatch(
      /\{id === "trace" && \(?\s*<TraceTabCount count=\{traceCount\} least=\{archiveTrace\?\.leastRows \?\? 0\} \/>\s*\)?\}/,
    );
    expect(app.split("<TraceTabCount").length - 1).toBe(1);
    // The chip is drawn in one place, so no second chip can come and go.
    expect(tab).not.toContain("tab-count");
    expect(tab.split("<TraceTabCount").length - 1).toBe(1);
  });

  it("the chip that holds the place is not drawn", () => {
    const css = stripComments(read("../styles/graph.css", import.meta.url));
    expect(css).toMatch(/\.tab-count--pending\s*\{\s*visibility:\s*hidden;\s*\}/);
  });
});
