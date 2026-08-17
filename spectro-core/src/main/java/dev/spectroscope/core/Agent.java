package dev.spectroscope.core;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.local.ModelProfile;
import dev.spectroscope.core.provider.LlmProvider.ToolSpec;
import dev.spectroscope.core.events.RunEvent.ContextInfo;
import dev.spectroscope.core.events.RunEvent.ContextPart;
import dev.spectroscope.core.events.RunEvent.ErrorEvent;
import dev.spectroscope.core.events.RunEvent.HookDecision;
import dev.spectroscope.core.hooks.HookRunner;
import dev.spectroscope.core.events.RunEvent.PermissionDecision;
import dev.spectroscope.core.events.RunEvent.PermissionRequest;
import dev.spectroscope.core.events.RunEvent.RunEnd;
import dev.spectroscope.core.events.RunEvent.RunStart;
import dev.spectroscope.core.events.RunEvent.TextDelta;
import dev.spectroscope.core.events.RunEvent.ThinkingDelta;
import dev.spectroscope.core.events.RunEvent.ToolCall;
import dev.spectroscope.core.events.RunEvent.ToolResult;
import dev.spectroscope.core.events.RunEvent.TurnStart;
import dev.spectroscope.core.events.RunEvent.Usage;
import dev.spectroscope.core.provider.LlmProvider.DocumentContent;
import dev.spectroscope.core.provider.LlmProvider.ImageContent;
import dev.spectroscope.core.provider.LlmProvider.PStop;
import dev.spectroscope.core.provider.LlmProvider.PTextDelta;
import dev.spectroscope.core.provider.LlmProvider.PThinkingDelta;
import dev.spectroscope.core.provider.LlmProvider.PToolCall;
import dev.spectroscope.core.provider.LlmProvider.PUsage;
import dev.spectroscope.core.provider.LlmProvider.ProviderContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import dev.spectroscope.core.provider.LlmProvider.ToolCallContent;
import dev.spectroscope.core.provider.LlmProvider.ToolResultContent;
import dev.spectroscope.core.provider.VisionFence;
import dev.spectroscope.core.session.Compaction;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.wire.LlmWireRecorder;
import dev.spectroscope.core.wire.LlmWireTap;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Consumer;

/**
 * The headless agent loop. It performs <b>no I/O</b> and speaks only {@link RunEvent}s
 * through the event sink. {@link #run(String, RunOptions)} starts a producer virtual
 * thread (via {@link EventStream}) that drives the loop; the caller consumes the returned
 * {@link EventStream} with a plain for-each.
 */
public final class Agent {

    private static final int MAX_TURNS = 15;         // runaway-loop brake
    private static final int DEFAULT_MAX_TOKENS = 32_000;

    private final AgentOptions options;
    // Multi-turn history lives in the agent, across runs on the same instance.
    private final List<ProviderMessage> messages = new ArrayList<>();

    /** Live reasoning override — null defers to the build-time option. ON is
     *  the only visible state; OFF additionally spends the provider's wire-level
     *  off switch (DEFAULT says nothing and merely hides the deltas). */
    private volatile ProviderRequest.Reasoning reasoningOverride;

    /** Live effort-level override — null leaves the model's default. Providers
     *  spend it only where their capability record lists the value. */
    private volatile String effortOverride;

    /**
     * Flips reasoning visibility mid-session — the web header toggle. Takes
     * effect immediately (even mid-run: the emission filter reads it per
     * delta); the next provider request also stops/starts asking for
     * reasoning where the wire supports that. Off maps to DEFAULT, not OFF:
     * the toggle promises visibility, not a wire-level refusal — that is
     * {@link #setReasoning}'s job.
     *
     * @param enabled true to surface thinking deltas, false to silence them
     */
    public void setThinking(boolean enabled) {
        this.reasoningOverride = enabled
                ? ProviderRequest.Reasoning.ON : ProviderRequest.Reasoning.DEFAULT;
    }

    /**
     * The picker's full reasoning control (card 88): mode plus effort level.
     * OFF reaches the provider's wire in its own dialect (ollama think:false,
     * the bundled engine's chat-template switch, anthropic thinking:disabled)
     * — where an endpoint has no such field the provider sends nothing, per
     * its {@link dev.spectroscope.core.provider.ReasoningCapability}.
     *
     * @param mode   the reasoning mode for subsequent requests; null keeps the
     *               build-time option
     * @param effort the effort level, or null/blank for the model's default
     */
    public void setReasoning(ProviderRequest.Reasoning mode, String effort) {
        this.reasoningOverride = mode;
        this.effortOverride = effort == null || effort.isBlank() ? null : effort;
    }

