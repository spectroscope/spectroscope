// The bar that states what an import was: the file, the conversation in prompts
// and answers, and that it is only shown and not saved. Its own comment says it belongs to the
// SESSION rather than to the dialog, and that is the whole rule: a bar naming a
// file the reader is no longer looking at is a label that means something
// different from what it says, which is the defect this card exists to remove.
//
// Found live: import a transcript, then click a stored session in the sidebar.
// The header eyebrow switches to "archive" and the bar keeps naming the
// imported file.
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { t } from "../i18n/i18n";
import { detectAndLoad } from "../import/detect";
import ccFollowup from "../import/fixtures/cc-followup.jsonl?raw";
import vscodeAgentExport from "../import/fixtures/vscode-agent.jsonl?raw";
import { initialState, reduceAll } from "../state/reducer";
import {
  childrenNote,
  conversationCounts,
  importBarAbout,
  importBarNote,
  importBarText,
  shownImportBar,
  subagentNote,
  type ImportBarState,
} from "./importBar";

const bar: ImportBarState = {
  sessionId: "import:claude-code:four-readings.jsonl",
  file: "four-readings.jsonl",
  stats: { lines: 3711, frames: 5602, zeroLines: 1304 },
  counts: { prompts: 14, answers: 293 },
  note: null,
  agentTranscript: false,
};

describe("which session the import bar belongs to", () => {
  it("shows it for the session it describes", () => {
    expect(shownImportBar(bar, bar.sessionId)).toBe(bar);
  });

  it("drops it the moment another session is opened", () => {
    expect(shownImportBar(bar, "20260726-172215-1a2b3c4d")).toBeNull();
  });

  it("drops it when the reader goes back to the live session", () => {
    expect(shownImportBar(bar, null)).toBeNull();
  });

  it("has nothing to show when nothing was imported", () => {
    expect(shownImportBar(null, "20260726-172215-1a2b3c4d")).toBeNull();
    expect(shownImportBar(null, null)).toBeNull();
  });

  // A second import replaces the first: same shape, different id, and the old
  // bar must not survive the swap for even one render.
  it("shows the second import rather than the first", () => {
    const next = { ...bar, sessionId: "import:claude-code:other.jsonl", file: "other.jsonl" };
    expect(shownImportBar(next, next.sessionId)?.file).toBe("other.jsonl");
    expect(shownImportBar(bar, next.sessionId)).toBeNull();
  });
});

// Saying what the file is (card 152).
//
// A subagent transcript that imports as an ordinary session is a second false
// statement on top of the first: the reader is told this is a session, when it
// is one agent lifted out of somebody else's run. The file names its own agent
// on every line, and names the session it ran under and the kind of agent it
// was, so the bar can say all three without inventing any of them.
//
// The rule of import/sourceNotes.ts applies here word for word: a fact the file
// does not carry produces NOTHING. No empty clause, no placeholder id.
describe("what the bar says about a subagent transcript", () => {
  it("says nothing at all about an ordinary session", () => {
    expect(subagentNote("en", undefined)).toBeNull();
    expect(subagentNote("de", null)).toBeNull();
  });

  it("names the agent, its kind and the session it came out of", () => {
    const note = subagentNote("en", {
      agentId: "a0b476c3c018",
      sessionId: "902488ae-c4cf-49ef-a57c-cd914740bee2",
      attributionAgent: "general-purpose",
    });
    expect(note).toContain("a0b476c3c018");
    expect(note).toContain("902488ae-c4cf-49ef-a57c-cd914740bee2");
    expect(note).toContain("general-purpose");
  });

  it("says it in German too", () => {
    const note = subagentNote("de", { agentId: "a0b476c3c018", sessionId: "s-1" });
    expect(note).toContain("a0b476c3c018");
    expect(note).toContain("s-1");
    expect(note).not.toMatch(/\{[a-z]+\}/); // no unfilled slot reaches the screen
  });

  it("drops the session clause when the file does not name one", () => {
    const note = subagentNote("en", { agentId: "lone" }) ?? "";
    expect(note).toContain("lone");
    expect(note.toLowerCase()).not.toContain("session ");
    expect(note).not.toContain("undefined");
  });

  it("drops the kind clause when the file does not name one", () => {
    const note = subagentNote("en", { agentId: "lone", sessionId: "s-1" }) ?? "";
    expect(note).toContain("s-1");
    expect(note).not.toContain("undefined");
  });
});

