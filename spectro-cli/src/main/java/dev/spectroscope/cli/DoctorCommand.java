package dev.spectroscope.cli;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.config.WorkspaceResolver;
import dev.spectroscope.core.local.LlamaServerBinary;
import dev.spectroscope.core.local.LocalCatalog;
import dev.spectroscope.core.local.LocalModel;
import dev.spectroscope.core.local.ModelResolution;
import dev.spectroscope.core.provider.OllamaOptions;
import dev.spectroscope.core.provider.OllamaProvider;
import dev.spectroscope.core.scheduler.CronScheduler;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.core.tools.ToolPath;
import picocli.CommandLine.Command;
import picocli.CommandLine.Option;
import picocli.CommandLine.ParentCommand;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.concurrent.Callable;

/**
 * spectroscope doctor — the environment check (Claude-Code style).
 * Verifies the runtime, the config hierarchy, provider reachability, and the
 * data home; prints one ✓/✗ line per check and exits non-zero if anything is red.
 */
@Command(name = "doctor", description = "Check the spectroscope environment and configuration.")
public final class DoctorCommand implements Callable<Integer> {

    private final Ansi ansi = Ansi.detect();
    private boolean healthy = true;

    @ParentCommand
    private SpectroCli parent;

    @Option(names = "--migrate",
            description = "rename ~/.spectro/config.json to settings.json (the new name)")
    boolean migrate;

    /**
     * Doctor probes what the flags select, not just the config files.
     *
     * @return the parent command's --provider/--model/--base-url overrides, or none
     *         when constructed standalone (tests)
     */
    private SpectroConfig.Overrides effectiveOverrides() {
        return parent != null ? parent.cliOverrides() : SpectroConfig.Overrides.none();
    }

    /**
     * Renames the user scope's legacy file name to its new one — never
     * destructive: a rename only happens when the new name is still absent,
     * so an already-migrated (or never-configured) home is left untouched.
     *
     * @return true when the rename happened
     * @throws IOException if the filesystem move fails
     */
    static boolean migrateUserFile() throws IOException {
        if (!Files.exists(SpectroConfig.CONFIG_PATH) || Files.exists(SpectroConfig.USER_SETTINGS_PATH)) {
            return false;
        }
        Files.move(SpectroConfig.CONFIG_PATH, SpectroConfig.USER_SETTINGS_PATH);
        return true;
    }

    /**
     * The SPECTRO_* environment variable name for a resolved config field — the
     * plain camelCase-to-SNAKE_CASE transform, except {@code chromeBinary}
     * (its real variable is {@code SPECTRO_CHROME}, not SPECTRO_CHROME_BINARY).
     *
     * @param field the field name as it appears in {@link SpectroConfig.Origin}
     * @return the SPECTRO_* variable name that feeds that field
     */
    private static String envVarName(String field) {
        if ("chromeBinary".equals(field)) {
            return "SPECTRO_CHROME";
        }
        return "SPECTRO_" + field.replaceAll("([A-Z])", "_$1").toUpperCase(Locale.ROOT);
    }

