package dev.spectroscope.cli;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.config.WorkspaceResolver;
import dev.spectroscope.core.provider.OllamaOptions;
import dev.spectroscope.core.provider.OllamaProvider;
import dev.spectroscope.core.scheduler.CronScheduler;
import dev.spectroscope.core.session.SessionStore;
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
import java.util.Locale;
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

        // Provider reachability
        switch (config.provider()) {
            case "anthropic" -> report(System.getenv("ANTHROPIC_API_KEY") != null,
                    "ANTHROPIC_API_KEY " + (System.getenv("ANTHROPIC_API_KEY") != null
                            ? "is set" : "is NOT set (export ANTHROPIC_API_KEY=...)"));
            case "ollama" -> {
                var version = new OllamaProvider(new OllamaOptions(config.baseUrl(), config.model()))
                        .serverVersion();
                report(version.isPresent(), "ollama at " + config.baseUrl()
                        + version.map(v -> " (version " + v + ")").orElse(" — unreachable"));
            }
            case "openai" -> report(probe(config.baseUrl() + "/v1/models"),
                    "openai-compatible server at " + config.baseUrl());
            default -> report(false, "unknown provider " + config.provider());
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

        // Web tools (branch web_search) — the search tier is decided by
        // TAVILY_API_KEY, browse_page by an installed Chrome. Neither is
        // unhealthy when absent: both tools explain themselves readably.
        if (System.getenv("TAVILY_API_KEY") != null && !System.getenv("TAVILY_API_KEY").isBlank()) {
            report(true, "web search: tavily tier (TAVILY_API_KEY is set)");
        } else {
            info("web search: duckduckgo fallback (keyless) — set TAVILY_API_KEY"
                    + " for the Tavily tier");
        }
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
                                    : " UNREACHABLE at " + server.target()));
                }
            } finally {
                mcp.close(); // release the probe's server processes/connections
            }
        }

        // Vision — a hint, never unhealthy. Only the local (ollama) path
        // needs a vision-capable model; the cloud model (claude) always sees.
        if ("ollama".equals(config.provider())) {
            info("vision: local provider — attach images only with a vision model"
                    + " (e.g. ollama pull qwen3-vl); a text-only model fails fast");
        } else {
            info("vision: " + config.provider() + " model handles images natively"
                    + " — attach with --image (headless) or the web composer");
        }

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