// Card 291: the bar says what came along with the session.
//
// A run import merges the children's own transcripts into the stream, and the
// bar states the count. When some sidecars could not be joined it says that
// too — honest, like the worker chip: a silent skip would read as "the run had
// fewer children", which is a claim about somebody else's session.
describe("what the bar says about a run import's children", () => {
  it("says nothing about a lone-file import", () => {
    expect(childrenNote("en", undefined)).toBeNull();
    expect(childrenNote("de", null)).toBeNull();
  });

  it("says nothing when the run had no sidecars at all", () => {
    expect(
      childrenNote("en", { workspace: null, childrenMerged: 0, childrenSkipped: 0, childrenUnrecorded: 0 }),
    ).toBeNull();
  });

  it("counts the merged children, in both languages", () => {
    const run = {
      workspace: "/workspaces/demo",
      childrenMerged: 2,
      childrenSkipped: 0,
      childrenUnrecorded: 0,
    };
    expect(childrenNote("en", run)).toContain("2");
    expect(childrenNote("en", run)).toContain("merged");
    expect(childrenNote("de", run)).toContain("2");
    expect(childrenNote("de", run)).not.toMatch(/\{[a-z]+\}/);
    // Nothing was skipped, so nothing claims it was.
    expect(childrenNote("en", run)?.toLowerCase()).not.toContain("skip");
  });

  it("says when a workflow named an agent that left no transcript", () => {
    // Card 297: neither merged nor skipped — there was nothing there to skip.
    // Without its own clause the agent simply vanishes, and a run that
    // reports four agents shows three with nothing admitting the fourth.
    const run = { workspace: null, childrenMerged: 3, childrenSkipped: 0, childrenUnrecorded: 1 };
    expect(childrenNote("en", run)?.toLowerCase()).toContain("no transcript");
    expect(childrenNote("en", run)).toContain("1");
    expect(childrenNote("de", run)).toContain("1");
    expect(childrenNote("de", run)).not.toMatch(/\{[a-z]+\}/);
    // Nothing was skipped, so nothing claims it was.
    expect(childrenNote("en", run)?.toLowerCase()).not.toContain("skip");
  });

  it("stays silent about agents no run ever named", () => {
    const run = { workspace: null, childrenMerged: 2, childrenSkipped: 0, childrenUnrecorded: 0 };
    expect(childrenNote("en", run)?.toLowerCase()).not.toContain("transcript");
  });

  it("says when children were skipped", () => {
    const run = { workspace: null, childrenMerged: 1, childrenSkipped: 2, childrenUnrecorded: 0 };
    expect(childrenNote("en", run)?.toLowerCase()).toContain("skipped");
    expect(childrenNote("en", run)).toContain("2");
    expect(childrenNote("de", run)).toContain("2");
  });
});

// Card 440: the bar says what was brought in, in counts a reader knows.
//
// It read "Imported from bv435-big-import.jsonl. 91956 lines, 91956 frames,
// nothing read from 0 of them. Nothing was written to disk." and the owner, who
// wrote the importer's brief, could not tell what to take from it. Lines and
// frames are the importer's units. A reader counts a conversation in what was
// asked and what came back.
const run = (agentId: string, prompt: string, parentId?: string): RunEvent => ({
  type: "run_start",
  runId: `r-${agentId}`,
  agentId,
  prompt,
  ...(parentId !== undefined ? { parentId } : {}),
  ts: 1,
});
const turn = (agentId: string, n: number): RunEvent => ({ type: "turn_start", agentId, turn: n, ts: 1 });
// An import-only frame: the union types what the socket sends, and a person's
// later words in a transcript are not one of those.
const said = (text: string): RunEvent => ({ type: "user_message", text, ts: 1 }) as unknown as RunEvent;
const steered = (text: string, taken: boolean): RunEvent =>
  ({ type: "steering_message", agentId: "main", text, taken, turn: 1, ts: 1 }) as RunEvent;
