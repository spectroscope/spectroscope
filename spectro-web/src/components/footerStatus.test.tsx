// Card 264: the footer stops calling an abandoned run ready.
//
// The reproduction was the owner's own session — a test written, a test run,
// then nothing, four plan steps open — and the line in the bottom right said
// "ready". It said it because it only ever asked whether the stop reason was
// "end_turn", and a run that walks away mid-plan stops with exactly that.
//
// The rule is pinned three ways: the fold against real event sequences (a plan
// event and a run_end, the way the socket delivers them), the rendered footer
// in both languages, and the mount in UsageFooter itself — because a pure fold
// nobody consults can ship dead (the sessionRowDensity lesson, card 247's
// sharpened pin).

import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageFooter, runStatusLine } from "./UsageFooter";
import { t } from "../i18n/i18n";
import { initialState, reduceAll } from "../state/reducer";
import type { RunEvent } from "../events";
import { dict } from "../i18n/i18n";
import { read, stripComments } from "../testkit/source";
import { setLang } from "../state/lang";

const start: RunEvent = {
  type: "run_start",
  runId: "r1",
  agentId: "main",
  prompt: "write the test and run it",
  provider: "lmstudio",
  ts: 1000,
};

const planOf = (...statuses: string[]): RunEvent => ({
  type: "plan",
  agentId: "main",
  steps: statuses.map((status, i) => ({ text: `step ${i + 1}`, status })),
  ts: 1100,
});

const end = (stopReason: string): RunEvent => ({ type: "run_end", runId: "r1", stopReason, ts: 2000 });

const fold = (events: RunEvent[]) => reduceAll(initialState, events);

describe("runStatusLine — what the footer says a run did", () => {
  it("says the run is active while it runs", () => {
    expect(runStatusLine(fold([start]), "en").key).toBe("footer.runActive");
  });

  it("names the open steps when the harness reports an unfinished run", () => {
    const state = fold([
      start,
      planOf("completed", "completed", "in_progress", "pending", "pending", "pending"),
      end("unfinished"),
    ]);
    expect(runStatusLine(state, "en")).toEqual({
      key: "footer.stoppedUnfinished",
      vars: { open: 4, total: 6 },
    });
  });

  it("says ready for a run that finished its plan", () => {
    const state = fold([start, planOf("completed", "completed"), end("end_turn")]);
    expect(runStatusLine(state, "en").key).toBe("footer.ready");
  });

  it("says so when no plan was ever written, instead of claiming a clean finish", () => {
    // The house backend's normal case: a model that cannot call update_plan
    // writes no ledger at all. "ready" would be a claim nobody can back.
    const state = fold([start, end("end_turn")]);
    expect(runStatusLine(state, "en").key).toBe("footer.readyNoPlan");
  });

  it("reads an older file honestly too — end_turn with steps still open", () => {
    // A session recorded before this card carries no verdict, only the facts
    // the verdict is computed from. The footer applies the same rule to them
    // rather than believing a stop reason the harness never graded.
    const state = fold([start, planOf("completed", "pending"), end("end_turn")]);
    expect(runStatusLine(state, "en")).toEqual({
      key: "footer.stoppedUnfinished",
      vars: { open: 1, total: 2 },
    });
  });

  // REPLACED by card 282, not loosened. This used to assert
  // {key: "footer.stopped", vars: {r: reason}} — the wire value substituted
  // straight into "gestoppt · {r}", so a German operator read
  // "gestoppt · max_turns". The threshold stays (the footer still names the
  // stop); the claim underneath it is exchanged and measured again.
  it("names the other stops in the operator's own language, not on the wire", () => {
    for (const lang of ["de", "en"] as const) {
      for (const reason of ["aborted", "error", "max_turns", "max_tokens"]) {
        const state = fold([start, planOf("pending"), end(reason)]);
        const line = runStatusLine(state, lang);
        expect(line.key).toBe("footer.stopped");
        const rendered = t(lang, line.key, line.vars);
        const sentence = t(lang, `stop.${reason}`);
        // It goes through the dictionary. Stated positively, because the
        // negative alone is the wrong claim: the English for "error" IS
        // "error", and a rule saying the wire word may never appear would
        // fail on a correct translation.
        expect(sentence, `stop.${reason} has no sentence`).not.toBe(`stop.${reason}`);
        expect(rendered, `${lang}/${reason} does not read its sentence`).toContain(sentence);
        // And where the sentence really differs from the wire word, the wire
        // word is gone — which is the owner's actual report, in German.
        if (sentence !== reason) {
          expect(rendered, `${lang}/${reason} still prints the wire word`).not.toContain(reason);
        }
      }
    }
  });

  it("still says something for a reason this build has never seen", () => {
    const state = fold([start, planOf("pending"), end("a_reason_from_the_future")]);
    const line = runStatusLine(state, "de");
    expect(t("de", line.key, line.vars)).toContain("a_reason_from_the_future");
  });

  it("is ready before anything has run", () => {
    expect(runStatusLine(initialState, "en").key).toBe("footer.ready");
  });
});

describe("the footer's own markup", () => {
  afterEach(() => setLang("en"));

  const unfinished = fold([
    start,
    planOf("completed", "completed", "in_progress", "pending", "pending", "pending"),
    end("unfinished"),
  ]);

  it("says what was left open, in English", () => {
    const html = renderToStaticMarkup(<UsageFooter state={unfinished} connection="open" />);
    expect(html).toContain("stopped · 4 of 6 steps open");
    expect(html).not.toContain(">ready<");
  });

  it("says it in German too", () => {
    setLang("de");
    const html = renderToStaticMarkup(<UsageFooter state={unfinished} connection="open" />);
    expect(html).toContain("gestoppt · 4 von 6 Schritten offen");
  });

  it("wears the warn dot an unclosed thing already wears, and never a new colour", () => {
    const html = renderToStaticMarkup(<UsageFooter state={unfinished} connection="open" />);
    expect(html).toContain('class="dot warn"');
  });

  it("stays quiet for a run nobody can grade", () => {
    const html = renderToStaticMarkup(
      <UsageFooter state={fold([start, end("end_turn")])} connection="open" />,
    );
    expect(html).toContain("ready · no plan on record");
    expect(html).toContain('class="dot faint"');
  });
});

describe("the mount — the fold is consulted, not just exported", () => {
  const footer = stripComments(read("./UsageFooter.tsx", import.meta.url));

  it("UsageFooter builds its status line from the fold and translates it", () => {
    expect(footer).toContain("runStatusLine(props.state, lang)");
    expect(footer).toContain("t(lang, status.key, status.vars)");
  });

  it("both new lines carry German and English", () => {
    for (const key of ["footer.stoppedUnfinished", "footer.readyNoPlan"]) {
      expect(dict[key]?.de, `${key}.de`).toBeTruthy();
      expect(dict[key]?.en, `${key}.en`).toBeTruthy();
    }
  });
});
