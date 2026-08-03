// What the dialog is allowed to offer, and what it has to say at the moment of
// choosing. The rule this file pins: an option either does what its label says
// or it is not on the sheet, and where a choice costs something the cost is
// COUNTED from the stream in front of the reader — "3 subagents and 142 tool
// outputs will not survive" is checkable, "some data may be lost" is noise.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import ccNoConvo from "../import/fixtures/cc-noconvo.jsonl?raw";
import { detectAndLoad } from "../import/detect";
import { eventsToJsonl } from "../state/textFeed";
import { toJsonl } from "./jsonl";
import {
  DEFAULT_REQUEST,
  JSONL_FORMATS,
  JSON_VIEW_CAVEAT,
  JSON_VIEW_OMITS,
  formatLosses,
  offeredViews,
  printWouldHide,
  streamFacts,
  switcherOffer,
} from "./options";

const ts = 1_783_500_000_000;

/** A stream with one subagent, two tool calls (one of them the spawn's own
 *  result), reasoning, usage and a permission decision — enough that every
 *  format's losses are non-zero and countable. */
function sampleEvents(): RunEvent[] {
  return [
    { type: "run_start", runId: "r", agentId: "main", prompt: "go", ts },
    { type: "turn_start", agentId: "main", turn: 1, ts },
    { type: "thinking_delta", agentId: "main", text: "hmm", ts },
    { type: "text_delta", agentId: "main", text: "hello", ts },
    { type: "agent_spawn", agentId: "sub-1", parentId: "main", task: "look", ts },
    { type: "tool_call", agentId: "main", callId: "c1", name: "read_file", input: { path: "a" }, ts },
    { type: "tool_result", agentId: "main", callId: "c1", output: "body", isError: false, durationMs: 3, ts },
    { type: "tool_call", agentId: "sub-1", callId: "c2", name: "list_dir", input: {}, ts },
    {
      type: "tool_result",
      agentId: "sub-1",
      callId: "c2",
      output: "x\ny",
      isError: false,
      durationMs: 1,
      ts,
    },
    { type: "permission_decision", callId: "c1", allowed: true, ts },
    { type: "usage", agentId: "main", inputTokens: 10, outputTokens: 4, ts },
    { type: "run_end", runId: "r", stopReason: "end_turn", ts },
  ] as RunEvent[];
}

describe("streamFacts", () => {
  it("counts what a lossy target would drop", () => {
    const facts = streamFacts(sampleEvents());
    expect(facts.events).toBe(12);
    expect(facts.subagents).toBe(1);
    expect(facts.toolResults).toBe(2);
    expect(facts.toolOutputs).toBe(2);
    expect(facts.reasoning).toBe(1);
    expect(facts.permissionDecisions).toBe(1);
    expect(facts.usage).toBe(1);
  });

  it("counts an empty tool result as a result without an output", () => {
    // Otherwise a re-export of a VS Code import would claim outputs to lose
    // that the stream never had.
    const events = [
      { type: "tool_result", agentId: "main", callId: "c", output: "", isError: false, durationMs: 0, ts },
    ] as RunEvent[];
    const facts = streamFacts(events);
    expect(facts.toolResults).toBe(1);
    expect(facts.toolOutputs).toBe(0);
  });

  it("counts distinct subagents, not spawn events", () => {
    const events = [
      { type: "agent_spawn", agentId: "s", parentId: "main", task: "a", ts },
      { type: "agent_spawn", agentId: "s", parentId: "main", task: "a", ts },
    ] as RunEvent[];
    expect(streamFacts(events).subagents).toBe(1);
  });
});

