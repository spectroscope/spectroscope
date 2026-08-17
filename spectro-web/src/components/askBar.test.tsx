// Card 265, criteria 7 and 8: the answer surface.
//
// It is its own component and not the gate's, for one reason that is easy to
// miss and expensive to get wrong: PermissionDialog maps Escape to a DECISION
// (`decide(false)` — deny is the safe default there, and a denial is a verdict a
// gate can honestly report). A question has no such verdict. Escape on an ask
// would fabricate an answer out of a keystroke somebody pressed to get their
// cursor back, and that answer would be in the transcript forever.
//
// No DOM in this suite (house rule), so the key rule is a pure function the
// component consults, the markup is pinned against a static render, and the
// mount in App.tsx is pinned against the source — a pure function nobody calls
// can ship dead, which is exactly what card 247's sharpened pin caught.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AskBar, askKeyAction } from "./AskBar";
import { ToolCard } from "./ToolCard";
import type { PendingAsk } from "../state/reducer";
import { read, stripComments } from "../testkit/source";
import { setLang } from "../state/lang";
import { dict } from "../i18n/i18n";

const pending: PendingAsk[] = [
  {
    callId: "c1",
    agentId: "main",
    questions: [
      {
        question: "Which store should the importer write to?",
        header: "Storage",
        multiSelect: false,
        options: [
          { label: "Postgres", description: "the one already in the compose file" },
          { label: "SQLite" },
        ],
      },
    ],
  },
  {
    callId: "c2",
    agentId: "main",
    questions: [{ question: "And then?", multiSelect: false, options: [{ label: "ship" }] }],
  },
];

const markup = (lang: "de" | "en" = "en"): string => {
  setLang(lang);
  return renderToStaticMarkup(<AskBar pending={pending} onAnswer={() => {}} />);
};

describe("askKeyAction — Escape must not answer", () => {
  it("Escape means nothing at all on the ask bar", () => {
    expect(askKeyAction("Escape")).toBe("ignore");
  });

  it("Enter submits what is already chosen or typed", () => {
    expect(askKeyAction("Enter")).toBe("submit");
  });

  it("everything else is ignored", () => {
    for (const key of ["Tab", "a", " ", "ArrowDown", "Backspace"]) {
      expect(askKeyAction(key)).toBe("ignore");
    }
  });

  it("the permission dialog still denies on Escape, so the contrast is real", () => {
    // The premise of this whole component. If the gate ever stops doing this the
    // sentence above is stale, and a reader would not know which of the two to
    // trust.
    const dialog = stripComments(read("./PermissionDialog.tsx", import.meta.url));
    const escape = dialog.slice(dialog.indexOf('e.key === "Escape"'));
    expect(escape).toContain("decide(false)");
  });

  it("the bar never calls the key handler's answer path on Escape", () => {
    // The sharpened pin: the component must CONSULT askKeyAction, or the pure
    // function above is a decoration and the real handler could do anything.
    const bar = stripComments(read("./AskBar.tsx", import.meta.url));
    expect(bar).toContain("askKeyAction(");
    expect(bar).not.toContain('"Escape"');
  });
});

describe("AskBar — the markup", () => {
  it("renders one question at a time, the first of the queue", () => {
    const html = markup();
    expect(html).toContain("Which store should the importer write to?");
    expect(html).not.toContain("And then?");
  });

  it("says how many more are waiting", () => {
    expect(markup()).toContain("+1");
  });

  it("offers every option, with its help line", () => {
    const html = markup();
    expect(html).toContain("Postgres");
    expect(html).toContain("the one already in the compose file");
    expect(html).toContain("SQLite");
  });

  it("offers a free-text field and a deliberate skip", () => {
    const html = markup();
    expect(html).toContain("<input");
    expect(html).toContain(dict["ask.skip"].en);
  });

  it("says out loud that the answer is written into the transcript", () => {
    // The one fence against the leak this surface invites: a person typing a key
    // into a field that lands in a session file that gets exported and
    // screenshotted. The tool's own manual says it too; this is where a human
    // reads it.
    expect(markup()).toContain(dict["ask.notice"].en);
    expect(markup("de")).toContain(dict["ask.notice"].de);
  });

  it("carries a screen-reader name and no colour-only meaning", () => {
    const html = markup();
    expect(html).toContain(`aria-label="${dict["ask.aria"].en}"`);
    // The kicker word carries the state in text, so the violet line is never the
    // only thing that says "the run is waiting on you".
    expect(html).toContain(dict["ask.kicker"].en);
  });

  it("labels everything from the dictionary, in both languages", () => {
    for (const key of ["ask.aria", "ask.kicker", "ask.skip", "ask.send", "ask.notice", "ask.queue"]) {
      expect(dict[key], key).toBeDefined();
      expect(dict[key].de, key).not.toBe("");
      expect(dict[key].en, key).not.toBe("");
      expect(dict[key].de, `${key} is untranslated`).not.toBe(dict[key].en);
    }
  });

  it("renders nothing when nothing is pending", () => {
    setLang("en");
    expect(renderToStaticMarkup(<AskBar pending={[]} onAnswer={() => {}} />)).toBe("");
  });
});

