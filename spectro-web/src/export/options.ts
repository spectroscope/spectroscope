// What the export dialog may offer, and what it owes the reader at the moment
// of choosing.
//
// The house rule this module exists to keep: the app never lets a person
// discover a loss afterwards. An export is the one action whose result leaves
// the app entirely — nobody comes back to check. So where a choice costs
// something, the cost is COUNTED off the stream in front of the reader and
// printed next to the choice: "3 subagents and 142 tool outputs will not
// survive this format" is checkable and acts on a decision; "some data may be
// lost" is noise that trains people to click past warnings.
//
// Nothing here renders. It decides what is true about a stream and a request,
// so the dialog and the document builder agree without either one guessing.

import type { RunEvent } from "../events";
import type { DesignId } from "../state/designPrefs";
import type { ExportKind } from "./kinds";
import { IMPORT_ONLY_TYPES, SOCKET_ONLY_TYPES } from "../wire/nonWire";

/** A section an exported document can carry. `json` is the TEXT TAB's json
 *  view, not the .jsonl download. See JSON_VIEW_CAVEAT. */
export type ViewId = "chat" | "text" | "json";

/** Whether reasoning and tool cards arrive folded or unfolded in the file. */
export type DisclosureChoice = "open" | "collapsed";

export type JsonlFormat = "spectroscope" | "claude-code" | "vscode";

export const JSONL_FORMATS: readonly JsonlFormat[] = ["spectroscope", "claude-code", "vscode"];

/** The two artifacts this app calls "json" are not the same bytes: the text
 *  tab's view is a fold of the stream, the .jsonl download is the file. They
 *  now leave out the same frames (both writers share nonWire.ts), so the
 *  difference is the fold and not the filter, and the header still has to say
 *  what neither of them carries.
 *
 *  It says both groups because both are real. This sentence used to name only
 *  the socket frames, which was true when the view filtered three types; it
 *  filters the whole non-wire set now, and on a real transcript the imported
 *  frames are the bulk of it. Naming the smaller group and stopping reads as a
 *  complete answer, which is worse than saying nothing. */
export const JSON_VIEW_OMITS: Record<"en" | "de", string> = {
  en: "as the text tab shows it: socket frames and imported frames omitted",
  de: "wie im Text-Tab: Socket-Frames und importierte Frames fehlen",
};

/** The same sentence with the view named, for a section header that stands on
 *  its own. Built from {@link JSON_VIEW_OMITS} rather than repeated, because
 *  the repetition is what went stale. */
export const JSON_VIEW_CAVEAT: Record<"en" | "de", string> = {
  en: `json view (${JSON_VIEW_OMITS.en})`,
  de: `JSON-Ansicht (${JSON_VIEW_OMITS.de})`,
};

/** Everything the dialog decided, in one value. */
export interface ExportRequest {
  kind: ExportKind;
  /** Sections the html carries, in the order they appear. */
  views: readonly ViewId[];
  /** The section selected when the file opens. */
  primary: ViewId;
  theme: DesignId;
  reasoning: DisclosureChoice;
  tools: DisclosureChoice;
  /** Offer both languages in the one file. Ignored when there is no second one. */
  switcher: boolean;
  format: JsonlFormat;
}

export const DEFAULT_REQUEST: ExportRequest = {
  kind: "chat",
  views: ["chat"],
  primary: "chat",
  theme: "spectroscope",
  // Reasoning folded, tools open: the same asymmetry the app's own default
  // disclosure keeps. A collapsed command in a file attached to a ticket is a
  // command nobody reads, while reasoning is long and rarely the point.
  reasoning: "collapsed",
  tools: "open",
  switcher: false,
  format: "spectroscope",
};

// ---- what is in the stream --------------------------------------------------

/** The counts a warning is allowed to quote. Only things a format could drop. */
export interface StreamFacts {
  events: number;
  subagents: number;
  toolResults: number;
  /** Results that carry text. A result with an empty output has nothing to lose. */
  toolOutputs: number;
  reasoning: number;
  permissionDecisions: number;
  usage: number;
  images: number;
  /** Frames the app announced over the socket. No writer may put one in a file,
   *  so the file is shorter than the header's event count by this much. */
  socketFrames: number;
  /** Frames an import read around the conversation. Same rule, different
   *  sentence: these carry something the reader saw on screen. */
  importedFrames: number;
}

/**
 * What a stream contains that a target format might not be able to hold.
 *
 * @param events the stream about to be written
 * @return counts, all of them derived — never a guess, never a constant
 */