describe("formatLosses", () => {
  it("says nothing for a stream the app's own format carries whole", () => {
    // Named for what it proves. It used to read "names spectroscope's own
    // format as lossless", which is a claim about the FORMAT, and it was
    // pinning that claim against a sample that holds nothing but wire events.
    // The claim went false and the test stayed green, which is how the sheet
    // came to print "nothing is lost" over a file 1083 lines short.
    expect(formatLosses("spectroscope", streamFacts(sampleEvents()))).toEqual([]);
  });

  it("counts what the app's own format leaves on the screen", () => {
    // toJsonl filters every non-wire frame, because a line the Java reader
    // cannot name is a line SessionStore drops as torn (nonWire.ts has the
    // measurement). The sheet did not know: LOSSES.spectroscope was empty, so
    // the dialog printed "nothing is lost" next to a format that had just
    // stopped writing five kinds of frame. Read through the production path,
    // because the count has to be the one the writer actually applies.
    const { events } = detectAndLoad(ccNoConvo);
    const facts = streamFacts(events);
    const written = toJsonl(events).trimEnd().split("\n").length;

    // The screen shows ten frames and the file holds five.
    expect(facts.events).toBe(10);
    expect(written).toBe(5);
    expect(facts.socketFrames + facts.importedFrames).toBe(facts.events - written);

    const losses = formatLosses("spectroscope", facts);
    expect(losses.map((l) => l.code)).toEqual(["socket-frames", "imported-frames"]);
    expect(losses.find((l) => l.code === "imported-frames")?.count).toBe(4);
    expect(losses.find((l) => l.code === "socket-frames")?.count).toBe(1);
  });

  it("counts the socket frames a live session carries and nothing else", () => {
    // The live half of the same hole: with an OTLP endpoint or a hub attached,
    // the app's own announcements ride in the very array the export menu is
    // handed. Nothing here was imported, so the second row must stay away
    // rather than print a zero.
    const live = streamFacts([
      { type: "run_start", runId: "r", agentId: "main", prompt: "go", ts },
      { type: "provider_info", provider: "anthropic", model: "m", ts },
      { type: "otlp_export", sessionId: "s", endpoint: "http://localhost:3000", spans: 2, ok: true, ts },
      { type: "run_end", runId: "r", stopReason: "end_turn", ts },
    ] as unknown as RunEvent[]);

    expect(live.socketFrames).toBe(2);
    expect(live.importedFrames).toBe(0);
    expect(formatLosses("spectroscope", live).map((l) => l.code)).toEqual(["socket-frames"]);
  });

  it("counts what the VS Code shape cannot carry", () => {
    const losses = formatLosses("vscode", streamFacts(sampleEvents()));
    const codes = losses.map((l) => l.code);
    // That export records no tool output anywhere and has no subagent record.
    expect(codes).toContain("tool-output");
    expect(codes).toContain("subagents");
    expect(losses.find((l) => l.code === "tool-output")?.count).toBe(2);
    expect(losses.find((l) => l.code === "subagents")?.count).toBe(1);
  });

  it("says nothing about a loss the stream cannot suffer", () => {
    // A session with no subagents loses no subagents; a warning here would be
    // the app inventing a cost to sound careful.
    const flat = streamFacts([
      { type: "run_start", runId: "r", agentId: "main", prompt: "p", ts },
      { type: "text_delta", agentId: "main", text: "hi", ts },
    ] as RunEvent[]);
    expect(formatLosses("vscode", flat).map((l) => l.code)).not.toContain("subagents");
  });

  it("counts what the Claude Code shape cannot carry", () => {
    const losses = formatLosses("claude-code", streamFacts(sampleEvents()));
    expect(losses.map((l) => l.code)).toContain("permissions");
    expect(losses.find((l) => l.code === "permissions")?.count).toBe(1);
  });

  it("writes every loss in both chrome languages", () => {
    for (const format of JSONL_FORMATS) {
      for (const loss of formatLosses(format, streamFacts(sampleEvents()))) {
        expect(loss.en).toContain(String(loss.count));
        expect(loss.de).toContain(String(loss.count));
      }
    }
  });
});

