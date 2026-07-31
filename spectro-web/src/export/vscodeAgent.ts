// Writing a spectroscope stream OUT as a VS Code / Copilot agent-mode export.
//
// The inverse of src/import/vscodeAgent.ts, tested by round trip against it.
//
// This is the LOSSY target, and the losses are structural, not bugs here:
//
//   tool output   the format's `tool.execution_complete` carries nothing but
//                 { toolCallId, success }. There is no field for the result, so
//                 a read_file that returned a whole file arrives as "it worked".
//   subagents     one lane, no spawn record. A subagent's prose is folded into
//                 the main lane so the words survive; the attribution does not.
//   token counts  no usage record anywhere in that shape.
//
// All three are counted off the real stream and printed next to the choice
// (options.ts). Writing them into some improvised field would be worse than
// dropping them: a reader importing the file elsewhere would get a shape that
// tool does not understand, and the round-trip test would go green on a lie.

import type { RunEvent } from "../events";

interface Record_ {
  type: string;
  id: string;
  timestamp: string;
  data: Record<string, unknown>;
}

const iso = (ts: number): string => new Date(ts).toISOString();

/**
 * The stream as a VS Code agent-mode export.
 *
 * @param events the stream to write, in wire order
 * @return one JSON record per line, terminated; "" for an empty stream
 */
export function toVscodeAgentJsonl(events: readonly RunEvent[]): string {
  if (events.length === 0) return "";

  const records: Record_[] = [];
  let seq = 0;
  const id = (): string => `spectro-${++seq}`;
  const push = (type: string, ts: number, data: Record<string, unknown>): void => {
    records.push({ type, id: id(), timestamp: iso(ts), data });
  };

  let turn = 0;
  let opened = false;
  /** Reasoning and prose for the message being assembled. The format puts both
   *  on ONE assistant.message record, so they are held until something closes
   *  it — a tool call, a turn boundary, or the end. */
  let reasoning = "";
  let content = "";
  let messageTs = events[0].ts;

  const flush = (): void => {
    if (reasoning === "" && content === "") return;
    push("assistant.message", messageTs, {
      messageId: id(),
      ...(reasoning !== "" ? { reasoningText: reasoning } : {}),
      ...(content !== "" ? { content } : {}),
      toolRequests: [],
    });
    reasoning = "";
    content = "";
  };

  const collect = (field: "reasoning" | "content", text: string, ts: number): void => {
    if (reasoning === "" && content === "") messageTs = ts;
    if (field === "reasoning") reasoning += text;
    else content += text;
  };

  for (const event of events) {
    switch (event.type) {
      case "run_start":
        // A child's run_start would open a second user turn for work the user
        // never asked for; only the root run is a user message here.
        if (event.parentId !== undefined && event.parentId !== null) break;
        flush();
        push("user.message", event.ts, { content: event.prompt });
        opened = true;
        break;

      case "turn_start":
        if (!opened) break;
        flush();
        push("assistant.turn_start", event.ts, { turnId: String(++turn) });
        break;

      // Subagent prose is folded into the one lane this format has. The words
      // survive, the lane does not, and the dialog says so before the save.
      case "thinking_delta":
        if (event.text !== "") collect("reasoning", event.text, event.ts);
        break;

      case "text_delta":
        if (event.text !== "") collect("content", event.text, event.ts);
        break;

      case "tool_call":
        flush();
        push("tool.execution_start", event.ts, {
          toolCallId: event.callId,
          toolName: event.name,
          arguments: event.input,
        });
        break;

      case "tool_result":
        // `success` is the whole vocabulary the format has for a result.
        push("tool.execution_complete", event.ts, {
          toolCallId: event.callId,
          success: !event.isError,
        });
        break;

      default:
        break;
    }
  }
  flush();

  return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}