    /**
     * Runs every check in order — runtime, config layers, provider reachability,
     * optional capabilities (images, skills, hooks, MCP, vision, voice), data home,
     * jobs file. Hard requirements print ✓/✗ and flip the exit code; optional
     * infrastructure prints dimmed info lines and never fails the doctor.
     *
     * @return 0 when every hard check passed, 1 as soon as one was red
     */
    @Override
    public Integer call() {
        System.out.println(ansi.coral("◆ ") + ansi.bold("spectroscope doctor"));

        // Runtime
        String javaVersion = System.getProperty("java.version", "unknown");
        int major = parseMajor(javaVersion);
        report(major >= 21, "Java " + javaVersion + (major >= 21 ? "" : " — 21+ required"));

        // The PATH every run_command shell gets, printed before anything that
        // depends on it (card 251). A Finder-launched app inherits launchd's four
        // directories and the owner's toolchain is invisible to the agent; that
        // was a hunt once and is a lookup from here on.
        emit(toolPathLines(ToolPath.resolve()));

        // Config hierarchy
        Path cwd = Path.of(System.getProperty("user.dir"));
        // legacyUserConfig / userSettingsFile: the user scope has TWO possible
        // file names since the rename (settings.json is the current one,
        // config.json the deprecated compat layer still read beneath it) — the
        // "layers:" line below must name the scope that ACTUALLY carries the
        // effective user-layer values, not just the legacy file.
        boolean legacyUserConfig = Files.exists(SpectroConfig.CONFIG_PATH);
        boolean userSettingsFile = Files.exists(SpectroConfig.USER_SETTINGS_PATH);
        boolean launchDirSettings = Files.exists(cwd.resolve(SpectroConfig.PROJECT_SETTINGS));
        SpectroConfig config;
        SpectroConfig.Resolved resolved;
        try {
            // First boot: materialize the env base once. seededNow is reported
            // below — a silent home write is a doctor honesty gap in itself.
            boolean seededNow = SpectroConfig.ensureSeeded(System.getenv());
            config = SpectroConfig.load(effectiveOverrides(), cwd);
            LogSetup.apply(config.logLevel()); // config-effective level applies here too
            // Computed once, reused by both the logging line's provenance below
            // AND the shadow report further down — one resolution, one truth.
            resolved = SpectroConfig.loadResolved(effectiveOverrides(), cwd, null);
            report(true, "config: provider=" + config.provider() + " model=" + config.model()
                    + " permissionMode=" + config.permissionMode()
                    + " autoApprove=" + config.autoApprove().size() + " rule(s)");
            if (seededNow) {
                info("seed: first boot — materialized ~/.spectro/settings.json from the environment base");
            }
            // The parenthetical must name the REAL source, not just "the env var
            // happens to be set" — a settings file can shadow SPECTRO_LOG_LEVEL
            // exactly like every other field, and used to still claim credit for it.
            boolean logLevelFromEnv = "env".equals(resolved.origins().get("logLevel").winner());
            info("logging: level=" + config.logLevel()
                    + (logLevelFromEnv ? " (from SPECTRO_LOG_LEVEL)" : "")
                    + " · file ~/.spectro/logs/spectroscope.log · console WARN+ · backend logback");
            info("layers: user settings.json " + (userSettingsFile ? "present" : "absent")
                    + (legacyUserConfig ? " (legacy config.json also present)" : "")
                    + " · launch-dir settings.json (deprecated) "
                    + (launchDirSettings ? "present" : "absent"));
            if (launchDirSettings) {
                info("launch-dir settings.json is a deprecated compat layer — team conventions belong"
                        + " in the workspace's own .spectro/settings.json instead");
            }
            info("workspace: " + (config.workspace() != null
                    ? WorkspaceResolver.locate(config.workspace(), null).toString()
                    : Path.of(System.getProperty("java.io.tmpdir"), "spectroscope-ws")
                            + "/<session-id> (per session)"));
        } catch (RuntimeException broken) {
            report(false, "config: " + broken.getMessage());
            return 1; // nothing below makes sense with a broken config
        }

        // Rename migration — the user scope's old name. Never destructive:
        // migrateUserFile only renames when settings.json is still absent.
        if (migrate) {
            try {
                boolean migrated = migrateUserFile();
                if (migrated) {
                    report(true, "migrate: renamed ~/.spectro/config.json to settings.json");
                } else {
                    info("migrate: nothing to rename (settings.json already exists,"
                            + " or no config.json found)");
                }
            } catch (IOException moveFailed) {
                report(false, "migrate: " + moveFailed.getMessage());
            }
        } else if (legacyUserConfig) {
            info("user config.json is the old name — 'spectroscope doctor --migrate' renames it to settings.json");
        }

        // Shadow report: every SPECTRO_* var that IS set but is not its field's
        // effective source, named per field — a forgotten env var never
        // silently "does nothing" without a trace.
        resolved.origins().forEach((field, origin) -> {
            if (origin.shadowed().contains("env") && !"env".equals(origin.winner())) {
                info("env " + envVarName(field) + " is set but shadowed by " + origin.winner()
                        + " settings (effective " + field + " comes from " + origin.winner() + ")");
            }
        });

        // Card 193: endpointFor applies a FIXED field priority ON TOP of the
        // folded layers, so a per-provider address beats a baseUrl that came
        // from a HIGHER layer — measured, --base-url=http://flag-box:11434 on
        // the command line loses to SPECTRO_OLLAMA_BASE_URL in the environment.
        // The precedence is deliberate (see the method); the silence was not,
        // and the env shadow report above cannot see it: it keys per FIELD, and
        // here both fields won their own.
        String addressField = addressFieldFor(config.provider());
        if (addressField != null) {
            emit(perProviderAddressLines(config.provider(),
                    config.endpointFor(config.provider()),
                    perProviderAddressOf(config),
                    config.baseUrl(),
                    resolved.origins().get(addressField),
                    resolved.origins().get("baseUrl")));
        }

        // Provider reachability. The kind is a pure mapping so a test can hold
        // it to SpectroConfig's provider list — this switch knew three of the
        // seven for two releases and called the built-in one "unknown" on every
        // fresh home (card 164).
        ProviderCheck check = providerCheckFor(config.provider());
        if (check == null) {
            report(false, "unknown provider " + config.provider());
        } else {
            switch (check) {
                case API_KEY -> {
                    String keyVar = SpectroConfig.keyEnvFor(config.provider());
                    report(SpectroConfig.hasApiKey(keyVar), keyVar
                            + (SpectroConfig.hasApiKey(keyVar)
                                    ? " is set" : " is NOT set (export it, or save it in the app)"));
                }
                case OLLAMA -> {
                    // endpointFor resolves ollama's OWN address (card 193) over
                    // the legacy shared baseUrl — probe and printed line carry
                    // the same string a run would dial, never a stale field.
                    String endpoint = config.endpointFor("ollama");
                    var version = new OllamaProvider(new OllamaOptions(endpoint, config.model()))
                            .serverVersion();
                    report(version.isPresent(), "ollama at " + endpoint
                            + version.map(v -> " (version " + v + ")").orElse(" — unreachable"));
                }
                case OPENAI_COMPAT -> {
                    // The EFFECTIVE endpoint, not the raw baseUrl: unset, the raw
                    // value is still ollama's :11434, so doctor used to probe the
                    // wrong port and print it as if it were the openai server.
                    // endpointFor also honours lmstudio's own address (card 193).
                    String endpoint = config.endpointFor(config.provider());
                    emit(openAiCompatLines(config.provider(), endpoint,
                            probe(endpoint + "/v1/models"),
                            SpectroConfig.hasApiKey(SpectroConfig.keyEnvFor(config.provider()))));
                }
                case BUILT_IN -> emit(builtInProviderLines(LlamaServerBinary.find(),
                        config.model(),
                        LocalCatalog.bundled().resolve(config.model()),
                        localModelFile(config.model())));
            }
        }

        // Fleet hub — optional infrastructure: nodes are opt-in, so the lines
        // inform when the env names a hub and never fail the doctor.
        // $SPECTRO_HUB is the node side (what a node DIALS);
        // $SPECTRO_HUB_PORT is the server side (what spectro-server BINDS).
        String hubEnv = System.getenv("SPECTRO_HUB");
        if (hubEnv != null && !hubEnv.isBlank()) {
            info(hubProbe(hubEnv));
        }
        String hubHosting = System.getenv("SPECTRO_HUB_PORT");
        if (hubHosting != null && !hubHosting.isBlank()) {
            info(hubHostingLine(hubHosting));
        }

        // Image provider — a missing key is not unhealthy: generate_image
        // explains itself when used. Doctor just says what would happen.
        String imageKeyVar = "gemini".equals(config.imageProvider())
                ? "GEMINI_API_KEY" : "OPENAI_API_KEY";
        if (System.getenv(imageKeyVar) != null) {
            report(true, "images: " + config.imageProvider() + " (" + imageKeyVar + " is set)");
        } else {
            info("images: " + config.imageProvider() + " — " + imageKeyVar
                    + " not set; generate_image will return a readable error");
        }

        // Web tools (branch web_search) — the tier comes from WebSearchTiers,
        // the SAME resolver the running tool builds from (card 203). This line
        // used to re-derive the rule from TAVILY_API_KEY on its own, so the
        // doctor and the tool described different machines the moment an
        // address was saved in settings rather than exported. browse_page is
        // decided by an installed Chrome. Neither is unhealthy when absent:
        // both tools explain themselves readably.
        emit(webSearchLine(dev.spectroscope.core.web.WebSearchTiers.forConfig(config)));
        dev.spectroscope.core.web.BrowsePageTool.findChrome(config.chromeEnv()).ifPresentOrElse(
                chrome -> report(true, "browse_page: chrome at " + chrome),
                () -> info("browse_page: no Chrome/Chromium found — the tool answers a"
                        + " readable error (install Chrome, or set SPECTRO_CHROME / the"
                        + " chromeBinary setting)"));

        // Skills
        var skills = dev.spectroscope.core.skills.SkillLibrary.load(
                dev.spectroscope.core.skills.SkillLibrary.defaultRoots(cwd));
        report(true, "skills: " + skills.skills().size() + " installed"
                + (skills.skills().isEmpty() ? "" : " ("
                + skills.skills().stream().map(s -> s.name())
                        .collect(java.util.stream.Collectors.joining(", ")) + ")"));

        // Hooks — external pre/post_tool_use shell commands from the config.
        report(true, "hooks: " + config.hooks().size() + " configured"
                + (config.hooks().isEmpty() ? "" : " ("
                + config.hooks().stream().map(h -> h.event() + ":" + h.matcherOrDefault())
                        .collect(java.util.stream.Collectors.joining(", ")) + ")"));

        // MCP servers — connect to each configured server and report its
        // reachability + advertised tool count. A dead/misconfigured server shows as
        // unreachable (a red per-server line, never a doctor crash); with no servers
        // configured this is a neutral info line.
        if (config.mcpServers().isEmpty()) {
            info("mcp: no servers configured (add an \"mcpServers\" block to"
                    + " ~/.spectro/config.json or .spectro/settings.json)");
        } else {
            dev.spectroscope.core.mcp.McpServerRegistry mcp =
                    dev.spectroscope.core.mcp.McpServerRegistry.load(config.mcpServers(), cwd);
            try {
                for (var server : mcp.servers()) {
                    report(server.reachable(), "mcp: " + server.name()
                            + (server.reachable()
                                    ? " reachable at " + server.target()
                                            + " (" + server.toolCount()
                                            + (server.toolCount() == 1 ? " tool)" : " tools)")
                                    // Name the server AND say what went wrong. "UNREACHABLE"
                                    // on its own tells a person their setup is broken and
                                    // nothing about which way to look (card 221, criterion 6).
                                    : " UNREACHABLE at " + server.target()
                                            + (server.failure() == null ? ""
                                                    : " — " + server.failure())));
                }
            } finally {
                mcp.close(); // release the probe's server processes/connections
            }
            // Card 220, AC 5: reachability names the faces it applies to, so a
            // green row can no longer be read as "spectro run has these tools".
            // One line rather than a per-row tail — which faces mount is a
            // property of the config, not of one server's health — and it
            // tracks the headlessMcp key from the SAME settings the probe read.
            info(config.headlessMcp()
                    ? "mcp: servers above are mounted by the repl, the web session and"
                            + " headless runs — headlessMcp is on; spectro run --no-mcp"
                            + " declines it per invocation"
                    : "mcp: servers above are mounted by the repl and the web session; a"
                            + " headless run (run/cron/node) mounts them only with --mcp or"
                            + " headlessMcp in the settings");
        }

        // Vision — a hint, never unhealthy.
        info(visionLine(config.provider(), config.model()));

        // Voice input — STT is optional infrastructure: info when absent.
        // config.sttModel() already folds the settings hierarchy AND SPECTRO_STT_MODEL;
        // the source name (settings vs SPECTRO_STT_MODEL vs default) is presentation only.
        Path sttModel = sttModelPath(config);
        String sttSource = sttModelSource(config);
        boolean whisper = onPath("whisper-cli");
        boolean sttReady = whisper && Files.exists(sttModel);
        if (sttReady) {
            report(true, "voice input: whisper-cli + " + sttModel.getFileName()
                    + " ready (source: " + sttSource + ") (/voice)");
        } else {
            info("voice input: " + (whisper ? "whisper-cli present" : "whisper-cli missing")
                    + " · model (source: " + sttSource + ") "
                    + (Files.exists(sttModel) ? "present" : "missing")
                    + " — run bash scripts/setup-stt.sh to enable /voice");
        }

        // Voice output — TTS is optional infrastructure: info when absent.
        Path piperBin = userHome().resolve(".spectro").resolve("models").resolve("piper").resolve("piper");
        Path ttsVoice = userHome().resolve(".spectro").resolve("models")
                .resolve("en_US-lessac-medium.onnx");
        boolean ttsReady = Files.isExecutable(piperBin) && Files.exists(ttsVoice);
        if (ttsReady) {
            report(true, "voice output: piper + en_US-lessac-medium ready (--speak / /speak on)");
        } else {
            info("voice output: piper " + (Files.isExecutable(piperBin) ? "present" : "missing")
                    + " · voice " + (Files.exists(ttsVoice) ? "present" : "missing")
                    + " — run bash scripts/setup-tts.sh to enable --speak");
        }

        // Data home
        try {
            Files.createDirectories(SessionStore.SESSIONS_DIR);
            Path probe = SessionStore.SESSIONS_DIR.resolve(".doctor-probe");
            Files.writeString(probe, "ok");
            Files.deleteIfExists(probe);
            report(true, "sessions dir writable: " + SessionStore.SESSIONS_DIR
                    + " (" + SessionStore.listSessions().size() + " session(s))");
        } catch (Exception failure) {
            report(false, "sessions dir not writable: " + failure.getMessage());
        }

        // Leveling — an info line, never a hard check: the tutorial is a nicety and
        // an unreadable leveling file is not a broken environment.
        try {
            info(LevelCommand.doctorLine(dev.spectroscope.core.leveling.Ladder.bundled(),
                    dev.spectroscope.core.leveling.LevelingStore.userStore().read()
                            .orElseGet(() -> dev.spectroscope.core.leveling.LevelingState
                                    .fresh(dev.spectroscope.core.leveling.LevelingState.Mode.CHECKLIST))));
        } catch (RuntimeException unreadable) {
            info("leveling: unavailable (" + unreadable.getClass().getSimpleName() + ")");
        }

        // Jobs file
        try {
            int jobs = CronScheduler.loadJobs(new ObjectMapper()).size();
            report(true, "jobs.json: " + jobs + " job(s)");
        } catch (IllegalArgumentException invalid) {
            report(false, "jobs.json: " + invalid.getMessage());
        }

        System.out.println(healthy
                ? ansi.green("\nEverything looks good.")
                : ansi.red("\nSome checks failed — see above."));
        return healthy ? 0 : 1;
    }

