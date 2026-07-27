// Translation at the level of the event stream (owner 2026-07-27: "mache das
// übersetzungsfeature auf jsonl text ebene ... einmal sinnvoll übersetzen im
// hintergrund und dann überall nutzen").
//
// Every view in this app is a fold over one RunEvent[] — chat, trace, the text
// feed, the graph, the spectrum, the lab. So a translation that produces a NEW
// RunEvent[] is inherited by all of them at once, and by the exported JSONL too.
// This file is that translation, and nothing else: extract the translatable
// text of a stream, and put a translation back into a copy of it.
//
// WHAT IS TRANSLATABLE, field by field, verified against events.ts and against
// a real recorded transcript. The rule is the owner's: "nur text" — what a
// human wrote or read, never what a machine was told or what it answered with.
//
//   run_start.prompt      IN   what the human asked. A child's prompt is in
//                              too: it is what the parent asked of it.
//   text_delta.text       IN   the answer, grouped (see below).
//   agent_message.text    IN   a subagent's task and its report — prose.
//   thinking_delta.text   IN, opt-in. It is prose and a reader of a foreign
//                              session cannot read it either, but it is
//                              routinely several times the size of the answer
//                              and the least load-bearing text in the file. So
//                              extract leaves it out unless asked, while apply
//                              always accepts it: bounding the wire is a
//                              decision for the caller, dropping a translation
//                              that already came back is just loss.
//   tool_call.input       OUT  commands, paths, globs, flags. Translating one
//                              produces something that still reads like a
//                              command and is not one.
//   tool_result.output    OUT  evidence. What a tool returned is a measurement,
//                              not a sentence.
//   error.message         OUT  usually a literal from a program or a stack.
//   image_generated.prompt OUT the exact string an image model was handed —
//                              same class as tool input.
//   context_info.parts[].text OUT the assembled request: system prompt and
//                              tool schemas. Machine text.
//   agent_spawn.task      OUT  prose, and arguably a miss — but it is the same
//   plan.steps[].text     OUT  sentence agent_message already carries, and the
//                              plan is a checklist the UI reads structurally.
//                              Both are additive to this table if the owner
//                              wants them; nothing else in the file changes.
//
// THE ID. A unit id is `<eventIndex>:<field>` — an address into the array it
// was extracted from. Not a hash of the text: two agents saying "done" are two
// units, and a hash would collapse them. Indices survive the only mutation
// this app performs on a stream (appending at the end), which is what lets a
// translation started mid-run still land. Applying to a DIFFERENT array is the
// caller's error, and it degrades honestly: an id that addresses nothing is
// ignored and that field keeps its original text.
//
// NOTHING HERE MUTATES. applyUnits returns a new array whose untouched events
// are the SAME objects, so a React tree re-renders only the rows that changed.
//
// MEASURED, on two real sessions rather than a fixture. A live spectroscope
// run of 1575 events carries 747 text_delta events that fold into 2 answer
// units — 373 fragments per unit. Translating those fragments one by one is
// 747 calls that each see a few characters of a sentence, which is why the
// grouping below is the load-bearing decision in this file. An IMPORTED Claude
// Code transcript never shows it: its adapter emits one delta per content
// block, with a turn boundary either side, so its 154 deltas are already 154
// separate answers and group with themselves. Both shapes have to work.
//
// A unit is semantic, not a wire packet. That same 3568-event transcript
// yields 157 units / 150 512 chars, with a longest single unit of 33 628 —
// far past the server's 4 000-per-passage and 60 000-per-request bounds.
// Cutting units into passages that fit, and joining the answers back, is the
// layer ABOVE this one; nothing here knows what a request looks like.

import type { RunEvent } from "../events";

/** What kind of text a unit holds — a label for the UI, not a wire field. */
export type UnitKind = "prompt" | "answer" | "thinking" | "message";

/** One translatable field of one stream, addressed by id. */
export interface Unit {
  /** `<eventIndex>:<field>`, unique within the stream it came from. */
  id: string;
  kind: UnitKind;
  /** The text exactly as recorded — a stream's deltas already joined. */
  text: string;
}

export interface ExtractOptions {
  /** Carry the reasoning stream as well. Off by default, see the table above. */
  thinking?: boolean;
}

/**
 * The translatable text of a stream, in wire order.
 *
 * @param events  the stream to read; never mutated
 * @param options `thinking: true` to carry the reasoning stream too
 * @return one unit per translatable field, blank fields left out
 */
export function extractUnits(events: readonly RunEvent[], options: ExtractOptions = {}): Unit[] {
  const wantThinking = options.thinking === true;
  return scan(events)
    .filter((span) => (span.kind === "thinking" ? wantThinking : true))
    .filter((span) => span.text.trim() !== "")
    .map((span) => ({ id: span.id, kind: span.kind, text: span.text }));
}

