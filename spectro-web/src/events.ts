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
  | {
      type: "run_start";
      runId: string;
      agentId: string;
      parentId?: string;
      prompt: string;
      provider?: string;
      model?: string; // additive (card 87)
      /** What woke a triggered node's run (additive, card 72), e.g.
       *  "fs #4 watch:/drop". Absent on every run that nothing triggered, which
       *  is the normal case — an absent trigger is a plain run, NOT an old
       *  server. The field has been on the wire since card 72
       *  (RunEvent.java:65-66); this line is the browser finally reading it. */
      trigger?: string;
      attachments?: AttachmentRef[];
      ts: number;
    } // provider?, model?, attachments? all additive
  | { type: "turn_start"; agentId: string; turn: number; ts: number }
  | { type: "text_delta"; agentId: string; text: string; ts: number }
  | { type: "thinking_delta"; agentId: string; text: string; ts: number } // reasoning stream, additive
  | { type: "tool_call"; agentId: string; callId: string; name: string; input: unknown; ts: number }
  | { type: "permission_request"; agentId: string; callId: string; name: string; input: unknown; ts: number }
  | { type: "permission_decision"; callId: string; allowed: boolean; ts: number }
  | {
      type: "tool_result";
      agentId: string;
      callId: string;
      output: string;
      isError: boolean;
      durationMs: number;
      ts: number;
    }
  | { type: "agent_spawn"; agentId: string; parentId: string; task: string; ts: number }
  | { type: "compaction"; agentId: string; removedTurns: number; summaryChars: number; ts: number } // additive
  // Card 184 leg 3: one finished backend-to-model exchange, as the SESSION's own
  // record of it. It was a socket-only frame until the sealed union grew a type
  // for it, which is why a reopened session used to lose the fact that a model
  // had been called at all. Metadata only — the bodies stay in the sidecar and
  // the gated endpoint serves them on the gesture that asks.
  | {
      type: "llm_exchange";
      /** The sidecar's own id: what joins this line to the two lines over there. */
      xid: string;
      agentId: string;
      /** Absent where no turn exists (stt happens before any session). */
      turn?: number;
      /** What the call was for: chat | compaction | image | stt. */
      kind: string;
      provider: string;
      model: string;
      /** Who owned the socket: http | sdk | websocket | process. */
      transport: string;
      url: string;
      /** Null when nothing ever answered — a zero would be a claim. */
      status?: number;
      requestBytes: number;
      responseBytes: number;
      responseLines: number;
      aborted: boolean;
      fidelity: string;
      durationMs: number;
      ts: number;
    }
  | {
      type: "usage";
      agentId: string;
      inputTokens: number;
      outputTokens: number;
      /** Additive (Anthropic prompt caching): absent when the provider reported none.
       *  inputTokens stays the RAW uncached remainder — the true context size is the sum. */
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      ts: number;
    }
  | { type: "run_end"; runId: string; stopReason: string; ts: number }
  | { type: "error"; agentId?: string; message: string; ts: number }
  | {
      type: "image_generated";
      agentId: string;
      callId: string;
      prompt: string;
      provider: string;
      model: string;
      mediaType: string;
      blobPath: string;
      sha256: string;
      ts: number;
    } // additive
  | {
      type: "context_info";
      agentId: string;
      turn: number;
      messages: number;
      estimatedTokens: number;
      threshold: number;
      parts: { label: string; chars: number; estTokens: number; text?: string }[];
      ts: number;
    } // additive: context introspection
  | {
      type: "agent_message";
      from: string;
      to: string;
      role: string;
      state: string;
      text: string;
      label?: string;
      ts: number;
    } // A2A-lite, additive: task/status/result between agents
  | { type: "plan"; agentId: string; steps: { text: string; status: string }[]; ts: number }; // additive: the main agent's TODO list, latest-wins

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
  | { type: "set_reasoning"; mode: "on" | "off" | "default"; effort?: string } // picker reasoning control (card 88)
  | { type: "set_provider"; provider: string; model?: string } // switch the LLM backend mid-session
  | { type: "set_workspace"; mode?: "random" | "default" | "set"; path?: string } // pin THIS session's workspace by mode (before the first run)
  | { type: "set_permission_mode"; mode: string }; // switch ask/auto/readonly mid-session (composer gear)

// GET /api/sessions — the sidebar list (REST contract, design/BUILD-PLAN.md).
export interface SessionMeta {
  id: string;
  startedAt: number;
  firstPrompt: string;
  tokens: number;
  /** distinct agents that ran (main + subagents); absent from pre-0.2.x servers. */
  agentCount?: number;
  /** top-level (main-agent) turns — the steppable conversation. */
  turnCount?: number;
  /** The LLM backend label the store recorded; "-" is its own "none recorded". */
  provider?: string;
  /** The model the session opened with; absent on files recorded before card 87. */
  model?: string;
  /** How the LAST main run stopped, verbatim from its run_end ("end_turn",
   *  "error", "aborted", "max_turns", "max_tokens"). Absent or null means no
   *  run_end closed it. Every field below is additive: a server from before
   *  this card simply omits them, and the row degrades to what it showed then. */
  stopReason?: string | null;
  /** Tool calls that stopped at the permission gate. */
  gateCount?: number;
  /** How many of those the operator refused. */
  denyCount?: number;
  /** The last event's timestamp — the span the session covers. */
  endedAt?: number;
}
