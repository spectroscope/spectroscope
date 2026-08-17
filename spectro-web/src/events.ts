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
      /** What a mutating file tool DID (card 269, additive): "created",
       *  "changed" or "unchanged". Absent for every tool that touched no file
       *  and on every session recorded before the field — and absent is NOT a
       *  synonym for "unchanged", it is the absence of any claim. */
      fileChange?: string;
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
  | { type: "plan"; agentId: string; steps: { text: string; status: string }[]; ts: number } // additive: the main agent's TODO list, latest-wins
  // Card 204: one browser tool call happened. The browser twin of llm_exchange
  // and for the same reason — the trace itself is a sidecar beside the session
  // (~/.spectro/browser-wire/<id>.browser.jsonl), but a session file that said
  // nothing at all could not even tell a reader that a browser had been driven.
  // Metadata only. No bytes ride here, ever: a screenshot is a blob in the store
  // and a hash on this line.
  | {
      type: "browser_action";
      agentId: string;
      /** The provider's tool_use id; absent where no turn produced one. */
      callId?: string;
      /** The sidecar's own id: what joins this line to the two lines over there. */
      cid: string;
      /** Which browser of this session's life it drove. 1-based; 0 when nothing
       *  was recording. Card 218 retires a browser when its session closes, so a
       *  resumed session's second browser is a second epoch and never a
       *  continuation of the first. */
      epoch: number;
      /** The wire name: browser_navigate, browser_eval, browser_computer, … */
      tool: string;
      /** The address it happened on; absent when no page was open. A
       *  credential-shaped address arrives as "[redacted: <rule>]". */
      url?: string;
      ok: boolean;
      resultBytes: number;
      durationMs: number;
      /** The screenshot blob's hash — the same key the image_generated event
       *  carries. Absent for a call that took no picture. */
      sha256?: string;
      ts: number;
    } // additive
  // Card 195: a configured shell hook did something worth a line. Two verdicts
  // ride here and only two — a hook that agreed emits nothing, because one line
  // per passing hook per tool call would bury the two that matter.
  //
  // It exists because neither outcome was visible before it. A block reached the
  // world only as the `ERROR: blocked by pre_tool_use hook: …` string inside a
  // tool_result, which carries a reason and names no hook; a TIMEOUT reached it
  // as nothing at all, because the runner fails open and the walk just carried
  // on. So the case where the difference matters most — a guard that never
  // answered — read exactly like a guard that agreed.
  | {
      type: "hook_decision";
      agentId: string;
      /** The tool invocation this applies to: what puts the row beside the
       *  tool_call it stopped and the ERROR result the model got instead. */
      callId: string;
      toolName: string;
      /** "pre_tool_use" or "post_tool_use". */
      event: string;
      /** The tool-name glob the hook matched with, defaulted to "*". */
      matcher: string;
      /** The configured shell string. Redacted WHOLE when a credential shape
       *  fires in it — it is operator config that lands in the session file. */
      command: string;
      timeoutSeconds: number;
      /** "blocked" or "timed-out". */
      verdict: string;
      /** The hook's own words on a block. Absent on a timeout: a killed process
       *  stated nothing, and an empty string would read as one that answered. */
      reason?: string;
      ts: number;
    } // additive
  // Card 252: the harness kept an image back, because the model serving this
  // session cannot see. Emitted once per run, at the turn where the fence first
  // closed — the image lives in the history, so it closes again on every later
  // turn of the same run.
  //
  // The attachment is NOT gone: run_start still carries it, the session file
  // keeps it and the bubble above still shows the picture. Only the provider
  // request was built without it. This line is the sole place that says so, and
  // it carries facts rather than a sentence — the transcript is German or
  // English by the reader's choice, and the server does not know which.
  | {
      type: "images_withheld";
      agentId: string;
      /** How many image blocks were kept back — prompt and resumed history alike. */
      images: number;
      /** The model that cannot see them. Absent when the provider reports no id;
       *  an empty string would name a model whose name is "". */
      model?: string;
      /** Why: "no_vision" today. The follow-up rung (describing the image through
       *  a vision provider) is a second value here, not a second event. */
      reason: string;
      ts: number;
    } // additive
  // Card 265: the run stopped and asked the person watching it something. Its own
  // pair of types rather than a permission_request with text on it — a gate's
  // whole vocabulary is allow/deny, and a reader that only ever saw the boolean
  // could not say what was asked or what came back.
  //
  // The shape is the IMPORTER's, verbatim, which is what makes a native question
  // render identically to one read out of a foreign transcript: toolViews.ts
  // already draws exactly this.
  | {
      type: "question_asked";
      agentId: string;
      /** The tool call parked on the answer; keys the response frame. */
      callId: string;
      questions: AskedQuestionWire[];
      ts: number;
    }
  | {
      type: "question_answered";
      callId: string;
      /** One entry per question asked. Empty exactly when `cancelled`. */
      answers: string[];
      /** True when the question was released without an answer: a cancelled run,
       *  a socket that went away, an unattended permission mode, a skip. Never a
       *  fabricated reply — an invented answer in a session file cannot be told
       *  from a real one afterwards. */
      cancelled: boolean;
      /** How long the run stood parked on the person. Card 111's split, one
       *  surface further: these same millis are SUBTRACTED from the tool's
       *  durationMs, so a slow human never paints the tool as slow. Absent when
       *  nothing was ever measured. */
      waitMs?: number;
      ts: number;
    }; // additive

/** One question of an ask, as the wire carries it (card 265). Deliberately the
 *  same field names the transcript importer reads, so both halves of the app
 *  draw a question with one renderer. */
export interface AskedQuestionWire {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

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
  | { type: "set_permission_mode"; mode: string } // switch ask/auto/readonly mid-session (composer gear)
  // Card 265: the answer to a parked question. Its own frame rather than a wider
  // permission_response, because that one carries allowlist work ("remember",
  // "persist") and answering a question consents to nothing. `cancelled` is the
  // skip button: released, never answered — "" would be a person saying nothing,
  // which is a different fact from nobody saying anything.
  | { type: "question_response"; callId: string; answers: string[]; cancelled?: boolean };

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
