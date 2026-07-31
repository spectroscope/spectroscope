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

/** A section an exported document can carry. `json` is the TEXT TAB's json
 *  view, not the .jsonl download — see JSON_VIEW_CAVEAT. */
export type ViewId = "chat" | "text" | "json";

/** Whether reasoning and tool cards arrive folded or unfolded in the file. */
export type DisclosureChoice = "open" | "collapsed";

export type JsonlFormat = "spectroscope" | "claude-code" | "vscode";

export const JSONL_FORMATS: readonly JsonlFormat[] = ["spectroscope", "claude-code", "vscode"];

/** The two artifacts this app calls "json" are not the same bytes: the text
 *  tab's view filters socket-only frames, the .jsonl download writes every
 *  event verbatim. Naming both "json" without saying so is a trap, so the
 *  section header says which one the reader is looking at. */
export const JSON_VIEW_CAVEAT: Record<"en" | "de", string> = {
  en: "json view (as the text tab shows it — socket-only frames omitted)",
  de: "JSON-Ansicht (wie im Text-Tab — reine Socket-Frames fehlen)",
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
  };
  for (const event of events) {
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
  // The app's own wire format, byte-identical on the round trip. Nothing to say.
  spectroscope: [],
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