    /** The reasoning mode requests carry: the live override, else the option. */
    private ProviderRequest.Reasoning effectiveReasoning() {
        ProviderRequest.Reasoning override = reasoningOverride;
        if (override != null) {
            return override;
        }
        return Boolean.TRUE.equals(options.thinking())
                ? ProviderRequest.Reasoning.ON : ProviderRequest.Reasoning.DEFAULT;
    }

    /** The effective reasoning visibility — ON is the only state that shows deltas. */
    private boolean thinkingEnabled() {
        return effectiveReasoning() == ProviderRequest.Reasoning.ON;
    }

    /**
     * Wires the agent from its options; a resumed session's {@code initialMessages}
     * seed the multi-turn history.
     *
     * @param options the complete wiring — provider, tools, permission broker, ids, limits
     */
    public Agent(AgentOptions options) {
        this.options = options;
        if (options.initialMessages() != null) {
            this.messages.addAll(options.initialMessages()); // resumed sessions
        }
    }

    /**
     * Starts a run; the returned stream is consumed with a plain for-each.
     *
     * @param prompt     the user message that opens this run
     * @param runOptions per-run extras — a cancel signal (a fresh one is created when
     *                   absent) and optional image attachments
     * @return the live event stream; closing it cancels the run
     */
    public EventStream run(String prompt, RunOptions runOptions) {
        CancelSignal signal = runOptions.signal() != null ? runOptions.signal() : new CancelSignal();
        // null instead of an empty list — @JsonInclude(NON_NULL) then drops
        // the field, so a run without images serializes exactly as without attachments.
        List<RunEvent.Attachment> attachments =
                (runOptions.attachments() == null || runOptions.attachments().isEmpty())
                        ? null
                        : List.copyOf(runOptions.attachments());
        return EventStream.start(signal,
                sink -> loop(prompt, runOptions.promptForModel(), attachments, signal, sink));
    }

    /**
     * forces a compaction NOW (the /compact slash command).
     * Call only between runs — during a run the loop compacts automatically at
     * its threshold. Returns the resulting event so the caller can persist and
     * render it: a {@code Compaction} on success, an {@code ErrorEvent} on a
     * failed summary call, empty when the history is too small to win anything.
     *
     * @return the event to persist and render, or empty when nothing was compacted
     */
    public Optional<RunEvent> compactNow() {
        // Between runs there is no turn number, so the wire binding carries null.
        LlmWireRecorder recorder = options.llmWire();
        Compaction.Result result = Compaction.maybeCompact(
                options.provider(), List.copyOf(messages),
                Integer.MAX_VALUE, 1, // force: pretend the context is over any threshold
                options.agentId(), new CancelSignal(),
                recorder == null ? null : recorder.bound(options.agentId(), null, "compaction"));
        if (result.event() instanceof RunEvent.Compaction) {
            messages.clear();
            messages.addAll(result.messages());
        }
        return Optional.ofNullable(result.event());
    }

    /**
     * The whole loop, running on the producer virtual thread. Terminates the stream on every path.
     *
     * @param prompt         the user message that opens the run
     * @param promptForModel the model's reading of it (card 247), or null for the prompt itself
     * @param attachments    images riding along with the prompt, or null for a text-only run
     * @param signal         cooperative cancellation, checked at the loop's safe points
     * @param emit           the event sink of the owning {@link EventStream}
     */
    private void loop(String prompt, String promptForModel,
                      List<RunEvent.Attachment> attachments, CancelSignal signal,
                      Consumer<RunEvent> emit) {
        String agentId = options.agentId();
        // The loop owns its producer thread, so the MDC set here
        // prefixes EVERY log line written below it (provider, tools, hooks,
        // subagent children each run their own loop) with [agentId] — see the
        // %X{agentId} pattern in logback.xml. Removed in the finally: virtual
        // threads die with the run, but hygiene keeps a pooled future honest.
        org.slf4j.MDC.put("agentId", agentId);
        long startedAtNanos = System.nanoTime();
        try {
            runLoop(prompt, promptForModel, attachments, signal, emit, agentId);
        } finally {
            // One operator line per run (the JSONL stays the source of truth).
            org.slf4j.LoggerFactory.getLogger(Agent.class).info("run finished in {} ms",
                    (System.nanoTime() - startedAtNanos) / 1_000_000);
            org.slf4j.MDC.remove("agentId");
        }
    }