// A picture a transcript record carried with no words beside it.
const picture = (): RunEvent =>
  ({
    type: "attachment_image",
    agentId: "main",
    mediaType: "image/png",
    dataBase64: "iVBORw0KGgo=",
    note: "[Image: 1 KB]",
    standalone: true,
    ts: 1,
  }) as unknown as RunEvent;

describe("what the bar counts a conversation in", () => {
  it("counts the opening prompt and every later message as prompts, the main agent's turns as answers", () => {
    const events = [
      run("main", "fix the build"),
      turn("main", 1),
      turn("main", 2),
      said("and the tests"),
      turn("main", 3),
    ];
    expect(conversationCounts(events)).toEqual({ prompts: 2, answers: 3 });
  });

  it("leaves a child agent's run and turns out of both counts", () => {
    const events = [
      run("main", "fan out"),
      turn("main", 1),
      run("child-1", "look around", "main"),
      turn("child-1", 1),
      turn("child-1", 2),
      turn("main", 2),
    ];
    expect(conversationCounts(events)).toEqual({ prompts: 1, answers: 2 });
  });

  it("counts every root run of a recorded session, one per message sent", () => {
    const events = [run("main", "one"), turn("main", 1), run("main", "two"), turn("main", 1)];
    expect(conversationCounts(events)).toEqual({ prompts: 2, answers: 2 });
  });

  it("does not count a prompt nobody wrote", () => {
    // A VS Code export can open mid-session, and its run then starts with an
    // empty prompt because the request is not in the file.
    const events = [run("main", ""), turn("main", 1), said("")];
    expect(conversationCounts(events)).toEqual({ prompts: 0, answers: 1 });
  });

  it("counts a real Claude Code transcript as the chat shows it", () => {
    // cc-followup.jsonl: the opening prompt, two later messages and the image
    // note the client wrote into the user channel, around two responses.
    const { events } = detectAndLoad(ccFollowup);
    expect(conversationCounts(events)).toEqual({ prompts: 4, answers: 2 });
  });

  it("counts a real VS Code export as the chat shows it", () => {
    // vscode-agent.jsonl: two user.message records, three assistant.turn_start.
    const { events } = detectAndLoad(vscodeAgentExport);
    expect(conversationCounts(events)).toEqual({ prompts: 2, answers: 3 });
  });

  it("counts a steering message as a prompt, whether the run read it or not", () => {
    // Card 380 draws both as the person's turn; the unread one only gets a
    // note beside it.
    const events = [
      run("main", "fix the build"),
      turn("main", 1),
      steered("and the tests too", true),
      turn("main", 2),
      steered("and the docs", false),
    ];
    expect(conversationCounts(events)).toEqual({ prompts: 3, answers: 2 });
  });

  it("counts as many prompts as the chat draws person turns with words", () => {
    // A native stream, the kind the owner imported: a prompt, a steering
    // message, a later message from a transcript.
    const events = [
      run("main", "fix the build"),
      turn("main", 1),
      steered("and the tests too", true),
      turn("main", 2),
      said("thanks"),
      turn("main", 3),
    ];
    const drawn = reduceAll(initialState, events).turns.filter((x) => x.kind === "user").length;
    expect(drawn).toBe(3);
    expect(conversationCounts(events).prompts).toBe(drawn);
  });

  it("leaves a picture sent without words out of the prompts", () => {
    // The importer gives each such picture a bubble of its own, so counting
    // those bubbles would count pictures, not messages.
    const events = [run("main", "look at these"), turn("main", 1), picture(), picture(), turn("main", 2)];
    const drawn = reduceAll(initialState, events).turns.filter((x) => x.kind === "user").length;
    expect(drawn).toBe(3);
    expect(conversationCounts(events)).toEqual({ prompts: 1, answers: 2 });
  });
});

const clean: ImportBarState = {
  sessionId: "import:spectroscope:bv435-big-import.jsonl",
  file: "bv435-big-import.jsonl",
  stats: { lines: 91956, frames: 91956, zeroLines: 0 },
  counts: { prompts: 14, answers: 293 },
  note: null,
  agentTranscript: false,
};
const unmatched: ImportBarState = { ...clean, stats: { lines: 3711, frames: 5602, zeroLines: 110 } };
const LANGS = ["en", "de"] as const;

