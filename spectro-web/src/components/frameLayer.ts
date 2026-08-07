// Which wire one trace row actually rode.
//
// Three layers, and the whole point of naming them is that the trace used to
// print one layer's facts on another layer's rows (card 184, owner 2026-08-07).
// In a one-turn session nine rows carried `SSE` and `api.anthropic.com` while
// riding nothing but the WebSocket from localhost, and the single row that WAS
// an HTTPS call to api.anthropic.com carried a dot and two dashes.
//
//   app   — browser <-> server. The WebSocket, and what the session JSONL holds.
//           A `text_delta` is our frame about the model's output; it is not the
//           model's output arriving. It never left this machine.
//   llm   — server <-> model provider. The recorded exchange, and only that.
//   tool  — the frame rode the app wire, but the WORK it announces ran
//           somewhere else: an MCP server over JSON-RPC, a fetch over HTTP, or
//           a local file. Its own layer, so the columns can name the tool's
//           counterpart without the row claiming that is where the FRAME went.
//
// `llmDirection` (eventSummary.tsx) stays exactly what it always was, a reading
// of which frames belong to the request handed to the model, and it stays the
// filter. What it stops being is a network fact printed beside two real ones.

export type FrameLayer = "app" | "llm" | "tool";

const LLM_TYPES: ReadonlySet<string> = new Set(["llm_exchange", "llm_request", "llm_response"]);
const TOOL_TYPES: ReadonlySet<string> = new Set(["tool_call", "tool_result", "image_generated"]);

/**
 * @param type the frame's type
 * @return the wire this row rode; an unknown type is `app`, because a frame
 *         this build has never heard of arrived over the socket like every
 *         other one, and guessing it left the machine would be the invention
 *         this whole card exists to remove
 */
export function frameLayer(type: string): FrameLayer {
  if (LLM_TYPES.has(type)) return "llm";
  if (TOOL_TYPES.has(type)) return "tool";
  return "app";
}
