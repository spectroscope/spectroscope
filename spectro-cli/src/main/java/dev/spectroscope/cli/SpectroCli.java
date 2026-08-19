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

    @Option(names = "--compaction-threshold",
            description = "Compaction threshold in input tokens "
                    + "(default: derived from the model's loaded context window).")
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
    /** What children of this face inherit — see {@link #childBelt()}. */
    private List<Tool> childBelt = List.of();
    private SubagentManager subagents;
    private PermissionBroker askOnTerminal;

    /**
     * Card 265: who the {@code ask_user_question} tool asks on this face. Set
     * only on the interactive path, and the tool is registered only when it is
     * set — registration IS the fence, so a face with no console never advertises
     * a verb nobody could answer.
     */
    private dev.spectroscope.core.Asker askQuestionOnTerminal;
    private Allowlist allowlist = Allowlist.fromEntries(List.of());
    // Config-only pre/post_tool_use shell hooks (provider-independent, like the allowlist).
    private HookRunner hooks = HookRunner.load(List.of());
    private SkillLibrary skills = SkillLibrary.load(List.of());
    private Agent agent;
    /** Card 267: what this session is FOR, and the command that decides it.
     *  Loaded from {@code ~/.spectro/goals/<id>.goal.md} at start and rewritten
     *  there by {@code /goal}, so it outlives the process the way SPECTRO.md
     *  does. Never null on this face — a goal with nothing stated is simply an
     *  empty statement, and the loop then behaves exactly as before. */
    private dev.spectroscope.core.goal.SessionGoal goal;
    private SessionStore store;
    // The tracing seam (KONZEPT §4.3): persistence rides a required port, so
    // bus/OTel consumers can dock without touching the drain loop. Rebuilt
    // wherever the store is — the sink holds the store it writes.
    private TracingPorts tracing;
    // The backend-to-LLM record (card 184) — opened with the store, same id.
    private LlmWireRecorder llmWire;
    /**
     * Card 270: ONE window of measured exchange durations for this REPL, shared
     * by the main agent and every child. It is a field rather than a local
     * because {@code /think} and a provider switch REBUILD the agent while the
     * conversation continues — a window minted inside the build would forget the
     * backend at exactly the moment the operator changed something about it, and
     * the next child would be priced at the floor as if the session were new.
     */
    private final dev.spectroscope.core.provider.ExchangeLatency latency =
            new dev.spectroscope.core.provider.ExchangeLatency();
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
        SpectroConfig.ensureSeeded(System.getenv()); // first boot: materialize the env base once
        anchorAt(Path.of(System.getProperty("user.dir")));
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

        BufferedReader console =
                new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        List<ProviderMessage> initialMessages = openInteractiveSession(console);
        if (initialMessages == null) {
            System.err.println("Session \"" + resume + "\" not found — \"sessions\" lists all ids.");
            return;
        }

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

    /**
     * The project anchor and the effective configuration for it — {@code run()}'s
     * first act, and the one every later step reads from.
     *
     * <p>Package-private so a test can put a CLI in the state the REPL is in
     * before it assembles anything, without repeating the two lines it takes to
     * get there.</p>
     *
     * @param project the PROJECT anchor (the process cwd in a real run): config
     *                layers, skills, MCP and SPECTRO.md all resolve from it
     */
    void anchorAt(Path project) {
        projectDir = project;
        config = SpectroConfig.load(cliOverrides(), project);
    }

    /**
     * Everything between the effective config and the REPL: the session store and
     * its three records, the workspace, the session-moment config, the two things
     * this console answers with — the permission broker AND, since card 265, the
     * asker — the tool belt, and the agent.
     *
     * <p>Driven whole by {@link #run()} and package-private on purpose. Card 265's
     * fence is the REGISTRATION, so "this face carries the ask" can only be read
     * off the belt the product really builds; card 222's finding F4 was exactly
     * this hole one file over, where a whole tool family was deleted from the live
     * assembly and every suite stayed green because each test built its own
     * belt.</p>
     *
     * @param console the shared stdin reader — the permission broker's, the
     *                asker's and the voice channel's, so nothing else may read
     *                stdin
     * @return the resumed history (empty for a fresh session), or {@code null}
     *         when {@code --resume} names a session that does not exist
     */
    List<ProviderMessage> openInteractiveSession(BufferedReader console) {
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
                return null;
            }
        }

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

        // The question side of the same console (card 265). The renderer PRINTS the
        // question when the event reaches it, exactly as it prints "run X? [y/N]";
        // this only reads, so the two can never show different questions.
        askQuestionOnTerminal = new ConsoleAsker(console);

        // Card 267: the goal comes off disk, so a resumed session resumes its
        // goal too. The check is the shipped command one — the evaluator variant
        // ships but is wired nowhere by default, which is the whole of owner
        // call 1's answer.
        goal = new dev.spectroscope.core.goal.SessionGoal(
                new dev.spectroscope.core.goal.CommandGoalCheck());
        goal.state(dev.spectroscope.core.goal.GoalStore.read(
                dev.spectroscope.core.goal.GoalStore.fileFor(store.id())));

        registerTools();
        agent = buildAgent(initialMessages);
        return initialMessages;
    }

    /**
     * The assembled tool belt — what the model is really advertised.
     *
     * <p>The server face has the same reader for the same reason
     * ({@code SessionConnection.belt()}): a fence made of registration is only
     * provable by reading the registry the face built.</p>
     *
     * @return the live registry, or null before the first assembly
     */
    ToolRegistry belt() {
        return registry;
    }

    /**
     * The agent this face assembled — the same evidence as {@link #belt()}, for
     * the things that hang off {@code AgentOptions} rather than off the registry.
     *
     * <p>Card 262's review found the hole this closes: the whole
     * {@code .progressGuard(...)} clause could be deleted from {@link #buildAgent}
     * and the entire Java gate stayed green, because nothing could read what the
     * REPL actually built. The server face already had that reader
     * ({@code SessionProgressGuardTest}); this is its twin. Card 222's finding F4
     * a third time.</p>
     *
     * @return the live agent, or null before the first assembly
     */
    Agent agent() {
        return agent;
    }

    /**
     * The belt this face hands its CHILDREN — the same evidence, for the other
     * half of the fence.
     *
     * <p>Card 270 made this the parent's own assembly instead of a hand-listed
     * subset, and decided at the same seam that {@code update_plan} and
     * {@code ask_user_question} stay off it: both are registered on the REGISTRY
     * below and never added to {@code shared}. That is a fence made of one
     * line's position, which is exactly the kind only a reader can prove.</p>
     *
     * @return the child belt {@link #registerTools} assembled, empty before it ran
     */
    List<Tool> childBelt() {
        return childBelt;
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
     *  act. A file already migrated, missing, or unwritable is a no-op. The chain
     *  comes from {@code AllowlistMigration.settingsChain} — one list, because
     *  three copies of it drifted and the workspace-local layer, which can BE the
     *  whole effective allowlist, was in none of them. */
    private void migrateAllowlistOnce() {
        var tiers = dev.spectroscope.core.permission.ToolTierMap.shipped();
        var ledger = dev.spectroscope.core.permission.AllowlistMigration.defaultLedger();
        for (java.nio.file.Path file : dev.spectroscope.core.permission.AllowlistMigration
                .settingsChain(projectDir, workspace)) {
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
     *  dev tools. Sets the registry/subagents/mcp fields.
     *
     *  <p>Package-private (card 265): the ask's fence lives in here, and the belt
     *  it produces is the only honest evidence of what this face advertises.</p>
     *
     *  <p>Card 270: the list is built ONCE, in {@code shared}, and both consumers
     *  read it — the main agent's registry and the belt the children inherit. The
     *  two used to be assembled separately, and the child's copy was
     *  {@code StandardTools.all()} plus {@code use_skill}: no image tool, no web
     *  tools, and not one of the MCP servers the operator had configured. A tool
     *  added here now reaches the children or nobody.</p> */
    void registerTools() {
        registry = new ToolRegistry();
        // The belt both the main agent and the children get, in registration
        // order. update_plan and the spawn/dev verbs are added to the REGISTRY
        // only, further down — they are main-only by decision, not by accident.
        List<Tool> shared = new ArrayList<>(StandardTools.all());
        // the provider is created lazily per call — a missing API key only
        // matters (and errors readably) when the model actually asks for an image.
        shared.add(new GenerateImageTool(config::imageProviderFromConfig,
                ImageStore.inUserHome(),
                llmWire)); // image calls land on the session's llm-wire record (card 184)
        // Real tool: fetch a web page as readable text. Network egress is a side
        // effect on untrusted input, so it is permission-gated like run_command; the
        // RestClient seam (DefaultHttpFetcher) is injectable so tests stay network-free.
        // Card 199: both browser-class tools take the net fence built from
        // allowLocalhost — file URLs, RFC-1918 and the 100.64/10 tailnet are
        // refused, loopback only on the deliberate opt-in for the verify loop.
        // The three are locals because they are handed over TWICE (card 205, and
        // card 270 widened the first half): once onto `shared`, which is both the
        // main agent's registry AND the belt every worker child inherits, and
        // once as the research role's explicit grant below — the SAME instances,
        // so a child's call passes the same fence, broker and tiers as the
        // parent's.
        Tool webSearch = WebSearchTool.fromConfig(config);
        Tool webFetch = new WebFetchTool(new DefaultHttpFetcher(),
                dev.spectroscope.core.net.NetFence.withSystemDns(config.allowLocalhost()));
        // chromeEnv() overlays the settings-hierarchy chromeBinary onto the process
        // env, so SPECTRO_CHROME AND the configured setting both reach discovery.
        Tool browsePage = new BrowsePageTool(
                () -> BrowsePageTool.findChrome(config.chromeEnv()), new DefaultChromeRunner(),
                dev.spectroscope.core.net.NetFence.withSystemDns(config.allowLocalhost()));
        shared.add(webFetch);
        // web_search branch: the ONE tier WebSearchTiers resolves from the
        // configuration (card 203) + browse_page through the system Chrome
        // headless (renders JS). Both network egress -> permission-gated.
        shared.add(webSearch);
        shared.add(browsePage);
        // Card 265, and a seam card 270 had to decide: only where a person can
        // answer. On this face that is the interactive REPL, which is the only
        // caller that sets the asker — a `spectro run`, a cron fire and a node
        // build their belts through HeadlessRunner and never reach this method at
        // all. It is registered on the REGISTRY and not on `shared`, so it is
        // main-only exactly like update_plan: a child that could raise its own
        // question would interrupt the operator on behalf of a spawn the operator
        // never saw. Card 270 measured the belt before card 265 existed, so this
        // withholding is a decision made at the merge, not one it carried.
        if (askQuestionOnTerminal != null) {
            registry.register(new dev.spectroscope.core.tools.AskUserQuestionTool(
                    askQuestionOnTerminal));
        }
        if (!skills.skills().isEmpty()) {
            shared.add(skills.useSkillTool());
        }
        // MCP is just another tool SOURCE. Connect eagerly to every
        // configured server and register each remote tool as mcp__<server>__<tool>
        // alongside the standard ones — the model calls them like any other tool,
        // and the tool_call/tool_result events flow unchanged (no new event type).
        // Registered once here; independent of the in-app provider switch.
        mcp = McpServerRegistry.load(config.mcpServers(), projectDir);
        shared.addAll(mcp.tools());

        shared.forEach(registry::register);
        // The main agent's plan. Permission-free, main-only (a worker's
        // plan would clobber the flat UI snapshot), so it is NOT in `shared`.
        registry.register(new UpdatePlanTool());
        // Card 205's grant, and card 270 changed what it MEANS here. The three web
        // tools are now on `shared`, so EVERY worker child carries them — the
        // widening that matters most, because it is the one that leaves the
        // machine. A worker child has network egress it did not have before card
        // 270, under the same NetFence, the same broker and the same card-199
        // tiers as the parent's own calls, but it has it.
        //
        // What `webTools` still does is narrower and unchanged: it is the grant
        // that reaches a RESEARCH child PAST its keep-list, which would otherwise
        // filter the trio out. Same instances either way.
        subagents = new SubagentManager(SubagentConfig.builder()
                .provider(provider)
                .cwd(workspace)
                .parentAgentId(MAIN_AGENT_ID)
                .onPermission(askOnTerminal)
                .baseTools(childBelt = List.copyOf(shared)) // card 270: the parent's own belt
                .hooks(hooks)
                .llmWire(llmWire) // the SAME recorder the parent writes on (card 231)
                .webTools(List.of(webSearch, webFetch, browsePage))
                .budget(dev.spectroscope.core.subagents.ChildBudget.derivedFrom(latency))
                // card 263 AC 3: the operator's threshold governs the tree, not
                // just its root — the same value the parent agent is built with
                .compactionThreshold(config.compactionThreshold())
                .build());
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
                .latency(latency)    // this REPL's own exchanges price its children (card 270)
                // Card 262: the progress guard, and only where a person can
                // answer its question. The REPL sets the asker; a `spectro run`,
                // a cron fire and a node never reach this method, so they carry
                // no guard — registration is the fence, the same one card 265's
                // ask uses. A guard that could only narrate while the hour keeps
                // burning is the outcome the owner explicitly ruled out.
                .progressGuard(askQuestionOnTerminal == null ? null
                        : new dev.spectroscope.core.progress.ProgressGuard(
                                new dev.spectroscope.core.progress.ProgressSettings(
                                        config.progressGuardWrites(),
                                        config.progressGuardFailures(),
                                        config.progressGuardPlanTurns()),
                                askQuestionOnTerminal))
                // Card 266: the leash, on the same fence and for the same
                // reason. An unattended face that continues by itself
                // multiplies a bill with nobody watching, which is what
                // konzept/ORCHESTRATION.md refusal 5 keeps off unattended
                // faces. A person sits at this console; `spectro run` and a
                // cron fire never reach this method.
                .continuationLeash(askQuestionOnTerminal == null ? null
                        : new dev.spectroscope.core.loop.ContinuationLeash(
                                config.continuationBudget()))
                // Card 267: the goal is wired on every face, unlike the leash
                // above. Grading is one gated command and it ends the run; only
                // the CONTINUATION half multiplies a bill, and that half is
                // already fenced by the leash being null here.
                .goal(goal)
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
        // /goal — the operator surface for card 267. A goal is text plus a
        // command; it grants no tool, no role and no permission, and stating it
        // is deliberately NOT a tool the model could reach: a model-written goal
        // is a run defining its own success, which
        // konzept/PROMPT-ORCHESTRATION.md §3 rule 2 already refuses.
        if (command.equals("/goal") || command.startsWith("/goal ")) {
            handleGoalCommand(command.length() > "/goal".length()
                    ? command.substring("/goal".length()).trim() : "");
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
                System.out.println("  /goal      state this run's outcome and its check");
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
                renderer.forgetPlan(); // the new agent has no ledger; neither has the line
                if (llmWire != null) {
                    llmWire.close(); // the old session's writer; lines are flushed
                }
                llmWire = LlmWireRecorder.forSession(store.id());
                // Card 267: a new session is a new goal file, and inheriting the
                // old session's outcome would be the harness deciding what the
                // fresh conversation is for.
                goal.state(dev.spectroscope.core.goal.GoalStore.read(
                        dev.spectroscope.core.goal.GoalStore.fileFor(store.id())));
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

    /**
     * The {@code /goal} surface (card 267, criterion 1).
     *
     * <p>Four forms, and the state after any of them is written straight to
     * {@code ~/.spectro/goals/<id>.goal.md} — the durable artifact criterion 1
     * asks for, in the shape {@code loadAgentsMd} already reads its file in. The
     * operator can equally edit that file in a text editor; the loop re-reads
     * the object on every turn, and {@code /goal} is what puts the two in
     * step.</p>
     *
     * @param arg what followed {@code /goal}, already trimmed
     */
    private void handleGoalCommand(String arg) {
        dev.spectroscope.core.goal.RunGoal current = goal.stated();
        java.nio.file.Path file = dev.spectroscope.core.goal.GoalStore.fileFor(store.id());
        if (arg.isEmpty()) {
            if (current == null) {
                System.out.println("No goal stated. /goal set <outcome>, then"
                        + " /goal check <command>.");
            } else {
                System.out.println(ansi.bold("Goal: ") + current.outcome());
                System.out.println(current.hasCheck()
                        ? ansi.bold("Check: ") + current.check()
                        : ansi.dim("No check — this run would be reported untested."));
            }
            System.out.println(ansi.dim(file.toString()));
            return;
        }
        if (arg.equals("clear")) {
            goal.state(null);
        } else if (arg.startsWith("check ")) {
            if (current == null) {
                System.out.println("State the outcome first: /goal set <outcome>");
                return;
            }
            goal.state(new dev.spectroscope.core.goal.RunGoal(current.outcome(),
                    arg.substring("check ".length()).trim()));
        } else {
            String outcome = arg.startsWith("set ") ? arg.substring("set ".length()).trim() : arg;
            goal.state(new dev.spectroscope.core.goal.RunGoal(outcome,
                    current == null ? null : current.check()));
        }
        try {
            dev.spectroscope.core.goal.GoalStore.write(file, goal.stated());
        } catch (IOException unwritable) {
            // The goal still governs this session; only its durability is lost,
            // and saying so is better than pretending the file exists.
            System.out.println(ansi.dim("Could not write " + file + ": "
                    + unwritable.getMessage()));
        }
        handleGoalCommand("");
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
            // An unreachable row carries the reason instead of a tool count of zero —
            // "0 tools" is the symptom, the reason is what someone can act on.
            String tail = handle.reachable() || handle.failure() == null
                    ? handle.toolCount() + (handle.toolCount() == 1 ? " tool" : " tools")
                    : handle.failure();
            System.out.println("  " + mark + " " + ansi.bold(handle.name())
                    + ansi.dim(" · " + handle.target() + " · " + tail));
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