/** The importer's own units, in either language. */
const LINES_OR_FRAMES = /\b(lines?|frames?|Zeilen?)\b/i;

describe("what the import bar says", () => {
  it("says what a clean import brought in, in the owner's words", () => {
    expect(importBarText("en", clean).said).toBe(
      "Opened bv435-big-import.jsonl: 14 prompts, 293 answers. The session is shown here only and not saved.",
    );
    expect(importBarText("de", clean).said).toBe(
      "bv435-big-import.jsonl geöffnet: 14 Eingaben, 293 Antworten. Die Sitzung wird nur angezeigt und nicht gespeichert.",
    );
  });

  it("names no lines and no frames when every line was matched", () => {
    for (const lang of LANGS) {
      const text = importBarText(lang, clean).said;
      expect(text).toContain("bv435-big-import.jsonl");
      expect(text).toContain("293");
      expect(text, lang).not.toMatch(LINES_OR_FRAMES);
    }
  });

  // Owner call 2, option D (the lead, 2026-09-25): all 150 of the newest Claude
  // Code session files measured had unmatched lines, nearly all of them records
  // the importer skips on purpose, so a warning there would be false on almost
  // every import. The count stays under Details.
  it("says the same about a file with unmatched lines as about a clean one", () => {
    expect(importBarText("en", unmatched).said).toBe(
      "Opened bv435-big-import.jsonl: 14 prompts, 293 answers. The session is shown here only and not saved.",
    );
    expect(importBarText("de", unmatched).said).toBe(
      "bv435-big-import.jsonl geöffnet: 14 Eingaben, 293 Antworten. Die Sitzung wird nur angezeigt und nicht gespeichert.",
    );
  });

  // Card 152: on a subagent transcript those lines held the whole conversation,
  // and the importer could not attribute them. The number measures what this
  // importer read, so its label must not describe the lines as empty.
  it("keeps the unmatched count under Details without calling those lines empty", () => {
    const en = importBarText("en", unmatched).details;
    const de = importBarText("de", unmatched).details;
    expect(en).toContain("Not matched: 110");
    expect(de).toContain("Nicht zugeordnet: 110");
    expect(en).not.toMatch(/empty|carry no|no conversation|nothing/i);
    expect(de).not.toMatch(/leer|kein Gespräch|nichts/i);
  });

  it("names no lines and no frames in its own sentences, whatever the counts", () => {
    const cases: ImportBarState[] = [
      clean,
      unmatched,
      { ...clean, stats: { lines: 3, frames: 4, zeroLines: 1 } },
      { ...clean, stats: { lines: 91956, frames: 91956, zeroLines: 1304 } },
    ];
    for (const lang of LANGS) {
      for (const state of cases) {
        const text = importBarText(lang, state).said;
        expect(text, `${lang} ${state.stats.zeroLines}`).toContain("bv435-big-import.jsonl");
        expect(text, `${lang} ${state.stats.zeroLines}`).not.toMatch(LINES_OR_FRAMES);
      }
    }
  });

  it("uses the singular for one of each", () => {
    const one: ImportBarState = {
      ...clean,
      stats: { lines: 3, frames: 4, zeroLines: 1 },
      counts: { prompts: 1, answers: 1 },
    };
    expect(importBarText("en", one).said).toContain(": 1 prompt, 1 answer.");
    expect(importBarText("de", one).said).toContain(": 1 Eingabe, 1 Antwort.");
  });

  it("groups numbers the way the reader's language does", () => {
    const big: ImportBarState = {
      ...clean,
      stats: { lines: 91956, frames: 91956, zeroLines: 1304 },
      counts: { prompts: 1204, answers: 12345 },
    };
    expect(importBarText("de", big).said).toContain("1.204 Eingaben, 12.345 Antworten");
    expect(importBarText("en", big).said).toContain("1,204 prompts, 12,345 answers");
    expect(importBarText("de", big).details).toBe(
      "Zeilen in der Datei: 91.956 · Frames: 91.956 · Nicht zugeordnet: 1.304",
    );
    expect(importBarText("en", big).details).toBe(
      "Lines in the file: 91,956 · Frames: 91,956 · Not matched: 1,304",
    );
  });

  it("keeps the raw numbers in its details, in both languages", () => {
    expect(importBarText("en", clean).details).toBe(
      "Lines in the file: 91,956 · Frames: 91,956 · Not matched: 0",
    );
    expect(importBarText("de", clean).details).toBe(
      "Zeilen in der Datei: 91.956 · Frames: 91.956 · Nicht zugeordnet: 0",
    );
    expect(importBarText("en", unmatched).details).toBe(
      "Lines in the file: 3,711 · Frames: 5,602 · Not matched: 110",
    );
  });

  it("fills a file name that looks like a slot as a file name", () => {
    const odd: ImportBarState = { ...clean, file: "{prompts}.jsonl" };
    expect(importBarText("en", odd).said).toContain("Opened {prompts}.jsonl: 14 prompts, 293 answers.");
  });

  it("fills a file name with dollar signs in it as written", () => {
    const odd: ImportBarState = { ...clean, file: "a$&b$'c$`d$$e.jsonl" };
    expect(importBarText("en", odd).said).toContain("Opened a$&b$'c$`d$$e.jsonl: 14 prompts, 293 answers.");
    expect(importBarText("de", odd).said).toContain("a$&b$'c$`d$$e.jsonl geöffnet: 14 Eingaben");
  });
});

