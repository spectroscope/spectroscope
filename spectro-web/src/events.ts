// The wire contract of the harness. The RunEvent union is copied VERBATIM from
// concept/CONCEPT.md §4 — it is shared with the TypeScript edition and with the
// JSONL files on disk (camelCase fields, snake_case type values). Never invent
// fields here; extend only additively, and let the reducer ignore unknown types.

// attachment REFERENCE — the bytes live in the blob store next to the
// session file, never in the event (JSONL-FORMAT.md §7).
export interface AttachmentRef {
  kind: string;
  mediaType: string;
  blobPath: string;
  sha256: string;
}

export type RunEvent =
  | { type: "run_start";           runId: string; agentId: string; parentId?: string; prompt: string; provider?: string; attachments?: AttachmentRef[]; ts: number } // provider?, attachments? both additive
  | { type: "turn_start";          agentId: string; turn: number; ts: number }
  | { type: "text_delta";          agentId: string; text: string; ts: number }
  | { type: "thinking_delta";      agentId: string; text: string; ts: number } // reasoning stream, additive
  | { type: "tool_call";           agentId: string; callId: string; name: string; input: unknown; ts: number }
  | { type: "permission_request";  agentId: string; callId: string; name: string; input: unknown; ts: number }
  | { type: "permission_decision"; callId: string; allowed: boolean; ts: number }
  | { type: "tool_result";         agentId: string; callId: string; output: string; isError: boolean; durationMs: number; ts: number }
  | { type: "agent_spawn";         agentId: string; parentId: string; task: string; ts: number }
  | { type: "compaction";          agentId: string; removedTurns: number; summaryChars: number; ts: number } // additive
  | { type: "usage";               agentId: string; inputTokens: number; outputTokens: number;
      /** Additive (Anthropic prompt caching): absent when the provider reported none.
       *  inputTokens stays the RAW uncached remainder — the true context size is the sum. */
      cacheReadTokens?: number; cacheCreationTokens?: number; ts: number }
  | { type: "run_end";             runId: string; stopReason: string; ts: number }
  | { type: "error";               agentId?: string; message: string; ts: number }
  | { type: "image_generated";     agentId: string; callId: string; prompt: string; provider: string; model: string; mediaType: string; blobPath: string; sha256: string; ts: number } // additive
  | { type: "context_info";        agentId: string; turn: number; messages: number; estimatedTokens: number; threshold: number; parts: { label: string; chars: number; estTokens: number }[]; ts: number } // additive: context introspection
  | { type: "agent_message";       from: string; to: string; role: string; state: string; text: string; label?: string; ts: number } // A2A-lite, additive: task/status/result between agents
  | { type: "plan";                agentId: string; steps: { text: string; status: string }[]; ts: number }; // additive: the main agent's TODO list, latest-wins

// Client -> server frames (socket protocol, design/BUILD-PLAN.md). The server
// sends nothing but RunEvent JSON in the other direction. user_message
// may carry attachments — HERE the frame still holds the bytes (base64); the
// server stores the blobs and passes only references into the core.
export type ClientMessage =
  | { type: "user_message"; text: string; attachments?: { mediaType: string; dataBase64: string }[] }
  | { type: "permission_response"; callId: string; allowed: boolean; remember?: boolean; persist?: boolean }
  | { type: "abort" }
  | { type: "set_image_provider"; provider: string } // image generation backend
  | { type: "set_thinking"; enabled: boolean } // reasoning visibility toggle
  | { type: "set_provider"; provider: string; model?: string } // switch the LLM backend mid-session
  | { type: "set_workspace"; path: string } // pin THIS session's workspace (before the first run)
  | { type: "set_permission_mode"; mode: string }; // switch ask/auto/readonly mid-session (composer gear)

// GET /api/sessions — the sidebar list (REST contract, design/BUILD-PLAN.md).
export interface SessionMeta {
  id: string;
  startedAt: number;
  firstPrompt: string;
  tokens: number;
}