export function streamFacts(events: readonly RunEvent[]): StreamFacts {
  const agents = new Set<string>();
  const facts: StreamFacts = {
    events: events.length,
    subagents: 0,
    toolResults: 0,
    toolOutputs: 0,
    reasoning: 0,
    permissionDecisions: 0,
    usage: 0,
    images: 0,
    socketFrames: 0,
    importedFrames: 0,
  };
  for (const event of events) {
    // Read before the switch, because these types are not in the RunEvent union
    // the switch is written against. Counted here rather than in a writer,
    // because the sheet has to say the cost BEFORE anybody clicks save.
    if (SOCKET_ONLY_TYPES.has(event.type)) facts.socketFrames += 1;
    else if (IMPORT_ONLY_TYPES.has(event.type)) facts.importedFrames += 1;
    switch (event.type) {
      case "agent_spawn":
        agents.add(event.agentId);
        break;
      case "tool_result":
        facts.toolResults += 1;
        if (event.output !== "") facts.toolOutputs += 1;
        break;
      case "thinking_delta":
        facts.reasoning += 1;
        break;
      case "permission_decision":
        facts.permissionDecisions += 1;
        break;
      case "usage":
        facts.usage += 1;
        break;
      case "image_generated":
        facts.images += 1;
        break;
      default:
        break;
    }
  }
  facts.subagents = agents.size;
  return facts;
}

// ---- what a format costs ----------------------------------------------------

export interface Loss {
  /** Stable identifier, so a test can assert a loss without matching prose. */
  code: string;
  count: number;
  en: string;
  de: string;
}

/** One entry per thing a foreign shape cannot carry, with the fact that decides
 *  whether it applies to THIS stream. A loss with a count of zero is never
 *  printed: a session with no subagents loses no subagents, and warning anyway
 *  is the app inventing a cost to sound careful. */
const LOSSES: Record<
  JsonlFormat,
  ReadonlyArray<{
    code: string;
    of: (f: StreamFacts) => number;
    en: (n: number) => string;
    de: (n: number) => string;
  }>
> = {
  // The app's own wire format. Byte-identical on the round trip for every line
  // it writes, and it no longer writes all of them: toJsonl filters the frames
  // the Java reader cannot name, because such a line is one SessionStore drops
  // as torn (nonWire.ts has the measurement). This row is what that filter costs
  // the reader, counted, and it is the reason the sheet stopped saying "nothing
  // is lost" over a file with fewer lines than the header's event count.
  spectroscope: [
    {
      code: "socket-frames",
      of: (f) => f.socketFrames,
      en: (n) =>
        `${n} socket ${n === 1 ? "frame" : "frames"} the app built for its own screen: no session file has a line for them`,
      de: (n) =>
        `${n} Socket-${n === 1 ? "Frame" : "Frames"}, die die App für ihr eigenes Bild gebaut hat: keine Sitzungsdatei hat dafür eine Zeile`,
    },
    {
      code: "imported-frames",
      of: (f) => f.importedFrames,
      // Named as a group and never by kind: a sentence listing the todo list
      // and the prompt queue would name them for a stream that carries neither.
      en: (n) =>
        `${n} imported ${n === 1 ? "frame" : "frames"} read around the conversation: the wire format has no line for them either`,
      de: (n) =>
        `${n} importierte ${n === 1 ? "Frame" : "Frames"}, die rund um das Gespräch gelesen wurden: auch dafür hat das Draht-Format keine Zeile`,
    },
  ],
  "claude-code": [
    {
      code: "permissions",
      of: (f) => f.permissionDecisions,
      en: (n) => `${n} permission ${n === 1 ? "decision" : "decisions"} — a transcript has no gate record`,
      de: (n) => `${n} Gate-${n === 1 ? "Entscheidung" : "Entscheidungen"} — ein Transkript kennt kein Gate`,
    },
    {
      code: "images",
      of: (f) => f.images,
      en: (n) => `${n} generated ${n === 1 ? "image" : "images"} — no counterpart in that format`,
      de: (n) => `${n} generierte ${n === 1 ? "Grafik" : "Grafiken"} — kein Gegenstück in dem Format`,
    },
  ],
  vscode: [
    {
      code: "tool-output",
      of: (f) => f.toolOutputs,
      // Measured in the real export: tool.execution_complete carries only
      // { toolCallId, success }. There is nowhere to put the output.
      en: (n) => `${n} tool ${n === 1 ? "output" : "outputs"} — the format records only success or failure`,
      de: (n) => `${n} Tool-${n === 1 ? "Ausgabe" : "Ausgaben"} — das Format kennt nur Erfolg oder Fehler`,
    },
    {
      code: "permissions",
      of: (f) => f.permissionDecisions,
      // The same hole the transcript has, and for the same reason: this writer
      // has no field for a gate decision either. Warned here only after a real
      // export was read back and the decisions were found missing with the
      // sheet silent — the transcript row had been warning about it all along.
      en: (n) => `${n} permission ${n === 1 ? "decision" : "decisions"} — that format has no gate record`,
      de: (n) => `${n} Gate-${n === 1 ? "Entscheidung" : "Entscheidungen"} — dieses Format kennt kein Gate`,
    },
    {
      code: "subagents",
      of: (f) => f.subagents,
      // Their prose is folded into the one lane the format has, so the words
      // survive and the attribution does not. Saying "lost" would be wrong in
      // the other direction.
      en: (n) =>
        `${n} ${n === 1 ? "subagent lane" : "subagent lanes"} — that format has one lane, so their work folds into it`,
      de: (n) =>
        `${n} Subagenten-${n === 1 ? "Spur" : "Spuren"} — dieses Format hat eine Spur, ihre Arbeit landet darin`,
    },
    {
      code: "usage",
      of: (f) => f.usage,
      en: (n) => `${n} token ${n === 1 ? "count" : "counts"} — not carried by that format`,
      de: (n) => `${n} Token-${n === 1 ? "Zählung" : "Zählungen"} — das Format trägt sie nicht`,
    },
    {
      code: "images",
      of: (f) => f.images,
      en: (n) => `${n} generated ${n === 1 ? "image" : "images"} — no counterpart in that format`,
      de: (n) => `${n} generierte ${n === 1 ? "Grafik" : "Grafiken"} — kein Gegenstück in dem Format`,
    },
  ],
};

