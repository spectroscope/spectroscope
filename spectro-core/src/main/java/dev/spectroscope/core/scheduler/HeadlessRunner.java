package dev.spectroscope.core.scheduler;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.PermissionBroker;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.config.ProviderFactory;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.hooks.HookRunner;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.core.trace.JsonlSink;
import dev.spectroscope.core.trace.OtlpSink;
import dev.spectroscope.core.trace.TracingPort;
import dev.spectroscope.core.trace.TracingPorts;
import dev.spectroscope.core.tools.StandardTools;
import dev.spectroscope.core.tools.ToolRegistry;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import dev.spectroscope.core.wire.LlmWireRecorder;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * The headless building block. Runs one prompt (a job or an ad-hoc
 * `spectroscope run`) unattended: mints a normal JSONL session, drives the agent, writes
 * the job state, and raises a desktop notification. No REPL, no y/N — the permission
 * policy is a constant {@link PermissionBroker} the caller passes in.
 *
 * <p>The core speaks only events, so this class never prints application output:
 * every log line goes through the injected {@code log} callback. The sole exception
 * is the deliberate terminal bell in {@link #notify} on non-macOS systems.
 */
public final class HeadlessRunner {

    /** System prompt for unattended operation (used by both `spectroscope run` and cron). */
    public static final String HEADLESS_SYSTEM_PROMPT =
            "You are spectroscope in unattended operation. There is no human at the terminal: "
                    + "do not ask questions, carry out the assignment with the available tools, "
                    + "and summarize the result briefly at the end. If a tool is denied, do not "
                    + "retry it — state the denial in your result.";

    /** The default identity of a headless run — the solo agent. */
    private static final String DEFAULT_AGENT_ID = "main";

    private final ObjectMapper mapper;
    private final SpectroConfig config;
    private final LlmProvider providerOverride;
    /** The agent id every event of a run carries (fleet nodes override it). */
    private final String agentId;
    /** An extra REGISTERED port next to the required JSONL sink; null = none. */
    private final TracingPort auxiliaryPort;
    /** An externally-owned cancel signal (a fleet node's, so a hub ctl{stop} can
     *  end a running turn); null = mint a fresh one per run, the frozen default. */
    private final CancelSignal externalSignal;
    /** A caller-supplied permission broker (a fleet node's ask-mode PARKING
     *  broker) that replaces the fixed readonly/auto policy; null = the constant
     *  {@code request -> autoApprove} broker, the frozen default. */
    private final PermissionBroker externalBroker;
    /** The trigger stamp for this run's {@code run_start} (card 72) — what woke
     *  a triggered node's run. Only the runner's caller knows it, so it is
     *  stamped at this seam, never inside the Agent; null = no stamp, the
     *  frozen default. */
    private final String trigger;

    /**
     * The production constructor — the provider is built fresh from config per run.
     *
     * @param mapper the module's shared, configured ObjectMapper
     * @param config the effective configuration (file plus overrides)
     */
    public HeadlessRunner(ObjectMapper mapper, SpectroConfig config) {
        this(mapper, config, null);
    }

    /**
     * Visible for tests: inject a scripted provider instead of the config-built one.
     *
     * @param mapper           the module's shared, configured ObjectMapper
     * @param config           the effective configuration
     * @param providerOverride the scripted provider, or null to build from config
     */
    HeadlessRunner(ObjectMapper mapper, SpectroConfig config, LlmProvider providerOverride) {
        this(mapper, config, providerOverride, DEFAULT_AGENT_ID, null, null, null, null);
    }

    private HeadlessRunner(ObjectMapper mapper, SpectroConfig config, LlmProvider providerOverride,
                           String agentId, TracingPort auxiliaryPort, CancelSignal externalSignal,
                           PermissionBroker externalBroker, String trigger) {
        this.mapper = mapper;
        this.config = config;
        this.providerOverride = providerOverride;
        this.agentId = agentId;
        this.auxiliaryPort = auxiliaryPort;
        this.externalSignal = externalSignal;
        this.externalBroker = externalBroker;
        this.trigger = trigger;
    }

    /**
     * A copy of this runner whose runs carry {@code agentId} instead of
     * "main" — identity at the source: a fleet node's events, session JSONL
     * and any auxiliary port all agree on who ran, with no downstream
     * relabeling.
     *
     * @param agentId the fleet identity (a node id) every event will carry
     * @return the re-identified runner; this instance is unchanged
     */
    public HeadlessRunner withIdentity(String agentId) {
        return new HeadlessRunner(mapper, config, providerOverride, agentId, auxiliaryPort,
                externalSignal, externalBroker, trigger);
    }

    /**
     * A copy of this runner that REGISTERS {@code port} next to the required
     * JSONL sink: durability first — the session file sees every event before
     * the auxiliary port, and the port's THROWN failures are isolated
     * (warn-once), never the run's. Isolation cannot cover blocking: the port
     * runs on the run loop's thread, so a port that might stall (a network
     * transport) must decouple itself behind its own bounded queue and
     * thread, turning a stall into counted loss instead of a hang.
     *
     * @param port the auxiliary consumer (a bus publisher, a metrics tap, …)
     * @return the extended runner; this instance is unchanged
     */
    public HeadlessRunner withAuxiliaryPort(TracingPort port) {
        return new HeadlessRunner(mapper, config, providerOverride, agentId, port,
                externalSignal, externalBroker, trigger);
    }

    /**
     * A copy of this runner whose run cancels off an EXTERNALLY-owned
     * {@link CancelSignal} instead of a fresh per-run one. This is the seam a
     * fleet node uses: it holds the signal, wires a hub {@code ctl{stop}} to
     * {@link CancelSignal#cancel()}, and a running turn ends "aborted". Unset
     * (the default), a fresh signal is minted per run — behaviour is unchanged.
     *
     * @param signal the caller-owned cancel signal to drive this runner's runs
     * @return the re-signalled runner; this instance is unchanged
     */
    public HeadlessRunner withCancelSignal(CancelSignal signal) {
        return new HeadlessRunner(mapper, config, providerOverride, agentId, auxiliaryPort,
                signal, externalBroker, trigger);
    }

    /**
     * A copy of this runner whose runs decide permissions through
     * {@code broker} instead of the fixed readonly/auto policy. This is the
     * ask-mode seam a fleet node uses: the broker PARKS a needsPermission tool
     * until an operator answers over the hub. Unset (the default), the constant
     * {@code request -> autoApprove} broker decides — behaviour is unchanged.
     *
     * @param broker the caller-owned permission broker to drive this runner's runs
     * @return the re-brokered runner; this instance is unchanged
     */
    public HeadlessRunner withBroker(PermissionBroker broker) {
        return new HeadlessRunner(mapper, config, providerOverride, agentId, auxiliaryPort,
                externalSignal, broker, trigger);
    }

    /**
     * A copy of this runner whose {@code run_start} carries {@code trigger}
     * (card 72) — the "what woke this run" stamp of a triggered fleet node.
     * The stamp is applied at the runner's event seam because only the
     * caller knows the trigger; the Agent stays untouched. Every consumer
     * (session JSONL, auxiliary port, onEvent) sees the same stamped event.
     * Unset (the default), the run_start is byte-identical to before.
     *
     * @param trigger the stamp, e.g. "fs #4 watch:/drop"; null keeps the default
     * @return the stamped runner; this instance is unchanged
     */
    public HeadlessRunner withTrigger(String trigger) {
        return new HeadlessRunner(mapper, config, providerOverride, agentId, auxiliaryPort,
                externalSignal, externalBroker, trigger);
    }

    /**
     * The immutable outcome of one headless run. {@code exitOk} is true only when the
     * run ended regularly with {@code end_turn} and no error surfaced.
     *
     * @param finalText  the text of the last turn — the run's final answer
     * @param stopReason end_turn | aborted | max_turns | tool_use | error: ...
     * @param sessionId  the session file id (the full history is reachable through it)
     * @param exitOk     true iff the run ended regularly with end_turn
     */
    public record Outcome(String finalText, String stopReason, String sessionId, boolean exitOk) {
    }

    /**
     * Runs one prompt once and returns the outcome. Stores every event into a fresh
     * JSONL session (the SessionStore mints the canonical id). Never throws: an
     * unexpected failure is folded into the outcome as {@code exitOk == false}.
     *
     * @param prompt      the task text
     * @param cwd         the tools' path sandbox (the job's cwd, or the process cwd for `run`)
     * @param autoApprove headless policy: true = approve every tool (auto),
     *                    false = deny every needsPermission tool (readonly)
     * @param maxTurns    optional 1-based turn ceiling; null = unlimited. When a
     *                    {@code turn_start} exceeds it, the run is cancelled from the outside
     * @param onEvent     called for every RunEvent (the `run` subcommand emits NDJSON here);
     *                    may be null
     * @param log         log sink (the core never prints); never null
     * @return the folded outcome — failures land in {@code exitOk == false}, never thrown
     */
    public Outcome runOnce(String prompt, Path cwd, boolean autoApprove, Integer maxTurns,
                           Consumer<RunEvent> onEvent, Consumer<String> log) {
        return runOnce(prompt, cwd, autoApprove, maxTurns, onEvent, log, null, List.of());
    }

    /**
     * Attachment overload: run with image attachments. The blob files live under the
     * session's own blobs directory, so the caller mints the {@link SessionStore}
     * FIRST, stores the blobs against its id, and hands both in; {@code store} may
     * be null for attachment-free calls (the runner then mints one as before).
     *
     * @param prompt        the task text
     * @param cwd           the tools' path sandbox for this run
     * @param autoApprove   headless policy: true approves every tool, false denies each request
     * @param maxTurns      optional 1-based turn ceiling; null = unlimited
     * @param onEvent       called for every RunEvent; may be null
     * @param log           log sink (the core never prints); never null
     * @param providedStore the pre-minted session store, or null to mint a fresh one
     * @param attachments   image attachments already stored against the session (may be empty)
     * @return the folded outcome — failures land in {@code exitOk == false}, never thrown
     */
    public Outcome runOnce(String prompt, Path cwd, boolean autoApprove, Integer maxTurns,
                           Consumer<RunEvent> onEvent, Consumer<String> log,
                           SessionStore providedStore, List<RunEvent.Attachment> attachments) {
        ToolRegistry registry = new ToolRegistry(); // standard tools only — never the spawn tools
        StandardTools.all().forEach(registry::register);

        LlmProvider provider = providerOverride != null
                ? providerOverride
                : ProviderFactory.providerFromConfig(config); // the model lives in the provider

        // The store BEFORE the agent: the llm-wire recorder (card 184) shares the
        // session id, and the agent needs it at build time. A triggered node's
        // provided store reuses one file across fires — the recorder appends the
        // same way.
        SessionStore store = providedStore != null
                ? providedStore
                : new SessionStore(); // canonical sessionId + JSONL append
        LlmWireRecorder llmWire = LlmWireRecorder.forSession(store.id());

        // Headless there is no y/N. The policy is the whole broker: readonly => always
        // false, auto => always true — auditable as a permission_decision event. A
        // fleet node in "ask" mode injects its own PARKING broker instead (block 4);
        // when it does, it decides every call and autoApprove is not consulted.
        //
        // Card 199 changes nothing about that decision and everything about what
        // is written down. Headless is the one surface that never consults the
        // allowlist — so it has no wildcard to widen and no tier to enforce, and
        // "--auto approves eval-execute" is the operator's own choice made once
        // at launch rather than a rule hidden in a settings file. What it owed
        // was the record: every call now lands in the gate audit sidecar with
        // the tier it resolved to and the map version that said so, so a
        // headless run is as readable after the fact as an interactive one.
        dev.spectroscope.core.permission.GateAudit gateAudit =
                dev.spectroscope.core.permission.GateAudit.forSession(store.id());
        dev.spectroscope.core.permission.Allowlist noAllowlist =
                dev.spectroscope.core.permission.Allowlist.fromEntries(java.util.List.of());
        PermissionBroker policy = externalBroker != null ? externalBroker : (request -> autoApprove);
        PermissionBroker broker = request -> {
            boolean allowed = policy.decide(request);
            gateAudit.record(request, externalBroker != null ? "node-broker"
                    : (autoApprove ? "policy:auto" : "policy:readonly"),
                    allowed, noAllowlist.decide(request));
            return allowed;
        };

        Agent agent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt(HEADLESS_SYSTEM_PROMPT)
                .registry(registry)
                .cwd(cwd)                              // path sandbox = the run's working directory
                .providerName(config.provider())       // run_start metadatum
                .onPermission(broker)
                .agentId(agentId)                      // "main", or a fleet node's identity
                .thinking(config.thinking())           // surface reasoning in the NDJSON stream too
                .llmWire(llmWire)                      // the backend-to-LLM record (card 184)
                // Card 195: the SAME config-only shell hooks the REPL and the
                // server load. This line was missing, and its absence was
                // silent in the worst possible direction — `spectro run`, every
                // cron job and every fleet node built an agent with no runner
                // at all, so a blocking guard the settings file declares,
                // `spectro doctor` counts and the settings page now lists was
                // inert on every surface except an interactive session. Unlike
                // the allowlist two blocks up, there is nothing about headless
                // that argues for skipping these: a hook comes from config and
                // never from model output, so it is exactly as trustworthy here
                // as there, and the operator asked for it either way.
                .hooks(HookRunner.load(config.hooks()))
                .build());
        // The tracing seam (KONZEPT §4.3): persistence as a required port —
        // headless failure behaviour stays exactly the inline sink's. An
        // auxiliary port (a node's bus publisher) is REGISTERED: durability
        // first, isolation for the extra consumer.
        TracingPorts tracing = new TracingPorts().require(new JsonlSink(store));
        OtlpSink.fromConfig(config, store.id()).ifPresent(tracing::register);
        if (auxiliaryPort != null) {
            tracing.register(auxiliaryPort);
        }
        // An externally-owned signal (a fleet node's) lets a hub ctl{stop} end a
        // running turn; without one, a fresh per-run signal — the frozen default.
        CancelSignal signal = externalSignal != null ? externalSignal : new CancelSignal();
        StringBuilder finalText = new StringBuilder();
        String stopReason = "error";
        String errorMessage = "";
        boolean turnLimitHit = false;

        try (EventStream events = agent.run(prompt, new RunOptions(signal, attachments))) {
            for (RunEvent rawEvent : events) {
                // Card 72: the run_start is re-stamped BEFORE any consumer sees
                // it — the session file, the bus and onEvent must never disagree
                // about what woke the run.
                RunEvent event = trigger != null && rawEvent instanceof RunEvent.RunStart start
                        ? new RunEvent.RunStart(start.runId(), start.agentId(), start.parentId(),
                                start.prompt(), start.provider(), start.model(), trigger,
                                start.attachments(), start.ts())
                        : rawEvent;
                tracing.onEvent(event); // headless runs are normal sessions too
                if (onEvent != null) {
                    onEvent.accept(event);
                }
                switch (event) {
                    case RunEvent.TurnStart turn -> {
                        finalText.setLength(0); // only the last turn's text is the final result
                        if (maxTurns != null && turn.turn() > maxTurns) {
                            turnLimitHit = true;
                            signal.cancel(); // the turn brake, applied from the outside as a consumer
                        }
                    }
                    case RunEvent.TextDelta delta -> finalText.append(delta.text());
                    case RunEvent.RunEnd end -> stopReason = end.stopReason();
                    case RunEvent.ErrorEvent error -> errorMessage = error.message();
                    default -> { }
                }
            }
        } catch (RuntimeException failure) {
            errorMessage = describe(failure);
        } finally {
            llmWire.close(); // per-run handle; a triggered node reopens per fire, appending
        }

        boolean exitOk = "end_turn".equals(stopReason) && !turnLimitHit && errorMessage.isEmpty();
        String effectiveStop = turnLimitHit ? "max_turns"
                : !errorMessage.isEmpty() ? "error: " + errorMessage
                : stopReason;
        return new Outcome(finalText.toString(), effectiveStop, store.id(), exitOk);
    }

    /**
     * Runs one job once, writes its {@link JobState}, and raises a notification.
     * A missing cwd fails fast without touching the model. Never throws.
     *
     * @param job the validated job definition to execute
     * @param log log sink for progress lines
     * @return the state that was just persisted to jobs-state.json
     */
    public JobState runJob(Job job, Consumer<String> log) {
        String startedAt = Instant.now().toString();
        if (!Files.exists(Path.of(job.cwd()))) {
            JobState state = new JobState(startedAt, JobState.FAILED,
                    "error: cwd \"" + job.cwd() + "\" does not exist", null, "");
            JobStateStore.write(mapper, job.id(), state);
            notify("spectroscope: " + job.id() + " failed", state.stopReason(), log);
            return state;
        }
        boolean autoApprove = Job.AUTO.equals(job.permissions());
        Outcome outcome = runOnce(job.prompt(), Path.of(job.cwd()), autoApprove, null, null, log);

        String preview = preview(outcome.finalText());
        JobState state = new JobState(startedAt,
                outcome.exitOk() ? JobState.OK : JobState.FAILED,
                outcome.stopReason(), outcome.sessionId(), preview);
        JobStateStore.write(mapper, job.id(), state);
        notify("spectroscope: " + job.id() + " " + state.status(),
                outcome.exitOk() ? (preview.isEmpty() ? "Run finished." : preview) : state.stopReason(),
                log);
        return state;
    }

    /**
     * First 200 characters of the final answer, whitespace collapsed.
     *
     * @param finalText the run's full final answer
     * @return the single-line preview for notifications and jobs-state.json
     */
    private static String preview(String finalText) {
        String collapsed = finalText.replaceAll("\\s+", " ").strip();
        return collapsed.length() > 200 ? collapsed.substring(0, 200) : collapsed;
    }

    /**
     * Desktop notification: macOS via osascript, otherwise a terminal bell plus a log
     * line. Never throws — a failed notification must not fail the run.
     *
     * @param title   the notification headline (job id plus status)
     * @param message the body text — sanitized and truncated before it reaches AppleScript
     * @param log     receives the fallback line and any failure note
     */
    public static void notify(String title, String message, Consumer<String> log) {
        String os = System.getProperty("os.name", "").toLowerCase();
        if (os.contains("mac")) {
            // Neutralize quotes and backslashes, or the AppleScript breaks.
            String safeTitle = sanitize(title);
            String safeMessage = sanitize(message);
            try {
                new ProcessBuilder("osascript", "-e",
                        "display notification \"" + safeMessage + "\" with title \"" + safeTitle + "\"")
                        .start(); // fire and forget — do not block the run on the banner
            } catch (IOException failure) {
                log.accept("Notification failed: " + failure.getMessage());
            }
        } else {
            System.out.print("\007"); // terminal bell — deliberate CLI/notification concern
            log.accept("[NOTIFY] " + title + ": " + message);
        }
    }

    /**
     * Strips quotes and backslashes (the AppleScript breakers) and caps the length.
     *
     * @param text the raw notification text
     * @return a string safe to inline into the osascript command
     */
    private static String sanitize(String text) {
        String cleaned = text.replaceAll("[\"\\\\]", " ");
        return cleaned.length() > 200 ? cleaned.substring(0, 200) : cleaned;
    }

    /**
     * A human-readable one-liner for a caught failure.
     *
     * @param failure the exception to describe (null tolerated)
     * @return its message, the toString fallback, or "unknown error"
     */
    private static String describe(Throwable failure) {
        if (failure == null) {
            return "unknown error";
        }
        return failure.getMessage() != null ? failure.getMessage() : failure.toString();
    }

    /**
     * Tiny helper for the read-modify-write of jobs-state.json. Package-private so the
     * scheduler (overlap skips) can record a state without a full run.
     */
    static final class JobStateStore {
        /** Static utility — never instantiated. */
        private JobStateStore() {
        }

        /**
         * Read-modify-write of jobs-state.json: merges this job's state into the
         * map and pretty-prints the whole file back.
         *
         * @param mapper the shared ObjectMapper
         * @param id     the job id — the map key
         * @param state  the state to record for that id
         */
        static void write(ObjectMapper mapper, String id, JobState state) {
            Path spectroDir = Path.of(System.getProperty("user.home"), ".spectro");
            Path path = spectroDir.resolve("jobs-state.json");
            try {
                Files.createDirectories(spectroDir);
                Map<String, JobState> all = read(mapper, path);
                all.put(id, state);
                Files.writeString(path,
                        mapper.writerWithDefaultPrettyPrinter().writeValueAsString(all) + "\n");
            } catch (IOException failure) {
                throw new UncheckedIOException("cannot write " + path, failure);
            }
        }

        /**
         * Loads the full state map; a missing or corrupt file yields an empty map —
         * a broken state file must not block the scheduler.
         *
         * @param mapper the shared ObjectMapper
         * @param path   the jobs-state.json location
         * @return the id → state map, mutable and insertion-ordered
         */
        static Map<String, JobState> read(ObjectMapper mapper, Path path) {
            if (!Files.exists(path)) {
                return new LinkedHashMap<>();
            }
            try {
                return mapper.readValue(Files.readString(path),
                        mapper.getTypeFactory().constructMapType(
                                LinkedHashMap.class, String.class, JobState.class));
            } catch (IOException broken) {
                // A corrupt state file must not block the scheduler.
                return new LinkedHashMap<>();
            }
        }
    }
}