    /**
     * The loop body behind the MDC bracket — unchanged semantics.
     *
     * @param prompt         the user message that opens the run
     * @param promptForModel the model's reading of it (card 247), or null for the prompt itself
     * @param attachments    images riding along with the prompt, or null for a text-only run
     * @param signal         cooperative cancellation, checked at the loop's safe points
     * @param emit           the event sink of the owning {@link EventStream}
     * @param agentId        this agent's id, already in the MDC
     */
    private void runLoop(String prompt, String promptForModel,
                         List<RunEvent.Attachment> attachments, CancelSignal signal,
                         Consumer<RunEvent> emit, String agentId) {
        String runId = UUID.randomUUID().toString();
        int maxTokens = options.maxTokens() != null ? options.maxTokens() : DEFAULT_MAX_TOKENS;
        int compactionThreshold = options.compactionThreshold() != null
                ? options.compactionThreshold() : 100_000;

        // A SwitchableProvider reports its live name; everyone else falls back to
        // the build-time label — so a mid-session provider switch is recorded right.
        String providerLabel = options.provider().providerName();
        if (providerLabel == null) {
            providerLabel = options.providerName();
        }
        emit.accept(new RunStart(runId, agentId, options.parentId(), prompt,
                providerLabel, options.provider().modelName(), attachments, now()));
        org.slf4j.LoggerFactory.getLogger(Agent.class).info(
                "run {} started (provider {})", runId, providerLabel);
        // images BEFORE the text — the same order the Anthropic mapping expects.
        List<ProviderContent> firstUserContent = new ArrayList<>();
        if (attachments != null) {
            firstUserContent.addAll(dev.spectroscope.core.session.SessionStore.attachmentsToContent(attachments));
        }
        // Card 247: the RECORD above carries what the user wrote; the model may
        // get a second reading with the slash-skill bodies appended.
        firstUserContent.add(new TextContent(promptForModel != null ? promptForModel : prompt));
        messages.add(new ProviderMessage(ProviderMessage.Role.USER, List.copyOf(firstUserContent)));

        // Input tokens of the last completed turn — the compaction trigger.
        int lastInputTokens = 0;

        // Card 252: the withholding is stated once per run. The image lives in
        // the history, so the fence closes again on every turn of a tool-using
        // run, and one line per turn would bury the transcript in one sentence.
        boolean saidTheImagesWereWithheld = false;

        // The backend-to-LLM record (card 184). Null means no record: every
        // request then travels tap-free, byte-identical to before.
        LlmWireRecorder recorder = options.llmWire();

        try {
            for (int turn = 1; turn <= MAX_TURNS; turn++) {
                emit.accept(new TurnStart(agentId, turn, now()));

                // context introspection, opt-in via the options.
                if (Boolean.TRUE.equals(options.introspection())) {
                    emit.accept(contextInfo(turn, messages));
                }

                // Compaction hook: a no-op below the threshold. The event
                // is appended to the stream; the JSONL file is never rewritten.
                // The summarizer's own model call is on the record too, under
                // its own kind — bound to the turn that triggered it.
                Compaction.Result compacted = Compaction.maybeCompact(
                        options.provider(), List.copyOf(messages), lastInputTokens,
                        compactionThreshold, agentId, signal,
                        recorder == null ? null : recorder.bound(agentId, turn, "compaction"));
                if (compacted.event() != null) {
                    messages.clear();
                    messages.addAll(compacted.messages());
                    emit.accept(compacted.event());
                    lastInputTokens = 0; // re-measure after compaction
                }

                StringBuilder text = new StringBuilder();
                PStop.StopReason stopReason = PStop.StopReason.END_TURN;
                List<PToolCall> toolCalls = new ArrayList<>();

                // Advertise tools only to a model that speaks the tool_calls
                // protocol. Under spectro-local that is now a per-model fact: the
                // small reasoner emits the call as text and can run away in the
                // think channel, while the bigger catalogue entries handle tools
                // natively. A null/unknown provider defaults to advertising (the
                // existing behavior); only a nativeTools:false model is stripped.
                // The LIVE label, not the build-time one: a session that had run on
                // a cloud provider and then switched to the built-in reasoner was
                // still profiled as the cloud provider, so the loop advertised a
                // tool belt that model cannot call. Same reasoning as run_start.
                List<ToolSpec> advertisedTools =
                        ModelProfile.forModel(providerLabel, options.provider().modelName())
                                .nativeTools()
                                ? options.registry().specs()
                                : List.of();
                // One tap per provider call, bound to this agent and the same
                // turn number turn_start carries; the provider records the real
                // exchange through it and knows neither agent nor turn itself.
                LlmWireTap tap = recorder == null ? null : recorder.bound(agentId, turn);
                // Card 252, the fence. Asked per turn, and asked of the PROVIDER,
                // because it is the only party that can know (ollama probes
                // /api/show; an openai-compatible endpoint remembers its own
                // refusal). UNKNOWN sends: see LlmProvider#vision for why the
                // permissive direction is the safe one. The history itself is
                // untouched — the fence copies, so run_start, the session file and
                // the user's bubble keep the image. The same call guards the
                // compaction summarizer inside Compaction.maybeCompact above: one
                // decision, every door.
                VisionFence.Fenced fenced = VisionFence.fence(options.provider(), List.copyOf(messages));
                if (fenced.withheld() > 0 && !saidTheImagesWereWithheld) {
                    saidTheImagesWereWithheld = true; // once per run, not per turn
                    emit.accept(new RunEvent.ImagesWithheld(agentId, fenced.withheld(),
                            options.provider().modelName(), "no_vision", now()));
                }
                ProviderRequest request = new ProviderRequest(options.systemPrompt(),
                        fenced.messages(), advertisedTools, maxTokens,
                        effectiveReasoning(), effortOverride, signal, tap);

                // Blocking for-each over the provider stream — text deltas are passed
                // through one by one; tool calls and usage arrive at the end of the turn.
                for (ProviderEvent event : options.provider().stream(request)) {
                    switch (event) {
                        case PTextDelta delta -> {
                            text.append(delta.text());
                            emit.accept(new TextDelta(agentId, delta.text(), now()));
                        }
                        // Reasoning stream: surfaced as its own event, but NEVER appended to
                        // `text` — thinking does not re-enter the provider history (only the
                        // answer text and tool calls do), exactly as today. With thinking OFF
                        // the delta is dropped HERE: some models reason unconditionally
                        // (Ollama's gpt-oss streams message.thinking regardless of the
                        // request), so the visibility switch must hold at the harness level.
                        case PThinkingDelta t -> {
                            if (thinkingEnabled()) {
                                emit.accept(new ThinkingDelta(agentId, t.text(), now()));
                            }
                        }
                        case PToolCall call -> {
                            toolCalls.add(call);
                            emit.accept(new ToolCall(agentId, call.callId(), call.name(),
                                    call.input(), now()));
                        }
                        case PUsage usage -> {
                            // The trigger sees the REAL context size (cached tokens still
                            // occupy the window); the wire keeps the provider's raw count
                            // and carries the cache counts ADDITIVELY (absent when the
                            // provider reported none — those sessions stay byte-identical).
                            lastInputTokens = contextTokens(usage);
                            emit.accept(new Usage(agentId,
                                    usage.inputTokens(), usage.outputTokens(),
                                    usage.cacheReadTokens() > 0 ? usage.cacheReadTokens() : null,
                                    usage.cacheCreationTokens() > 0 ? usage.cacheCreationTokens() : null,
                                    now()));
                        }
                        case PStop stop -> stopReason = stop.reason();
                    }
                }

                if (stopReason == PStop.StopReason.ABORTED || signal.isCancelled()) {
                    emit.accept(new RunEnd(runId, "aborted", now()));
                    return;
                }

                // Assistant message BEFORE the tool results (API rule).
                List<ProviderContent> assistantContent = new ArrayList<>();
                if (!text.isEmpty()) {
                    assistantContent.add(new TextContent(text.toString()));
                }
                toolCalls.forEach(call ->
                        assistantContent.add(new ToolCallContent(call.callId(), call.name(), call.input())));
                if (!assistantContent.isEmpty()) {
                    messages.add(new ProviderMessage(ProviderMessage.Role.ASSISTANT, assistantContent));
                }

                if (stopReason != PStop.StopReason.TOOL_USE || toolCalls.isEmpty()) {
                    emit.accept(new RunEnd(runId, stopReasonName(stopReason), now()));
                    return;
                }

                // Execute the tools; ALL results of the round go into ONE user message.
                List<ProviderContent> results = new ArrayList<>();
                // view_image/view_file: tools may hand the loop images or documents
                // to SHOW the model — they ride the tool-results message as provider
                // content (after the results; the mappers keep the API order).
                List<ProviderContent> attachedContent = new ArrayList<>();
                for (PToolCall call : toolCalls) {
                    GuardedResult outcome = executeToolCall(call, agentId, signal, emit,
                            attachment -> attachedContent.add(switch (attachment) {
                                case Tool.AttachedImage image -> new ImageContent(
                                        image.mediaType(), image.dataBase64());
                                case Tool.AttachedDocument document -> new DocumentContent(
                                        document.mediaType(), document.dataBase64(),
                                        document.name());
                            }));
                    boolean isError = outcome.output().startsWith("ERROR: ");
                    emit.accept(new ToolResult(agentId, call.callId(), outcome.output(), isError,
                            outcome.durationMs(), outcome.gateWaitMs(), now()));
                    // Denial/error goes back to the model as a tool_result for self-correction.
                    results.add(new ToolResultContent(call.callId(), outcome.output(), isError));
                }
                results.addAll(attachedContent);
                messages.add(new ProviderMessage(ProviderMessage.Role.USER, results));
            }
            emit.accept(new RunEnd(runId, "max_turns", now()));
        } catch (RuntimeException error) {
            if (signal.isCancelled()) {
                emit.accept(new RunEnd(runId, "aborted", now()));
                return;
            }
            emit.accept(new ErrorEvent(agentId, error.getMessage(), now()));
            emit.accept(new RunEnd(runId, "error", now()));
        }
    }

