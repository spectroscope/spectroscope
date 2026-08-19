package dev.spectroscope.core.events;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
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
 *
 * <p><b>And the rule that makes the second one true from the reading side</b>
 * ({@code ignoreUnknown}, card 184): a field a newer writer added must cost
 * nothing here. Without it Jackson raises {@code UnrecognizedPropertyException},
 * which is an {@code IOException}, which {@code SessionStore}'s reader catches as
 * a torn trailing line and discards <em>silently</em> — so an already-shipped
 * build would read a newer session as a file whose enriched lines do not exist,
 * without a word. Measured before it was fixed: today's {@code run_start} read,
 * the same line plus {@code cwd}/{@code gitBranch}/{@code version} did not. The
 * TypeScript edition reads structurally and the Python one filters unknown keys
 * ({@code events.py} {@code from_dict}), so this reader was the only intolerant
 * one of the three and the promise above was aspirational in Java alone.</p>
 */
@JsonIgnoreProperties(ignoreUnknown = true)
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
    @JsonSubTypes.Type(value = RunEvent.Plan.class,               name = "plan"),          // additive
    @JsonSubTypes.Type(value = RunEvent.LlmExchange.class,        name = "llm_exchange"),  // additive (card 184 leg 3)
    @JsonSubTypes.Type(value = RunEvent.BrowserAction.class,      name = "browser_action"), // additive (card 204)
    @JsonSubTypes.Type(value = RunEvent.HookDecision.class,       name = "hook_decision"), // additive (card 195)
    @JsonSubTypes.Type(value = RunEvent.ImagesWithheld.class,     name = "images_withheld"), // additive (card 252)
    @JsonSubTypes.Type(value = RunEvent.QuestionAsked.class,      name = "question_asked"),   // additive (card 265)
    @JsonSubTypes.Type(value = RunEvent.QuestionAnswered.class,   name = "question_answered"), // additive (card 265)
    @JsonSubTypes.Type(value = RunEvent.NoProgress.class,         name = "no_progress"),      // additive (card 262)
    @JsonSubTypes.Type(value = RunEvent.Continuation.class,       name = "continuation"),     // additive (card 266)
    @JsonSubTypes.Type(value = RunEvent.GoalCheck.class,          name = "goal_check")        // additive (card 267)
})
public sealed interface RunEvent permits RunEvent.LlmExchange, RunEvent.RunStart, RunEvent.TurnStart,
        RunEvent.TextDelta, RunEvent.ThinkingDelta, RunEvent.ToolCall, RunEvent.PermissionRequest,
        RunEvent.PermissionDecision, RunEvent.ToolResult, RunEvent.AgentSpawn,
        RunEvent.Compaction, RunEvent.VoiceInput, RunEvent.Usage, RunEvent.RunEnd,
        RunEvent.ErrorEvent, RunEvent.ImageGenerated, RunEvent.ContextInfo,
        RunEvent.AgentMessage, RunEvent.Plan, RunEvent.BrowserAction, RunEvent.HookDecision,
        RunEvent.ImagesWithheld, RunEvent.QuestionAsked, RunEvent.QuestionAnswered,
        RunEvent.NoProgress, RunEvent.Continuation, RunEvent.GoalCheck {

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
     * @param model       the model id serving the run (additive, card 87); null when unknown
     * @param trigger     what woke a triggered node's run (additive, card 72),
     *                    e.g. "fs #4 watch:/drop"; null on every non-triggered run
     * @param attachments images riding along with the prompt (additive); null when none
     * @param ts          epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record RunStart(String runId, String agentId, String parentId, String prompt,
                    String provider,                  // additive
                    String model,                     // additive (card 87)
                    String trigger,                   // additive (card 72)
                    List<Attachment> attachments,     // from additive
                    long ts) implements RunEvent {
        /** Pre-card-72 arity — no trigger; Jackson keeps using the canonical.
         *
         * @param runId       unique id of the run
         * @param agentId     the agent running it
         * @param parentId    the spawning agent's id; null on the main agent
         * @param prompt      the user message that started the run
         * @param provider    label of the LLM backend serving the run
         * @param model       the model id serving the run; null when unknown
         * @param attachments images riding along with the prompt; null when none
         * @param ts          epoch millis of emission */
        public RunStart(String runId, String agentId, String parentId, String prompt,
                        String provider, String model, List<Attachment> attachments, long ts) {
            this(runId, agentId, parentId, prompt, provider, model, null, attachments, ts);
        }

        /** Pre-card-87 arity — model unknown; Jackson keeps using the canonical.
         *
         * @param runId       unique id of the run
         * @param agentId     the agent running it
         * @param parentId    the spawning agent's id; null on the main agent
         * @param prompt      the user message that started the run
         * @param provider    label of the LLM backend serving the run
         * @param attachments images riding along with the prompt; null when none
         * @param ts          epoch millis of emission */
        public RunStart(String runId, String agentId, String parentId, String prompt,
                        String provider, List<Attachment> attachments, long ts) {
            this(runId, agentId, parentId, prompt, provider, null, null, attachments, ts);
        }
    }

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
     * Additive (card 265): the run stopped and asked a person a question that is
     * not a yes/no on a side effect. Emitted by the permission-free
     * {@code ask_user_question} tool from inside its own call, before it parks.
     *
     * <p>Deliberately its own type rather than a {@link PermissionRequest} with a
     * text field. The gate's verdict is a boolean and its whole vocabulary is
     * allow/deny; a question has options and an answer in a person's own words,
     * and a reader that only ever saw the boolean could not say what was asked.
     * Old frontends skip the unknown type, which costs them the bar and nothing
     * else — the {@code tool_call} for the same {@code callId} is already on the
     * wire before this line.</p>
     *
     * @param agentId   the asking agent — the tool is main-only by registration
     * @param callId    the tool invocation waiting on the answer; keys the response
     * @param questions what was asked, in the importer's own shape, so a native
     *                  question renders exactly like an imported one
     * @param ts        epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record QuestionAsked(String agentId, String callId, List<AskedQuestion> questions,
                         long ts) implements RunEvent {}

    /** One question of an ask; a plain value record like {@link PlanStep}, NOT a subtype.
     *  @param question    the question in the model's words, rendered as plain text
     *  @param header      a short label above it; null (omitted) when none was given
     *  @param multiSelect whether more than one option may be chosen
     *  @param options     the offered choices, in the order they were offered */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record AskedQuestion(String question, String header, boolean multiSelect,
                         List<QuestionOption> options) {}

    /** One offered choice of an {@link AskedQuestion}.
     *  @param label       the choice as the person sees and picks it
     *  @param description one line of help; null (omitted) when none was given */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record QuestionOption(String label, String description) {}

    /**
     * Additive (card 265): the answer closing a {@link QuestionAsked} — or the
     * record that no answer ever came.
     *
     * <p><b>Nothing here is ever invented.</b> Four independent paths release a
     * parked question (a cancelled run, a socket that went away, an unattended
     * permission mode, no asker at all) and every one of them lands here with
     * {@code cancelled} true and an empty {@code answers} list. A fabricated
     * answer in a session file cannot be told apart from a real one afterwards,
     * and the trace is the product.</p>
     *
     * @param callId    which {@link QuestionAsked} this answers
     * @param answers   one entry per question asked, in the order they were
     *                  asked; empty exactly when {@code cancelled}
     * @param cancelled true when the question was released without an answer
     * @param waitMs    how long the run stood parked on the person — card 111's
     *                  split, one surface further: the same milliseconds are
     *                  SUBTRACTED from the tool's {@code durationMs}, so a slow
     *                  human never paints the tool as slow. Absent (null,
     *                  omitted) when nothing was ever measured
     * @param ts        epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record QuestionAnswered(String callId, List<String> answers, boolean cancelled,
                            Long waitMs, long ts) implements RunEvent {}

    /**
     * A tool finished; the output goes back to the model in the next user message.
     *
     * @param agentId    the agent the call ran under
     * @param callId     correlation id of the originating {@link ToolCall}
     * @param output     the tool output, or an {@code ERROR: } string on denial/failure
     * @param isError    true when {@code output} is such an {@code ERROR: } string
     * @param durationMs wall-clock EXECUTION time of the call — the clock starts
     *                   when the tool actually runs, never when it was requested
     *                   (card 111); 0 when it never executed (denied, hook-blocked,
     *                   unknown). In sessions recorded before card 111 the number
     *                   still spans request-to-finish, gate wait included.
     * @param gateWaitMs additive (card 111): how long the call sat parked at the
     *                   permission gate before the decision; present only when a
     *                   gate parked the call — absent (null, omitted on the wire)
     *                   otherwise, so ungated results stay byte-identical
     * @param fileChange additive (card 269): what a mutating file tool DID —
     *                   {@code created}, {@code changed} or {@code unchanged} —
     *                   as a word rather than a sentence to parse. Absent (null,
     *                   omitted on the wire) for every tool that touched no file
     *                   and for every result recorded before this card, so those
     *                   stay byte-identical. Absence is NOT a synonym for
     *                   {@code unchanged}: it means nothing was claimed.
     * @param ts         epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record ToolResult(String agentId, String callId, String output, boolean isError,
                      long durationMs, Long gateWaitMs, String fileChange, long ts) implements RunEvent {
        /** The pre-card-111 arity — no gate wait recorded; Jackson keeps using the canonical.
         *
         * @param agentId    the agent the call ran under
         * @param callId     correlation id of the originating {@link ToolCall}
         * @param output     the tool output, or an {@code ERROR: } string
         * @param isError    true when {@code output} is such an {@code ERROR: } string
         * @param durationMs wall-clock execution time of the call
         * @param ts         epoch millis of emission */
        public ToolResult(String agentId, String callId, String output, boolean isError,
                          long durationMs, long ts) {
            this(agentId, callId, output, isError, durationMs, null, null, ts);
        }

        /** The pre-card-269 arity — a gate wait, but no word about any file.
         *
         * @param agentId    the agent the call ran under
         * @param callId     correlation id of the originating {@link ToolCall}
         * @param output     the tool output, or an {@code ERROR: } string
         * @param isError    true when {@code output} is such an {@code ERROR: } string
         * @param durationMs wall-clock execution time of the call
         * @param gateWaitMs time parked at the permission gate, or null
         * @param ts         epoch millis of emission */
        public ToolResult(String agentId, String callId, String output, boolean isError,
                          long durationMs, Long gateWaitMs, long ts) {
            this(agentId, callId, output, isError, durationMs, gateWaitMs, null, ts);
        }
    }

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
     * @param stopReason why it ended: end_turn, max_tokens, max_turns, aborted,
     *                   error — or {@code unfinished}, the verdict of card 264:
     *                   the loop read its own plan ledger at the exit and found
     *                   steps still open, so this run did not finish. The field
     *                   was never an enum on the wire, which is what let the
     *                   verdict travel on it without moving a single key
     *                   ({@code PlanVerdict}, {@code RunEndVerdictAdditivityTest})
     * @param ts         epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record RunEnd(String runId, String stopReason, long ts) implements RunEvent {}

    /**
     * One finished backend-to-model exchange, as the session's own record of it
     * (card 184 leg 3).
     *
     * <p>This has been a socket frame since leg 2 and a line in the session file
     * never — so reopening a stored session lost the fact that a model call had
     * happened at all, and the spectrum's second line per agent could only exist
     * while you were watching. Every field here is MEASURED by the sidecar
     * recorder rather than inferred, which is the constraint this record was
     * allowed to grow under: a field we cannot fill truthfully is not added.</p>
     *
     * <p><b>Bodies never ride this line.</b> They stay in the sidecar and the
     * gated endpoint serves them on the gesture that asks — a session file that
     * carried every prompt twice would double in size for a convenience.</p>
     *
     * @param xid           the sidecar's own id, which is what joins the two
     *                      protocols: one line here, two lines there
     * @param agentId       the agent whose call this was
     * @param turn          the 1-based turn, or null where no turn exists (stt)
     * @param kind          what the call was for: chat, compaction, image, stt
     * @param provider      the backend label as the session knows it
     * @param model         the model the request named
     * @param transport     who owned the socket: http, sdk, websocket, process
     * @param url           the full request URL, or the process:// pseudo-url
     * @param status        the HTTP status, or null when nothing ever answered —
     *                      a zero there would be a claim about a reply that
     *                      never came
     * @param requestBytes  the recorded request body's size
     * @param responseBytes the recorded response's size
     * @param responseLines how many stream lines came back
     * @param aborted       true when a cancel tore the stream down mid-generation
     * @param fidelity      what the recorded bytes ARE: bytes, sdk-json,
     *                      sdk-events, encoded, process-output
     * @param durationMs    send to close
     * @param ts            epoch millis at close
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record LlmExchange(String xid, String agentId, Integer turn, String kind,
                       String provider, String model, String transport, String url,
                       Integer status, long requestBytes, long responseBytes,
                       int responseLines, boolean aborted, String fidelity,
                       long durationMs, long ts) implements RunEvent {}

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
     * <p>Two tools emit this, and the wire is frozen, so the second one borrows the
     * fields rather than growing new ones: {@code generate_image} fills them as
     * written below, while an <b>MCP tool result carrying an image</b> (card 198)
     * sends {@code provider} {@code "mcp"}, {@code model} the configured server name,
     * and {@code prompt} the qualified tool name {@code mcp__<server>__<tool>}. One
     * call may emit several — an MCP result can carry more than one image, so
     * {@code callId} alone does not identify one picture; the pair with
     * {@code sha256} does.
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
     * Additive (card 204): one browser tool call happened.
     *
     * <p>The browser twin of {@link LlmExchange}, and for the same reason. The
     * trace itself is a sidecar beside the session
     * ({@code ~/.spectro/browser-wire/&lt;id&gt;.browser.jsonl}) because a browser run
     * is arguments, results and pictures and none of that belongs in the
     * byte-frozen wire. But a session file that said nothing at all could not
     * even tell a reader that a browser had been driven, so this line carries the
     * metadata: which tool, on which page, how it went, and the two keys that
     * join it to the record — {@code cid} for the sidecar's pair of lines and
     * {@code sha256} for the screenshot blob that {@link ImageGenerated}
     * announced.
     *
     * <p><b>{@code epoch} is the field that would be easy to leave out and must
     * not be.</b> Closing a session retires its browser and a resume opens a
     * fresh one, with fresh cookies, appending to the same sidecar (card 218). A
     * replay that could not tell those apart would narrate two logins as one
     * continuous story.
     *
     * <p>No bytes ride here, ever: a picture is a blob in the store and a hash on
     * this line, which is what keeps a thousand-action run a text file.
     *
     * @param agentId     the agent whose tool call this was
     * @param callId      the provider's tool_use id, or null where none exists
     * @param cid         the sidecar's own id for this call — pairs the two lines
     * @param epoch       which browser of this session's life it drove, 1-based;
     *                    0 when nothing was recording
     * @param tool        the wire name of the tool ({@code browser_navigate}, …)
     * @param url         the address the call happened on, or null when no page
     *                    was open; redacted by the same rules as the sidecar
     * @param ok          whether the tool answered rather than refused
     * @param resultBytes UTF-8 size of the result string the model read back
     * @param durationMs  entry-to-answer wall clock
     * @param sha256      the screenshot blob's content hash, or null for a call
     *                    that took no picture
     * @param ts          epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record BrowserAction(String agentId, String callId, String cid, int epoch, String tool,
                         String url, boolean ok, long resultBytes, long durationMs,
                         String sha256, long ts) implements RunEvent {}

    /**
     * Additive (card 195): a configured shell hook did something worth a line.
     *
     * <p>Two verdicts ride here and only two: {@code blocked} and
     * {@code timed-out}. A hook that agreed emits nothing — one line per passing
     * hook per tool call would bury the two that matter, and "nothing objected"
     * is already what the tool result says.</p>
     *
     * <p><b>Why this event had to exist before the hooks page could.</b> A block
     * used to surface as nothing but the {@code ERROR: blocked by pre_tool_use
     * hook: …} string inside a {@link ToolResult}, which carries the reason and
     * names no hook; a TIMEOUT surfaced as nothing at all, because
     * {@code HookRunner} fails open and the walk simply continued. So a screen
     * could truthfully say which hooks are configured and could not say which
     * one fired — and the one case where the difference is largest, a guard that
     * never answered, read exactly like a guard that agreed.</p>
     *
     * <p>{@code command} arrives REDACTED by {@code Redaction}'s rules: it is
     * operator-written config that lands in the session file, and a session file
     * is what people export and paste.</p>
     *
     * @param agentId        the agent whose tool call the hook ran around
     * @param callId         the tool invocation it applies to — what joins this
     *                       line to its {@link ToolCall} and {@link ToolResult}
     * @param toolName       the tool the hook fired for
     * @param event          the phase: {@code pre_tool_use} or {@code post_tool_use}
     * @param matcher        the tool-name glob the hook matched with, defaulted
     * @param command        the configured shell string, redacted whole when a
     *                       credential shape fires in it
     * @param timeoutSeconds the budget the hook actually ran under
     * @param verdict        {@code blocked} or {@code timed-out}
     * @param reason         the hook's own words on a block; null on a timeout,
     *                       because a killed process stated nothing
     * @param ts             epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record HookDecision(String agentId, String callId, String toolName, String event,
                        String matcher, String command, long timeoutSeconds,
                        String verdict, String reason, long ts) implements RunEvent {}

    /**
     * Additive (card 252): the harness kept an image back because the serving
     * model cannot see it. Emitted once per run, at the turn where the fence
     * first closed — the image sits in the history, so a line per turn would
     * bury the transcript in the same sentence.
     *
     * <p>It exists because the withholding is otherwise invisible in the one
     * place it matters most. The attachment stays in the RECORD: {@code
     * run_start} carries it, the session file keeps it, and the user's own
     * bubble still shows the picture. Only the provider request is built
     * without it. Without this line the operator sees a model answer a prompt
     * about a screenshot it never received, with the screenshot on screen and
     * nothing anywhere saying why.</p>
     *
     * <p>No sentence rides here, only the facts a sentence is built from — the
     * web renders it from an i18n key in both languages, and a reopened session
     * must not print English into a German transcript.</p>
     *
     * @param agentId the agent whose request was built without the images
     * @param images  how many image blocks were kept back, prompt and resumed
     *                history alike
     * @param model   the model that cannot see them; null (omitted) when the
     *                provider reports no id — an empty string would name a model
     * @param reason  why they were kept back: {@code no_vision} today. The
     *                follow-up rung (describing an image through a vision
     *                provider and handing the text over) is a second value here,
     *                not a second event.
     * @param ts      epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record ImagesWithheld(String agentId, int images, String model, String reason, long ts)
            implements RunEvent {}

    /**
     * Additive: the harness decided whether to keep an unfinished run going
     * (card 266).
     *
     * <p>One line per DECISION, not per continuation, because the two refusals
     * are the facts an operator most needs afterwards: a run that quietly
     * stopped being continued is the same silence card 264 was cut to end. The
     * value in {@code decision} is what a reader keys off — never the prose in
     * {@code evidence}, which is written for a person and may be reworded.</p>
     *
     * @param agentId      the agent whose run stopped with steps open
     * @param decision     {@code continued}, {@code budget_exhausted} or
     *                     {@code no_progress} — the three outcomes of
     *                     {@code ContinuationLeash.Decision}
     * @param continuation which continuation this is, 1-based; on a refusal, how
     *                     many had already been spent
     * @param budget       the leash's budget for this run, so the count is
     *                     readable as "2 of 3" without a second lookup
     * @param openSteps    how many plan steps were still open at the exit
     * @param totalSteps   how many steps the plan had
     * @param inputTokens  what the run's LAST exchange reported as input tokens —
     *                     the floor of what this continuation's own exchange
     *                     costs. The non-functional criterion of card 266 asks
     *                     the price to be stated per continuation, and this is
     *                     the only honest number the loop holds. 0 when the
     *                     provider reported no usage
     * @param evidence     the same decision as one English sentence, for the
     *                     surfaces with no dictionary
     * @param ts           epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record Continuation(String agentId, String decision, int continuation, int budget,
                        int openSteps, int totalSteps, int inputTokens, String evidence,
                        long ts) implements RunEvent {}

    /**
     * Additive: the goal's check ran, and this is what it said (card 267).
     *
     * <p>One line per check, at the exit that would otherwise have ended the
     * run. Criterion 4 is the reason every field is here: <b>a verdict is never
     * a claim</b>. The command and its exit code — or the evaluator's model name
     * and what it answered — travel WITH the outcome, so nobody downstream has
     * to take the word "done" on faith, and a run recorded as met can be re-run
     * by hand from its own record.</p>
     *
     * <p>Key off {@code outcome}, never off {@code evidence}: the prose is
     * written for a person and may be reworded, the three values may not. And
     * the prose is written in the register
     * {@code .spectro/skills/verification/SKILL.md} permits — the banned words
     * ("should work", "probably passes", "looks correct") state a belief where
     * this line states a measurement.</p>
     *
     * @param agentId    the agent whose run was about to end
     * @param outcome    {@code met}, {@code failed} or {@code untested}
     * @param command    the command that ran, or null when a model judged
     * @param exitCode   the exit code, or null when nothing ran to completion
     * @param judge      the evaluator's model name, or null for a command check
     * @param output     what the check printed, clipped to the tail
     * @param durationMs how long the CHECK took — kept apart from the model's
     *                   work, the split card 111 established for the gate and
     *                   card 265 extended to the ask
     * @param gateWaitMs how long the check waited on a person at the permission
     *                   gate, or null when it never parked
     * @param evidence   the same verdict as one English sentence
     * @param ts         epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record GoalCheck(String agentId, String outcome, String command, Integer exitCode,
                     String judge, String output, long durationMs, Long gateWaitMs,
                     String evidence, long ts) implements RunEvent {}

    /**
     * Additive: the harness noticed that nothing is moving (card 262).
     *
     * <p>Emitted the moment a detector fires, BEFORE the question that follows
     * it, so the transcript carries the observation even if the run is
     * cancelled while the question is parked. Never a silent abort: the line is
     * on the wire whatever the operator then decides, and whatever happens when
     * nobody answers.</p>
     *
     * <p><b>Facts and a sentence, both.</b> {@code detector}, {@code count} and
     * {@code details} are the facts a localized surface builds its own wording
     * from — {@link ImagesWithheld} learned that the hard way, and a reopened
     * session must not print English into a German transcript. {@code evidence}
     * is the ready-made English sentence for every surface that has no
     * dictionary at all: the CLI transcript, the log line, a session file a
     * human opens in an editor. A guard that says "no progress" without naming
     * what it saw is a guess wearing a warning's clothes, and that has to hold
     * in the places where no UI is watching.</p>
     *
     * @param agentId  the agent whose run stopped moving
     * @param detector which net caught it — {@code identical_writes},
     *                 {@code repeated_failure} or {@code stalled_plan}. Pin on
     *                 this, never on {@code evidence}: the prose is written for
     *                 a person and may be reworded, this may not
     * @param count    how many times the thing happened — three identical
     *                 writes, three failures in a row, five unmoved turns
     * @param details  the supporting facts, per detector. {@code identical_writes}:
     *                 the paths that already carry those bytes, and LAST the new
     *                 path the run was about to write. {@code repeated_failure}:
     *                 one entry, the call as it was issued. {@code stalled_plan}:
     *                 the plan steps still open. Null (omitted) when a detector
     *                 has none
     * @param evidence the same thing as one English sentence, for the surfaces
     *                 with no dictionary
     * @param ts       epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record NoProgress(String agentId, String detector, int count, List<String> details,
                      String evidence, long ts) implements RunEvent {}

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
     * @param thresholdSource which fact produced the threshold (additive, card
     *                        263): {@code override} when an explicit setting won,
     *                        {@code window} when the backend stated the window
     *                        the loaded instance serves, {@code fallback} when
     *                        nothing could be learned. Null in pre-263 sessions,
     *                        and dropped from the wire when null
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record ContextInfo(String agentId, int turn, int messages, int estimatedTokens,
                       int threshold, List<ContextPart> parts, long ts,
                       String thresholdSource) implements RunEvent {

        /** Pre-card-263 shape: a threshold with no stated provenance.
         *  @param agentId        the agent the estimate belongs to
         *  @param turn           the turn the estimate precedes (1-based)
         *  @param messages       how many history entries ride along
         *  @param estimatedTokens the chars/4 sum of the parts
         *  @param threshold      the compaction trigger's level
         *  @param parts          the labeled slices behind the estimate
         *  @param ts             epoch millis of emission */
        public ContextInfo(String agentId, int turn, int messages, int estimatedTokens,
                           int threshold, List<ContextPart> parts, long ts) {
            this(agentId, turn, messages, estimatedTokens, threshold, parts, ts, null);
        }
    }

    /** One labeled slice of the context estimate; not a RunEvent itself, like {@link Attachment}.
     *  @param label     what the slice covers (e.g. "system prompt")
     *  @param chars     raw character count of the slice
     *  @param estTokens the chars/4 token estimate
     *  @param text      the slice's CONTENT (additive, card 86 follow-up) — what
     *                   actually rides to the provider, capped by the emitter;
     *                   null in pre-content sessions */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record ContextPart(String label, int chars, int estTokens, String text) {}

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