    /**
     * How doctor verifies one provider — the pure half of the reachability
     * switch, so {@code DoctorProviderCheckTest} can hold it to
     * {@link SpectroConfig#knownProviders()} instead of trusting that whoever
     * adds the next provider remembers this file.
     */
    enum ProviderCheck {
        /** A cloud service: its {@link SpectroConfig#keyEnvFor} variable must be set. */
        API_KEY,
        /** ollama: ask the local daemon for its version. */
        OLLAMA,
        /** An OpenAI-compatible endpoint: a cheap GET against {@code /v1/models}. */
        OPENAI_COMPAT,
        /** The built-in provider: a llama-server binary and a model file on disk. */
        BUILT_IN
    }

    /**
     * The check that fits a provider.
     *
     * @param provider the configured provider name
     * @return the check kind, or {@code null} when the name is not a provider at
     *         all — doctor then says so, which is the only case that line was
     *         ever meant for
     */
    static ProviderCheck providerCheckFor(String provider) {
        return switch (provider) {
            // gemini and openrouter speak the openai wire, but a request to
            // either without a key never leaves the machine usefully — the key
            // is the thing doctor can actually answer for, offline.
            case "anthropic", "openrouter", "gemini" -> ProviderCheck.API_KEY;
            case "ollama" -> ProviderCheck.OLLAMA;
            case "openai", "lmstudio" -> ProviderCheck.OPENAI_COMPAT;
            case "spectro-local" -> ProviderCheck.BUILT_IN;
            default -> null;
        };
    }