describe("AskBar — mounted where the operator is", () => {
  it("App renders it and sends a question_response", () => {
    // The dead-consumer pin. A bar nobody mounts is a run parked behind nothing.
    const app = stripComments(read("../App.tsx", import.meta.url));
    expect(app).toContain("<AskBar");
    expect(app).toContain("pendingAsks");
    expect(app).toContain('type: "question_response"');
  });

  it("an archived or imported view never mounts it", () => {
    // Criterion 8, at the mount rather than only in the reducer: the same guard
    // the gate bar uses, so a replay cannot offer a live control.
    //
    // Read as ONE statement, up to its own semicolon. The first version of this
    // pin took 300 characters from the declaration, and deleting `viewingLive`
    // from the guard left it green — the neighbouring code says the word too.
    // A loose substring pin is how a dead consumer ships (card 247).
    const app = stripComments(read("../App.tsx", import.meta.url));
    const from = app.indexOf("const askVisible");
    const statement = app.slice(from, app.indexOf(";", from));
    expect(statement).toContain("viewingLive");
    expect(statement).toContain("live.pendingAsks.length > 0");
  });
});

describe("the wait, drawn where the tool duration is", () => {
  it("the card shows the human wait beside the tool's own 0.0 s", () => {
    // The payoff card 111 wrote the second clock for and nobody ever drew: how
    // long the machine waited for YOU. Measured live on 2026-08-17 — an answer
    // after 2 m 59 s left durationMs at 0, and without this the 179 seconds are
    // in the session file and on no surface at all. `gateWaitMs` has had no
    // reader since card 111 shipped it; this one is not repeating that.
    setLang("en");
    const html = renderToStaticMarkup(
      <ToolCard
        card={{
          callId: "c1",
          agentId: "main",
          name: "ask_user_question",
          input: { questions: [{ question: "Which store?", options: [{ label: "Postgres" }] }] },
          status: "ok",
          output: 'The user answered: "Which store?"="Postgres". Continue with that answer.',
          durationMs: 0,
          askWaitMs: 179_448,
          answers: ["Postgres"],
          startedAt: 1,
        }}
        live={false}
      />,
    );
    expect(html).toContain("0.0 s");
    // 179448 ms rounds to 179 s, which formatDuration splits as 2 m 59 s. The
    // first version of this test asserted "3 m 0 s" and was simply wrong about
    // the arithmetic — the code was right and said so.
    expect(html).toContain(dict["ask.waited"].en.replace("{d}", "2 m 59 s"));
  });

  it("the importers own renderer marks the chosen option off our result prose", () => {
    // Criterion 2, and the whole reason the tool answers in that wording: the
    // existing card renderer locates an answer by "<question>"=" and marks the
    // option it names. Measured here on a NATIVE call — a terser result would
    // leave an answered question drawn as one nobody ever answered.
    setLang("en");
    const html = renderToStaticMarkup(
      <ToolCard
        card={{
          callId: "c1",
          agentId: "main",
          name: "ask_user_question",
          input: {
            questions: [{ question: "Which store?", options: [{ label: "Postgres" }, { label: "SQLite" }] }],
          },
          status: "ok",
          output: 'The user answered: "Which store?"="Postgres". Continue with that answer.',
          durationMs: 0,
          startedAt: 1,
        }}
        live={false}
      />,
    );
    expect(html).toContain("tv-opt--chosen");
    expect(html).toContain("chosen");
  });

  it("a tool nobody waited on draws no wait at all", () => {
    setLang("en");
    const html = renderToStaticMarkup(
      <ToolCard
        card={{
          callId: "c2",
          agentId: "main",
          name: "read_file",
          input: {},
          status: "ok",
          durationMs: 12,
          startedAt: 1,
        }}
        live={false}
      />,
    );
    expect(html).not.toContain(dict["ask.waited"].en.split("{d}")[0].trim());
  });
});