    /**
     * One guarded call's outcome, timed honestly (card 111): the output plus the
     * two clocks the wire keeps apart.
     *
     * @param output     the tool output, or an {@code ERROR: } string
     * @param durationMs execution time only — 0 when the tool never ran
     * @param gateWaitMs time parked at the permission gate; null when no gate was involved
     */
    private record GuardedResult(String output, long durationMs, Long gateWaitMs) {}

    /**
     * Looks the tool up and runs it behind the permission handshake. Unknown tools and
     * denials come back as {@code ERROR: } strings — input for the model, never exceptions.
     *
     * @param call    the tool invocation as the provider streamed it
     * @param agentId the agent the call runs under, stamped on the emitted events
     * @param signal  cooperative cancellation, passed through to hooks and the tool
     * @param emit    sink for permission events and tool-emitted domain events
     * @return the timed outcome; an unknown tool "ran" for 0 ms and saw no gate
     */
    private GuardedResult executeToolCall(PToolCall call, String agentId, CancelSignal signal,
                                          Consumer<RunEvent> emit, Consumer<Tool.Attachment> attach) {
        return options.registry().get(call.name())
                .map(tool -> runGuarded(tool, call, agentId, signal, emit, attach))
                .orElse(new GuardedResult("ERROR: unknown tool: " + call.name(), 0, null));
    }

