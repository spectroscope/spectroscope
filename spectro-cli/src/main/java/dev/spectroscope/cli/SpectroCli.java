package dev.spectroscope.cli;

import dev.spectroscope.cli.speech.SpeechRenderer;
import dev.spectroscope.cli.speech.TtsConfig;
import dev.spectroscope.cli.trace.TracingProvider;
import dev.spectroscope.cli.voice.Transcriber;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.PermissionBroker;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.config.WorkspaceResolver;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.hooks.HookRunner;
import dev.spectroscope.core.image.GenerateImageTool;
import dev.spectroscope.core.image.ImageStore;
import dev.spectroscope.core.mcp.McpServerRegistry;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.OllamaOptions;
import dev.spectroscope.core.provider.OllamaProvider;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.core.trace.JsonlSink;
import dev.spectroscope.core.wire.LlmWireRecorder;
import dev.spectroscope.core.trace.OtlpSink;
import dev.spectroscope.core.trace.TracingPorts;
import dev.spectroscope.core.skills.SkillLibrary;
import dev.spectroscope.core.subagents.SubagentConfig;
import dev.spectroscope.core.subagents.SubagentManager;
import dev.spectroscope.core.permission.Allowlist;
import dev.spectroscope.core.tools.DefaultHttpFetcher;
import dev.spectroscope.core.tools.StandardTools;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import dev.spectroscope.core.tools.UpdatePlanTool;
import dev.spectroscope.core.tools.WebFetchTool;
import dev.spectroscope.core.web.BrowsePageTool;
import dev.spectroscope.core.web.DefaultChromeRunner;
import dev.spectroscope.core.web.WebSearchTool;
import picocli.CommandLine;
import picocli.CommandLine.Command;
import picocli.CommandLine.Option;
import picocli.CommandLine.Parameters;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;

/**
 * The CLI: the complete harness plus the Claude-Code
 * style extras — a settings hierarchy with a permission allowlist, slash
 * commands inside the REPL (/help /cost /model /sessions /compact /clear),
 * a doctor subcommand, and a third provider (openai-compatible).
 *
 * <p>Run with: {@code ./gradlew :spectro-cli:run -q --console=plain}</p>
 */
@Command(name = "spectroscope", mixinStandardHelpOptions = true,
        subcommands = {RunCommand.class, NodeCommand.class, CronCommand.class, DoctorCommand.class,
                LevelCommand.class},
        description = "spectroscope — an agent harness.")
public final class SpectroCli implements Runnable {

    private static final String BASE_SYSTEM_PROMPT =
            "You are spectroscope, a coding agent in the terminal. Use the tools when they help, "
                    + "and answer in English. Working directory: ";

    private static final String MAIN_AGENT_ID = "main";

    /** The console answer that approves a permission request ("? [y/N]"). */
    private static final String APPROVAL_ANSWER = "y";

    /** The sessions overview clips each first prompt to this many chars. */
    private static final int FIRST_PROMPT_PREVIEW_CHARS = 50;

    @Option(names = "--resume", description = "Resume the session with this id.")
    String resume;

    @Option(names = "--provider", description = "anthropic, ollama or openai (overrides the config).")
    String providerFlag;

    @Option(names = "--model", description = "Model id (overrides the config).")
    String modelFlag;

    @Option(names = "--base-url", description = "Provider base URL (overrides the config).")
    String baseUrlFlag;

    @Option(names = "--compaction-threshold", description = "Compaction threshold in input tokens.")
    Integer compactionThresholdFlag;

    @Option(names = "--workspace",
            description = "The agent's working directory (default: a per-session temp folder).")
    String workspaceFlag;

    @Option(names = "--verbose", description = "Trace the agent<->provider protocol on stderr (cyan).")
    boolean verbose;

    @Option(names = "--speak", description = "Speak the answer aloud while it streams.")
    boolean speak = false;

    @Parameters(index = "0", arity = "0..1", description = "Subcommand, e.g. sessions.")
    String subcommand;

    private final Ansi ansi = Ansi.detect();
    private final Spinner spinner = new Spinner(ansi);
    // The presentation layer (parent view + indented child view) lives in its
    // own class; the allowlist supplier stays live across /clear rebuilds
    // (qualified this.allowlist: the field is declared below — JLS 8.3.3).
    private final EventRenderer renderer =
            new EventRenderer(ansi, spinner, MAIN_AGENT_ID, () -> this.allowlist);