// The label over the text tab's json view. It says what that view leaves out,
// and it was written when the view dropped three socket types. It now drops the
// whole non-wire set, and on a real import the import-only kinds are the bulk
// of it: measured on one 6431-line transcript, 1071 of the 1083 omitted frames
// were import-only and 12 were socket frames. A caveat that names the 12 and
// not the 1071 is worse than none, because it reads as a complete answer.
describe("the json view's caveat", () => {
  it("leaves out both groups, measured", () => {
    const { events } = detectAndLoad(ccNoConvo);
    const facts = streamFacts(events);

    expect(facts.events - eventsToJsonl(events).length).toBe(facts.socketFrames + facts.importedFrames);
    expect(facts.importedFrames).toBeGreaterThan(facts.socketFrames);
  });

  it("says so in both languages", () => {
    expect(JSON_VIEW_CAVEAT.en.toLowerCase()).toContain("socket");
    expect(JSON_VIEW_CAVEAT.en.toLowerCase()).toContain("imported");
    expect(JSON_VIEW_CAVEAT.de.toLowerCase()).toContain("socket");
    expect(JSON_VIEW_CAVEAT.de.toLowerCase()).toContain("importierte");
  });

  it("is written once and read by the dialog", () => {
    // The sheet carried a second, hand-typed copy of the same sentence, so the
    // wording went stale in one place and not the other. A drift test rather
    // than a render test: what matters is that there is one sentence.
    const dialog = readFileSync(
      fileURLToPath(new URL("../components/ExportDialog.tsx", import.meta.url)),
      "utf8",
    );
    expect(dialog).toContain("JSON_VIEW_OMITS");
    expect(dialog).not.toContain("socket-only frames omitted");
    // and the header form is built from the same words rather than typed twice
    expect(JSON_VIEW_CAVEAT.en).toContain(JSON_VIEW_OMITS.en);
    expect(JSON_VIEW_CAVEAT.de).toContain(JSON_VIEW_OMITS.de);
  });
});

describe("offeredViews", () => {
  it("offers the chat tab its own view first", () => {
    expect(offeredViews("chat")[0]).toBe("chat");
  });

  it("offers the text tab its own view first", () => {
    expect(offeredViews("text")[0]).toBe("text");
  });

  it("offers the other view and the json view from either tab", () => {
    // The owner's ask: a text export may also carry the chat view, and a chat
    // export the text view, json included.
    for (const kind of ["chat", "text"] as const) {
      expect(offeredViews(kind)).toContain("chat");
      expect(offeredViews(kind)).toContain("text");
      expect(offeredViews(kind)).toContain("json");
    }
  });
});

describe("switcherOffer", () => {
  const both = { original: sampleEvents(), translated: sampleEvents(), landed: 4, failed: 0 };

  it("is offered when both languages are in hand", () => {
    expect(switcherOffer(both).offered).toBe(true);
  });

  it("is withheld when nothing was translated", () => {
    expect(switcherOffer({ ...both, landed: 0 }).offered).toBe(false);
  });

  it("is withheld when the original side is missing", () => {
    // The text tab is handed the translated stream and cannot recover the
    // original; a switcher there would flip between two identical documents.
    expect(switcherOffer({ ...both, original: null }).offered).toBe(false);
  });

  it("reports a partial translation rather than implying a whole one", () => {
    const offer = switcherOffer({ ...both, failed: 3 });
    expect(offer.offered).toBe(true);
    expect(offer.partial).toBe(3);
  });
});

describe("printWouldHide", () => {
  it("is true when a disclosure is collapsed", () => {
    // A closed <details> does not print: picking print with tools collapsed
    // drops every tool call from the PDF without saying so.
    expect(printWouldHide({ ...DEFAULT_REQUEST, tools: "collapsed" })).toBe(true);
    expect(printWouldHide({ ...DEFAULT_REQUEST, reasoning: "collapsed" })).toBe(true);
  });

  it("is false once everything is expanded", () => {
    expect(printWouldHide({ ...DEFAULT_REQUEST, tools: "open", reasoning: "open" })).toBe(false);
  });
});

describe("DEFAULT_REQUEST", () => {
  it("keeps the record complete by default", () => {
    // A collapsed command in a file attached to a ticket is a command nobody
    // reads; the reader can fold it away afterwards.
    expect(DEFAULT_REQUEST.tools).toBe("open");
    expect(DEFAULT_REQUEST.format).toBe("spectroscope");
  });
});
