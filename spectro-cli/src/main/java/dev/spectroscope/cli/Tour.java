package dev.spectroscope.cli;

import java.io.BufferedReader;
import java.io.Console;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Stream;

/**
 * The guided feature tour: a menu-driven CLI around the spectroscope faces. It
 * explains what the harness can do, launches everything as guided child
 * processes, and holds your settings for the session — the Anthropic API key
 * entered HIDDEN (memory only, injected into child environments), or a local
 * provider (Ollama / OpenAI-compatible) selected instead.
 *
 * <p>Menu entries appear once the class or module behind them exists
 * (sessions, headless + cron, the web face, doctor + openai).</p>
 *
 * <p>Run with: {@code ./gradlew tour}</p>
 */
public final class Tour {

    // The provider ids the settings menu switches between.
    private static final String PROVIDER_ANTHROPIC = "anthropic";
    private static final String PROVIDER_OLLAMA = "ollama";
    private static final String PROVIDER_OPENAI = "openai";

    // Defaults offered in the settings menu — pressing Enter keeps them.
    private static final String DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
    private static final String DEFAULT_OLLAMA_MODEL = "qwen3";
    private static final String DEFAULT_OPENAI_BASE_URL = "http://localhost:1234";
    private static final String DEFAULT_OPENAI_MODEL = "local-model";

    // Environment variable names — the contract with SpectroConfig's env layer.
    private static final String ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";
    private static final String SPECTRO_PROVIDER_ENV = "SPECTRO_PROVIDER";
    private static final String SPECTRO_MODEL_ENV = "SPECTRO_MODEL";
    private static final String SPECTRO_BASE_URL_ENV = "SPECTRO_BASE_URL";

    /** POSIX mode for ./.env — the key file is readable by its owner only. */
    private static final String ENV_FILE_OWNER_ONLY_MODE = "rw-------";
    /** Where the web face serves once the boot jar runs. */
    private static final String WEB_UI_URL = "http://127.0.0.1:8080";

