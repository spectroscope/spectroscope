package dev.spectroscope.core.config;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.mcp.McpServerConfig;
import dev.spectroscope.core.provider.AnthropicProvider;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.OllamaOptions;
import dev.spectroscope.core.provider.OllamaProvider;
import dev.spectroscope.core.provider.OpenAiCompatProvider;
import dev.spectroscope.core.provider.RetryPolicy;
import dev.spectroscope.core.provider.RetryingProvider;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.Function;

/**
 * The spectroscope configuration with the full settings hierarchy (Claude-Code style):
 *
 * <pre>defaults &lt; env (SPECTRO_*) &lt; ~/.spectro/settings.json (config.json compat)
 * &lt; &lt;project&gt;/.spectro/settings.json &lt; &lt;workspace&gt;/.spectro/settings.json
 * &lt; &lt;workspace&gt;/.spectro/settings.local.json &lt; CLI flags</pre>
 *
 * The environment (typically fed from a gitignored {@code ./.env}) is the
 * BASE just above the defaults — settings files call the shots from there:
 * the per-project (launch-dir) file carries team conventions into the repo
 * (checked in), the user file holds personal defaults, and — joined at the
 * session moment once a workspace resolves, see {@link #loadForWorkspace} —
 * the workspace's own pair speaks loudest of all short of a flag: its
 * project half is meant to be portable and shared, its local half
 * (gitignored by convention) machine-specific. All fields are optional at
 * every layer; missing fields fall through to the layer below.
 *
 * @param provider            "anthropic", "ollama" or "openai" (LM Studio &amp; friends)
 * @param model               model id for the chosen provider
 * @param baseUrl             base URL for ollama/openai (ignored for anthropic)
 * @param compactionThreshold input-token threshold that triggers compaction
 * @param permissionMode      "ask", "auto" or "readonly"
 * @param autoApprove         permission allowlist, e.g. ["write_file", "run_command:git status*"]
 * @param imageProvider       "gemini" or "openai" — the backend of the generate_image tool
 * @param thinking            surface the model's reasoning stream (default true)
 * @param mcpServers          external MCP servers to connect to; never null,
 *                            defaults to an empty list. The JSON is an object keyed by
 *                            server name; each entry becomes an {@link McpServerConfig}
 *                            with {@code name} taken from the key. A higher-precedence
 *                            layer that defines {@code mcpServers} replaces the whole
 *                            block below it (no deep per-server merge).
 * @param maxRetries          transient-failure retries per provider call (0 disables;
 *                            the wrap happens once in {@link #providerFromConfig()})
 * @param promptCaching       Anthropic prompt caching (cache_control breakpoints);
 *                            a no-op for ollama/openai
 * @param hooks               external shell hooks around tool calls (pre_tool_use /
 *                            post_tool_use); never null. A higher layer that defines
 *                            {@code hooks} replaces the whole block below it —
 *                            whole-block merge, exactly like {@code mcpServers}.
 * @param workspace           the agent's working directory (file tools,
 *                            glob/grep, run_command); {@code null} means a
 *                            per-session folder under the OS temp dir — see
 *                            {@link WorkspaceResolver}
 * @param logLevel            operator-log detail for the file appender
 *                            (error | warn | info | debug | trace, default
 *                            info; env {@code SPECTRO_LOG_LEVEL} wins) — the
 *                            never touches the RunEvent wire
 * @param imageModel          override for the image backend's default model
 *                           ; {@code null} means "use the backend's
 *                            own default" — env {@code SPECTRO_IMAGE_MODEL}
 * @param sttModel            path to the local whisper.cpp model file;
 *                            {@code null} means the CLI-side default —
 *                            env {@code SPECTRO_STT_MODEL}
 * @param chromeBinary        override for the system-Chrome binary used by
 *                            {@code browse_page}; {@code null} means the
 *                            built-in discovery — env {@code SPECTRO_CHROME}
 */