    // Session state — fields so the /clear slash command can rebuild them.
    private SpectroConfig config;
    private LlmProvider provider;
    /** The PROJECT anchor (process cwd): config layers, skills, MCP, SPECTRO.md. */
    private Path projectDir;
    /** The agent's working world: file tools, glob/grep and run_command. */
    private Path workspace;
    private String systemPrompt;
    private ToolRegistry registry;
    private SubagentManager subagents;
    private PermissionBroker askOnTerminal;
    private Allowlist allowlist = Allowlist.fromEntries(List.of());
    // Config-only pre/post_tool_use shell hooks (provider-independent, like the allowlist).
    private HookRunner hooks = HookRunner.load(List.of());
    private SkillLibrary skills = SkillLibrary.load(List.of());
    private Agent agent;
    private SessionStore store;
    // The tracing seam (KONZEPT §4.3): persistence rides a required port, so
    // bus/OTel consumers can dock without touching the drain loop. Rebuilt
    // wherever the store is — the sink holds the store it writes.
    private TracingPorts tracing;
    // The backend-to-LLM record (card 184) — opened with the store, same id.
    private LlmWireRecorder llmWire;
    /** Card 199: one line per gate decision, beside the session (the wire is frozen). */
    private dev.spectroscope.core.permission.GateAudit gateAudit;
    // Live-toggleable via /think on|off; seeded from config. Applied by rebuilding
    // the agent (the flag is a build-time AgentOptions input), preserving history.
    private boolean thinking;
    // MCP tools are a static tool SOURCE, connected once at startup and
    // registered alongside the standard ones. They are independent of the provider
    // switch (SwitchableProvider) — a rebuilt agent keeps the same registry, so the
    // MCP tools stay registered. Closed on shutdown to release server processes.
    private McpServerRegistry mcp = McpServerRegistry.load(List.of(), Path.of("."));

    /**
     * Process entry point: picocli parses and dispatches (REPL or subcommand),
     * and the command's result becomes the process exit code.
     *
     * @param args the raw command line — flags, an optional subcommand, its options
     */
    public static void main(String[] args) {
        int exitCode = new CommandLine(new SpectroCli()).execute(args);
        System.exit(exitCode);
    }

    /** The provider overrides carried by the global flags — subcommands (run,
     *  doctor) resolve them too, so flags > env holds on every entry point.
     *
     * @return the overrides for {@link SpectroConfig#load}; unset flags stay null
     *         and defer to the lower config layers
     */
    SpectroConfig.Overrides cliOverrides() {
        return new SpectroConfig.Overrides(
                providerFlag, modelFlag, baseUrlFlag, compactionThresholdFlag, null,
                workspaceFlag);
    }