// A note for a special kind of file still appears, and after the bar's own
// sentences: it qualifies what they said, so it is read second.
describe("the notes for special kinds of file", () => {
  // The bar as App builds it: the note and what the file is come from one call.
  const after = (lang: "en" | "de", about: Parameters<typeof importBarNote>[1]): string => {
    const parts = importBarAbout(lang, about);
    const note = importBarNote(lang, about);
    const text = importBarText(lang, { ...unmatched, ...parts }).said;
    const own = importBarText(lang, { ...unmatched, ...parts, note: null }).said;
    expect(parts.note).toBe(note);
    expect(note).not.toBeNull();
    expect(text).toBe(`${own} ${note}`);
    return text;
  };

  it("says nothing extra about an ordinary file", () => {
    expect(importBarNote("en", { kind: "claude-code" })).toBeNull();
    expect(importBarNote("de", { kind: "spectroscope" })).toBeNull();
    expect(importBarText("en", unmatched).said).toMatch(/not saved\.$/);
  });

  it("puts the VS Code note after the bar's own sentences", () => {
    for (const lang of LANGS) {
      const note = importBarNote(lang, { kind: "vscode-agent" });
      expect(note).toBe(t(lang, "imp.vscodeNote"));
      after(lang, { kind: "vscode-agent" });
    }
  });

  it("puts the subagent note after the bar's own sentences", () => {
    for (const lang of LANGS) {
      const sub = { agentId: "a0b476c3c018", sessionId: "s-1" };
      const note = importBarNote(lang, { kind: "claude-code", subagent: sub });
      expect(note).toBe(subagentNote(lang, sub));
      after(lang, { kind: "claude-code", subagent: sub });
    }
  });

  it("puts what a run import carried after the bar's own sentences", () => {
    for (const lang of LANGS) {
      const summary = { workspace: null, childrenMerged: 2, childrenSkipped: 1, childrenUnrecorded: 0 };
      const note = importBarNote(lang, { kind: "claude-code", run: summary });
      expect(note).toBe(childrenNote(lang, summary));
      after(lang, { kind: "claude-code", run: summary });
    }
  });

  it("puts the store's fall-back sentence after the bar's own sentences", () => {
    for (const lang of LANGS) {
      const extra = t(lang, "imp.run.vanished", { agents: 3 });
      const note = importBarNote(lang, { kind: "claude-code", extra });
      expect(note).toBe(extra);
      after(lang, { kind: "claude-code", extra });
    }
  });

  it("adds nothing for an empty fall-back sentence", () => {
    expect(importBarNote("en", { kind: "claude-code", extra: "" })).toBeNull();
    expect(importBarNote("en", { kind: "vscode-agent", extra: "" })).toBe(t("en", "imp.vscodeNote"));
  });

  it("keeps every note when a file wants more than one, in a fixed order", () => {
    const sub = { agentId: "a0b476c3c018" };
    const summary = { workspace: null, childrenMerged: 1, childrenSkipped: 0, childrenUnrecorded: 0 };
    const note = importBarNote("en", { kind: "vscode-agent", subagent: sub, run: summary, extra: "Last." });
    expect(note).toBe(
      [t("en", "imp.vscodeNote"), subagentNote("en", sub), childrenNote("en", summary), "Last."].join(" "),
    );
  });
});