    /**
     * The permission handshake: emit the request, block on the broker, emit the decision.
     * Card 111 splits the clocks here: {@code durationMs} starts when the tool actually
     * runs — the broker wait is measured separately and travels as {@code gateWaitMs},
     * so a slow operator never paints the tool as slow.
     *
     * @param tool    the resolved tool implementation
     * @param call    the invocation carrying the call id and the model-supplied input
     * @param agentId the agent the call runs under
     * @param signal  cooperative cancellation, handed to hooks and the tool
     * @param emit    sink for the permission events and tool-emitted domain events
     * @return the timed outcome — output, execution time, and the gate wait when one parked the call
     */
    private GuardedResult runGuarded(Tool tool, PToolCall call, String agentId, CancelSignal signal,
                                     Consumer<RunEvent> emit, Consumer<Tool.Attachment> attach) {
        // pre_tool_use runs BEFORE the permission gate. A block short-circuits: no
        // permission events, no execute — the model sees it as this tool_result
        // ERROR, and the RUN sees it as the hook_decision events emitted first.
        // Card 195 added those because the ERROR string names a reason and no
        // hook, and a timed-out hook used to leave no trace at all.
        if (options.hooks() != null) {
            var pre = options.hooks().preToolUse(call.name(), call.input(), options.cwd(), signal);
            emitHookRuns(pre.runs(), call, agentId, emit);
            if (pre.blocked()) {
                return new GuardedResult("ERROR: blocked by pre_tool_use hook"
                        + (pre.reason() == null ? "" : ": " + pre.reason()), 0, null);
            }
        }
        Long gateWaitMs = null;
        if (tool.needsPermission()) {
            PermissionRequest request = new PermissionRequest(
                    agentId, call.callId(), call.name(), call.input(), now());
            emit.accept(request);
            // Blocking on purpose: this virtual thread pauses until the human decided.
            long parkedAt = now();
            boolean allowed = options.onPermission().decide(request);
            gateWaitMs = now() - parkedAt;
            emit.accept(new PermissionDecision(call.callId(), allowed, now()));
            if (!allowed) {
                // Denied means the tool never executed — 0 ms, only the wait is real.
                return new GuardedResult("ERROR: the user denied the execution.", 0, gateWaitMs);
            }
        }
        // the context carries the loop's own event sink plus the call ids, so
        // artifact-producing tools (generate_image) can publish additive domain events;
        // view_image hands images to SHOW the model through the attach sink.
        // Card 265: the loop provides the wait sink, because only the loop can
        // subtract. A tool that parks on a PERSON inside execute (ask_user_question
        // today) reports those milliseconds here, and they leave durationMs the
        // same way card 111 took the gate's wait out of it — a four-minute answer
        // must not be recorded as a four-minute tool call. Every existing tool
        // reports nothing and is timed exactly as before.
        java.util.concurrent.atomic.AtomicLong humanWaitMs = new java.util.concurrent.atomic.AtomicLong();
        long startedAt = now();
        String output = tool.execute(call.input(),
                new Tool.ToolContext(options.cwd(), signal, agentId, call.callId(), emit, attach,
                        humanWaitMs::addAndGet));
        long durationMs = Math.max(0, now() - startedAt - humanWaitMs.get());
        // post_tool_use runs AFTER execute — advisory only, never rewrites the
        // result. Only a hook the deadline killed comes back: a non-zero exit is
        // not a finding in this phase, and reporting one would invent a veto
        // post_tool_use does not have.
        if (options.hooks() != null) {
            emitHookRuns(options.hooks().postToolUse(call.name(), call.input(), output,
                    options.cwd(), signal), call, agentId, emit);
        }
        return new GuardedResult(output, durationMs, gateWaitMs);
    }

