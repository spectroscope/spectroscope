// Card 338 — the work panel's empty state promises what it cannot deliver.
//
// The owner pressed play on a launch configuration and then waited, because
// the panel's own words told him to: "Nothing yet. Subagents, triggered node
// runs and launched background tasks appear here once there are any." Three
// kinds named, one of them reachable in a live desktop session, and the word
// `launched` is the word the browser start page uses for the very thing he had
// just started. The defect is the sentence, not the fold.
//
// So this file guards a sentence, and it guards it in the only way a sentence
// about code can be guarded: from the code. Three separate properties.
//
//  1. THE COPY IS DERIVED. The panel maps state/work.ts's own WORK_KINDS to one
//     line each, so a fourth kind cannot arrive without a line — it renders as
//     a bare i18n key and the first case below goes red. A hand-typed list of
//     three checked by a test that types the same three is two copies of one
//     lie, which card 312 found three times in one card.
//  2. THE LIVE CASE IS HONEST. LIVE_KINDS says which kinds this window can
//     produce, and the two cases at the bottom are what make that claim true:
//     they read the JAVA sources and re-measure the card's own greps. When
//     either goes red, somebody has made a kind reachable — and the copy here
//     has to change in the same commit.
//  3. THE WORD HAS ONE OWNER. The empty state names the browser start page's
//     heading verbatim, interpolated rather than retyped, and says a launch is
//     none of these kinds. One string, two surfaces.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkPanel } from "./WorkPanel";
import { LIVE_KINDS, WORK_KINDS } from "../state/work";
import { kindLineKey } from "./workEmptyCopy";
import { t } from "../i18n/i18n";
import { setLang } from "../state/lang";
import type { Lang } from "../i18n/i18n";

afterEach(() => setLang("en"));

const LANGS: readonly Lang[] = ["en", "de"];

function emptyMarkup(live: boolean, lang: Lang): string {
  setLang(lang);
  return renderToStaticMarkup(<WorkPanel items={[]} liveView={live} />);
}

describe("the empty state names what the fold can actually produce (card 338)", () => {
  it("carries a line of copy for every kind, in both languages", () => {
    for (const lang of LANGS) {
      const live = emptyMarkup(true, lang);
      const recorded = emptyMarkup(false, lang);
      for (const kind of WORK_KINDS) {
        const key = kindLineKey(kind);
        // t() returns the KEY when the dictionary has no entry, which is
        // exactly what a fourth kind would render. Both halves matter: the
        // dictionary must answer, and the panel must put the answer on screen.
        const line = t(lang, key);
        expect(line, `${key} has no ${lang} copy`).not.toBe(key);
        expect(live, `${key} is missing from the live empty state (${lang})`).toContain(line);
        expect(recorded, `${key} is missing from the recorded empty state (${lang})`).toContain(line);
      }
    }
  });

  it("renders the list FROM the fold's array, so a fourth kind cannot be left off", () => {
    // Two halves, because the count alone proves nothing: a hand-typed list of
    // three lines counts three and agrees with a three-element array forever.
    // The source pin is what makes the count mean "derived" — mutate the map
    // into three literal <li>s and this goes red while the count stays green.
    const panel = readFileSync(path.join(__dirname, "WorkPanel.tsx"), "utf8");
    expect(panel).toContain("WORK_KINDS.map(");
    for (const lang of LANGS) {
      const live = emptyMarkup(true, lang);
      // The prefix, not the whole attribute: a line the live reading marks as
      // unreachable carries a second class after it.
      const lines = live.split('class="work-empty-kind').length - 1;
      expect(lines, `${lang}: one line per kind`).toBe(WORK_KINDS.length);
    }
  });

  it("derives the kind union from the array, so the two cannot drift apart", () => {
    const src = readFileSync(path.join(__dirname, "..", "state", "work.ts"), "utf8");
    expect(src).toContain("export type WorkKind = (typeof WORK_KINDS)[number];");
  });

  it("marks the kinds a live session cannot produce, and only those", () => {
    const live = emptyMarkup(true, "en");
    for (const kind of WORK_KINDS) {
      const line = t("en", kindLineKey(kind));
      const at = live.indexOf(line);
      expect(at, `${kind} is not on screen`).toBeGreaterThan(-1);
      // The marker class sits on the <li> that carries the line, so the
      // opening tag is the text immediately before it.
      const tag = live.slice(live.lastIndexOf("<li", at), at);
      expect(tag.includes("work-empty-kind--elsewhere"), `${kind} elsewhere-marked`).toBe(
        !LIVE_KINDS.includes(kind),
      );
    }
  });

  it("a recorded session marks nothing as elsewhere — every kind is readable in a file", () => {
    // The marker answers "can THIS WINDOW produce it", which is a question
    // about a live run. An imported transcript carries whatever it carries.
    expect(emptyMarkup(false, "en")).not.toContain("work-empty-kind--elsewhere");
  });

  it("says a launch configuration is none of these, in the start page's own words", () => {
    for (const lang of LANGS) {
      const heading = t(lang, "browser.start.heading");
      expect(emptyMarkup(true, lang), `${lang}: the launch note`).toContain(heading);
    }
  });
});