/**
 * The same stream with the translations put back in.
 *
 * Total by construction: the result has the same length and the same order as
 * the input, an id nobody translated leaves its field exactly as it was, and an
 * id that addresses nothing is ignored. Events that did not change are the same
 * objects, so `applyUnits(events, new Map())` deep-equals its input.
 *
 * @param events       the stream to read; never mutated
 * @param translations unit id -> translated text
 * @return a new array of the same length, in the same order
 */
export function applyUnits(
  events: readonly RunEvent[],
  translations: ReadonlyMap<string, string>,
): RunEvent[] {
  const replaced = new Map<number, RunEvent>();

  for (const span of scan(events)) {
    const translated = translations.get(span.id);
    // A model that answered with nothing must not erase what it was given.
    if (translated === undefined || translated.trim() === "") continue;

    if (span.field === "prompt") {
      const event = events[span.indices[0]] as Extract<RunEvent, { type: "run_start" }>;
      // A passage that came back unchanged (already in the target language) is
      // not a change: keep the object so the views keep their identity checks.
      if (event.prompt !== translated) replaced.set(span.indices[0], { ...event, prompt: translated });
      continue;
    }
    // A delta run: the whole translation goes into the FIRST event of the run
    // and the rest are blanked. Every view concatenates a run, so the joined
    // text is exactly the translation; the head keeps the timestamp the answer
    // started at, which is the one the trace and the timeline place it by. The
    // blanked events STAY: an event index is an address in this app (the
    // `#/session/{id}@{n}` receipts of card 81 among others), and dropping
    // them would move every index behind them. Splitting the translation back
    // across the fragments was the alternative and it is worse: the fragment
    // boundaries are an artifact of the network, and cutting a translated
    // sentence at one of them mangles a word for no gain.
    span.indices.forEach((index, position) => {
      const event = events[index];
      const text = position === 0 ? translated : "";
      if (!hasText(event) || event.text === text) return; // unchanged: keep the object identity
      replaced.set(index, rewriteText(event, text));
    });
  }

  return events.map((event, index) => replaced.get(index) ?? event);
}

/** The events carrying a `text` field a unit may address. */
type TextEvent = Extract<RunEvent, { text: string }>;

function hasText(event: RunEvent): event is TextEvent {
  return event.type === "text_delta" || event.type === "thinking_delta" || event.type === "agent_message";
}

/** Rewrite per concrete type: one union-wide spread would widen the result. */
function rewriteText(event: TextEvent, text: string): RunEvent {
  switch (event.type) {
    case "text_delta":
      return { ...event, text };
    case "thinking_delta":
      return { ...event, text };
    default:
      return { ...event, text };
  }
}

/** A unit under construction: which events it covers and which field it is. */
interface Span {
  id: string;
  kind: UnitKind;
  field: "prompt" | "text";
  /** Event indices in order — one for a scalar field, many for a delta run. */
  indices: number[];
  text: string;
}

/**
 * Every translatable field of the stream, blank ones included.
 *
 * This is the one place that decides what a unit is, so extract and apply can
 * never disagree about an id: apply re-derives the same spans from the same
 * array. Extract then filters (blanks, opt-in reasoning); apply does not,
 * because refusing to place a translation that already came back would lose it.
 */
function scan(events: readonly RunEvent[]): Span[] {
  const spans: Span[] = [];
  /** The delta run currently open per agent — what a further delta extends. */
  const open = new Map<string, Span>();

  events.forEach((event, index) => {
    switch (event.type) {
      case "text_delta":
      case "thinking_delta": {
        const kind: UnitKind = event.type === "text_delta" ? "answer" : "thinking";
        const current = open.get(event.agentId);
        // Same agent, same channel, nothing of that agent's in between: one
        // sentence arriving in fragments. Ten fragments translated on their
        // own produce ten pieces of nonsense.
        if (current !== undefined && current.kind === kind) {
          current.indices.push(index);
          current.text += event.text;
          return;
        }
        const span: Span = {
          id: `${index}:text`,
          kind,
          field: "text",
          indices: [index],
          text: event.text,
        };
        open.set(event.agentId, span);
        spans.push(span);
        return;
      }
      case "run_start":
        open.delete(event.agentId);
        spans.push({
          id: `${index}:prompt`,
          kind: "prompt",
          field: "prompt",
          indices: [index],
          text: event.prompt,
        });
        return;
      case "agent_message":
        open.delete(event.from);
        spans.push({
          id: `${index}:text`,
          kind: "message",
          field: "text",
          indices: [index],
          text: event.text,
        });
        return;
      case "run_end":
        // The end of the run ends every stream in it, including a child's.
        open.clear();
        return;
      case "error":
        open.delete(event.agentId ?? "main");
        return;
      case "permission_decision":
        // Carries no agent, and the tool_call it answers already closed the run.
        return;
      default: {
        // Anything else this agent did ends its stream: a turn boundary, a tool
        // call, its own usage line. An agent that keeps streaming through
        // ANOTHER agent's event keeps its run — a merged fleet stream
        // interleaves, and splitting on that would cut mid-sentence.
        const agentId = (event as { agentId?: string }).agentId;
        if (typeof agentId === "string") open.delete(agentId);
        return;
      }
    }
  });

  return spans;
}