    /** What a check produced: a verdict that moves the exit code, or a note that
     *  does not. Doctor's own {@code report}/{@code info} pair, made a value so
     *  the built-in provider's reasoning is testable without capturing stdout. */
    enum Kind { PASS, FAIL, INFO }

    /**
     * One line of a provider check.
     *
     * @param kind    verdict or note
     * @param message the human-readable text
     */
    record Line(Kind kind, String message) {}

    /** Prints assembled lines through doctor's own two faces. */
    private void emit(List<Line> lines) {
        for (Line line : lines) {
            if (line.kind() == Kind.INFO) {
                info(line.message());
            } else {
                report(line.kind() == Kind.PASS, line.message());
            }
        }
    }

    /**
     * The PATH report: what the agent's shells get, and what the policy had to
     * add to reach it.
     *
     * <p>Two lines rather than one, because they answer different questions. The
     * summary says whether this launch needed help at all — from a terminal that
     * already exports the toolchain the policy is a no-op, and knowing that tells
     * an operator the app is not the problem. The verbatim value is the lookup
     * itself, printed whole: a PATH that is summarised cannot be grepped for the
     * directory somebody's tool is missing from.
     *
     * <p>Notes, never verdicts. An unusual PATH is not an unhealthy install, and
     * a machine without homebrew must not fail doctor.
     *
     * <p>The honest limit of this line: it reports the PATH of the process
     * PRINTING it. Run from a terminal it shows the terminal's; the desktop app's
     * server JVM has its own, and {@link ToolPath} is what makes the two agree
     * about which directories are searched.
     *
     * @param resolved the policy's answer for this process
     * @return the summary line and the verbatim PATH line
     */
    static List<Line> toolPathLines(ToolPath.Result resolved) {
        int entries = resolved.path().isBlank() ? 0 : resolved.path().split(":", -1).length;
        String provenance = resolved.added().isEmpty()
                ? "nothing added, this shell already exports the toolchain"
                : resolved.added().size() + " added by policy: " + String.join(", ", resolved.added());
        return List.of(
                new Line(Kind.INFO, "tool PATH (every run_command shell and hook): "
                        + entries + " entries · " + provenance),
                new Line(Kind.INFO, "tool PATH = " + resolved.path()));
    }

