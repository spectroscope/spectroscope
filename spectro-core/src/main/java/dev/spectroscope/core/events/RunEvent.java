package dev.spectroscope.core.events;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;
import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;

/**
 * The event protocol of the harness — the harness's API promise.
 *
 * <p>Every occurrence in a run is one flat, JSON-serializable record with a timestamp
 * ({@code ts}, epoch millis) and, where meaningful, an agent id. Jackson serializes
 * each record with a snake_case {@code type} discriminator and camelCase field names —
 * <b>byte for byte the same wire format as the original TypeScript edition</b> of the workshop this harness began in.
 * A session written by either harness replays in the other.</p>
 *
 * <p>Three rules make this a load-bearing protocol: only JSON-serializable fields;
 * extend only additively (never rename or remove a field); ignore unknown event types.</p>
 */
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "type")
@JsonSubTypes({
    @JsonSubTypes.Type(value = RunEvent.RunStart.class,           name = "run_start"),
    @JsonSubTypes.Type(value = RunEvent.TurnStart.class,          name = "turn_start"),
    @JsonSubTypes.Type(value = RunEvent.TextDelta.class,          name = "text_delta"),
    @JsonSubTypes.Type(value = RunEvent.ThinkingDelta.class,      name = "thinking_delta"), // web tier, additive
    @JsonSubTypes.Type(value = RunEvent.ToolCall.class,           name = "tool_call"),
    @JsonSubTypes.Type(value = RunEvent.PermissionRequest.class,  name = "permission_request"),
    @JsonSubTypes.Type(value = RunEvent.PermissionDecision.class, name = "permission_decision"),
    @JsonSubTypes.Type(value = RunEvent.ToolResult.class,         name = "tool_result"),
    @JsonSubTypes.Type(value = RunEvent.AgentSpawn.class,         name = "agent_spawn"),
    @JsonSubTypes.Type(value = RunEvent.Compaction.class,         name = "compaction"),    // additive
    @JsonSubTypes.Type(value = RunEvent.VoiceInput.class,         name = "voice_input"),   // optional audit
    @JsonSubTypes.Type(value = RunEvent.Usage.class,              name = "usage"),
    @JsonSubTypes.Type(value = RunEvent.RunEnd.class,             name = "run_end"),
    @JsonSubTypes.Type(value = RunEvent.ErrorEvent.class,         name = "error"),
    @JsonSubTypes.Type(value = RunEvent.ImageGenerated.class,     name = "image_generated"), // from additive
    @JsonSubTypes.Type(value = RunEvent.ContextInfo.class,        name = "context_info"),  // additive
    @JsonSubTypes.Type(value = RunEvent.AgentMessage.class,       name = "agent_message"), // A2A-lite, additive
    @JsonSubTypes.Type(value = RunEvent.Plan.class,               name = "plan")           // additive
})
public sealed interface RunEvent permits RunEvent.RunStart, RunEvent.TurnStart,
        RunEvent.TextDelta, RunEvent.ThinkingDelta, RunEvent.ToolCall, RunEvent.PermissionRequest,
        RunEvent.PermissionDecision, RunEvent.ToolResult, RunEvent.AgentSpawn,
        RunEvent.Compaction, RunEvent.VoiceInput, RunEvent.Usage, RunEvent.RunEnd,
        RunEvent.ErrorEvent, RunEvent.ImageGenerated, RunEvent.ContextInfo,
        RunEvent.AgentMessage, RunEvent.Plan {

    /** Epoch millis of the moment the event was emitted. */
    long ts();

    // NON_NULL: optional fields (parentId, provider, attachments, agentId on errors)
    // are omitted from the JSON when null — an absent field stays absent on the wire.

    /**
     * Opens a run — the user's prompt is on record before the first provider call.
     *
     * @param runId       unique id of the run, echoed by the closing {@link RunEnd}
     * @param agentId     the agent running it ("main", or a subagent id)
     * @param parentId    the spawning agent's id; null (omitted) on the main agent
     * @param prompt      the user message that started the run
     * @param provider    label of the LLM backend serving the run (additive)
     * @param attachments images riding along with the prompt (additive); null when none
     * @param ts          epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record RunStart(String runId, String agentId, String parentId, String prompt,
                    String provider,                  // additive
                    List<Attachment> attachments,     // from additive
                    long ts) implements RunEvent {}

    /**
     * One provider round-trip begins; the loop's turn brake caps how many a run may take.
     *
     * @param agentId the agent starting the turn
     * @param turn    1-based turn number within the run
     * @param ts      epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record TurnStart(String agentId, int turn, long ts) implements RunEvent {}

    /**
     * One streamed chunk of the assistant's answer — concatenating the deltas yields the full text.
     *
     * @param agentId the agent whose answer streams
     * @param text    the raw chunk, exactly as the provider sent it
     * @param ts      epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record TextDelta(String agentId, String text, long ts) implements RunEvent {}

    /**
     * Web tier, additive: one streamed chunk of the model's reasoning ("thinking").
     * Sibling of {@link TextDelta}, but a separate stream — thinking is shown apart
     * from the answer and, unlike text, never re-enters the provider history.
     *
     * @param agentId the agent whose reasoning streams
     * @param text    one raw reasoning chunk
     * @param ts      epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record ThinkingDelta(String agentId, String text, long ts) implements RunEvent {}

    /**
     * The model requests a tool. The input is model output and therefore untrusted —
     * the house rule behind the permission gate.
     *
     * @param agentId the agent the call belongs to
     * @param callId  correlation id linking this call to its permission events and result
     * @param name    the registered tool name
     * @param input   the model-supplied arguments — parsed JSON, but unvalidated
     * @param ts      epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record ToolCall(String agentId, String callId, String name, JsonNode input, long ts) implements RunEvent {}

    /**
     * A permission-needing tool waits at the gate; the run blocks until the
     * {@code PermissionBroker} answers.
     *
     * @param agentId the asking agent
     * @param callId  the tool invocation awaiting the verdict
     * @param name    the tool that wants to run
     * @param input   exactly what would run, shown to the human verbatim
     * @param ts      epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record PermissionRequest(String agentId, String callId, String name, JsonNode input, long ts) implements RunEvent {}

    /**
     * The verdict closing a {@link PermissionRequest}.
     *
     * @param callId  which request this answers
     * @param allowed true executes the tool; false sends an ERROR result to the model
     * @param ts      epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record PermissionDecision(String callId, boolean allowed, long ts) implements RunEvent {}

    /**
     * A tool finished; the output goes back to the model in the next user message.
     *
     * @param agentId    the agent the call ran under
     * @param callId     correlation id of the originating {@link ToolCall}
     * @param output     the tool output, or an {@code ERROR: } string on denial/failure
     * @param isError    true when {@code output} is such an {@code ERROR: } string
     * @param durationMs wall-clock execution time of the call
     * @param ts         epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record ToolResult(String agentId, String callId, String output, boolean isError,
                      long durationMs, long ts) implements RunEvent {}

    /**
     * A subagent enters; its events interleave on the same stream under its own id.
     *
     * @param agentId  the NEW child's id
     * @param parentId the agent that spawned it
     * @param task     the assignment the child works on
     * @param ts       epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record AgentSpawn(String agentId, String parentId, String task, long ts) implements RunEvent {}

    /**
     * The history was folded into a summary (additive). Only the stream records
     * it — the JSONL file is never rewritten.
     *
     * @param agentId      the agent whose history shrank
     * @param removedTurns how many history messages the summary replaced
     * @param summaryChars length of the surviving summary text
     * @param ts           epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record Compaction(String agentId, int removedTurns, int summaryChars, long ts) implements RunEvent {}

    /**
     * Optional and additive: marks the provenance of a turn that began as
     * speech. Written to the session file as an audit line BEFORE the {@code run_start},
     * so the trace tab and the JSONL show where a turn came from. It never enters the
     * provider history (see the resume flow) — the reconstructed conversation is
     * byte-identical to a typed one. Old frontends ignore the unknown type.
     *
     * @param agentId    the agent the spoken turn belongs to
     * @param durationMs length of the recorded audio
     * @param model      the transcription model used (e.g. {@code ggml-small})
     * @param ts         epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record VoiceInput(String agentId, long durationMs, String model, long ts) implements RunEvent {}

    /**
     * The token bill of one provider call, as the provider reported it —
     * {@code inputTokens} stays the RAW uncached count (byte-identical wire).
     * With Anthropic prompt caching active the raw count is only the uncached
     * remainder, so the cache counts ride ADDITIVELY: absent (null, omitted on
     * the wire) when the provider reported none, present when it did — the UIs
     * add them to show the true context size.
     *
     * @param agentId             the billed agent
     * @param inputTokens         prompt-side tokens of the call, the provider's raw count
     * @param outputTokens        completion-side tokens of the call
     * @param cacheReadTokens     tokens served from the prompt cache (additive; null = not reported)
     * @param cacheCreationTokens tokens freshly written into the cache (additive; null = not reported)
     * @param ts                  epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record Usage(String agentId, int inputTokens, int outputTokens,
                 Integer cacheReadTokens, Integer cacheCreationTokens,
                 long ts) implements RunEvent {

        /**
         * The pre-caching shape — providers without cache counts (and every
         * older call site) keep the old five arguments.
         *
         * @param agentId      the billed agent
         * @param inputTokens  prompt-side tokens of the call
         * @param outputTokens completion-side tokens of the call
         * @param ts           epoch millis of emission
         */
        public Usage(String agentId, int inputTokens, int outputTokens, long ts) {
            this(agentId, inputTokens, outputTokens, null, null, ts);
        }
    }

    /**
     * Closes the run on every path — the consumer's signal to stop iterating.
     *
     * @param runId      id of the run being closed, matching its {@link RunStart}
     * @param stopReason why it ended: end_turn, max_tokens, max_turns, aborted or error
     * @param ts         epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record RunEnd(String runId, String stopReason, long ts) implements RunEvent {}

    /**
     * A run-level failure, emitted right before the closing {@link RunEnd}.
     *
     * @param agentId the failing agent; may be null (omitted) on run-level errors
     * @param message the human-readable cause
     * @param ts      epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record ErrorEvent(String agentId, String message, long ts) implements RunEvent {}

    /**
     * From additive: a tool produced an image. The bytes live content-addressed
     * under {@code ~/.spectro/images/<sha256>.<ext>}; the event carries only the reference
     * ({@code blobPath} relative to {@code ~/.spectro}) — events stay small, files dedupe.
     *
     * @param agentId   the agent whose tool call produced the image
     * @param callId    the generate_image invocation it belongs to
     * @param prompt    the image prompt as sent to the backend
     * @param provider  the image backend ("gemini" or "openai")
     * @param model     the image model that rendered it
     * @param mediaType MIME type of the stored bytes
     * @param blobPath  the reference into the store, relative to {@code ~/.spectro}
     * @param sha256    content hash of the bytes — the store's dedupe key
     * @param ts        epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record ImageGenerated(String agentId, String callId, String prompt, String provider,
                          String model, String mediaType, String blobPath, String sha256,
                          long ts) implements RunEvent {}

    /**
     * Additive: what sits in the context window right now. Emitted
     * once per turn when introspection is enabled; sizes are char/4 estimates — the
     * real token truth stays with the {@link Usage} events.
     *
     * @param agentId         the introspected agent
     * @param turn            the turn the estimate precedes
     * @param messages        current history length, counted in messages
     * @param estimatedTokens chars/4 estimate of the whole next request
     * @param threshold       the compaction threshold the estimate is measured against
     * @param parts           the labeled slices (system prompt, tool schemas, conversation)
     * @param ts              epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record ContextInfo(String agentId, int turn, int messages, int estimatedTokens,
                       int threshold, List<ContextPart> parts, long ts) implements RunEvent {}

    /** One labeled slice of the context estimate; not a RunEvent itself, like {@link Attachment}.
     *  @param label     what the slice covers (e.g. "system prompt")
     *  @param chars     raw character count of the slice
     *  @param estTokens the chars/4 token estimate */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record ContextPart(String label, int chars, int estTokens) {}

    /**
     * A2A-lite, additive: one visible message between two agents — the protocol
     * layer the spawn mechanics never showed. Three roles with an A2A-style task
     * lifecycle: {@code task} (parent → child, state {@code submitted}),
     * {@code status} (child → parent while working, state {@code working} — fed
     * by the child's permission-free {@code report_status} tool) and
     * {@code result} (child → parent, state {@code completed} or {@code failed}).
     * {@code label} names the dev tool that spawned the child ({@code build_plan},
     * …); plain {@code spawn_agent} spawns carry none.
     *
     * @param from  the sending agent's id
     * @param to    the receiving agent's id
     * @param role  {@code task}, {@code status} or {@code result}
     * @param state the A2A lifecycle state: submitted, working, completed or failed
     * @param text  the message content — the task text, a status line, or the result
     * @param label the dev tool that spawned the child; null on plain spawns
     * @param ts    epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record AgentMessage(String from, String to, String role, String state,
                        String text, String label, long ts) implements RunEvent {}

    /**
     * Additive: the main agent's current step-by-step plan (a
     * short TODO list). Emitted by the permission-free {@code update_plan} tool;
     * each event fully replaces the previous plan (latest-wins). The Plan tab
     * renders from it; old frontends skip the unknown type.
     *
     * @param agentId the planning agent — always the main one, the tool is main-only
     * @param steps   the complete plan; replaces any previous plan wholesale
     * @param ts      epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record Plan(String agentId, List<PlanStep> steps, long ts) implements RunEvent {}

    /** One step of a {@link Plan}; a plain value record like {@link ContextPart}, NOT a subtype.
     *  @param text   the step in the model's words
     *  @param status {@code pending}, {@code in_progress} or {@code completed} —
     *                enforced at the write boundary */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record PlanStep(String text, String status) {}

    /** Present from day one so the wire format never changes later.
     *  @param kind      the attachment kind — {@code "image"} today
     *  @param mediaType MIME type of the stored bytes
     *  @param blobPath  the reference into the blob store, relative to {@code ~/.spectro}
     *  @param sha256    content hash of the bytes — the store's dedupe key */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record Attachment(String kind, String mediaType, String blobPath, String sha256) {}
}