    /**
     * Turns what the hooks did into wire lines. Additive and quiet: an empty
     * list — the normal case, every hook agreeing — emits nothing at all.
     *
     * @param runs    the notable hook runs, in the order the runner walked them
     * @param call    the invocation they applied to, for the joining call id
     * @param agentId the agent the call runs under
     * @param emit    the loop's event sink
     */
    private void emitHookRuns(List<HookRunner.HookRun> runs, PToolCall call,
                              String agentId, Consumer<RunEvent> emit) {
        for (HookRunner.HookRun run : runs) {
            emit.accept(new HookDecision(agentId, call.callId(), call.name(), run.event(),
                    run.matcher(), run.command(), run.timeoutSeconds(),
                    run.verdict().wireName(), run.reason(), now()));
        }
    }

    /**
     * estimates what the NEXT provider call will carry — system
     * prompt, tool schemas, conversation. Everything is chars/4; the real token
     * truth arrives afterwards with the usage event.
     *
     * @param turn     the turn the estimate precedes (1-based)
     * @param messages the history that will ride along with the next request
     * @return the additive {@code context_info} event, ready to emit
     */
    private ContextInfo contextInfo(int turn, List<ProviderMessage> messages) {
        int systemChars = options.systemPrompt().length();
        int schemaChars = options.registry().specs().stream()
                .mapToInt(spec -> spec.name().length() + spec.description().length()
                        + spec.inputSchema().toString().length())
                .sum();
        int conversationChars = messages.stream()
                .flatMap(message -> message.content().stream())
                .mapToInt(Agent::charsOf)
                .sum();
        String schemaText = options.registry().specs().stream()
                .map(spec -> spec.name() + " — " + spec.description() + "\n" + spec.inputSchema())
                .reduce((a, b) -> a + "\n\n" + b).orElse("");
        List<ContextPart> parts = List.of(
                part("system prompt", systemChars, options.systemPrompt()),
                part("tool schemas", schemaChars, schemaText),
                part("conversation", conversationChars, renderConversation(messages)));
        int estimatedTokens = parts.stream().mapToInt(ContextPart::estTokens).sum();
        int threshold = options.compactionThreshold() != null
                ? options.compactionThreshold() : 100_000;
        return new ContextInfo(options.agentId(), turn, messages.size(),
                estimatedTokens, threshold, parts, now());
    }