    /**
     * The OpenAI-compatible endpoint's two questions, kept apart: is something
     * answering there, and can we actually call it.
     *
     * <p>The probe alone was the whole check, and it is the weaker half —
     * {@code api.openai.com/v1/models} answers 401 to a keyless request, which
     * is an answer, so a home with no {@code OPENAI_API_KEY} used to collect a
     * green tick and "Everything looks good" while every call it would ever
     * make was going to be refused. The auth line says the second half in the
     * vocabulary the rest of the product already uses
     * ({@link SpectroConfig#onboardingStatusAt}): a public service without its
     * key is {@code needs-key} and red, a server on the operator's own machine
     * is {@code local} and needs nothing.</p>
     *
     * @param provider   the configured provider name
     * @param endpoint   the effective base url (already resolved from the preset)
     * @param reachable  whether the {@code /v1/models} probe got an answer
     * @param keyPresent whether this provider's key variable is set somewhere
     * @return the two lines to print, reachability first
     */
    static List<Line> openAiCompatLines(String provider, String endpoint,
            boolean reachable, boolean keyPresent) {
        List<Line> lines = new java.util.ArrayList<>();
        lines.add(new Line(reachable ? Kind.PASS : Kind.FAIL,
                "openai-compatible server at " + endpoint
                        + (reachable ? " answers" : " — unreachable")));
        String status = SpectroConfig.onboardingStatusAt(provider, endpoint, keyPresent);
        String keyVar = SpectroConfig.keyEnvFor(provider);
        lines.add(switch (status) {
            // "local" is reached by TWO different roads and they are not the same
            // sentence. Printing the first road's words for both told the reader
            // that api.openai.com sits on their own machine, as a fact, whenever
            // they pointed lmstudio at it — a line that had been honest before it
            // was improved. The verdict may be shared; the reason may not.
            case "local" -> SpectroConfig.isLocalEndpoint(endpoint)
                    ? new Line(Kind.INFO, "auth: no key needed — " + endpoint
                            + " is a server on your own machine or network")
                    : new Line(Kind.INFO, "auth: no key is sent — spectroscope carries no key"
                            + " variable for " + provider + ", so " + endpoint
                            + " is called without one (if it wants a key, point "
                            + provider + " at a server that does not, or use a"
                            + " provider that has one)");
            case "ready" -> new Line(Kind.PASS, "auth: " + keyVar + " is set");
            default -> new Line(Kind.FAIL, "auth: " + keyVar + " is NOT set — " + endpoint
                    + " answers the probe but refuses every call without a key"
                    + " (export it, or save it in the app)");
        });
        return lines;
    }

    /**
     * The web_search line, built from the tier the tool itself will use.
     *
     * <p>This method holds no rule of its own — that is the point. The old line
     * read {@code TAVILY_API_KEY} and decided for itself, which was a second
     * copy of a decision that lived in {@code WebSearchTool}; the two agreed
     * only for as long as the environment was the only input. The resolver is
     * now the one input, and this method only chooses a face for it.</p>
     *
     * <p>A configured tier is a PASS. The scrape is an INFO rather than a FAIL:
     * it is not a fault, it is a state the operator should know they are in,
     * and its own label says as much.</p>
     *
     * @param choice the resolved tier
     * @return the one line to print
     */
    static List<Line> webSearchLine(dev.spectroscope.core.web.WebSearchTiers.Choice choice) {
        boolean configured = !dev.spectroscope.core.web.WebSearchTiers.DUCKDUCKGO.equals(choice.tier());
        String message = "web search: " + dev.spectroscope.core.web.WebSearchTiers.describe(choice);
        return List.of(new Line(configured ? Kind.PASS : Kind.INFO, message));
    }

    /**
     * The settings field carrying a provider's own address, or {@code null} for
     * every provider that has none (card 193 gave one to the two local-model
     * backends and to nobody else).
     *
     * @param provider the configured provider name
     * @return "ollamaBaseUrl" | "lmstudioBaseUrl" | null
     */
    static String addressFieldFor(String provider) {
        return switch (provider) {
            case "ollama" -> "ollamaBaseUrl";
            case "lmstudio" -> "lmstudioBaseUrl";
            default -> null;
        };
    }

    /**
     * The folded value of {@code config}'s OWN address field, or {@code null}
     * for a provider that has none — the value half of
     * {@link #addressFieldFor}, read through the record's accessor rather than
     * by field name so the compiler catches a rename.
     *
     * @param config the resolved configuration
     * @return the per-provider address as configured, may be null or blank
     */
    static String perProviderAddressOf(SpectroConfig config) {
        return switch (config.provider()) {
            case "ollama" -> config.ollamaBaseUrl();
            case "lmstudio" -> config.lmstudioBaseUrl();
            default -> null;
        };
    }