public record SpectroConfig(
        String provider,
        String model,
        String baseUrl,
        int compactionThreshold,
        String permissionMode,
        List<String> autoApprove,
        String imageProvider,
        boolean thinking,
        List<McpServerConfig> mcpServers,
        int maxRetries,
        boolean promptCaching,
        List<HookConfig> hooks,
        String workspace,
        String logLevel,
        String imageModel,
        String sttModel,
        String chromeBinary) {

    /** Canonical constructor guards against null block fields — callers get empty lists. */
    public SpectroConfig {
        mcpServers = mcpServers == null ? List.of() : List.copyOf(mcpServers);
        hooks = hooks == null ? List.of() : List.copyOf(hooks);
    }

    public static final Path CONFIG_PATH =
            Path.of(System.getProperty("user.home"), ".spectro", "config.json");

    /** The user scope's NEW name; config.json keeps being read underneath for one release.
     *  Public (like {@link #CONFIG_PATH}): the doctor's {@code --migrate} rename and its
     *  own tests live in {@code spectroscope.cli}, outside this package. */
    public static final Path USER_SETTINGS_PATH =
            Path.of(System.getProperty("user.home"), ".spectro", "settings.json");

    /** Project-level settings file, relative to the working directory. */
    public static final String PROJECT_SETTINGS = ".spectro/settings.json";

    /** Workspace-local settings file (machine-local, gitignored by convention) —
     *  sits directly above the workspace's own project settings in the chain,
     *  below only the CLI flags. Relative to the workspace directory, same
     *  shape as {@link #PROJECT_SETTINGS}. */
    static final String WS_LOCAL_SETTINGS = ".spectro/settings.local.json";

    // Package-private (not private): SettingsWriter's patch validation references
    // these as the single source instead of re-declaring the same literals.
    static final Set<String> KNOWN_PROVIDERS =
            Set.of("anthropic", "ollama", "openai", "lmstudio", "openrouter");
    static final Set<String> KNOWN_IMAGE_PROVIDERS = Set.of("gemini", "openai");
    static final Set<String> KNOWN_LOG_LEVELS =
            Set.of("error", "warn", "info", "debug", "trace");
    /** {@code permissionMode}'s known values — the single source for both the
     *  load-time check below and {@link SettingsWriter}'s write-time check. */
    static final Set<String> KNOWN_PERMISSION_MODES = Set.of("ask", "auto", "readonly");

    private static final SpectroConfig DEFAULTS = new SpectroConfig(
            "anthropic", "claude-opus-4-8", "http://localhost:11434", 100_000, "ask", List.of(),
            "gemini", true, List.of(), 2, true, List.of(), // 2 retries; caching on; no hooks
            null, // workspace: per-session temp folder unless configured
            "info", // logLevel: file diagnostics at info; console stays WARN-quiet
            null, null, null); // imageModel/sttModel/chromeBinary: backend/CLI/discovery defaults

    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * Overrides from the CLI flags. Each field is nullable: a null means "not set
     * on the command line" and leaves the lower layers in place.
     *
     * @param provider            the {@code --provider} flag; null when not given
     * @param model               the {@code --model} flag; null when not given
     * @param baseUrl             the {@code --base-url} flag; null when not given
     * @param compactionThreshold the {@code --compaction-threshold} flag; null when not given
     * @param permissionMode      permission-mode override (ask/auto/readonly); null when not given
     * @param workspace           the {@code --workspace} flag; null when not given
     */
    public record Overrides(
            String provider,
            String model,
            String baseUrl,
            Integer compactionThreshold,
            String permissionMode,
            String workspace) {

        /** The all-null overrides for callers without a command line (server boot, tests).
         *  @return overrides that defer every field to the layers below */
        public static Overrides none() {
            return new Overrides(null, null, null, null, null, null);
        }
    }

    /**
     * Where a resolved field's value came from — the settings UI's provenance
     * view (e.g. "workspace: from user settings; env shadowed").
     *
     * @param winner   the layer name that supplied the value ({@code "defaults"}
     *                 when no scope set it at all); one of {@code "defaults"},
     *                 {@code "env"}, {@code "user"}, {@code "launch-dir"},
     *                 {@code "project"}, {@code "local"}, {@code "flags"}
     * @param shadowed lower layers that also supplied a value but were
     *                 overridden by the winner, highest (closest to the
     *                 winner) first
     */
    public record Origin(String winner, List<String> shadowed) {}

    /**
     * The effective configuration alongside a full provenance trail: which
     * layer won each of the 17 fields (see {@link Origin}), and the raw
     * non-empty scopes as JSON — the settings API's "layers" view.
     *
     * @param config  the effective, validated configuration — identical to
     *                what {@link #load} returns for the same arguments
     * @param origins per-field winner + shadowed layers, keyed by field name
     * @param layers  each non-empty scope's own settings as JSON, keyed by
     *                layer name ({@code "env"}, {@code "user"},
     *                {@code "launch-dir"}, {@code "project"}, {@code "local"},
     *                {@code "flags"}); a scope that set nothing at all is
     *                simply absent from the map, never present as {@code {}}
     */
    public record Resolved(SpectroConfig config, Map<String, Origin> origins, Map<String, JsonNode> layers) {}

    /** Convenience loader: the project layer resolves at the current working directory.
     *  @param overrides the CLI layer — null fields defer to the hierarchy below
     *  @return the effective, validated configuration */
    public static SpectroConfig load(Overrides overrides) {
        return load(overrides, Path.of(System.getProperty("user.dir")));
    }

    /**
     * Loads the full hierarchy: defaults, then the environment (SPECTRO_*), then
     * ~/.spectro/settings.json (config.json compat), then
     * {@code projectDir}/.spectro/settings.json, then the CLI overrides.
     * A missing file at any layer is fine; malformed JSON fails loudly on
     * purpose — a broken config is a programming error, not something to
     * silently ignore.
     *
     * @param overrides  the CLI layer — null fields defer to the hierarchy below
     * @param projectDir directory whose {@code .spectro/settings.json} forms the project layer
     * @return the effective, validated configuration
     */
    public static SpectroConfig load(Overrides overrides, Path projectDir) {
        return load(overrides, projectDir, System.getenv());
    }

    /** Visible for tests: the environment layer (SPECTRO_PROVIDER/MODEL/BASE_URL,
     *  typically fed from ./.env) is injectable. Precedence: defaults &lt;
     *  environment &lt; user settings (~/.spectro/settings.json, with
     *  ~/.spectro/config.json underneath as compat) &lt; project settings &lt; flags —
     *  env is the BASE directly above the defaults; settings files call the shots.
     *  Delegates to the 4-arg overload with a {@code null} workspace — the
     *  process-moment view, with no workspace scopes in the chain.
     *  @param overrides  the CLI layer, highest precedence
     *  @param projectDir directory whose {@code .spectro/settings.json} forms the project layer
     *  @param env        the environment layer — injectable so tests need no real env
     *  @return the effective, validated configuration */
    static SpectroConfig load(Overrides overrides, Path projectDir, Map<String, String> env) {
        return load(overrides, projectDir, null, env);
    }

    /**
     * Session-moment load: once a session's workspace is resolved (see
     * {@code WorkspaceResolver}), its own {@code .spectro} settings pair joins
     * the chain directly below the CLI flags — the folder the agent actually
     * works in gets the loudest settings voice short of a flag. Reads
     * {@code System.getenv()} for the environment layer.
     *
     * @param overrides  the CLI layer, highest precedence
     * @param projectDir directory whose {@code .spectro/settings.json} forms the launch-dir layer
     * @param workspace  the resolved workspace directory whose own {@code .spectro}
     *                   pair (project, then local) joins the chain
     * @return the effective, validated configuration
     */
    public static SpectroConfig loadForWorkspace(Overrides overrides, Path projectDir, Path workspace) {
        return load(overrides, projectDir, workspace, System.getenv());
    }

    /** Visible for tests: the workspace layer is injectable alongside the
     *  environment. Precedence: defaults &lt; environment &lt; user settings
     *  (~/.spectro/settings.json, with ~/.spectro/config.json underneath as compat)
     *  &lt; launch-dir project settings &lt; the workspace's own project settings
     *  &lt; the workspace's local settings &lt; flags — env is the BASE directly
     *  above the defaults; every settings file calls the shots above it. A
     *  {@code null} workspace omits both workspace scopes entirely — the
     *  process-moment view used before a session resolves one, and the exact
     *  behaviour of the 3-arg overload above. Delegates to {@link #loadResolved}
     *  and discards its provenance — callers that want the "why" use that
     *  method directly.
     *  @param overrides  the CLI layer, highest precedence
     *  @param projectDir directory whose {@code .spectro/settings.json} forms the launch-dir layer
     *  @param workspace  the resolved workspace directory, or {@code null} to skip
     *                     the workspace scopes entirely
     *  @param env        the environment layer — injectable so tests need no real env
     *  @return the effective, validated configuration */
    static SpectroConfig load(Overrides overrides, Path projectDir, Path workspace,
                            Map<String, String> env) {
        return loadResolved(overrides, projectDir, workspace, env).config();
    }

    /**
     * Session-moment load with a full provenance trail: which layer won each
     * of the 17 fields (see {@link Origin}) and the non-empty scopes as raw
     * JSON (the settings API's "layers" view) — the same resolution
     * {@link #load}/{@link #loadForWorkspace} perform, with the "why" kept
     * instead of thrown away. Reads {@code System.getenv()} for the
     * environment layer.
     *
     * @param overrides  the CLI layer, highest precedence
     * @param projectDir directory whose {@code .spectro/settings.json} forms the launch-dir layer
     * @param workspace  the resolved workspace directory whose own {@code .spectro}
     *                   pair (project, then local) joins the chain, or
     *                   {@code null} to skip both workspace scopes
     * @return the effective configuration alongside its provenance
     */
    public static Resolved loadResolved(Overrides overrides, Path projectDir, Path workspace) {
        return loadResolved(overrides, projectDir, workspace, System.getenv());
    }

    /**
     * Visible for tests: the environment layer is injectable alongside the
     * workspace. Builds the SAME scope chain {@code load} used to fold by
     * hand — env, user (config.json overridden by settings.json), launch-dir,
     * then (only when {@code workspace} is given) the workspace's own project
     * and local settings, then flags — folds it into one effective config
     * exactly as before (see {@link #finishResolve}), and probes the
     * identical scopes a second time per field to build the provenance map,
     * so the reported origins can never drift from what the fold actually used.
     *
     * @param overrides  the CLI layer, highest precedence
     * @param projectDir directory whose {@code .spectro/settings.json} forms the launch-dir layer
     * @param workspace  the resolved workspace directory, or {@code null} to skip
     *                   the workspace scopes entirely
     * @param env        the environment layer — injectable so tests need no real env
     * @return the effective configuration alongside its provenance
     */
    static Resolved loadResolved(Overrides overrides, Path projectDir, Path workspace,
            Map<String, String> env) {
        List<Scope> scopes = new ArrayList<>();
        scopes.add(new Scope("env", PartialConfig.fromEnv(env)));
        scopes.add(new Scope("user", readFile(CONFIG_PATH).overriddenBy(readFile(USER_SETTINGS_PATH))));
        scopes.add(new Scope("launch-dir", readFile(projectDir.resolve(PROJECT_SETTINGS))));
        if (workspace != null) {
            Path wsProjectFile = workspace.resolve(PROJECT_SETTINGS);
            Path wsLocalFile = workspace.resolve(WS_LOCAL_SETTINGS);
            PartialConfig wsProject = readFile(wsProjectFile);
            PartialConfig wsLocal = readFile(wsLocalFile);
            rejectProcessGlobals(wsProject, wsProjectFile);
            rejectProcessGlobals(wsLocal, wsLocalFile);
            scopes.add(new Scope("project", wsProject));
            scopes.add(new Scope("local", wsLocal));
        }
        scopes.add(new Scope("flags", PartialConfig.fromOverrides(overrides)));

        // One ascending-precedence fold, scope by scope — the direct successor
        // of the old hand-wired chain: defaults < env < user settings <
        // launch-dir settings < workspace settings (project, then local) < flags.
        PartialConfig folded = new PartialConfig();
        for (Scope scope : scopes) {
            folded = folded.overriddenBy(scope.partial());
        }
        SpectroConfig config = finishResolve(folded);

        // Provenance: re-walk the SAME scopes per field, on each scope's own
        // (pre-fold) partial — so a whole-block field like mcpServers/hooks is
        // attributed to whichever layer set the block, never to a layer that
        // merely left an inner key standing.
        Map<String, Origin> origins = new LinkedHashMap<>();
        for (FieldProbe probe : FIELD_PROBES) {
            String winner = "defaults";
            List<String> shadowed = new ArrayList<>();
            for (Scope scope : scopes) {                       // ascending: last hit wins
                if (probe.get().apply(scope.partial()) != null) {
                    if (!"defaults".equals(winner)) {
                        shadowed.add(winner);
                    }
                    winner = scope.name();
                }
            }
            Collections.reverse(shadowed);                     // highest shadowed first
            origins.put(probe.name(), new Origin(winner, List.copyOf(shadowed)));
        }

        // Layers view: each scope's own settings as sparse JSON, present only
        // when the scope actually set something (an absent scope is absent,
        // never {}).
        Map<String, JsonNode> layers = new LinkedHashMap<>();
        for (Scope scope : scopes) {
            JsonNode node = JSON.valueToTree(scope.partial());
            if (node.isObject() && !node.isEmpty()) {
                layers.put(scope.name(), node);
            }
        }
        return new Resolved(config, origins, layers);
    }

    /** First-boot seed: when NO user file exists (neither settings.json nor the
     *  legacy config.json), materialize the env base into ~/.spectro/settings.json —
     *  the user sees their exact current behavior in the new file and the Settings
     *  page, and day one changes nothing functionally. Secrets never enter.
     *  {@code CREATE_NEW} makes the existence check and the write one atomic
     *  filesystem operation — a racing process that seeds first is discovered
     *  as a (caught, ignored) {@code FileAlreadyExistsException} instead of a
     *  clobbered file, closing the exists-then-write gap the earlier
     *  {@code Files.exists} check left open.
     *  @param env the environment layer — injectable so tests need no real env
     *  @return true when this call just wrote a fresh {@code settings.json};
     *          false when a user scope already existed, there was nothing in
     *          the env worth seeding, or a racing process won instead — the
     *          doctor face reports this line only when it actually fired */
    public static boolean ensureSeeded(Map<String, String> env) {
        if (Files.exists(USER_SETTINGS_PATH) || Files.exists(CONFIG_PATH)) {
            return false;
        }
        PartialConfig fromEnv = PartialConfig.fromEnv(env);
        JsonNode node = JSON.valueToTree(fromEnv);
        if (!node.isObject() || node.isEmpty()) {
            return false;                        // nothing to seed
        }
        try {
            Files.createDirectories(USER_SETTINGS_PATH.getParent());
            Files.writeString(USER_SETTINGS_PATH,
                    JSON.writerWithDefaultPrettyPrinter().writeValueAsString(node),
                    StandardOpenOption.CREATE_NEW);
            return true;
        } catch (IOException ignored) {
            // Seeding is a convenience — a read-only home never blocks a run,
            // and CREATE_NEW racing into FileAlreadyExistsException just means
            // another process seeded first; both are equally "not seeded here".
            return false;
        }
    }

    /** Finishes a fully-folded partial into the effective config: fills every
     *  remaining gap from DEFAULTS, validates the known-value fields, and
     *  applies the local-provider model fallback when no layer named a model
     *  explicitly. Extracted verbatim from the pre-Task-6 {@code load} body —
     *  {@link #loadResolved} is now its only caller.
     *  @param folded the fully-folded partial (every scope applied, ascending)
     *  @return the effective, validated configuration */
    private static SpectroConfig finishResolve(PartialConfig folded) {
        // Any non-default layer setting model — files, env or the flag — counts
        // as explicit; only then do we skip the local-provider fallback below.
        boolean explicitModel = folded.model != null;
        SpectroConfig base = folded.merged();

        validateKnown("provider", base.provider(), KNOWN_PROVIDERS,
                "anthropic, ollama, openai");
        validateKnown("image provider", base.imageProvider(), KNOWN_IMAGE_PROVIDERS,
                "gemini, openai");
        // A typo must not silently disable what the owner configured — the same
        // reasoning that already covered provider/imageProvider/logLevel now
        // covers permissionMode too (it used to load unchecked).
        validateKnown("permissionMode", base.permissionMode(), KNOWN_PERMISSION_MODES,
                "ask, auto, readonly");
        validateKnown("logLevel", base.logLevel(), KNOWN_LOG_LEVELS,
                "error, warn, info, debug, trace");

        // Local providers without an explicitly set model: use sensible local defaults
        // instead of the Claude id.
        if (!explicitModel) {
            String fallback = switch (base.provider()) {
                case "ollama" -> "qwen3";
                case "openai" -> "local-model"; // LM Studio ignores unknown ids and uses the loaded one
                default -> base.model();
            };
            if (!fallback.equals(base.model())) {
                base = new SpectroConfig(base.provider(), fallback, base.baseUrl(),
                        base.compactionThreshold(), base.permissionMode(), base.autoApprove(),
                        base.imageProvider(), base.thinking(), base.mcpServers(),
                        base.maxRetries(), base.promptCaching(), base.hooks(),
                        base.workspace(), base.logLevel(),
                        base.imageModel(), base.sttModel(), base.chromeBinary());
            }
        }
        return base;
    }

    /** One named layer in the resolution chain, paired with its own (pre-fold)
     *  partial — provenance probing reads this directly, never the fold, so a
     *  whole-block field (mcpServers, hooks) is attributed to the layer that
     *  set the block, not to whichever layer happens to leave an inner key
     *  standing after the fold.
     *  @param name    the layer name surfaced in {@link Origin} and {@link Resolved#layers()}
     *  @param partial that layer's own settings, independent of every other scope */
    private record Scope(String name, PartialConfig partial) {}

    /** One resolvable field, named for {@link Origin} and read straight off a
     *  single scope's partial (never the fold) so provenance probing can ask
     *  "did THIS layer set this field" independent of any other layer.
     *  @param name the field name as it appears in {@link Resolved#origins()}
     *  @param get  reads this field off one scope's partial; {@code null} means unset */
    private record FieldProbe(String name, Function<PartialConfig, Object> get) {}

    /** Every resolvable field, in {@link SpectroConfig}'s record-component order —
     *  drives the per-field provenance loop in {@link #loadResolved}. */
    private static final List<FieldProbe> FIELD_PROBES = List.of(
            new FieldProbe("provider", p -> p.provider),
            new FieldProbe("model", p -> p.model),
            new FieldProbe("baseUrl", p -> p.baseUrl),
            new FieldProbe("compactionThreshold", p -> p.compactionThreshold),
            new FieldProbe("permissionMode", p -> p.permissionMode),
            new FieldProbe("autoApprove", p -> p.autoApprove),
            new FieldProbe("imageProvider", p -> p.imageProvider),
            new FieldProbe("thinking", p -> p.thinking),
            new FieldProbe("mcpServers", p -> p.mcpServers),
            new FieldProbe("maxRetries", p -> p.maxRetries),
            new FieldProbe("promptCaching", p -> p.promptCaching),
            new FieldProbe("hooks", p -> p.hooks),
            new FieldProbe("workspace", p -> p.workspace),
            new FieldProbe("logLevel", p -> p.logLevel),
            new FieldProbe("imageModel", p -> p.imageModel),
            new FieldProbe("sttModel", p -> p.sttModel),
            new FieldProbe("chromeBinary", p -> p.chromeBinary));

    /** Circularity + process-global rule: a workspace settings file must not
     *  re-point the workspace itself, nor reconfigure the one-per-process log
     *  level. Fails loudly, naming the offending file — a workspace scope is
     *  meant to be portable (the project half even checked in), so a folder
     *  silently redirecting the agent elsewhere or hijacking process-wide
     *  logging would be a surprise nobody could debug from the settings alone.
     *  @param scope the parsed workspace-scope layer (project or local)
     *  @param file  the file it was read from, named in the thrown message
     *  @throws IllegalArgumentException when the scope sets a forbidden field */
    private static void rejectProcessGlobals(PartialConfig scope, Path file) {
        if (scope.workspace != null) {
            throw new IllegalArgumentException("\"workspace\" is not allowed in a workspace scope ("
                    + file + ") — a folder must not point the agent at a different folder.");
        }
        if (scope.logLevel != null) {
            throw new IllegalArgumentException("\"logLevel\" is process-global and not allowed in a "
                    + "workspace scope (" + file + ") — set it in ~/.spectro/settings.json or SPECTRO_LOG_LEVEL.");
        }
    }

    /** A copy of this config with only the provider/model pair swapped — the
     *  mid-session switch derives configs HERE, never via the canonical ctor,
     *  so record growth cannot silently drop fields again.
     *  @param provider the new provider ("anthropic" | "ollama" | "openai")
     *  @param model    the new model, paired with {@code provider}
     *  @return a new config identical to this one except provider and model */
    public SpectroConfig withProvider(String provider, String model) {
        return new SpectroConfig(provider, model, baseUrl,
                compactionThreshold, permissionMode, autoApprove,
                imageProvider, thinking, mcpServers,
                maxRetries, promptCaching, hooks,
                workspace, logLevel, imageModel, sttModel, chromeBinary);
    }

    /**
     * Fails loudly when a resolved field's value is outside its known set — a
     * typo must never silently disable what the user configured. The allowed-
     * value text is passed explicitly rather than derived from {@code known}'s
     * iteration order (which {@link Set#of} does not guarantee) so the message
     * stays byte-for-byte reproducible.
     *
     * @param field          human-readable field name for the message (e.g. "provider")
     * @param value          the resolved value to check
     * @param known          the valid values for this field
     * @param allowedDisplay the exact "(allowed: ...)" listing for the message
     * @throws IllegalArgumentException when {@code value} is not in {@code known}
     */
    private static void validateKnown(String field, String value, Set<String> known,
            String allowedDisplay) {
        if (!known.contains(value)) {
            throw new IllegalArgumentException(
                    "Unknown " + field + ": \"" + value + "\" (allowed: " + allowedDisplay + ")");
        }
    }

    /**
     * Converts the Claude-Desktop-shaped {@code mcpServers} object (keyed by
     * server name) into a name-carrying list, preserving declaration order.
     *
     * @param byName the parsed config object — keys are the server names
     * @return the same servers as an immutable list, each entry carrying its name
     */
    private static List<McpServerConfig> toServerList(Map<String, McpServerConfig> byName) {
        List<McpServerConfig> servers = new ArrayList<>();
        byName.forEach((name, entry) -> {
            McpServerConfig e = entry == null
                    ? new McpServerConfig(null, null, null, null, null, null) : entry;
            servers.add(new McpServerConfig(name, e.command(), e.args(), e.env(), e.url(), e.type()));
        });
        return List.copyOf(servers);
    }

    /** Accepts 1/0/true/false (case-insensitive); anything else is falsey.
     *  @param value the raw environment-variable string
     *  @return true only for "1" or "true" */
    private static boolean parseBool(String value) {
        String v = value.trim().toLowerCase(java.util.Locale.ROOT);
        return v.equals("1") || v.equals("true");
    }

    /** Malformed config fails loudly — but readably, not as a raw NumberFormatException.
     *  @param value the raw SPECTRO_MAX_RETRIES string
     *  @return the parsed retry count (0 disables retries) */
    private static int parseMaxRetries(String value) {
        try {
            return Integer.parseInt(value.trim());
        } catch (NumberFormatException bad) {
            throw new IllegalArgumentException(
                    "SPECTRO_MAX_RETRIES must be an integer, got: \"" + value + "\"");
        }
    }

    /**
     * Picks the {@link LlmProvider} implementation for this config and wraps it
     * in the transient-retry decorator — the single chokepoint every face goes
     * through (CLI, server, headless, and the mid-session provider switch). The
     * model lives in the provider constructor — the agent has no model option.
     *
     * @return the retry-wrapped provider, ready to hand to the agent
     */
    public LlmProvider providerFromConfig() {
        LlmProvider real = switch (provider) {
            case "ollama" -> new OllamaProvider(new OllamaOptions(baseUrl, model));
            case "openai", "lmstudio", "openrouter" -> new OpenAiCompatProvider(
                    new OpenAiCompatProvider.Options(openAiBaseUrl(), model, openAiCompatKey()));
            case "anthropic" -> new AnthropicProvider(model, promptCaching);
            default -> throw new IllegalArgumentException("Unknown provider: " + provider);
        };
        // The autologging proxy sits around the CONCRETE provider,
        // INSIDE the retry decorator — so at DEBUG every retry attempt shows as
        // its own entry/exit pair. Silent below DEBUG.
        LlmProvider logged = dev.spectroscope.core.log.Logged.wrap(LlmProvider.class, real);
        return RetryingProvider.wrap(logged, RetryPolicy.from(maxRetries));
    }

    /**
     * The EFFECTIVE endpoint for an OpenAI-compatible provider, static and pure
     * for tests: an explicit baseUrl always wins; otherwise the provider's own
     * preset. No key-based swapping — the provider names the endpoint, the key
     * only authenticates. The provider, {@link #providerHost()} and the server's
     * live model list all derive from this one rule.
     *
     * @param provider "openai" | "lmstudio" | "openrouter"
     * @param baseUrl  the configured base url
     * @return the endpoint the openai-compatible provider talks to
     */
    public static String effectiveOpenAiBaseUrl(String provider, String baseUrl) {
        if (!"http://localhost:11434".equals(baseUrl)) {
            return baseUrl; // an explicit endpoint always wins
        }
        return openAiCompatPreset(provider);
    }

    /** The preset endpoint root for each OpenAI-compatible provider (before an
     *  explicit override): openai = the cloud, lmstudio = a local LM Studio
     *  server, openrouter = the OpenRouter gateway.
     *  @param provider the provider name
     *  @return the preset base URL */
    static String openAiCompatPreset(String provider) {
        return switch (provider) {
            case "lmstudio" -> "http://localhost:1234";
            case "openrouter" -> "https://openrouter.ai/api";
            default -> "https://api.openai.com";
        };
    }

    /** True for the OpenAI-compatible providers (one wire protocol, three hosts).
     *  @param provider the provider name
     *  @return whether it speaks the OpenAI chat/completions API */
    static boolean isOpenAiCompat(String provider) {
        return "openai".equals(provider)
                || "lmstudio".equals(provider)
                || "openrouter".equals(provider);
    }

    /** This provider's API key from the environment — {@code OPENROUTER_API_KEY}
     *  for openrouter, {@code OPENAI_API_KEY} otherwise (LM Studio ignores it).
     *  @return the key, or null when unset */
    private String openAiCompatKey() {
        return "openrouter".equals(provider)
                ? System.getenv("OPENROUTER_API_KEY")
                : System.getenv("OPENAI_API_KEY");
    }

    /** The effective openai-compatible endpoint for THIS config.
     *  @return the effective base URL */
    private String openAiBaseUrl() {
        return effectiveOpenAiBaseUrl(provider, baseUrl);
    }

    /**
     * The network host the active provider actually talks to — presentation
     * truth for the UI (header chip, trace host column, provider_info frame):
     * the Anthropic SDK's fixed endpoint, or the host[:port] of the EFFECTIVE
     * base URL for the local backends (including the openai LM-Studio default
     * swap). An unparseable base URL degrades to the raw value.
     *
     * @return e.g. "api.anthropic.com", "localhost:11434", "localhost:1234"
     */
    public String providerHost() {
        if ("anthropic".equals(provider)) {
            return "api.anthropic.com";
        }
        String effective = isOpenAiCompat(provider) ? openAiBaseUrl() : baseUrl;
        try {
            java.net.URI url = java.net.URI.create(effective);
            String host = url.getHost();
            if (host == null) {
                return effective;
            }
            return url.getPort() == -1 ? host : host + ":" + url.getPort();
        } catch (RuntimeException invalid) {
            return effective;
        }
    }

    /**
     * Builds the {@link dev.spectroscope.core.image.ImageProvider} for this config.
     * Throws {@link IllegalStateException} when the provider's API key is missing —
     * callers behind the generate_image tool turn that into an {@code ERROR:} string.
     * {@code imageModel} (settings hierarchy, env {@code SPECTRO_IMAGE_MODEL}) overrides
     * the provider's default model.
     *
     * @return the image backend named by {@code imageProvider} ("gemini" or "openai")
     */
    public dev.spectroscope.core.image.ImageProvider imageProviderFromConfig() {
        return dev.spectroscope.core.image.ImageProviders.create(imageProvider, imageModel, System.getenv());
    }

    /** The env map for Chrome discovery: the process env, with the configured
     *  chromeBinary overlaid as SPECTRO_CHROME so BrowsePageTool needs no new seam. */
    public Map<String, String> chromeEnv() {
        if (chromeBinary == null || chromeBinary.isBlank()) {
            return System.getenv();
        }
        Map<String, String> overlay = new HashMap<>(System.getenv());
        overlay.put("SPECTRO_CHROME", chromeBinary);
        return overlay;
    }

    /**
     * SPECTRO.md from the working directory — its content is appended to the
     * system prompt. The legacy name FORGE.md is still read when SPECTRO.md is
     * absent, so pre-rename workspaces keep working (de-brand leftover, closed
     * in migration phase 6 docs work). Returns an empty string when neither
     * file exists. Provider-neutral: it reaches every provider via
     * {@code ProviderRequest.system}.
     *
     * @param cwd the working directory searched for SPECTRO.md (then FORGE.md)
     * @return the ready-to-append prompt section, or "" when no file is present
     */
    public static String loadProjectMd(Path cwd) {
        for (String name : new String[] {"SPECTRO.md", "FORGE.md"}) {
            Path file = cwd.resolve(name);
            try {
                String content = Files.readString(file, StandardCharsets.UTF_8).strip();
                return "\n\n## Project context (" + name + ")\n\n" + content;
            } catch (IOException absent) {
                // fall through to the legacy name
            }
        }
        return "";
    }

    /** Reads one layer into a partial holder, or an all-null holder if absent.
     *  Only genuine file-absence (the file itself missing, or a parent
     *  directory that does not exist — both surface as {@link
     *  java.nio.file.NoSuchFileException}) is "absent"; a file that EXISTS but
     *  fails to parse is a broken config and fails loudly, naming the file and
     *  the parse problem, matching this class's own javadoc ("malformed JSON
     *  fails loudly on purpose — a broken config is a programming error, not
     *  something to silently ignore") — the pre-fix code caught IOException
     *  wholesale here, so a typo'd settings file silently loaded as an EMPTY
     *  layer instead.
     *  @param path the layer's JSON file (user config or project settings)
     *  @return the parsed partial; all fields null when the file does not exist
     *  @throws IllegalArgumentException when the file exists but is not valid
     *          JSON for this shape */
    private static PartialConfig readFile(Path path) {
        String raw;
        try {
            raw = Files.readString(path, StandardCharsets.UTF_8);
        } catch (java.nio.file.NoSuchFileException absent) {
            return new PartialConfig(); // layer absent — all fields null
        } catch (IOException unreadable) {
            // Anything else reading the file (permissions, a directory sitting
            // where a file is expected, …) is not a JSON parse problem — treated
            // the same as absent, exactly like before this fix.
            return new PartialConfig();
        }
        try {
            // Parsing a String (not a stream) can only ever fail with a JSON
            // parse problem — readValue(String, Class) never touches real I/O,
            // so JsonProcessingException is the only checked exception in play.
            return JSON.readValue(raw, PartialConfig.class);
        } catch (com.fasterxml.jackson.core.JsonProcessingException malformed) {
            throw new IllegalArgumentException(
                    "malformed settings file " + path + ": " + malformed.getOriginalMessage(), malformed);
        }
    }

    /**
     * Jackson holder with nullable fields: distinguishes "absent in the file" (null)
     * from "explicitly set". Not every layer comes from a JSON file — {@code fromEnv}
     * and {@code fromOverrides} synthesize the same sparse shape from the environment
     * and the CLI flags, so every layer (file or not) folds through the identical
     * {@code overriddenBy} chain. Layers compose with overriddenBy(); merged() fills
     * the remaining gaps from DEFAULTS.
     *
     * <p>ignoreUnknown: the same config.json also carries the CLI-side {@code tts}
     * block (read by {@code dev.spectroscope.cli.speech.TtsConfig}). The core ignores
     * it here so one file serves both — and so a new field added by either edition
     * never breaks config loading (the project's additive-compatibility rule).</p>
     *
     * <p>NON_NULL: {@link #loadResolved}'s layers view serializes a scope's
     * partial straight out (see {@link Resolved#layers()}) — sparse output
     * (only the fields that scope actually set) is what makes an all-null
     * partial serialize as {@code {}}, so an empty scope reads as absent
     * rather than as a wall of {@code null}s. Deserialization (reading a
     * settings file) is unaffected — this only shapes output.</p>
     *
     * <p>Package-private (not private): {@link SettingsWriter#patch} binds a
     * patched settings tree against this same shape before ever writing it —
     * the one place a settings file's value validation is answered, so a
     * write can never brick what {@link #load} later reads.</p>
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    @JsonInclude(JsonInclude.Include.NON_NULL)
    static final class PartialConfig {
        public String provider;
        public String model;
        public String baseUrl;
        public Integer compactionThreshold;
        public String permissionMode;
        public List<String> autoApprove;
        public String imageProvider;
        public Boolean thinking;
        public Integer maxRetries;
        public Boolean promptCaching;
        public String workspace;
        public String logLevel;
        public String imageModel;
        public String sttModel;
        public String chromeBinary;
        // Jackson deserializes the Claude-Desktop-shaped object here; the key is the
        // server name (folded in by toServerList). LinkedHashMap preserves order.
        // A layer that defines mcpServers replaces the whole block below it — the
        // block is treated as one unit in overriddenBy (no deep per-server merge).
        public LinkedHashMap<String, McpServerConfig> mcpServers;
        // Hooks are a plain array (event/matcher/command). A layer that defines
        // hooks replaces the whole block below it — whole-block merge, like mcpServers.
        public List<HookConfig> hooks;

        /** This layer overridden by a higher-priority one (project over user).
         *  @param higher the layer that wins wherever it defines a field
         *  @return a new partial — higher's fields where set, this layer's otherwise */
        PartialConfig overriddenBy(PartialConfig higher) {
            PartialConfig out = new PartialConfig();
            out.provider = Optional.ofNullable(higher.provider).orElse(provider);
            out.model = Optional.ofNullable(higher.model).orElse(model);
            out.baseUrl = Optional.ofNullable(higher.baseUrl).orElse(baseUrl);
            out.compactionThreshold =
                    Optional.ofNullable(higher.compactionThreshold).orElse(compactionThreshold);
            out.permissionMode = Optional.ofNullable(higher.permissionMode).orElse(permissionMode);
            out.autoApprove = Optional.ofNullable(higher.autoApprove).orElse(autoApprove);
            out.imageProvider = Optional.ofNullable(higher.imageProvider).orElse(imageProvider);
            out.thinking = Optional.ofNullable(higher.thinking).orElse(thinking);
            out.maxRetries = Optional.ofNullable(higher.maxRetries).orElse(maxRetries);
            out.promptCaching = Optional.ofNullable(higher.promptCaching).orElse(promptCaching);
            out.workspace = Optional.ofNullable(higher.workspace).orElse(workspace);
            out.logLevel = Optional.ofNullable(higher.logLevel).orElse(logLevel);
            out.imageModel = Optional.ofNullable(higher.imageModel).orElse(imageModel);
            out.sttModel = Optional.ofNullable(higher.sttModel).orElse(sttModel);
            out.chromeBinary = Optional.ofNullable(higher.chromeBinary).orElse(chromeBinary);
            // Whole-block replacement: the higher layer's mcpServers, if it defines one
            // at all, replaces this layer's block wholesale.
            out.mcpServers = Optional.ofNullable(higher.mcpServers).orElse(mcpServers);
            out.hooks = Optional.ofNullable(higher.hooks).orElse(hooks);
            return out;
        }

        /** Fills every remaining gap from DEFAULTS — the end of the layer chain.
         *  @return the complete, non-partial configuration */
        SpectroConfig merged() {
            return new SpectroConfig(
                    Optional.ofNullable(provider).orElse(DEFAULTS.provider()),
                    Optional.ofNullable(model).orElse(DEFAULTS.model()),
                    Optional.ofNullable(baseUrl).orElse(DEFAULTS.baseUrl()),
                    Optional.ofNullable(compactionThreshold).orElse(DEFAULTS.compactionThreshold()),
                    Optional.ofNullable(permissionMode).orElse(DEFAULTS.permissionMode()),
                    Optional.ofNullable(autoApprove).orElse(DEFAULTS.autoApprove()),
                    Optional.ofNullable(imageProvider).orElse(DEFAULTS.imageProvider()),
                    Optional.ofNullable(thinking).orElse(DEFAULTS.thinking()),
                    mcpServers == null ? DEFAULTS.mcpServers() : toServerList(mcpServers),
                    Optional.ofNullable(maxRetries).orElse(DEFAULTS.maxRetries()),
                    Optional.ofNullable(promptCaching).orElse(DEFAULTS.promptCaching()),
                    Optional.ofNullable(hooks).orElse(DEFAULTS.hooks()),
                    Optional.ofNullable(workspace).orElse(DEFAULTS.workspace()),
                    Optional.ofNullable(logLevel).orElse(DEFAULTS.logLevel()),
                    Optional.ofNullable(imageModel).orElse(DEFAULTS.imageModel()),
                    Optional.ofNullable(sttModel).orElse(DEFAULTS.sttModel()),
                    Optional.ofNullable(chromeBinary).orElse(DEFAULTS.chromeBinary()));
        }

        /**
         * The environment as a config layer: only the SPECTRO_* variables it actually
         * sets. Parsing mirrors the per-field code this factory replaces exactly —
         * {@code thinking}/{@code promptCaching} accept only "1"/"true" as true (see
         * {@link SpectroConfig#parseBool}), and a malformed {@code SPECTRO_MAX_RETRIES}
         * fails loudly instead of being swallowed (see
         * {@link SpectroConfig#parseMaxRetries}) — both pinned by the test suite.
         *
         * @param env the environment map (injectable for tests; production callers
         *            pass {@code System.getenv()})
         * @return a layer with just the SPECTRO_* fields the environment defines;
         *         every other field stays null
         */
        static PartialConfig fromEnv(Map<String, String> env) {
            PartialConfig out = new PartialConfig();
            out.provider = env.get("SPECTRO_PROVIDER");
            out.model = env.get("SPECTRO_MODEL");
            out.baseUrl = env.get("SPECTRO_BASE_URL");
            // SPECTRO_WORKSPACE names the agent's working directory; unset keeps the
            // per-session temp folder (resolved later, when the session id exists).
            out.workspace = env.get("SPECTRO_WORKSPACE");
            out.imageProvider = env.get("SPECTRO_IMAGE_PROVIDER");
            // SPECTRO_THINKING (1/0/true/false) sits next to SPECTRO_PROVIDER in the env layer.
            String thinking = env.get("SPECTRO_THINKING");
            if (thinking != null) {
                out.thinking = parseBool(thinking);
            }
            String maxRetries = env.get("SPECTRO_MAX_RETRIES");
            if (maxRetries != null) {
                out.maxRetries = parseMaxRetries(maxRetries);
            }
            String promptCaching = env.get("SPECTRO_PROMPT_CACHING");
            if (promptCaching != null) {
                out.promptCaching = parseBool(promptCaching);
            }
            // SPECTRO_LOG_LEVEL steers the file-appender detail — the
            // same defaults < config file < env precedence as everything else.
            String logLevel = env.get("SPECTRO_LOG_LEVEL");
            if (logLevel != null) {
                out.logLevel = logLevel.trim().toLowerCase(java.util.Locale.ROOT);
            }
            // The three settings-productization fields: this is only their ENV
            // layer — every face now reads the resolved config field instead of
            // getenv (GenerateImageTool/imageModel, DoctorCommand.sttModelPath/
            // Transcriber/TranscribeController via sttModel, BrowsePageTool via
            // chromeEnv()'s SPECTRO_CHROME overlay), so a settings file can set
            // any of the three exactly like every other field.
            out.imageModel = env.get("SPECTRO_IMAGE_MODEL");
            out.sttModel = env.get("SPECTRO_STT_MODEL");
            out.chromeBinary = env.get("SPECTRO_CHROME");
            return out;
        }

        /**
         * CLI flags as the top config layer — sparse, only what the flags can
         * express. {@code compactionThreshold} and {@code permissionMode} have no
         * environment counterpart, so this is their only non-file source;
         * {@code imageProvider}/{@code thinking}/{@code maxRetries}/
         * {@code promptCaching}/{@code logLevel} have no flag at all and so never
         * appear here.
         *
         * @param overrides the CLI layer; null fields defer to the layers below
         * @return a layer with just the flag-settable fields; every other field
         *         stays null
         */
        static PartialConfig fromOverrides(Overrides overrides) {
            PartialConfig out = new PartialConfig();
            out.provider = overrides.provider();
            out.model = overrides.model();
            out.baseUrl = overrides.baseUrl();
            out.compactionThreshold = overrides.compactionThreshold();
            out.permissionMode = overrides.permissionMode();
            out.workspace = overrides.workspace();
            return out;
        }
    }
}