// ---- the measurements the copy above stands on ------------------------------

const REPO = path.join(__dirname, "..", "..", "..");

/** Every `.java` under one module's `src/main`, as [path, source]. */
function javaMain(module: string): [string, string][] {
  const root = path.join(REPO, module, "src", "main");
  const out: [string, string][] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".java")) out.push([path.relative(REPO, full), readFileSync(full, "utf8")]);
    }
  };
  walk(root);
  return out;
}

const JAVA = ["spectro-core", "spectro-server", "spectro-cli"].flatMap(javaMain);

/** Comments blanked, newlines kept — prose about a field is not the field. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, "");
}

/** Java main files whose code says "launched/started … task <id>". */
const RECEIPT = /\b(?:launched|started)\b[^\n]*?\btask(?:\s+id)?[:\s]\s*([A-Za-z0-9_-]{4,})\b/i;
const receiptWriters = JAVA.filter(([, src]) => RECEIPT.test(src)).map(([rel]) => path.basename(rel));

/** Java main files that name a run_start trigger in code, not in prose. */
const triggerFiles = JAVA.filter(
  ([, src]) => /\bRunStart\b/.test(code(src)) && /\btrigger\b/.test(code(src)),
).map(([rel]) => path.basename(rel));

/** The file that streams a LIVE desktop session's events. */
const LIVE_PATH = "SessionConnection.java";

/**
 * Whether this kind can arise in a live session, ANSWERED FROM THE SOURCES.
 *
 * <p>Each arm is a measurement, never a recollection — that is the whole point
 * of the case below. `LIVE_KINDS` and the panel read one array, so a mutation
 * of that array moves both and stays green; this function is the third,
 * independent voice that catches it.</p>
 *
 * <p>A kind nobody has measured is NOT live. That default is deliberate: a
 * fourth kind added to `LIVE_KINDS` without a measurement turns this red.</p>
 */
function measuredLive(kind: string): boolean {
  switch (kind) {
    case "spawn":
      // The live session path itself knows agent_spawn, so a fan-out is on the
      // wire of the window the reader is looking at.
      return JAVA.some(
        ([rel, src]) => path.basename(rel) === LIVE_PATH && /agent_spawn|AgentSpawn/.test(src),
      );
    case "trigger":
      // Live only if something OTHER than the record that declares the field
      // and the headless runner that stamps it can wake a run.
      return triggerFiles.some((f) => f !== "HeadlessRunner.java" && f !== "RunEvent.java");
    case "launched":
      // Live only once a spectroscope tool writes the receipt the fold reads.
      return receiptWriters.length > 0;
    default:
      return false;
  }
}

describe("why a live session can only produce a fan-out (card 338, measured)", () => {
  it("LIVE_KINDS says what the Java sources say, and nothing more", () => {
    expect([...LIVE_KINDS].sort()).toEqual(WORK_KINDS.filter(measuredLive).sort());
  });

  it("reads more than a handful of Java files, or it has measured nothing", () => {
    // A walk that silently found an empty tree would make both cases below
    // vacuously green — the shape card 312 calls a guard that cannot fail.
    expect(JAVA.length).toBeGreaterThan(100);
  });

  it("no spectroscope tool writes a launch receipt, so `launched` needs an import", () => {
    // The same grammar state/work.ts folds on: launched/started, then a task
    // id. `launched` exists because an IMPORTED Claude Code transcript carries
    // this line; the day a spectroscope tool writes one, the empty state stops
    // being right and this goes red first.
    expect(receiptWriters).toEqual([]);
  });

  it("only the headless runner stamps a run_start trigger; the live path does not", () => {
    // RunEvent declares the field, HeadlessRunner fills it (card 72). A third
    // name here means some other path can wake a run, and `trigger` may then
    // be reachable from this window.
    expect(triggerFiles.sort()).toEqual(["HeadlessRunner.java", "RunEvent.java"]);
  });
});