    /**
     * The address {@code provider} would fall back to if its OWN field were
     * cleared — {@link SpectroConfig#endpointFor} run with the per-provider
     * value unset, which is exactly what the operator does when he empties the
     * field to get his general address back.
     *
     * <p>It is NOT always {@code baseUrl}. {@link SpectroConfig#effectiveOpenAiBaseUrl}
     * treats the literal ollama default as "unset" for the openai-compat
     * providers — a compatibility rule for configs written before each backend
     * had its own field — so an lmstudio operator who typed exactly that value
     * into the general field lands on LM Studio's preset, not on what he typed.
     * The ollama path carries no such sentinel and takes any non-blank general
     * value verbatim.</p>
     *
     * <p>Computed rather than re-stated: the literal and the presets live in
     * {@code SpectroConfig} and are reached through its own methods, so a
     * change to either rule moves this answer with it.</p>
     *
     * @param provider the configured provider
     * @param baseUrl  the shared field's folded value
     * @return the endpoint an empty per-provider field would resolve to
     */
    static String generalFallbackFor(String provider, String baseUrl) {
        return switch (provider) {
            case "ollama" -> SpectroConfig.effectiveOllamaBaseUrl(null, baseUrl);
            case "lmstudio" -> SpectroConfig.effectiveLmstudioBaseUrl(null, baseUrl);
            default -> baseUrl;
        };
    }

    /**
     * The note that makes card 193's fixed field priority visible.
     *
     * <p>The settings layers fold in ascending precedence (defaults &lt; env &lt;
     * user &lt; launch-dir &lt; project &lt; local &lt; flags), but
     * {@link SpectroConfig#endpointFor} then applies a FIXED priority over the
     * folded result: a provider's own address wins over the shared
     * {@code baseUrl} no matter which layer either value came from. Measured:
     * {@code --base-url=http://flag-box:11434} together with
     * {@code SPECTRO_OLLAMA_BASE_URL=http://env-box:11434} resolves to env-box,
     * so the command-line flag loses; a launch-dir override loses the same way.
     * </p>
     *
     * <p>That precedence is kept on purpose — a field named after ONE provider
     * saying where THAT provider lives is more specific than a shared field
     * every provider once read, and making it layer-aware would mean threading
     * provenance through {@code endpointFor} and therefore through every caller
     * (the provider construction, the server probes, the settings page's
     * address map), turning the card's single resolution point back into
     * several. What is fixed instead is the silence: doctor says the quiet part
     * out loud, names both layers, and leaves the exit code alone — this is a
     * legitimate configuration, not a fault.</p>
     *
     * <p>Card 311 added the two values beside the two origins, because a
     * present key is not a value that wins. A hand-edited
     * {@code "lmstudioBaseUrl": ""} is non-null, so the fold takes it and the
     * Origin names a layer — while {@link SpectroConfig#effectiveLmstudioBaseUrl}
     * reads a blank as unset and dials {@code baseUrl} after all. On origins
     * alone this method claimed an override one line under a probe that had
     * just used the address it declared inapplicable. A blank {@code baseUrl}
     * is the mirror case: the per-provider address wins, but there is no
     * losing address to name.</p>
     *
     * @param provider          the configured provider
     * @param endpoint          the address {@code endpointFor} resolved for it
     * @param perProviderAddress the per-provider field's folded value, may be
     *                          null or blank — either reads as unset
     * @param baseUrl           the shared field's folded value, may be null
     * @param addressOrigin     provenance of the per-provider address field
     * @param baseUrlOrigin     provenance of the legacy shared {@code baseUrl}
     * @return one INFO line when a set per-provider address is overriding a set
     *         {@code baseUrl}, empty otherwise
     */
    static List<Line> perProviderAddressLines(String provider, String endpoint,
            String perProviderAddress, String baseUrl,
            SpectroConfig.Origin addressOrigin, SpectroConfig.Origin baseUrlOrigin) {
        String field = addressFieldFor(provider);
        if (field == null || addressOrigin == null || baseUrlOrigin == null) {
            return List.of();
        }
        // Both halves matter, but not both on both fields: the per-provider
        // fields default to null, so their origin check is belt beside braces
        // (measured — removing it alone leaves every test green), while
        // baseUrl's default is the non-blank literal http://localhost:11434
        // and ONLY its origin can tell "unset" from "typed by hand".
        boolean addressSet = !"defaults".equals(addressOrigin.winner())
                && perProviderAddress != null && !perProviderAddress.isBlank();
        boolean baseUrlSet = !"defaults".equals(baseUrlOrigin.winner())
                && baseUrl != null && !baseUrl.isBlank();
        if (!addressSet || !baseUrlSet) {
            return List.of();       // nothing is being overridden — a line would be noise
        }
        String head = "address: " + field + " (from " + addressOrigin.winner() + ") is what "
                + provider + " dials — " + endpoint + "; baseUrl (from "
                + baseUrlOrigin.winner() + ") is set too and does NOT apply to " + provider;
        // Card 311, review: the claim above is right in every case, but its
        // REASON is wrong in one. When clearing the per-provider field would
        // not hand the general address over either, "a provider's own address
        // wins" names a cause that is not the one operating — and sends the
        // operator to empty a field that will not give him back what he typed.
        String fallback = generalFallbackFor(provider, baseUrl);
        if (!baseUrl.equals(fallback)) {
            return List.of(new Line(Kind.INFO, head
                    + ": that value is the legacy shared default, which " + provider
                    + " reads as unset — clearing " + field + " would fall back to "
                    + fallback + ", not to it"));
        }
        return List.of(new Line(Kind.INFO, head
                + ": a provider's own address wins whatever layer either value came from"));
    }