// Review of wave H3e: a subagent transcript's bar read "The session is shown
// here only and not saved." and, one sentence later, "This is a subagent
// transcript, not a session". Card 152 removed exactly that false statement:
// the file is one agent lifted out of another session's run.
describe("what the bar calls a subagent transcript", () => {
  const sub = {
    agentId: "a0b476c3c018",
    sessionId: "902488ae-c4cf-49ef-a57c-cd914740bee2",
    attributionAgent: "general-purpose",
  };
  const opened = (lang: "en" | "de", about: Parameters<typeof importBarNote>[1]): string =>
    importBarText(lang, { ...clean, file: "agent-a0b476c3c018.jsonl", ...importBarAbout(lang, about) }).said;

  it("says the transcript is shown, not the session", () => {
    expect(opened("en", { kind: "claude-code", subagent: sub })).toBe(
      "Opened agent-a0b476c3c018.jsonl: 14 prompts, 293 answers. The transcript is shown here only and not saved. " +
        "This is a subagent transcript, not a session: agent a0b476c3c018. Kind: general-purpose. " +
        "It ran in session 902488ae-c4cf-49ef-a57c-cd914740bee2.",
    );
    expect(opened("de", { kind: "claude-code", subagent: sub })).toBe(
      "agent-a0b476c3c018.jsonl geöffnet: 14 Eingaben, 293 Antworten. Das Transkript wird nur angezeigt und nicht gespeichert. " +
        "Das ist das Transkript eines Subagenten, keine Sitzung: Agent a0b476c3c018. Art: general-purpose. " +
        "Er lief in Sitzung 902488ae-c4cf-49ef-a57c-cd914740bee2.",
    );
  });

  it("never calls the file a session in the sentences before the note that says it is not one", () => {
    const cases: Parameters<typeof importBarNote>[1][] = [
      { kind: "claude-code", subagent: sub },
      { kind: "claude-code", subagent: { agentId: "lone" } },
      { kind: "claude-code", subagent: { agentId: "lone", sessionId: "s-1" } },
      { kind: "vscode-agent", subagent: sub },
      {
        kind: "claude-code",
        subagent: sub,
        run: { workspace: null, childrenMerged: 1, childrenSkipped: 0, childrenUnrecorded: 0 },
        extra: "Last.",
      },
    ];
    for (const lang of LANGS) {
      for (const about of cases) {
        const note = importBarNote(lang, about) ?? "";
        const said = opened(lang, about);
        const label = `${lang} ${JSON.stringify(about)}`;
        expect(said, label).toContain(subagentNote(lang, about.subagent) ?? "no subagent note");
        expect(said.endsWith(` ${note}`), label).toBe(true);
        expect(said.slice(0, said.length - note.length), label).not.toMatch(/session|Sitzung/i);
      }
    }
  });

  it("still calls an ordinary file a session, in the owner's words", () => {
    for (const lang of LANGS) {
      for (const about of [{ kind: "claude-code" }, { kind: "vscode-agent" }] as const) {
        const said = opened(lang, about);
        expect(said, lang).toContain(lang === "en" ? "The session is shown" : "Die Sitzung wird");
        expect(importBarAbout(lang, about).agentTranscript).toBe(false);
      }
    }
  });

  it("marks the bar as an agent's transcript exactly when the file named its agent", () => {
    expect(importBarAbout("en", { kind: "claude-code", subagent: sub }).agentTranscript).toBe(true);
    expect(importBarAbout("en", { kind: "claude-code", subagent: null }).agentTranscript).toBe(false);
    expect(importBarAbout("en", { kind: "claude-code" }).agentTranscript).toBe(false);
  });
});