    /**
     * The REPL entry (no subcommand): loads config, handles the bare {@code sessions}
     * listing, guards the missing Anthropic key, builds the whole session state
     * (provider, tools, broker, agent, optional resume history), then hands off to
     * the interactive loop. A shutdown hook cancels a running turn and closes MCP.
     */
    @Override
    public void run() {
        projectDir = Path.of(System.getProperty("user.dir"));
        SpectroConfig.ensureSeeded(System.getenv()); // first boot: materialize the env base once
        config = SpectroConfig.load(cliOverrides(), projectDir);
        LogSetup.apply(config.logLevel()); // config-effective level onto the root

        if ("sessions".equals(subcommand)) {
            printSessions();
            return;
        }

        // First-run onboarding (the CLI twin of the web's first-run sheet): if the
        // configured API provider has no key, don't fail with a terse line — tell a
        // newcomer how to get a backend running. Local providers (ollama/lmstudio)
        // are left to try; an unreachable one fails clearly on the first call.
        if ("needs-key".equals(
                SpectroConfig.onboardingStatus(config.provider(), providerKeyPresent(config.provider())))) {
            System.err.print(firstRunHint(config.provider()));
            return;
        }

        // The store first: the auto workspace is keyed by the session id, so a
        // resume lands in the SAME folder it worked in before.
        store = new SessionStore(resume);
        llmWire = LlmWireRecorder.forSession(store.id()); // the second JSONL (card 184)
        gateAudit = dev.spectroscope.core.permission.GateAudit.forSession(store.id()); // card 199
        tracing = new TracingPorts().require(new JsonlSink(store));
        // The OTel exporter rides as a REGISTERED port (isolated, warn-once):
        // off unless the config names an OTLP endpoint.
        OtlpSink.fromConfig(config, store.id()).ifPresent(tracing::register);
        workspace = WorkspaceResolver.resolve(config.workspace(), store.id());
        initializeSession();

        List<ProviderMessage> initialMessages = List.of();
        if (resume != null) {
            try {
                initialMessages = SessionStore.loadSession(resume);
            } catch (IOException notFound) {
                System.err.println("Session \"" + resume + "\" not found — \"sessions\" lists all ids.");
                return;
            }
        }

        BufferedReader console =
                new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));

        // ONE broker for parent and children. The allowlist answers first; only
        // unlisted requests fall through to the human. Either way the decision
        // lands in the stream as a permission_decision event (auditable).
        askOnTerminal = request -> {
            // Card 199: the verdict carries the tier, its source and the map version,
            // and the audit line names the entry that approved the call — the
            // visibility the exact-name hole is answered with.
            var verdict = allowlist.decide(request);
            if (verdict.approved()) {
                gateAudit.record(request, "allowlist", true, verdict);
                return true;
            }
            boolean allowed;
            try {
                String answer = console.readLine();
                allowed = answer != null && answer.trim().equalsIgnoreCase(APPROVAL_ANSWER);
            } catch (Exception readError) {
                allowed = false;
            }
            gateAudit.record(request, "user", allowed, verdict);
            return allowed;
        };

        registerTools();
        agent = buildAgent(initialMessages);

        AtomicReference<CancelSignal> currentSignal = new AtomicReference<>();
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            CancelSignal signal = currentSignal.get();
            if (signal != null) {
                signal.cancel();
            }
            mcp.close(); // tear down MCP server processes/connections on exit
        }));

        // voice output as a SECOND event consumer next to the CLI renderer —
        // the core is untouched. --speak overrides the config; /speak on|off toggles at
        // runtime. The tts block is read HERE (spectro-cli), not in spectro-core, so the
        // "spectro-core unchanged" acceptance criterion holds.
        TtsConfig tts = TtsConfig.load();
        SpeechRenderer speech = new SpeechRenderer(tts.voice(), speak || tts.enabled());

        printBanner(store, initialMessages.size());
        replLoop(console, speech, currentSignal);
    }

    /** Whether this provider's API key is present in the environment. A local
     *  provider (ollama, lmstudio) carries no key requirement, so it counts as
     *  present. */
    private static boolean providerKeyPresent(String provider) {
        String env = SpectroConfig.keyEnvFor(provider);
        return env == null || SpectroConfig.hasApiKey(env); // local needs none; else env or ~/.spectro/.env
    }

    /**
     * The {@code /model} line: provider, model, and the address the ACTIVE
     * provider really dials when it has one.
     *
     * <p>The address comes off the PROVIDER, never off {@code config.baseUrl()}:
     * card 193 gave ollama and LM Studio addresses of their own, so the legacy
     * shared field is no longer the string a run dials, and {@code /help}
     * advertises this line as "the active base URL". Providers that have no
     * address to name — anthropic's is fixed in the SDK, the built-in runtime is
     * a subprocess — print none, where they used to be handed ollama's default
     * port.</p>
     *
     * <p>Package-private and static so the wiring itself is testable — the
     * defect this pins was never in the formatting, it was in WHERE the address
     * came from.</p>
     *
     * @param config   the effective configuration (names provider and model)
     * @param provider the live provider instance, wrappers and all
     * @return the line {@code /model} prints
     */
    static String modelLine(SpectroConfig config, LlmProvider provider) {
        String endpoint = provider == null ? null : provider.endpoint();
        return config.provider() + " · " + config.model()
                + (endpoint == null || endpoint.isBlank() ? "" : " · " + endpoint);
    }

    /**
     * The banner's ollama segment: the live server version when it answers, and
     * otherwise a red sentence naming the address that did not.
     *
     * <p>Two defects lived here. The address printed was {@code config.baseUrl()}
     * while the provider beside it had been built from {@code endpointFor}, so a
     * probe that went to another machine was reported against localhost. And the
     * branch was reached by {@code provider instanceof OllamaProvider}, which is
     * never true: {@code providerFromConfig} hands back a logging PROXY (and, with
     * retries configured, a retry decorator around it), so the whole segment —
     * version line and failure sentence alike — had silently stopped printing.
     * Both are fixed by asking the live provider for its endpoint, which every
     * decorator forwards.</p>
     *
     * @param config   the effective configuration (names provider and model)
     * @param provider the live provider instance, wrappers and all
     * @param ansi     the colour writer (the red is on the failure half only)
     * @return the segment to append, or "" for every non-ollama provider
     */
    static String ollamaBannerSuffix(SpectroConfig config, LlmProvider provider, Ansi ansi) {
        String endpoint = provider == null ? null : provider.endpoint();
        if (!"ollama".equals(config.provider()) || endpoint == null || endpoint.isBlank()) {
            return "";
        }
        // A throwaway probe object against the SAME address the run dials — the
        // same shape the doctor's ollama check uses.
        return new OllamaProvider(new OllamaOptions(endpoint, config.model()))
                .serverVersion()
                .map(version -> " · ollama " + version)
                .orElse(ansi.red(" · unreachable at " + endpoint));
    }

    /** The first-run onboarding message for a keyless API provider — the CLI's
     *  version of the web's first-run sheet: the two zero-cost local paths and how
     *  to add a cloud key to .env. Package-private + static so it is unit-testable.
     *  @param provider the configured provider whose key is missing
     *  @return the multi-line hint to print on stderr */
    static String firstRunHint(String provider) {
        String keyEnv = SpectroConfig.keyEnvFor(provider);
        return """

                spectroscope needs an llm backend — none is ready. pick one:

                  ollama    (local, free)  install https://ollama.com, run `ollama pull qwen3`,
                                           then start with SPECTRO_PROVIDER=ollama
                  lmstudio  (local, free)  run LM Studio's server on :1234,
                                           then start with SPECTRO_PROVIDER=lmstudio
                  %s  (needs a key)  add %s=... to a .env file next to spectroscope, then rerun

                set the provider for good in ~/.spectro/settings.json; run `spectro doctor` to check.
                """
                .formatted(provider, keyEnv);
    }

    /** Provider (plus the --verbose trace wrap), skills, system prompt,
     *  allowlist, hooks and thinking — the per-session state read from the
     *  config layers. Everything here lives in fields so /clear can rebuild. */
    private void initializeSession() {
        // The session moment: the workspace's own .spectro pair joins the chain
        // now that workspace is resolved — flags (cliOverrides) stay the top
        // layer. A broken workspace file is loud but never fatal: the REPL
        // simply keeps the process-moment config it already had.
        try {
            config = SpectroConfig.loadForWorkspace(cliOverrides(), projectDir, workspace);
        } catch (IllegalArgumentException invalidWorkspaceScope) {
            System.err.println("workspace settings ignored: " + invalidWorkspaceScope.getMessage());
        }
        provider = config.providerFromConfig();
        if (verbose) {
            // Wire view on stderr; wrapped HERE so the agent AND the subagents get the traced instance.
            provider = new TracingProvider(provider, config.provider() + " · " + config.model());
        }
        // the skill catalog (name + description only) rides in the system
        // prompt; bodies load on demand through the use_skill tool.
        skills = SkillLibrary.load(SkillLibrary.defaultRoots(projectDir));
        composeSystemPrompt();
        // Card 199, criterion 8: the one-time, in-place migration of existing
        // entries onto tiers, so no entry starts or stops approving anything.
        // Idempotent and never throwing — a file the ledger already names is
        // left alone, and a file that cannot be written simply is not.
        migrateAllowlistOnce();
        try {
            config = SpectroConfig.loadForWorkspace(cliOverrides(), projectDir, workspace);
        } catch (IllegalArgumentException ignoredTwice) {
            // already reported above; the reload only picks up migrated entries
        }
        allowlist = Allowlist.fromEntries(config.autoApprove());
        hooks = HookRunner.load(config.hooks());
        thinking = config.thinking();
    }

    /** Card 199, criterion 8: every settings file in this session's chain is
     *  migrated onto tiers exactly once, recorded entry by entry in
     *  {@code ~/.spectro/gate-audit/allowlist-migration.jsonl}. The ledger, not
     *  a marker inside the settings file, is what makes it once-ever, so the
     *  settings schema is untouched and the migration is auditable by the same
     *  act. A file already migrated, missing, or unwritable is a no-op. */
    private void migrateAllowlistOnce() {
        var tiers = dev.spectroscope.core.permission.ToolTierMap.shipped();
        var ledger = dev.spectroscope.core.permission.AllowlistMigration.defaultLedger();
        java.util.List<java.nio.file.Path> files = new java.util.ArrayList<>(java.util.List.of(
                SpectroConfig.USER_SETTINGS_PATH,
                SpectroConfig.CONFIG_PATH,
                projectDir.resolve(SpectroConfig.PROJECT_SETTINGS)));
        if (workspace != null) {
            files.add(workspace.resolve(SpectroConfig.PROJECT_SETTINGS));
        }
        for (java.nio.file.Path file : files) {
            dev.spectroscope.core.permission.AllowlistMigration.migrateFileOnce(file, tiers, ledger);
        }
    }

    /** The system prompt names the WORKSPACE as the working directory while
     *  SPECTRO.md still comes from the project — the agent works in its own
     *  folder but keeps the project's context. Recomposed by /clear (a new
     *  session means a new workspace). */
    private void composeSystemPrompt() {
        systemPrompt = BASE_SYSTEM_PROMPT + workspace + SpectroConfig.loadProjectMd(projectDir)
                + SpectroConfig.loadAgentsMd(workspace) + skills.systemPromptSection();
    }

    /** Assembles the tool registry: standard tools, image generation, web
     *  fetch, the plan tool, skills, MCP servers, and the subagent spawn +
     *  dev tools. Sets the registry/subagents/mcp fields. */
    private void registerTools() {
        registry = new ToolRegistry();
        StandardTools.all().forEach(registry::register);
        // the provider is created lazily per call — a missing API key only
        // matters (and errors readably) when the model actually asks for an image.
        registry.register(new GenerateImageTool(config::imageProviderFromConfig,
                ImageStore.inUserHome(),
                llmWire)); // image calls land on the session's llm-wire record (card 184)
        // Real tool: fetch a web page as readable text. Network egress is a side
        // effect on untrusted input, so it is permission-gated like run_command; the
        // RestClient seam (DefaultHttpFetcher) is injectable so tests stay network-free.
        // Card 199: both browser-class tools take the net fence built from
        // allowLocalhost — file URLs, RFC-1918 and the 100.64/10 tailnet are
        // refused, loopback only on the deliberate opt-in for the verify loop.
        registry.register(new WebFetchTool(new DefaultHttpFetcher(),
                dev.spectroscope.core.net.NetFence.withSystemDns(config.allowLocalhost())));
        // web_search branch: the ONE tier WebSearchTiers resolves from the
        // configuration (card 203) + browse_page through the system Chrome
        // headless (renders JS). Both network egress -> permission-gated.
        registry.register(WebSearchTool.fromConfig(config));
        // chromeEnv() overlays the settings-hierarchy chromeBinary onto the process
        // env, so SPECTRO_CHROME AND the configured setting both reach discovery.
        registry.register(new BrowsePageTool(
                () -> BrowsePageTool.findChrome(config.chromeEnv()), new DefaultChromeRunner(),
                dev.spectroscope.core.net.NetFence.withSystemDns(config.allowLocalhost())));
        // The main agent's plan. Permission-free, main-only (a worker's
        // plan would clobber the flat UI snapshot), so it is NOT added to childBase.
        registry.register(new UpdatePlanTool());
        if (!skills.skills().isEmpty()) {
            registry.register(skills.useSkillTool());
        }
        // MCP is just another tool SOURCE. Connect eagerly to every
        // configured server and register each remote tool as mcp__<server>__<tool>
        // alongside the standard ones — the model calls them like any other tool,
        // and the tool_call/tool_result events flow unchanged (no new event type).
        // Registered once here; independent of the in-app provider switch.
        mcp = McpServerRegistry.load(config.mcpServers(), projectDir);
        mcp.tools().forEach(registry::register);
        // Children get the standard tools PLUS use_skill (when skills exist), so a
        // dev-tool child can actually load the skill its role prompt points at.
        List<Tool> childBase = new ArrayList<>(StandardTools.all());
        if (!skills.skills().isEmpty()) {
            childBase.add(skills.useSkillTool());
        }
        subagents = new SubagentManager(new SubagentConfig(
                provider, workspace, MAIN_AGENT_ID, askOnTerminal, List.copyOf(childBase), hooks));
        for (Tool tool : subagents.tools()) {
            registry.register(tool);
        }
        for (Tool tool : subagents.devTools()) {
            registry.register(tool);
        }
    }

    /** The interactive loop: prompt, read, dispatch (/speak, /voice, slash
     *  commands), run the agent and render its event stream. Owns the REPL's
     *  error handling and the speech/MCP teardown on exit.
     *
     * @param console       the shared stdin reader — also the permission broker's and
     *                      the voice channel's, so nothing else may read stdin
     * @param speech        the voice-output consumer fed alongside the CLI renderer
     * @param currentSignal holds the running turn's cancel signal so Ctrl+C
     *                      (the shutdown hook) can abort it
     */
    private void replLoop(BufferedReader console, SpeechRenderer speech,
                          AtomicReference<CancelSignal> currentSignal) {
        try {
            while (true) {
                System.out.print("\n" + ansi.coral("❯ "));
                System.out.flush();
                // Ctrl+C outside a run (or after run_end while trailing audio still plays):
                // no run_end 'aborted' will arrive to trigger stop(), so stop the player here.
                speech.stop();
                String rawLine = console.readLine();
                if (rawLine == null) {
                    break;
                }
                String input = rawLine.trim();
                if (input.isEmpty() || input.equals("/exit")) {
                    break;
                }

                // toggle voice output at runtime — /speak off also stops any
                // sentence currently playing (the shared stop() clears the queue).
                if (input.equals("/speak on") || input.equals("/speak off")) {
                    boolean on = input.endsWith(" on");
                    speech.setEnabled(on);
                    System.out.println("Voice output " + (on ? "on" : "off") + ".");
                    continue;
                }

                if (input.equals("/voice")) {
                    Optional<String> spoken = voiceInputTurn(console);
                    if (spoken.isEmpty()) {
                        continue;                   // discarded, empty, or failed — no turn
                    }
                    input = spoken.get();           // fall through to the normal user turn
                }

                if (input.startsWith("/")) {
                    handleSlashCommand(input);
                    continue;
                }

                CancelSignal signal = new CancelSignal();
                currentSignal.set(signal);
                try (var events = subagents.run(agent, input, new RunOptions(signal, null))) {
                    for (RunEvent event : events) {
                        tracing.onEvent(event);
                        speech.onEvent(event); // second consumer — the CLI rendering below is unchanged
                        renderer.render(event);
                    }
                } finally {
                    spinner.stop();
                    currentSignal.set(null);
                }
            }
        } catch (Exception loopError) {
            System.err.println("REPL error: " + loopError.getMessage());
        } finally {
            speech.close(); // stop playback, release the synth/playback workers
            mcp.close();     // clean exit releases MCP server processes too
        }
        System.out.println("Bye.");
    }

    /** /voice records, transcribes, and returns the transcript as the
     *  next input line — empty means discarded or failed, the REPL continues.
     *  The optional voice_input audit line is written to the session file
     *  BEFORE run_start; it never enters the provider history, so the
     *  reconstructed conversation stays byte-identical to a typed one.
     *
     * @param console the REPL's stdin reader, reused for stop-recording and the edit prompt
     * @return the confirmed text for the next user turn, or empty for "no turn"
     */
    private Optional<String> voiceInputTurn(BufferedReader console) {
        try {
            Transcriber transcriber = new Transcriber(config.sttModel());
            Optional<String> spoken = transcriber.voiceInput(console);
            if (spoken.isEmpty()) {
                return Optional.empty();            // discarded or empty — no turn, no call
            }
            tracing.onEvent(new RunEvent.VoiceInput(MAIN_AGENT_ID,
                    transcriber.lastDurationMs(), Transcriber.MODEL_NAME,
                    System.currentTimeMillis()));
            return spoken;
        } catch (IOException voiceFailure) {
            System.err.println("Voice input failed: " + voiceFailure.getMessage());
            return Optional.empty();                // the REPL survives — an expected error
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            System.err.println("Voice input interrupted.");
            return Optional.empty();
        }
    }

    /**
     * Assembles the main agent from the current session fields — /clear and
     * /think rebuild through here, so a flag change or a fresh start always
     * yields a consistently configured agent.
     *
     * @param initialMessages reconstructed history to seed the conversation with
     *                        (resume, /think rebuild) — empty for a fresh session
     * @return the ready agent; the registry and broker are shared, not rebuilt
     */
    private Agent buildAgent(List<ProviderMessage> initialMessages) {
        return new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt(systemPrompt)
                .registry(registry)
                .cwd(workspace)      // the agent works IN the workspace, not the repo
                .agentId(MAIN_AGENT_ID)
                .initialMessages(initialMessages)
                .providerName(config.provider())
                .compactionThreshold(config.compactionThreshold())
                .introspection(true) // additive: context introspection — feeds the web ring, lands in the JSONL
                .thinking(thinking)  // reasoning visibility; toggled live by /think on|off
                .hooks(hooks)        // external pre/post_tool_use shell hooks (config-only)
                .llmWire(llmWire)    // the backend-to-LLM record rides the session's recorder (card 184)
                .onPermission(askOnTerminal)
                .build());
    }

    // ---------------------------------------------------------- slash commands

    /**
     * The in-REPL commands — none of them ever reaches the model.
     *
     * @param command the full input line starting with {@code /}, including any argument
     */
    private void handleSlashCommand(String command) {
        // /think on|off — toggles reasoning visibility live. The flag is a build-time
        // AgentOptions input, so we rebuild the agent to apply it. History is preserved
        // by reconstructing the conversation from the current session's JSONL file
        // (the same path the --resume flag uses), so a following turn continues normally.
        if (command.startsWith("/think")) {
            String arg = command.length() > "/think".length()
                    ? command.substring("/think".length()).trim() : "";
            if (arg.equals("on") || arg.equals("off")) {
                thinking = arg.equals("on");
                List<ProviderMessage> history = List.of();
                try {
                    history = SessionStore.loadSession(store.id());
                } catch (IOException fresh) {
                    // No file yet (no run in this session) — nothing to carry over.
                }
                agent = buildAgent(history);
                System.out.println("Thinking " + (thinking ? "on" : "off") + ".");
            } else {
                System.out.println("Usage: /think on|off  (currently "
                        + (thinking ? "on" : "off") + ")");
            }
            return;
        }
        switch (command) {
            case "/help" -> {
                System.out.println(ansi.bold("Slash commands"));
                System.out.println("  /help      this overview");
                System.out.println("  /cost      token usage of this session");
                System.out.println("  /model     active provider, model and base URL");
                System.out.println("  /sessions  list stored sessions");
                System.out.println("  /skills    list installed skills");
                System.out.println("  /mcp       connected MCP servers and their tools");
                System.out.println("  /think     reasoning visibility on|off");
                System.out.println("  /voice     push-to-talk: record, transcribe, edit, send");
                System.out.println("  /speak     read answers aloud on|off");
                System.out.println("  /compact   summarize older history now");
                System.out.println("  /clear     start a fresh session (new agent, new file)");
                System.out.println("  /exit      quit (empty line works too)");
            }
            case "/cost" -> System.out.println("Session usage: " + renderer.sessionUsage());
            case "/model" -> System.out.println(modelLine(config, provider));
            case "/sessions" -> printSessions();
            case "/mcp" -> printMcpStatus();
            case "/skills" -> {
                if (skills.skills().isEmpty()) {
                    System.out.println("No skills installed — put SKILL.md packages under "
                            + "~/.spectro/skills/ or <project>/.spectro/skills/.");
                } else {
                    skills.skills().forEach(skill -> System.out.println(
                            "  " + ansi.bold(skill.name()) + "  " + ansi.dim(skill.description())));
                }
            }
            case "/compact" -> agent.compactNow().ifPresentOrElse(event -> {
                tracing.onEvent(event);
                renderer.render(event);
            }, () -> System.out.println("Nothing to compact — the history is still small."));
            case "/clear" -> {
                // A new session means a new workspace: re-key the folder, refresh
                // the prompt, and rebuild the tool world so subagents inherit it.
                // MCP is reloaded by registerTools — release the old processes first.
                store = new SessionStore(null);
                if (llmWire != null) {
                    llmWire.close(); // the old session's writer; lines are flushed
                }
                llmWire = LlmWireRecorder.forSession(store.id());
                gateAudit = dev.spectroscope.core.permission.GateAudit.forSession(store.id());
                tracing = new TracingPorts().require(new JsonlSink(store));
                workspace = WorkspaceResolver.resolve(config.workspace(), store.id());
                composeSystemPrompt();
                mcp.close();
                registerTools();
                agent = buildAgent(List.of());
                System.out.println("New session: " + store.id());
                System.out.println("Workspace:   " + workspace);
            }
            default -> System.out.println("Unknown command: " + command + " (/help lists all)");
        }
    }

    /** Lists every configured MCP server, its reachability, and the tools it advertised. */
    private void printMcpStatus() {
        var servers = mcp.servers();
        if (servers.isEmpty()) {
            System.out.println(ansi.dim(
                    "No MCP servers configured. Add an \"mcpServers\" block to"
                            + " ~/.spectro/config.json or .spectro/settings.json."));
            return;
        }
        System.out.println(ansi.sand("MCP servers") + ansi.dim("  (" + servers.size() + ")"));
        for (var handle : servers) {
            String mark = handle.reachable() ? ansi.green("✓") : ansi.red("✗");
            System.out.println("  " + mark + " " + ansi.bold(handle.name())
                    + ansi.dim(" · " + handle.target()
                    + " · " + handle.toolCount() + (handle.toolCount() == 1 ? " tool" : " tools")));
        }
        // The wrapped tools carry the mcp__<server>__<tool> names the model sees.
        List<Tool> mcpTools = mcp.tools();
        if (!mcpTools.isEmpty()) {
            mcpTools.forEach(tool ->
                    System.out.println("    " + ansi.coral("⚒ ") + ansi.dim(tool.name())));
        }
    }

    /** The sessions overview: one line per file, newest last (ids sort by start time). */
    private void printSessions() {
        List<SessionStore.SessionInfo> sessions = SessionStore.listSessions();
        if (sessions.isEmpty()) {
            System.out.println("No sessions under ~/.spectro/sessions/.");
            return;
        }
        DateTimeFormatter stamp = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm");
        sessions.forEach(session -> {
            String start = Instant.ofEpochMilli(session.startedAt())
                    .atZone(ZoneId.systemDefault())
                    .format(stamp);
            String prompt = session.firstPrompt().replaceAll("\\s+", " ");
            prompt = prompt.length() > FIRST_PROMPT_PREVIEW_CHARS
                    ? prompt.substring(0, FIRST_PROMPT_PREVIEW_CHARS) : prompt;
            System.out.printf("%s  %s  %8d tokens  [%s]  %s%n",
                    ansi.bold(session.id()), start, session.tokens(),
                    session.provider(), ansi.dim(prompt));
        });
    }

    /**
     * The startup banner: provider line (with a live Ollama version probe),
     * capability hints, the session id and file, and the command cheat line.
     *
     * @param store           the session whose id and file path the banner names
     * @param resumedMessages how many messages a resume reconstructed — shown so the
     *                        user knows the model remembers
     */
    private void printBanner(SessionStore store, int resumedMessages) {
        System.out.println(ansi.coral("◆ ") + ansi.bold("spectroscope"));
        String providerLine = config.provider() + " · " + config.model()
                + ollamaBannerSuffix(config, provider, ansi);
        System.out.println(ansi.dim("  " + providerLine
                + " · images: " + config.imageProvider()
                + (skills.skills().isEmpty() ? "" : " · skills: " + skills.skills().size())
                + (allowlist.isEmpty() ? "" : " · allowlist active")));
        String sessionLine = resume != null
                ? "resumed " + store.id() + " (" + resumedMessages + " messages reconstructed)"
                : "session " + store.id();
        System.out.println(ansi.dim("  " + sessionLine + " · " + store.file()));
        System.out.println(ansi.dim("  workspace " + workspace
                + (config.workspace() == null ? " (per session — configure \"workspace\" to pin one)" : "")));
        System.out.println(ansi.dim("  /help for commands · /mcp servers · /voice push-to-talk"
                + " · /speak on|off reads answers aloud · Ctrl+C aborts a run"));
    }

}