    /**
     * The vision hint for one (provider, model) pair.
     *
     * <p>This line used to branch on the name "ollama" and tell everyone else
     * that their model "handles images natively" — a claim for lmstudio,
     * openrouter, gemini and the built-in provider that nobody had measured,
     * and that is plainly false for the last one. spectroscope carries a
     * per-model fact for tools and for reasoning ({@code ModelProfile},
     * {@code /api/models/capabilities}) and none at all for vision, so the
     * providers whose answer depends on the model say that instead of
     * guessing. The built-in provider is the one case doctor CAN answer: the
     * runtime starts llama-server with the weights and no projector, so no
     * catalogue entry can see an image.</p>
     *
     * @param provider the configured provider name
     * @param model    the configured model, may be null
     * @return the info line to print
     */
    static String visionLine(String provider, String model) {
        String named = (model == null || model.isBlank()) ? "(no model set)" : model;
        return switch (provider) {
            case "ollama" -> "vision: ollama serves what you pulled — attach images only with"
                    + " a vision model (e.g. ollama pull qwen3-vl); a text-only model fails fast";
            case "lmstudio" -> "vision: lmstudio serves whatever model is loaded — attach images"
                    + " only when that one is vision-capable; a text-only model fails fast";
            // No model name here on purpose: the answer does not depend on one.
            // Naming the CONFIGURED model would also print the wrong id whenever
            // the catalogue swapped it out one line above.
            case "spectro-local" -> "vision: not supported — the built-in runtime starts"
                    + " llama-server with the weights alone (no --mmproj projector), so an"
                    + " attached image never reaches the model, whichever catalogue entry runs";
            default -> "vision: unknown for " + provider + " / " + named
                    + " — no per-model vision fact is carried here (the capabilities endpoint"
                    + " answers for reasoning only); check the model's own docs before"
                    + " attaching an image";
        };
    }

    /**
     * The built-in provider's questions, assembled pure: is there a
     * {@code llama-server} to run at all, which model will really run, and are
     * that model's weights on disk.
     *
     * <p>Only the first is a verdict. A missing binary means the provider cannot
     * answer anything, ever, and the remedy is one brew command. Missing weights
     * are the normal state of a fresh install — the model chooser downloads them
     * on first use — so that line informs and leaves the exit code alone, and so
     * does a configured model the catalogue does not carry: the runtime falls
     * back to a working one, which is a note rather than a broken machine.</p>
     *
     * @param binary          the located llama-server, or empty
     * @param configuredModel the model id the config names, may be null or stale
     * @param model           the catalogue entry that id resolved to
     * @param file            where that model's weights are (or would be downloaded to)
     * @return the lines to print, binary first
     */
    static List<Line> builtInProviderLines(Optional<LlamaServerBinary.Found> binary,
            String configuredModel, LocalCatalog.Model model, ModelResolution.Resolved file) {
        List<Line> lines = new java.util.ArrayList<>();
        lines.add(binary
                .map(found -> new Line(Kind.PASS, "built-in: llama-server "
                        + (found.source() == LlamaServerBinary.Source.BUNDLE
                                ? "bundled with the app (" + found.path() + ")"
                                : "at " + found.path())))
                .orElseGet(() -> new Line(Kind.FAIL, "built-in: no llama-server found"
                        + " — the built-in provider runs models through it."
                        + " Install llama.cpp (brew install llama.cpp), or use the"
                        + " desktop run kit, which bundles one")));
        // The catalogue quietly falls back to its default for an id it does not
        // carry (LocalCatalog.resolve), which is right for the runtime and was
        // silent here: doctor printed the configured model on the config line
        // and a different one on the next, with no word between them.
        if (configuredModel != null && !configuredModel.isBlank()
                && !configuredModel.equals(model.id())) {
            lines.add(new Line(Kind.INFO, "built-in: configured model \"" + configuredModel
                    + "\" is not in the catalogue — the built-in runtime will run "
                    + model.id() + " instead (the model chooser lists what this build offers)"));
        }
        if (file.source() == ModelResolution.Source.ABSENT) {
            lines.add(new Line(Kind.INFO, "built-in model " + model.id()
                    + " is not downloaded yet — the model chooser fetches "
                    + gigabytes(model.sizeBytes()) + " into " + file.path()
                    + " on first use; a fresh install is expected to look like this"));
        } else {
            lines.add(new Line(Kind.PASS, "built-in model " + model.id() + ": "
                    + file.path() + " ("
                    + (file.source() == ModelResolution.Source.BUNDLE
                            ? "bundled with the app" : "downloaded") + ")"));
        }
        return lines;
    }

    /** Where the selected built-in model's weights are, or would be downloaded to.
     *  @param modelId the configured model id (null or stale resolves to the default)
     *  @return the resolution over this machine's real bundle and user model dirs */
    private static ModelResolution.Resolved localModelFile(String modelId) {
        return ModelResolution.locate(LocalModel.bundleDir(), LocalModel.userModelsDir(),
                LocalCatalog.bundled().resolve(modelId).file());
    }

    /** A download size in whole-tenths of a gigabyte, for a hint line.
     *  @param bytes the exact size from the catalogue
     *  @return e.g. "2.5 GB" */
    private static String gigabytes(long bytes) {
        return String.format(Locale.ROOT, "%.1f GB", bytes / 1_000_000_000d);
    }