/**
 * What choosing this format would cost THIS stream, counted.
 *
 * @param format the target the reader is hovering
 * @param facts  {@link streamFacts} for the stream about to be written
 * @return one entry per real loss, in reading order; empty when nothing is lost
 */
export function formatLosses(format: JsonlFormat, facts: StreamFacts): Loss[] {
  return LOSSES[format]
    .map((entry) => ({ entry, count: entry.of(facts) }))
    .filter(({ count }) => count > 0)
    .map(({ entry, count }) => ({
      code: entry.code,
      count,
      en: entry.en(count),
      de: entry.de(count),
    }));
}

// ---- what may be offered ----------------------------------------------------

/**
 * The views this tab can put in a file, its own first.
 *
 * Every view in this app is a fold over the same RunEvent[], so a chat export
 * can carry the text feed and a text export the chat — the owner's ask costs
 * nothing but the choosing. Order matters: the tab you pressed the button in
 * leads, because that is the document you think you are saving.
 */
export function offeredViews(kind: ExportKind): readonly ViewId[] {
  return kind === "chat" ? (["chat", "text", "json"] as const) : (["text", "chat", "json"] as const);
}

export interface SwitcherInput {
  /** The recorded stream. Null when the caller only holds the translated one. */
  original: readonly RunEvent[] | null;
  translated: readonly RunEvent[] | null;
  /** Units that came back whole. */
  landed: number;
  /** Units that stayed in the source language. */
  failed: number;
}

export interface SwitcherOffer {
  offered: boolean;
  /** Units still in the original language, or 0. A switcher implying a complete
   *  translation over a partial one is the same lie as a missing note. */
  partial: number;
}

/**
 * Whether a two-language file can honestly be offered.
 *
 * Withheld unless BOTH sides are in hand and something was actually translated.
 * The text tab is handed the already-translated stream and cannot recover the
 * original, so it gets no switcher rather than one that flips between two
 * identical documents.
 */
export function switcherOffer(input: SwitcherInput): SwitcherOffer {
  const offered = input.original !== null && input.translated !== null && input.landed > 0;
  return { offered, partial: offered ? input.failed : 0 };
}

/**
 * Whether printing this request would silently drop content.
 *
 * A closed <details> does not print. Picking "save as PDF" with tool cards
 * collapsed produces a PDF with every command and every result missing, and
 * nothing on the page says so — which is exactly the after-the-fact discovery
 * this module exists to prevent. The dialog uses this to force the expansion
 * before it hands the document to the print sheet.
 */
export function printWouldHide(request: ExportRequest): boolean {
  return request.reasoning === "collapsed" || request.tools === "collapsed";
}