    private final Ansi ansi = Ansi.detect();
    private final BufferedReader console =
            new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));

    // ---- session settings ---------------------------------------------------
    private String apiKey;                  // entered hidden; null = .env / shell env
    private String provider = PROVIDER_ANTHROPIC;  // anthropic | ollama | openai
    private String model;                   // null = the CLI's default for the provider
    private String baseUrl;                 // ollama/openai only

    /** KEY=VALUE pairs from ./.env (gitignored) — injected into every child. */
    private Map<String, String> dotEnv = loadDotEnv();

    private static final Path ENV_FILE = Path.of(".env");

    /**
     * Parses ./.env into KEY=VALUE pairs — comments and blank lines skipped,
     * surrounding double quotes stripped, empty values dropped. An unreadable
     * file behaves as absent: a broken .env must never kill the tour.
     *
     * @return the parsed pairs in file order, empty when no .env exists
     */
    private static Map<String, String> loadDotEnv() {
        Map<String, String> values = new LinkedHashMap<>();
        if (!Files.isRegularFile(ENV_FILE)) {
            return values;
        }
        try {
            for (String raw : Files.readAllLines(ENV_FILE, StandardCharsets.UTF_8)) {
                String line = raw.strip();
                int eq = line.indexOf('=');
                if (line.isEmpty() || line.startsWith("#") || eq <= 0) {
                    continue;
                }
                String value = line.substring(eq + 1).strip();
                if (value.length() >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
                    value = value.substring(1, value.length() - 1);
                }
                if (!value.isEmpty()) {
                    values.put(line.substring(0, eq).strip(), value);
                }
            }
        } catch (IOException unreadable) {
            // A broken .env must not kill the tour — behave as if absent.
        }
        return values;
    }

    /**
     * Writes/updates one KEY in ./.env, keeping other lines; file mode 600.
     *
     * @param key   the variable to set — an existing line is replaced in place
     * @param value the new value, written verbatim (no quoting)
     */
    private void saveToDotEnv(String key, String value) throws IOException {
        List<String> lines = Files.isRegularFile(ENV_FILE)
                ? new ArrayList<>(Files.readAllLines(ENV_FILE, StandardCharsets.UTF_8))
                : new ArrayList<>();
        boolean replaced = false;
        for (int i = 0; i < lines.size(); i++) {
            if (lines.get(i).strip().startsWith(key + "=")) {
                lines.set(i, key + "=" + value);
                replaced = true;
            }
        }
        if (!replaced) {
            lines.add(key + "=" + value);
        }
        Files.write(ENV_FILE, lines, StandardCharsets.UTF_8);
        try {
            Files.setPosixFilePermissions(ENV_FILE, PosixFilePermissions.fromString(ENV_FILE_OWNER_ONLY_MODE));
        } catch (UnsupportedOperationException windows) {
            // Non-POSIX filesystem — the file still exists, just without the tight mode.
        }
        dotEnv = loadDotEnv();
    }

    // ---- feature detection: entries appear once their classes exist --
    private final boolean hasSessions = classExists("dev.spectroscope.core.session.SessionStore");
    private final boolean hasOllama = classExists("dev.spectroscope.core.provider.OllamaProvider");
    private final boolean hasConfigFlags = classExists("dev.spectroscope.core.config.SpectroConfig");
    private final boolean hasOpenAi = classExists("dev.spectroscope.core.provider.OpenAiCompatProvider");
    private final boolean hasSubagents = classExists("dev.spectroscope.core.subagents.SubagentManager");
    private final boolean hasHeadless = classExists("dev.spectroscope.core.scheduler.HeadlessRunner");
    private final boolean hasDoctor = classExists("dev.spectroscope.cli.DoctorCommand");
    private final boolean hasImageGen = classExists("dev.spectroscope.core.image.ImageProvider");
    private final boolean hasSkills = classExists("dev.spectroscope.core.skills.SkillLibrary");
    private final boolean hasMcp = classExists("dev.spectroscope.core.mcp.McpServerRegistry");
    // Capability markers: the blob store record, the voice channel, the voice-output consumer.
    private final boolean hasVision = classExists("dev.spectroscope.core.session.SessionStore$StoredBlob");
    private final boolean hasVoiceInput = classExists("dev.spectroscope.cli.voice.Transcriber");
    private final boolean hasVoiceOutput = classExists("dev.spectroscope.cli.speech.SpeechRenderer");
    private final boolean hasServerModule = Files.isDirectory(Path.of("spectro-server"));

    /**
     * Entry point for {@code ./gradlew tour}.
     *
     * @param args unused — the tour is fully interactive
     */
    public static void main(String[] args) throws IOException {
        new Tour().run();
    }

    /**
     * The tour's main loop: seed provider state from the environment, print the
     * banner, then dispatch menu choices until {@code q} or end of input. Entries
     * whose capability is absent in this stage are silently ignored.
     */
    private void run() throws IOException {
        seedFromEnvironment();
        banner();
        while (true) {
            printMenu();
            String choice = console.readLine();
            if (choice == null || choice.strip().equalsIgnoreCase("q")) {
                break;
            }
            switch (choice.strip().toLowerCase()) {
                case "1" -> launchCli(List.of());
                case "2" -> { if (hasSessions) launchCli(List.of("sessions")); }
                case "3" -> { if (hasSessions) resume(); }
                case "4" -> { if (hasHeadless) headlessRun(); }
                case "5" -> { if (hasHeadless) cronMenu(); }
                case "6" -> { if (hasServerModule) webFace(); }
                case "7" -> { if (hasDoctor) launchCli(List.of("doctor")); }
                case "s" -> settingsMenu();
                case "t" -> tips();
                default -> System.out.println(ansi.dim("Unknown choice — pick one of the keys above."));
            }
        }
        System.out.println("Bye.");
    }


    /**
     * SPECTRO_PROVIDER / SPECTRO_MODEL / SPECTRO_BASE_URL from ./.env or the shell
     * pre-select the provider, so the tour status matches what the
     * launched children will actually use. Flags picked in the settings menu
     * still win — they are passed explicitly.
     */
    private void seedFromEnvironment() {
        if (!hasOllama) {
            return; // the provider switch arrives
        }
        String fromEnv = firstNonBlank(dotEnv.get(SPECTRO_PROVIDER_ENV), System.getenv(SPECTRO_PROVIDER_ENV));
        if (fromEnv != null && (fromEnv.equals(PROVIDER_OLLAMA) || fromEnv.equals(PROVIDER_ANTHROPIC)
                || (fromEnv.equals(PROVIDER_OPENAI) && hasOpenAi))) {
            provider = fromEnv;
        }
        model = firstNonBlank(dotEnv.get(SPECTRO_MODEL_ENV), System.getenv(SPECTRO_MODEL_ENV), model);
        baseUrl = firstNonBlank(dotEnv.get(SPECTRO_BASE_URL_ENV), System.getenv(SPECTRO_BASE_URL_ENV), baseUrl);
    }

    /**
     * The precedence helper behind the env seeding: first candidate wins.
     *
     * @param values candidates in descending precedence, e.g. .env before shell env
     * @return the first non-null, non-blank value — or null when none qualifies
     */
    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value;
            }
        }
        return null;
    }

    // ------------------------------------------------------------------ menu

    /** The one-time greeting: title, detected stage, and the settings hint. */
    private void banner() {
        System.out.println(ansi.coral("◆ ") + ansi.bold("spectroscope tour") + ansi.dim("  " + stageLabel()));
        System.out.println(ansi.dim("  Guided access to everything this stage can do."
                + " Settings [s] first if no key is exported."));
    }

    /**
     * Names the stage by its NEWEST detected capability — the same file ships in
     * every stage solution and labels itself.
     *
     * @return e.g. {@code "spectroscope"} or {@code "sessions + providers"}
     */
    private String stageLabel() {
        // The newest CAPABILITY names the label; the complete harness
        // carries everything, so the doctor check comes first.
        if (hasDoctor) return "spectroscope";
        if (hasSkills) return "skills";
        if (hasImageGen) return "image generation";
        if (hasHeadless) return "cron + headless";
        if (hasSubagents) return "subagents";
        if (hasSessions) return "sessions + providers";
        return "core + events";
    }

    /** The main menu — only entries whose capability exists in this stage appear. */
    private void printMenu() {
        System.out.println();
        entry("1", "agent REPL", replDescription());
        if (hasSessions) {
            entry("2", "sessions", "list the stored JSONL sessions (~/.spectro/sessions)");
            entry("3", "resume", "continue an old session by id — the model remembers");
        }
        if (hasHeadless) {
            entry("4", "headless run", "one prompt, no REPL — optionally as NDJSON (--json)");
            entry("5", "cron", "list / status / run one job now (~/.spectro/jobs.json)");
        }
        if (hasServerModule) {
            entry("6", "web face", "start the Spring Boot server + browser UI on :8080");
        }
        if (hasDoctor) {
            entry("7", "doctor", "check Java, config layers, provider reachability");
        }
        entry("s", "settings", settingsStatus());
        entry("t", "tips", "what to try in this stage");
        entry("q", "quit", "");
        System.out.print(ansi.coral("❯ "));
        System.out.flush();
    }

    /**
     * One menu line: coral key, bold title, dimmed description.
     *
     * @param key         the single character the user types to pick this entry
     * @param title       the entry's short name
     * @param description the dimmed explanation — empty prints nothing after the title
     */
    private void entry(String key, String title, String description) {
        System.out.println("  " + ansi.coral("[" + key + "]") + " " + ansi.bold(title)
                + (description.isEmpty() ? "" : "  " + ansi.dim(description)));
    }

    /**
     * The REPL entry's description, adjusted to what the build can show.
     *
     * @return the subagent-aware line once subagents are present, the plain one before
     */
    private String replDescription() {
        if (hasSubagents) {
            return "chat with tools AND spawn_agents — watch [explore-1] lines interleave";
        }
        return "chat with tools — every event rendered live, Ctrl+C aborts a run";
    }

    /**
     * The settings entry's live status line: provider, model, and where the key
     * comes from (hidden input, .env, shell env) — or "no key needed" for local providers.
     *
     * @return the summary shown next to the [s] menu entry
     */
    private String settingsStatus() {
        String envKey = System.getenv(ANTHROPIC_API_KEY_ENV);
        String key = apiKey != null ? "key set (hidden)"
                : dotEnv.containsKey(ANTHROPIC_API_KEY_ENV) ? "key from .env"
                : envKey != null && !envKey.isBlank() ? "key from env" : "key NOT set";
        if (hasOllama && !PROVIDER_ANTHROPIC.equals(provider)) {
            key = "no key needed"; // local providers ignore the Anthropic key entirely
        }
        String modelLabel = model != null ? model : "default";
        return provider + " · " + modelLabel + " · " + key;
    }

    // -------------------------------------------------------------- settings

    /**
     * The settings submenu: pick a provider (key entered hidden for anthropic,
     * base URL + model prompted for the local ones), set/replace the key alone,
     * or persist it to ./.env. Everything else stays in memory for this tour session.
     */
    private void settingsMenu() throws IOException {
        System.out.println(ansi.sand("Settings") + ansi.dim("  (memory only — nothing is written to disk)"));
        entry("1", PROVIDER_ANTHROPIC, "cloud provider; enter " + ANTHROPIC_API_KEY_ENV + " hidden");
        if (hasOllama) {
            entry("2", PROVIDER_OLLAMA, "local models, no key (default " + DEFAULT_OLLAMA_BASE_URL + ", " + DEFAULT_OLLAMA_MODEL + ")");
        } else {
            System.out.println(ansi.dim("  [i] provider switching (Ollama) needs the config module"));
        }
        if (hasOpenAi) {
            entry("3", "openai-compatible", "LM Studio & friends (default " + DEFAULT_OPENAI_BASE_URL + ")");
        }
        entry("k", "enter key only", "set/replace " + ANTHROPIC_API_KEY_ENV + " without switching provider");
        entry("w", "save key to .env", "gitignored, mode 600 — every ./gradlew run picks it up");
        entry("b", "back", "");
        System.out.print(ansi.coral("❯ "));
        System.out.flush();
        String choice = console.readLine();
        if (choice == null) {
            return;
        }
        switch (choice.strip().toLowerCase()) {
            case "1" -> {
                provider = PROVIDER_ANTHROPIC;
                model = null;
                baseUrl = null;
                apiKey = readSecret(ANTHROPIC_API_KEY_ENV + " (empty keeps the current one): ");
                System.out.println(ansi.dim("Provider: " + PROVIDER_ANTHROPIC + " · " + settingsStatus()));
            }
            case "2" -> {
                if (hasOllama) {
                    provider = PROVIDER_OLLAMA;
                    baseUrl = readDefaulted("Base URL", DEFAULT_OLLAMA_BASE_URL);
                    model = readDefaulted("Model", DEFAULT_OLLAMA_MODEL);
                    System.out.println(ansi.dim("Provider: " + PROVIDER_OLLAMA + " · " + model + " · " + baseUrl));
                }
            }
            case "3" -> {
                if (hasOpenAi) {
                    provider = PROVIDER_OPENAI;
                    baseUrl = readDefaulted("Base URL", DEFAULT_OPENAI_BASE_URL);
                    model = readDefaulted("Model", DEFAULT_OPENAI_MODEL);
                    System.out.println(ansi.dim("Provider: " + PROVIDER_OPENAI + " · " + model + " · " + baseUrl));
                }
            }
            case "k" -> apiKey = Optional.ofNullable(readSecret(ANTHROPIC_API_KEY_ENV + ": ")).orElse(apiKey);
            case "w" -> {
                String toSave = apiKey != null ? apiKey : readSecret(ANTHROPIC_API_KEY_ENV + ": ");
                if (toSave != null) {
                    apiKey = toSave;
                    saveToDotEnv(ANTHROPIC_API_KEY_ENV, toSave);
                    System.out.println(ansi.dim("Saved to ./.env — future ./gradlew runs need no export."));
                }
            }
            default -> { }
        }
    }

    /**
     * Hidden input where a real terminal exists; visible fallback under Gradle.
     *
     * @param prompt the label printed before the input
     * @return the entered secret, or null on empty input/EOF — callers keep their
     *         previous value then
     */
    private String readSecret(String prompt) throws IOException {
        Console terminal = System.console();
        if (terminal != null) {
            char[] secret = terminal.readPassword(prompt);
            return secret == null || secret.length == 0 ? null : new String(secret);
        }
        System.out.println(ansi.dim("(no TTY — input is visible here, but kept in memory only)"));
        System.out.print(prompt);
        System.out.flush();
        String line = console.readLine();
        return line == null || line.isBlank() ? null : line.strip();
    }

    /**
     * A prompt with a visible default — plain Enter keeps it.
     *
     * @param label    what is being asked for, e.g. {@code "Base URL"}
     * @param fallback the default shown in brackets and returned on empty input
     * @return the typed value, or {@code fallback} when the user just pressed Enter
     */
    private String readDefaulted(String label, String fallback) throws IOException {
        System.out.print(ansi.sand(label + " [" + fallback + "]: "));
        System.out.flush();
        String line = console.readLine();
        return line == null || line.isBlank() ? fallback : line.strip();
    }

    // -------------------------------------------------------------- actions

    /** Menu [3]: asks for a session id and relaunches the REPL with {@code --resume}. */
    private void resume() throws IOException {
        System.out.print(ansi.sand("Session id (see [2]): "));
        System.out.flush();
        String id = console.readLine();
        if (id != null && !id.isBlank()) {
            launchCli(List.of("--resume", id.strip()));
        }
    }

    /** Menu [4]: prompts for a task and runs {@code spectroscope run -p ...}, optionally with --json. */
    private void headlessRun() throws IOException {
        System.out.print(ansi.sand("Prompt: "));
        System.out.flush();
        String prompt = console.readLine();
        if (prompt == null || prompt.isBlank()) {
            return;
        }
        System.out.print(ansi.sand("Emit NDJSON (--json)? [y/N] "));
        System.out.flush();
        String json = console.readLine();
        List<String> args = new ArrayList<>(List.of("run", "-p", prompt.strip()));
        if (json != null && json.strip().equalsIgnoreCase("y")) {
            args.add("--json");
        }
        launchCli(args);
    }

    /** Menu [5]: the cron submenu — list, status, or fire one job now by id. */
    private void cronMenu() throws IOException {
        entry("1", "list", "jobs + next execution");
        entry("2", "status", "last result per job");
        entry("3", "run once", "fire one job now by id");
        System.out.print(ansi.coral("❯ "));
        System.out.flush();
        String choice = console.readLine();
        if (choice == null) {
            return;
        }
        switch (choice.strip()) {
            case "1" -> launchCli(List.of("cron", "list"));
            case "2" -> launchCli(List.of("cron", "status"));
            case "3" -> {
                System.out.print(ansi.sand("Job id: "));
                System.out.flush();
                String id = console.readLine();
                if (id != null && !id.isBlank()) {
                    launchCli(List.of("cron", "--once", id.strip()));
                }
            }
            default -> { }
        }
    }

    /** Starts the boot jar if built; otherwise explains the one command to build it. */
    private void webFace() {
        Optional<Path> jar = newestServerJar();
        if (jar.isEmpty()) {
            System.out.println(ansi.dim("The server jar is not built yet. Run once:"));
            System.out.println("  " + ansi.bold("./gradlew :spectro-server:bootJar"));
            System.out.println(ansi.dim("then pick [6] again. (The web UI ships inside the jar.)"));
            return;
        }
        System.out.println(ansi.dim("Starting " + jar.get().getFileName()
                + " — open " + ansi.bold(WEB_UI_URL) + ansi.dim(" · Ctrl+C stops it.")));
        if (!PROVIDER_ANTHROPIC.equals(provider)) {
            System.out.println(ansi.dim("Note: the server reads ~/.spectro/config.json — put"
                    + " {\"provider\":\"" + provider + "\"} there for local models."));
        }
        launch(List.of(javaBinary(), "-jar", jar.get().toString()));
    }

    /**
     * A built boot jar under spectro-server/build/libs, if any.
     *
     * @return the first jar found, or empty when the module was never bootJar-built
     */
    private Optional<Path> newestServerJar() {
        Path libs = Path.of("spectro-server", "build", "libs");
        if (!Files.isDirectory(libs)) {
            return Optional.empty();
        }
        try (Stream<Path> jars = Files.list(libs)) {
            return jars.filter(path -> path.getFileName().toString().endsWith(".jar")).findFirst();
        } catch (IOException unreadable) {
            return Optional.empty();
        }
    }

    // --------------------------------------------------------------- launch

    /** The provider FLAGS exist (SpectroConfig); flag-less children
     *  are steered via the SPECTRO_* environment instead (see launch()).
     *
     * @return {@code --provider/--model/--base-url} for the selected local provider,
     *         or nothing for anthropic and pre-stage-4 children
     */
    private List<String> providerArgs() {
        if (!hasConfigFlags || PROVIDER_ANTHROPIC.equals(provider)) {
            return List.of();
        }
        List<String> args = new ArrayList<>(List.of("--provider", provider));
        if (model != null) {
            args.addAll(List.of("--model", model));
        }
        if (baseUrl != null) {
            args.addAll(List.of("--base-url", baseUrl));
        }
        return args;
    }

    /**
     * Launches the SpectroCli main class on the tour's own classpath and JVM,
     * appending the menu-selected provider flags.
     *
     * @param subcommandArgs what to run — empty for the REPL, or e.g.
     *                       {@code ["run", "-p", ...]}, {@code ["doctor"]}
     */
    private void launchCli(List<String> subcommandArgs) {
        List<String> command = new ArrayList<>(List.of(
                javaBinary(), "-cp", System.getProperty("java.class.path"), "dev.spectroscope.cli.SpectroCli"));
        command.addAll(subcommandArgs);
        command.addAll(providerArgs());
        launch(command);
    }

    /**
     * Child process with inherited terminal; the key travels as an env var only.
     *
     * @param command the full argv to start — the tour blocks until the child exits
     */
    private void launch(List<String> command) {
        System.out.println(ansi.dim("── launching — Ctrl+C (or /exit) returns to the tour ──"));
        ProcessBuilder builder = new ProcessBuilder(command);
        Map<String, String> env = builder.environment();
        env.putAll(dotEnv);              // .env first ...
        if (apiKey != null) {
            env.put(ANTHROPIC_API_KEY_ENV, apiKey); // ... the tour's own key wins
        }
        // The menu-selected provider also travels as SPECTRO_* environment —
        // flag-less children read only these; the flags above take precedence
        // anyway, so setting both is consistent, never conflicting.
        if (hasOllama && !PROVIDER_ANTHROPIC.equals(provider)) {
            env.put(SPECTRO_PROVIDER_ENV, provider);
            if (model != null) {
                env.put(SPECTRO_MODEL_ENV, model);
            }
            if (baseUrl != null) {
                env.put(SPECTRO_BASE_URL_ENV, baseUrl);
            }
        } else if (hasOllama && PROVIDER_ANTHROPIC.equals(provider)) {
            // An explicit anthropic choice must beat a SPECTRO_PROVIDER from .env.
            env.remove(SPECTRO_PROVIDER_ENV);
        }
        builder.inheritIO();
        try {
            int exit = builder.start().waitFor();
            System.out.println(ansi.dim("── ended (exit " + exit + ") — back in the tour ──"));
        } catch (IOException failure) {
            System.out.println(ansi.red("Could not launch: " + failure.getMessage()));
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    /**
     * The java executable of the RUNNING JVM — children get the same Java the
     * tour runs on, never whatever happens to be on the PATH.
     *
     * @return the absolute path to {@code java.home}'s java binary
     */
    private static String javaBinary() {
        return System.getProperty("java.home") + "/bin/java";
    }

    // ----------------------------------------------------------------- tips

    /** Menu [t]: stage-appropriate experiments — each block appears with its capability. */
    private void tips() {
        System.out.println(ansi.sand("Try this"));
        System.out.println(ansi.dim("""
                  · Ask: "What is in the build.gradle.kts and which modules exist?" → ⚒ tool cards.
                  · Answer a run_command question with n → the model reads the denial and adapts.
                  · Press Ctrl+C mid-answer → the run ends with `aborted`, nothing crashes."""));
        if (hasSessions) {
            System.out.println(ansi.dim("""
                      · Tell the REPL your name, /exit, then [3] resume with the session id → it remembers.
                      · tail -f the newest ~/.spectro/sessions/*.jsonl in a second terminal while chatting."""));
        }
        if (hasSubagents) {
            System.out.println(ansi.dim("""
                      · Ask: "Investigate spectro-core/ and spectro-cli/ in parallel with two explore
                        subagents and compare the structure." → interleaved [explore-1]/[explore-2] lines."""));
        }
        if (hasHeadless) {
            System.out.println(ansi.dim("""
                      · [4] with --json, pipe it through jq later — same lines as the session file."""));
        }
        if (hasServerModule) {
            System.out.println(ansi.dim("""
                      · [6], then open two browser tabs → two independent sessions; try the Graph tab."""));
        }
        if (hasImageGen) {
            System.out.println(ansi.dim("""
                      · Ask: "Generate an image of a lighthouse at dusk." → gallery panel on the right
                        (web) or a ▣ line (CLI). Needs GEMINI_API_KEY or OPENAI_API_KEY in ./.env;
                        the dropdown in the web header switches the backend mid-session."""));
        }
        if (hasSkills) {
            System.out.println(ansi.dim("""
                      · Ask: "Use the test-driven-development skill and add a failing test first."
                        → a use_skill tool card, then the model follows the loaded instructions.
                        Skills live under .spectro/skills/ — add your own SKILL.md and rerun."""));
        }
        if (hasVision) {
            System.out.println(ansi.dim("""
                      · [6], drag an image into the chat → preview chip, send "Describe this image"
                        → the answer names what is in it. Headless: [4] exists too, but --image only
                        via ./spectro run -p "Describe this image" --image path/to/image.png
                        Blobs land under ~/.spectro/sessions/<id>/blobs/ — the JSONL stays small.
                        Local: SPECTRO_PROVIDER=ollama needs a vision model (ollama pull qwen3-vl)."""));
        }
        if (hasVoiceInput) {
            System.out.println(ansi.dim("""
                      · One-time: bash scripts/setup-stt.sh (whisper.cpp + ggml-small, checksum-pinned).
                        In the REPL [1]: /voice → speak → Enter → the transcript appears editable,
                        Enter sends it as a normal turn (a blank line discards). Nothing reaches the
                        agent unreviewed. Web [6]: the mic button in the composer does the same.
                        Airplane mode: SPECTRO_PROVIDER=ollama → the whole channel runs offline."""));
        }
        if (hasVoiceOutput) {
            System.out.println(ansi.dim("""
                      · One-time: bash scripts/setup-tts.sh (piper + en_US-lessac-medium, checksum-pinned).
                        REPL [1] with --speak (or /speak on): ask "Explain in two sentences what an agent
                        harness is." → the first sentence is spoken while the second still streams.
                        Ctrl+C stops the run AND the voice at once — no ghost sentences. Headless [4]:
                        ./spectro run -p "..." --speak. Config: "tts": {"enabled": true} in ~/.spectro/settings.json.
                        With voice input the loop closes: speak in, whisper transcribes, piper speaks back."""));
        }
        if (hasDoctor) {
            System.out.println(ansi.dim("""
                      · In the REPL: /help — slash commands; .spectro/settings.json feeds the allowlist."""));
        }
        if (hasMcp) {
            System.out.println(ansi.dim("""
                      · Build the example server once: ./gradlew :spectro-mcp-notes:installDist (or
                        ./spectro mcp-notes), then in the REPL type /mcp to see the "notes" server and its
                        mcp__notes__search_notes / mcp__notes__add_note tools. Ask: "Search my notes for
                        the deploy runbook." → a permission-gated mcp__notes__search_notes tool card. The
                        .spectro/settings.json mcpServers block points at the built dist; MCP is just another
                        tool source — its calls surface as ordinary tool_call/tool_result events."""));
        }
    }

    /**
     * The feature-detection primitive: probes the classpath WITHOUT initializing
     * the class, so merely asking never triggers static setup.
     *
     * @param name the fully qualified class name that marks a stage capability
     * @return true when this stage's build contains the class
     */
    private static boolean classExists(String name) {
        try {
            Class.forName(name, false, Tour.class.getClassLoader());
            return true;
        } catch (ClassNotFoundException absent) {
            return false;
        }
    }
}