    /**
     * One human line about the configured fleet hub: a plain TCP dial with a
     * short timeout — reachable, unreachable, or an invalid address. Never a
     * wire handshake: doctor informs, it does not join the fleet.
     *
     * @param address the raw $SPECTRO_HUB value (host:port)
     * @return the info line to print, naming the state unambiguously
     */
    static String hubProbe(String address) {
        NodeCommand.HubAddress hub;
        try {
            hub = NodeCommand.parseHub(address);
        } catch (IllegalArgumentException invalid) {
            return "hub: $SPECTRO_HUB invalid — " + invalid.getMessage();
        }
        try (java.net.Socket socket = new java.net.Socket()) {
            socket.connect(new java.net.InetSocketAddress(hub.host(), hub.port()), 500);
            return "hub: " + address + " reachable — fleet nodes can join";
        } catch (java.io.IOException dead) {
            return "hub: " + address + " unreachable — is the aggregator up?";
        }
    }

    /**
     * The hosting twin of {@link #hubProbe}: what {@code SPECTRO_HUB_PORT}
     * will make spectro-server BIND on boot — or the typo, named loudly, so
     * the operator never believes a fleet is on that silently is not.
     *
     * @param value the raw $SPECTRO_HUB_PORT value
     * @return the info line to print
     */
    static String hubHostingLine(String value) {
        try {
            int port = Integer.parseInt(value.strip());
            return "hub hosting: SPECTRO_HUB_PORT=" + port
                    + " — spectro-server binds loopback:" + port + " on boot";
        } catch (NumberFormatException invalid) {
            return "hub hosting: SPECTRO_HUB_PORT invalid (\"" + value
                    + "\") — the server keeps the hub OFF";
        }
    }

    /**
     * One ✓/✗ check line; a false result also marks the whole doctor unhealthy.
     *
     * @param ok      the check's verdict — false turns the final exit code red
     * @param message the human-readable finding printed after the mark
     */
    private void report(boolean ok, String message) {
        healthy &= ok;
        System.out.println("  " + (ok ? ansi.green("✓") : ansi.red("✗")) + " " + message);
    }

    /**
     * A dimmed, extra-indented note — context or optional infrastructure, never a verdict.
     *
     * @param message the hint to print; it does not affect the exit code
     */
    private void info(String message) {
        System.out.println("    " + ansi.dim(message));
    }

    /**
     * The major Java version out of {@code java.version} — tolerant of the old
     * {@code 1.8.0} scheme only insofar as unparseable strings count as 0 (fails the check).
     *
     * @param version the raw {@code java.version} system property
     * @return the leading major number, or 0 when it cannot be parsed
     */
    private static int parseMajor(String version) {
        try {
            String head = version.split("\\.")[0];
            return Integer.parseInt(head);
        } catch (NumberFormatException old) {
            return 0;
        }
    }

    /**
     * The user's home directory — base of every {@code ~/.spectro} path probed here.
     *
     * @return {@code user.home} as a Path
     */
    private static Path userHome() {
        return Path.of(System.getProperty("user.home"));
    }

    /**
     * The env override for a model path, or the given default when unset/blank.
     *
     * @param var      the environment variable that may carry an alternative path
     * @param fallback the path used when the variable is unset or blank
     * @return the effective path to check
     */
    private static Path envPath(String var, Path fallback) {
        String override = System.getenv(var);
        return (override != null && !override.isBlank()) ? Path.of(override) : fallback;
    }

    /**
     * The effective whisper model path: {@code config.sttModel()} (settings
     * hierarchy, already folding {@code SPECTRO_STT_MODEL}) wins when non-blank,
     * else the same {@code envPath} default chain doctor always used.
     *
     * @param config the loaded config
     * @return the model path doctor checks for existence
     */
    private static Path sttModelPath(SpectroConfig config) {
        String configured = config.sttModel();
        return (configured != null && !configured.isBlank())
                ? Path.of(configured)
                : envPath("SPECTRO_STT_MODEL",
                        userHome().resolve(".spectro").resolve("models").resolve("ggml-small.bin"));
    }

    /**
     * Names where the effective STT model path came from, for the doctor line —
     * a settings file, {@code SPECTRO_STT_MODEL} directly, or the built-in default.
     *
     * @param config the loaded config
     * @return {@code "settings"}, {@code "SPECTRO_STT_MODEL"}, or {@code "default"}
     */
    private static String sttModelSource(SpectroConfig config) {
        String configured = config.sttModel();
        if (configured == null || configured.isBlank()) {
            return "default";
        }
        return configured.equals(System.getenv("SPECTRO_STT_MODEL")) ? "SPECTRO_STT_MODEL" : "settings";
    }

    /**
     * True when {@code command} resolves on the PATH (used for the STT binary check).
     *
     * @param command the binary name to look for in every PATH entry
     * @return true when an executable of that name exists on the PATH
     */
    private static boolean onPath(String command) {
        String path = System.getenv("PATH");
        if (path == null) {
            return false;
        }
        for (String dir : path.split(java.io.File.pathSeparator)) {
            if (!dir.isBlank() && Files.isExecutable(Path.of(dir, command))) {
                return true;
            }
        }
        return false;
    }

    /**
     * A cheap GET reachability probe (any HTTP answer counts as reachable).
     *
     * @param url the endpoint to hit with short connect/request timeouts
     * @return true for any status below 500; false for 5xx, timeouts, or refusal
     */
    private static boolean probe(String url) {
        try (HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(2)).build()) {
            HttpResponse<Void> response = client.send(
                    HttpRequest.newBuilder(URI.create(url)).GET()
                            .timeout(Duration.ofSeconds(3)).build(),
                    HttpResponse.BodyHandlers.discarding());
            return response.statusCode() < 500;
        } catch (Exception unreachable) {
            return false;
        }
    }
}
