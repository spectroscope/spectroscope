// The structured face of ONE event, for the trace's expanded row and the lab's
// JSONL strip. Where toolViews.ts names the shape of a tool call, this names
// the shape of a frame: a call is its tool card, an answer is markdown, a usage
// frame is its numbers, a plan is its steps. Pure and DOM-free — the pixels
// live in the views, so the mapping stays unit-tested.
//
// Two honesty rules hold the whole module up:
//   1. Nothing is dropped. Every field a payload carries lands in some section;
//      what has no shape of its own falls through to rows/json rather than
//      disappearing behind a prettier rendering.
//   2. Nothing is invented. A tool_result only becomes a tool card when its
//      tool_call is actually in the stream; otherwise it stays its own output.
//      The raw face remains the evidence either way.

import { imageUrl } from "../lab/flowmap/imageUrl";
import { readTodoItems, type TodoItem } from "./todoList";

/** A key/value pair of a frame, in wire names — this is the wire view. */
export interface DetailRow {
  key: string;
  value: string;
}

/** One entry of a listed field (a plan step, a context part, a tool name). */
export interface DetailItem {
  text: string;
  note?: string;
}

/** One region of the structured face. `field` names the payload field(s) it
 *  renders, so the label needs no translation and cannot drift from the wire. */
export type DetailSection =
  | { kind: "tool"; field: string; name: string; input: unknown; output?: string; isError: boolean }
  | { kind: "prose"; field: string; text: string; markdown: boolean }
  | { kind: "rows"; field: string; rows: DetailRow[] }
  | { kind: "list"; field: string; items: DetailItem[]; more: number }
  /** A todo list with a status on every item (card 141). Its own shape rather
   *  than a `list` with the status as a note: the status is what the eye looks
   *  for, and it is the one field that gets a mark of its own. */
  | { kind: "todo"; field: string; items: TodoItem[]; more: number }
  | { kind: "image"; field: string; src: string; alt: string; path: string }
  | { kind: "json"; field: string; value: unknown };

/** A call as the result of it needs to be understood: name plus input. */
export interface ToolCallRef {
  name: string;
  input: unknown;
}

/** A string this long, or one carrying a newline, gets its own block instead
 *  of a row — a row is for values the eye takes in at a glance. */
const PROSE_MIN_CHARS = 120;
/** Longest list rendered in full; the rest is counted, never silently cut. */
const LIST_MAX_ITEMS = 200;