    /** Context-part texts are capped for the wire — a whole conversation can be
     *  megabytes; the char counts stay the full truth regardless. */
    private static final int CONTEXT_PART_TEXT_CAP = 16_384;

    /** Builds one labeled slice of the context estimate, deriving its tokens as
     *  chars/4 and carrying the (capped) content itself — what actually rides
     *  to the provider, readable in the trace (card 86 follow-up).
     *  @param label the slice name shown by the introspection UI
     *  @param chars the raw character count behind the estimate
     *  @param text  the slice's content, capped here */
    private static ContextPart part(String label, int chars, String text) {
        return new ContextPart(label, chars, chars / 4, capped(text));
    }

    /** Caps a part text with an honest marker naming the full size. */
    private static String capped(String text) {
        if (text.length() <= CONTEXT_PART_TEXT_CAP) {
            return text;
        }
        return text.substring(0, CONTEXT_PART_TEXT_CAP)
                + "\n… (truncated, full size " + text.length() + " chars)";
    }

    /** Renders the provider history readably: one block per message, calls and
     *  results in their string forms, binary payloads as size notes. */
    private static String renderConversation(List<ProviderMessage> messages) {
        StringBuilder sb = new StringBuilder();
        for (ProviderMessage message : messages) {
            sb.append(message.role()).append(":\n");
            for (ProviderContent content : message.content()) {
                sb.append(switch (content) {
                    case TextContent text -> text.text();
                    case ImageContent image ->
                            "[image · " + image.dataBase64().length() + " base64 chars]";
                    case DocumentContent document -> "[document " + document.name()
                            + " · " + document.dataBase64().length() + " base64 chars]";
                    case ToolCallContent call -> "tool_call " + call.name() + " " + call.input();
                    case ToolResultContent result -> "tool_result " + result.output();
                }).append("\n");
            }
            sb.append("\n");
        }
        return sb.toString();
    }

    /** The char weight one content block adds; calls and results count their string forms.
     *  @param content one block of a provider message — text, image, tool call or result
     *  @return the character count that block contributes to the estimate */
    private static int charsOf(ProviderContent content) {
        return switch (content) {
            case TextContent text -> text.text().length();
            case ImageContent image -> image.dataBase64().length();
            case DocumentContent document -> document.dataBase64().length();
            case ToolCallContent call -> call.toString().length();
            case ToolResultContent result -> result.toString().length();
        };
    }

    /**
     * The compaction trigger's view of a usage event: cached tokens still occupy
     * the context window, so they count toward the threshold even though the
     * provider bills them outside {@code inputTokens}. The wire-format usage
     * event keeps the raw count.
     *
     * @param usage the provider's raw per-call token report
     * @return input plus cache-read plus cache-creation tokens — the real window size
     */
    static int contextTokens(PUsage usage) {
        return usage.inputTokens() + usage.cacheReadTokens() + usage.cacheCreationTokens();
    }

    /** The single timestamp source of the loop — epoch millis, the wire format's {@code ts}. */
    private static long now() {
        return System.currentTimeMillis();
    }

    /** Maps the provider-neutral stop reason onto its snake_case wire name.
     *  @param reason the reason the provider stream ended
     *  @return the {@code run_end.stopReason} string, stable on the wire */
    private static String stopReasonName(PStop.StopReason reason) {
        return switch (reason) {
            case END_TURN -> "end_turn";
            case MAX_TOKENS -> "max_tokens";
            case TOOL_USE -> "tool_use";
            case ABORTED -> "aborted";
        };
    }
}
