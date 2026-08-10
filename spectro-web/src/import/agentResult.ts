// What a subagent cost, said on its parent's record (card 167, findings 1+6).
//
// A modern Claude Code transcript does not contain its own children. Measured
// over the 5,132 files in ~/.claude/projects on 2026-08-04: 0 of 311,332
// sidechain records resolve an owner inside the file that holds them, and
// 4,674 files are nothing BUT sidechain records — a subagent's transcript is a
// separate file
// under <session-uuid>/subagents/. So on a session import the whole child-run
// machinery (run_start `cc-<id>`, per-child turns, per-child usage) never
// fires, and everything a reader can learn about a child comes from the one
// record the parent wrote when the call came back:
//
//   resolvedModel  the model the child ACTUALLY ran on. 617 of the 624 launch
//                  records that carry a result object name one, across seven
//                  ids — and it is a different
//                  model from the parent's often enough that inheriting the
//                  parent's was wrong on all of them, sometimes by a whole
//                  tier (a haiku child under an opus parent).
//   status         "completed" (230) or "async_launched" (394). The launched
//                  ones never reported back inside the file; without this the
//                  card renders the launch receipt as the child's answer and
//                  the roster calls it finished.
//   usage          the child's own token bill, in the Anthropic shape. 230
//                  records carry one, together 842,802 output tokens and
//                  22,119,636 cache reads that no frame has ever carried.
//
// THIS IS A READING, NOT A FRAME, the same idiom as sourceNotes.ts,
// recordMeta.ts and toolResultDetail.ts: nothing in events.ts gains a field.
// The usage half needs no carrier at all — it maps one to one onto the wire's
// existing `usage` event under the CHILD's agentId — and the other half rides
// an import-only frame (wire/nonWire.ts) that can never be written to a file.
//
// ABSENT-FIRST. Every reader returns nothing rather than a default: 117 of the
// 741 launch results in the corpus carry no object at all, and a zero token
// count would read as "the child was free".
//
// VALUES TRAVEL VERBATIM. The model id keeps the "[1m]" context-window suffix
// the file wrote on 63 of them (46 opus-4-8, 17 opus-5); trimming it would name
// a model the child did not run on.

/** The child's own token bill, in this app's names. */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/** What a launch record says about the child it launched. Every field is
 *  optional and absent means the record did not carry it. */
export interface AgentRunResult {
  /** `resolvedModel`, verbatim, suffix and all. */
  model?: string;
  /** The call was launched in the background and never reported back inside
   *  this file. Only ever true; a launch that DID report back carries nothing
   *  here, because "it finished" is what an unmarked row already says. */
  launched?: true;
  /** `totalDurationMs` — the child's wall time. 238 of the session corpus's
   *  launch records carry it, and none of them reached a frame until card 167's
   *  residue was closed: a row could say which model a child ran on and what it
   *  spent, but not that it took three minutes, which is the first thing a
   *  reader asks when a subagent looks stuck. */
  durationMs?: number;
  /** `totalToolUseCount` — how many tools the child called. 237 records carry
   *  the neighbouring `toolStats`; this is the one number of it a row can show
   *  without inventing a layout for the rest. */
  toolCalls?: number;
  /** `usage`, the four counters this app has words for. The rest of the
   *  object (service_tier, inference_geo, iterations, speed) is plumbing
   *  inside an otherwise load-bearing value. */
  usage?: AgentUsage;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * The child's token bill, or null for an object that holds no count.
 *
 * A usage object with neither an input nor an output count says nothing about
 * what the child spent, and reporting it as 0/0 would put a free subagent in
 * the session total.
 */
function usageOf(value: unknown): AgentUsage | null {
  const u = obj(value);
  if (u === null) return null;
  const inputTokens = num(u["input_tokens"]);
  const outputTokens = num(u["output_tokens"]);
  if (inputTokens === undefined && outputTokens === undefined) return null;
  const cacheReadTokens = num(u["cache_read_input_tokens"]);
  const cacheCreationTokens = num(u["cache_creation_input_tokens"]);
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
  };
}

/**
 * A launch record's `toolUseResult`, as far as the child's row can use it.
 *
 * @param value the record's own `toolUseResult`, whatever it is
 * @return what it says about the child, or null when it says none of it
 */
export function readAgentResult(value: unknown): AgentRunResult | null {
  const tur = obj(value);
  if (tur === null) return null;
  const r: AgentRunResult = {};
  const model = tur["resolvedModel"];
  if (typeof model === "string" && model !== "") r.model = model;
  // Exactly one status in the corpus means "not back yet". Any other word,
  // known or new, is left alone rather than guessed at.
  if (tur["status"] === "async_launched") r.launched = true;
  // Absent-first, like every reader in this file: `num` returns undefined for
  // a string, a null, a NaN or an infinity, and a zero duration would read as
  // "it took no time" rather than "the record did not say".
  const durationMs = num(tur["totalDurationMs"]);
  if (durationMs !== undefined) r.durationMs = durationMs;
  const toolCalls = num(tur["totalToolUseCount"]);
  if (toolCalls !== undefined) r.toolCalls = toolCalls;
  const usage = usageOf(tur["usage"]);
  if (usage !== null) r.usage = usage;
  return Object.keys(r).length === 0 ? null : r;
}