function asRecord(payload: unknown): Record<string, unknown> | null {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

function str(p: Record<string, unknown>, key: string): string | null {
  return typeof p[key] === "string" ? (p[key] as string) : null;
}

/** Cap a list at LIST_MAX_ITEMS and report what stayed behind. */
function capped(field: string, items: DetailItem[]): DetailSection {
  return {
    kind: "list",
    field,
    items: items.slice(0, LIST_MAX_ITEMS),
    more: Math.max(0, items.length - LIST_MAX_ITEMS),
  };
}

/**
 * Index every tool call in a stream by its callId, so a later `tool_result`
 * can be rendered as the call it answers.
 *
 * @param payloads the frames to walk (RunEvents, or trace payloads)
 * @return callId → the first call seen under it
 */
export function toolCallsById(payloads: Iterable<unknown>): Map<string, ToolCallRef> {
  const calls = new Map<string, ToolCallRef>();
  for (const payload of payloads) {
    const p = asRecord(payload);
    if (p === null) continue;
    const type = str(p, "type");
    if (type !== "tool_call" && type !== "permission_request") continue;
    const callId = str(p, "callId");
    const name = str(p, "name");
    // First wins: a callId is answered once, and a later frame reusing the id
    // must not rewrite what the earlier result was about.
    if (callId !== null && name !== null && !calls.has(callId))
      calls.set(callId, { name, input: p["input"] });
  }
  return calls;
}

/** The fields already rendered by a named section — the ledger that makes
 *  "nothing is dropped" checkable instead of hopeful. */
type Used = Set<string>;

/** Every remaining field, in payload order: scalars as one block of rows, long
 *  text as prose, string arrays as lists, anything else as json. */
function genericSections(p: Record<string, unknown>, used: Used): DetailSection[] {
  const rows: DetailRow[] = [];
  const blocks: DetailSection[] = [];
  for (const [key, value] of Object.entries(p)) {
    if (used.has(key) || value === undefined) continue;
    if (typeof value === "string") {
      if (value.includes("\n") || value.length > PROSE_MIN_CHARS) {
        blocks.push({ kind: "prose", field: key, text: value, markdown: false });
      } else {
        rows.push({ key, value });
      }
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      rows.push({ key, value: String(value) });
    } else if (Array.isArray(value)) {
      if (value.length === 0) rows.push({ key, value: "[]" });
      else if (value.every((v) => typeof v === "string")) {
        blocks.push(
          capped(
            key,
            (value as string[]).map((text) => ({ text })),
          ),
        );
      } else blocks.push({ kind: "json", field: key, value });
    } else {
      blocks.push({ kind: "json", field: key, value });
    }
  }
  return rows.length > 0 ? [{ kind: "rows", field: "", rows }, ...blocks] : blocks;
}

/** The re-uploaded history as a census of its event types, first seen first. */
function historyCensus(history: unknown[]): DetailItem[] {
  const counts = new Map<string, number>();
  for (const event of history) {
    const p = asRecord(event);
    const type = p === null ? null : str(p, "type");
    const key = type ?? "?";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([text, n]) => ({ text, note: `${n}×` }));
}

/**
 * Describe one frame as the sections that render it.
 *
 * @param type    the frame's type (the trace row's type column)
 * @param payload the frame's payload, whatever crossed the socket
 * @param calls   the stream's calls by callId, so a result finds its call
 * @return the sections, in reading order; empty when the payload holds nothing
 *         beyond the columns the row already shows
 */
export function describeEvent(
  type: string,
  payload: unknown,
  calls?: ReadonlyMap<string, ToolCallRef>,
): DetailSection[] {
  const p = asRecord(payload);
  if (p === null) return [{ kind: "json", field: "", value: payload }];

  // The row that opened this detail already carries the type and the clock —
  // repeating them here would be noise, not evidence.
  const used: Used = new Set(["type", "ts"]);
  const named: DetailSection[] = [];
  const prose = (field: string, markdown: boolean): void => {
    const text = str(p, field);
    if (text === null) return;
    used.add(field);
    named.push({ kind: "prose", field, text, markdown });
  };

  switch (type) {
    case "tool_call":
    case "permission_request": {
      const name = str(p, "name");
      if (name !== null) {
        used.add("name");
        used.add("input");
        named.push({ kind: "tool", field: "", name, input: p["input"], isError: false });
      }
      break;
    }

    case "tool_result": {
      const callId = str(p, "callId");
      const call = callId === null ? undefined : calls?.get(callId);
      const output = str(p, "output") ?? "";
      // isError is deliberately NOT consumed either way: the card only shows a
      // failure where the shape has somewhere to show it (a terminal), so the
      // flag stays a row of its own. A failed result must read as failed.
      if (call !== undefined) {
        used.add("output");
        named.push({
          kind: "tool",
          field: "",
          name: call.name,
          input: call.input,
          output,
          isError: p["isError"] === true,
        });
      } else {
        // No call in the stream: the result is all we have, so that is all we
        // show.
        used.add("output");
        named.push({ kind: "prose", field: "output", text: output, markdown: false });
      }
      break;
    }

    case "run_start":
      prose("prompt", true);
      break;

    case "text_delta":
    case "thinking_delta":
    case "agent_message":
    case "user_message":
      prose("text", true);
      break;

    case "agent_spawn":
      prose("task", true);
      break;

    case "error":
      prose("message", false);
      break;

    case "system_context":
      prose("systemPrompt", true);
      break;

    case "image_generated": {
      const path = str(p, "blobPath");
      if (path !== null) {
        used.add("blobPath");
        named.push({
          kind: "image",
          field: "blobPath",
          src: imageUrl(path),
          alt: str(p, "prompt") ?? "",
          path,
        });
      }
      break;
    }

    case "context_info": {
      const parts = p["parts"];
      if (Array.isArray(parts)) {
        used.add("parts");
        named.push(
          capped(
            "parts",
            parts.map((part) => {
              const q = asRecord(part);
              const chars = q === null ? null : q["chars"];
              const est = q === null ? null : q["estTokens"];
              const note = [
                typeof chars === "number" ? `${chars} chars` : null,
                typeof est === "number" ? `~${est} tokens` : null,
              ]
                .filter((s) => s !== null)
                .join(" · ");
              return {
                text: (q === null ? null : str(q, "label")) ?? "?",
                note: note === "" ? undefined : note,
              };
            }),
          ),
        );
      }
      break;
    }

    case "plan": {
      const steps = p["steps"];
      if (Array.isArray(steps)) {
        used.add("steps");
        named.push(
          capped(
            "steps",
            steps.map((step) => {
              const q = asRecord(step);
              const status = q === null ? null : str(q, "status");
              return { text: (q === null ? null : str(q, "text")) ?? "?", note: status ?? undefined };
            }),
          ),
        );
      }
      break;
    }

    case "task_reminder": {
      // The todo list an imported transcript recorded (card 141). Read whole
      // or not at all: readTodoItems returns null for a list with an item it
      // cannot draw, and then `items` stays unused and falls through to the
      // raw json below, where nothing is hidden.
      const items = readTodoItems(p["items"]);
      if (items !== null) {
        used.add("items");
        named.push({
          kind: "todo",
          field: "items",
          items: items.slice(0, LIST_MAX_ITEMS),
          more: Math.max(0, items.length - LIST_MAX_ITEMS),
        });
      }
      break;
    }

    case "session_resume": {
      const history = p["history"];
      if (Array.isArray(history)) {
        used.add("history");
        named.push(capped("history", historyCensus(history)));
      }
      break;
    }
  }

  return [...named, ...genericSections(p, used)];
}
