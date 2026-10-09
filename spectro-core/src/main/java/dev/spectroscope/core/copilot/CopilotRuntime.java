package dev.spectroscope.core.copilot;

import dev.spectroscope.core.tools.ToolPath;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Where the GitHub Copilot runtime (the {@code copilot} CLI) comes from on macOS,
 * and what its child process is started with (card 497).
 *
 * <p>The Copilot Java SDK starts this program and talks JSON-RPC to it. It takes
 * the program from {@code cliPath}, then {@code COPILOT_CLI_PATH}, then a
 * platform classifier jar, and it never searches {@code PATH} (card 478,
 * {@code CliServerManager.resolveCliLaunch} in 1.0.20-preview.0). The app ships
 * no classifier jar, so it finds the user's own install and hands the SDK an
 * explicit {@code cliPath} through {@link #launch}.
 *
 * <p>The search order:
 * <ol>
 *   <li>{@code COPILOT_CLI_PATH}, the SDK's own override and the user's explicit
 *       choice. When it is set and unusable the lookup says so and stops; it
 *       never hands out a different runtime instead.</li>
 *   <li>Homebrew: {@code /opt/homebrew/bin}, then {@code /usr/local/bin}.</li>
 *   <li>An npm global install: {@code <prefix>/bin}, with the prefix from
 *       {@code NPM_CONFIG_PREFIX} or the {@code prefix} line of
 *       {@code ~/.npmrc}. npm with Homebrew's node installs into the Homebrew
 *       folder of step 2 and is reported as npm there.</li>
 *   <li>{@code PATH}, as {@link ToolPath} builds it for a tool shell: the
 *       inherited value with the toolchain folders and {@code ~/.local/bin} (the
 *       install script's default) in front. The fixed folders of steps 2 and 3
 *       are what make an app started from Finder or the Dock find the runtime,
 *       since launchd gives it only {@code /usr/bin:/bin:/usr/sbin:/sbin}.</li>
 * </ol>
 *
 * <p>No candidate may resolve to a file inside the workspace folder, so an agent
 * that writes a program into its workspace cannot make the app run it.
 *
 * <p>macOS only. On every other platform the lookup answers
 * {@link Status#UNSUPPORTED} without looking.
 */
public final class CopilotRuntime {

    /** The provider name the Copilot provider is registered under. */
    public static final String PROVIDER = "copilot";

    /** The runtime's file name. */
    public static final String EXECUTABLE = "copilot";

    /** The variable the SDK reads as an explicit runtime path. */
    public static final String CLI_PATH_VARIABLE = "COPILOT_CLI_PATH";

    /**
     * The install line for macOS, from GitHub's Copilot CLI documentation
     * ({@link #INSTALL_SOURCE}, read 2026-10-09).
     */
    public static final String INSTALL_LINE = "brew install --cask copilot-cli";

    /** Where {@link #INSTALL_LINE} was read. */
    public static final String INSTALL_SOURCE =
            "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli";

    /** Homebrew's binary folders: Apple silicon first, then Intel. */
    public static final List<String> HOMEBREW_DIRS = List.of("/opt/homebrew/bin", "/usr/local/bin");

    /**
     * Variables that override the runtime's stored login. They are removed from
     * the child's environment, so credentials reach the runtime only the way the
     * provider passes them.
     */
    public static final List<String> TOKEN_VARIABLES =
            List.of("COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN");

    private static final Pattern VERSION = Pattern.compile("(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.]+)?)");

    private CopilotRuntime() {
    }

    /** What the lookup found. */
    public enum Status {
        /** A runtime was found; {@link Lookup#path()} holds it. */
        FOUND,
        /** No runtime in any place searched. */
        NOT_INSTALLED,
        /** {@code COPILOT_CLI_PATH} names a file that cannot be used. */
        REJECTED,
        /** Not macOS. */
        UNSUPPORTED
    }

    /** Which step of the search order supplied the runtime. */
    public enum Source {
        /** The {@code COPILOT_CLI_PATH} variable. */
        COPILOT_CLI_PATH("COPILOT_CLI_PATH"),
        /** A Homebrew folder holding the Homebrew cask. */
        HOMEBREW("Homebrew"),
        /** An npm global install. */
        NPM_GLOBAL("npm global"),
        /** A folder on the tool PATH. */
        PATH("PATH");

        private final String label;

        Source(String label) {
            this.label = label;
        }

        /**
         * The name a status line uses.
         *
         * @return a short human-readable name
         */
        public String label() {
            return label;
        }
    }

    /**
     * The answer of one lookup.
     *
     * @param status   what was found
     * @param path     the runtime as found (not resolved through links), or null
     *                 unless {@link Status#FOUND}
     * @param source   the step that supplied it, or null unless found
     * @param searched the folders searched, in order, each once
     * @param detail   one sentence for a status line: where it was found, why a
     *                 choice was rejected, or how to install
     */
    public record Lookup(Status status, Path path, Source source, List<String> searched, String detail) {

        /**
         * Copies {@code searched}.
         *
         * @param status   what was found
         * @param path     the runtime, or null
         * @param source   the step that supplied it, or null
         * @param searched the folders searched
         * @param detail   one sentence for a status line
         */
        public Lookup {
            searched = List.copyOf(searched);
        }

        /**
         * Whether a runtime was found.
         *
         * @return true for {@link Status#FOUND}
         */
        public boolean isFound() {
            return status == Status.FOUND;
        }
    }

    /**
     * What the SDK is started with: pass {@code cliPath} to
     * {@code CopilotClientOptions.setCliPath} and {@code environment} to
     * {@code setEnvironment}.
     *
     * @param cliPath     the runtime to start
     * @param environment the child's whole environment
     */
    public record Launch(Path cliPath, Map<String, String> environment) {

        /**
         * Copies the environment.
         *
         * @param cliPath     the runtime to start
         * @param environment the child's whole environment
         */
        public Launch {
            environment = Map.copyOf(environment);
        }
    }

    /**
     * The inputs of a lookup, gathered once so a test can supply its own.
     *
     * @param osName          the {@code os.name} value
     * @param copilotCliPath  the {@code COPILOT_CLI_PATH} value, or null
     * @param npmConfigPrefix the {@code NPM_CONFIG_PREFIX} value, or null
     * @param npmrc           the user's {@code .npmrc}, or null to read none
     * @param inheritedPath   the inherited {@code PATH}, or null
     * @param home            the home folder
     * @param homebrewDirs    the Homebrew folders, in order
     */
    public record Environment(String osName, String copilotCliPath, String npmConfigPrefix, Path npmrc,
                              String inheritedPath, Path home, List<String> homebrewDirs) {

        /**
         * Copies {@code homebrewDirs}.
         *
         * @param osName          the {@code os.name} value
         * @param copilotCliPath  the {@code COPILOT_CLI_PATH} value, or null
         * @param npmConfigPrefix the {@code NPM_CONFIG_PREFIX} value, or null
         * @param npmrc           the user's {@code .npmrc}, or null
         * @param inheritedPath   the inherited {@code PATH}, or null
         * @param home            the home folder
         * @param homebrewDirs    the Homebrew folders
         */
        public Environment {
            homebrewDirs = List.copyOf(homebrewDirs);
        }

        /**
         * The inputs of this process: its {@code os.name}, environment, home
         * and {@code ~/.npmrc}, and {@link #HOMEBREW_DIRS}.
         *
         * @return the live inputs
         */
        public static Environment current() {
            Path home = Path.of(System.getProperty("user.home", ""));
            return new Environment(System.getProperty("os.name", ""),
                    System.getenv(CLI_PATH_VARIABLE),
                    npmPrefixVariable(System.getenv()),
                    home.isAbsolute() ? home.resolve(".npmrc") : null,
                    System.getenv("PATH"),
                    home,
                    HOMEBREW_DIRS);
        }

        /**
         * A builder with empty inputs, for tests and callers that assemble
         * their own.
         *
         * @return a new builder
         */
        public static Builder builder() {
            return new Builder();
        }

        /** Assembles an {@link Environment}. */
        public static final class Builder {
            private String osName = "";
            private String copilotCliPath;
            private String npmConfigPrefix;
            private Path npmrc;
            private String path;
            private Path home = Path.of("");
            private final List<String> homebrewDirs = new ArrayList<>();

            private Builder() {
            }

            /**
             * Sets the {@code os.name} value.
             *
             * @param value the platform name
             * @return this builder
             */
            public Builder os(String value) {
                osName = value;
                return this;
            }

            /**
             * Sets the home folder.
             *
             * @param value the home folder
             * @return this builder
             */
            public Builder home(Path value) {
                home = value;
                return this;
            }

            /**
             * Replaces the Homebrew folders.
             *
             * @param values the folders, in order
             * @return this builder
             */
            public Builder homebrewDirs(List<String> values) {
                homebrewDirs.clear();
                homebrewDirs.addAll(values);
                return this;
            }

            /**
             * Appends one Homebrew folder.
             *
             * @param value the folder
             * @return this builder
             */
            public Builder homebrew(Path value) {
                homebrewDirs.add(value.toString());
                return this;
            }

            /**
             * Sets the {@code NPM_CONFIG_PREFIX} value.
             *
             * @param value the prefix, or null
             * @return this builder
             */
            public Builder npmConfigPrefix(String value) {
                npmConfigPrefix = value;
                return this;
            }

            /**
             * Sets the {@code .npmrc} to read.
             *
             * @param value the file, or null
             * @return this builder
             */
            public Builder npmrc(Path value) {
                npmrc = value;
                return this;
            }

            /**
             * Sets the {@code COPILOT_CLI_PATH} value.
             *
             * @param value the path, or null
             * @return this builder
             */
            public Builder copilotCliPath(String value) {
                copilotCliPath = value;
                return this;
            }

            /**
             * Sets the inherited {@code PATH}.
             *
             * @param value the PATH value
             * @return this builder
             */
            public Builder path(String value) {
                path = value;
                return this;
            }

            /**
             * Builds the inputs.
             *
             * @return the environment
             */
            public Environment build() {
                return new Environment(osName, copilotCliPath, npmConfigPrefix, npmrc, path, home, homebrewDirs);
            }
        }
    }

    /**
     * Whether the Copilot runtime is offered on a platform.
     *
     * @param osName an {@code os.name} value
     * @return true on macOS only
     */
    public static boolean isSupportedPlatform(String osName) {
        return osName != null && osName.toLowerCase(Locale.ROOT).startsWith("mac");
    }

    /**
     * The lookup for this process.
     *
     * @param workspace the workspace folder no runtime may come from, or null
     * @return the answer
     */
    public static Lookup find(Path workspace) {
        return find(Environment.current(), workspace);
    }

    /**
     * The lookup over given inputs.
     *
     * @param environment the inputs
     * @param workspace   the workspace folder no runtime may come from, or null
     * @return the answer
     */
    public static Lookup find(Environment environment, Path workspace) {
        if (!isSupportedPlatform(environment.osName())) {
            return new Lookup(Status.UNSUPPORTED, null, null, List.of(),
                    "not supported on this platform (macOS only)");
        }
        Path fence = realFolder(workspace);

        String chosen = environment.copilotCliPath();
        if (chosen != null && !chosen.isBlank()) {
            return explicit(chosen.trim(), fence);
        }

        Set<String> searched = new LinkedHashSet<>();
        List<Candidate> candidates = new ArrayList<>();
        for (String dir : environment.homebrewDirs()) {
            candidates.add(new Candidate(dir, Source.HOMEBREW));
        }
        for (String prefix : npmPrefixes(environment)) {
            candidates.add(new Candidate(Path.of(prefix).resolve("bin").toString(), Source.NPM_GLOBAL));
        }
        // No extra toolchain folders here: Homebrew was step 2, and ToolPath adds
        // ~/.local/bin itself.
        for (String dir : ToolPath.locate(EXECUTABLE, environment.inheritedPath(), environment.home(),
                List.of()).searched()) {
            candidates.add(new Candidate(dir, Source.PATH));
        }

        for (Candidate candidate : candidates) {
            String folder = trimSlashes(candidate.folder());
            if (!searched.add(folder)) {
                continue;
            }
            Path file;
            try {
                file = Path.of(folder, EXECUTABLE);
            } catch (InvalidPathException unparsable) {
                continue;
            }
            if (!Files.isRegularFile(file) || !Files.isExecutable(file)) {
                continue;
            }
            Optional<Path> real = realPath(file);
            if (real.isEmpty() || inside(real.get(), fence)) {
                continue;
            }
            Source source = real.get().toString().contains("/node_modules/") ? Source.NPM_GLOBAL : candidate.source();
            return new Lookup(Status.FOUND, file, source, List.copyOf(searched),
                    "found at " + file + " (" + source.label() + ")");
        }
        return new Lookup(Status.NOT_INSTALLED, null, null, List.copyOf(searched),
                "not installed. Install it with: " + INSTALL_LINE);
    }

    /**
     * The process start for a runtime: the parent's environment without
     * {@link #TOKEN_VARIABLES}, and a {@code PATH} with the runtime's own folder
     * first and the {@link ToolPath} policy after it. An npm install is a Node
     * script, and its {@code node} usually sits in the same folder.
     *
     * @param cliPath the runtime, as found
     * @param parent  the environment to start from
     * @param home    the home folder the per-user PATH folders resolve against
     * @return what the SDK is started with
     */
    public static Launch launch(Path cliPath, Map<String, String> parent, Path home) {
        Map<String, String> environment = new LinkedHashMap<>(parent);
        TOKEN_VARIABLES.forEach(environment::remove);
        String toolPath = ToolPath.locate(EXECUTABLE, parent.get("PATH"), home, ToolPath.TOOLCHAIN_DIRS)
                .searched().stream().reduce((a, b) -> a + File.pathSeparator + b).orElse("");
        Path folder = cliPath.toAbsolutePath().getParent();
        List<String> entries = new ArrayList<>();
        if (folder != null) {
            entries.add(folder.toString());
        }
        for (String entry : toolPath.split(File.pathSeparator, -1)) {
            if (!entry.isBlank() && !entries.contains(entry)) {
                entries.add(entry);
            }
        }
        environment.put("PATH", String.join(File.pathSeparator, entries));
        return new Launch(cliPath, environment);
    }

    /**
     * The runtime's version, read from {@code copilot --version} with the
     * launch's environment. The SDK's {@code getStatus()} reports the same
     * number once a client has started; this answers without starting one.
     *
     * @param launch  the runtime and its environment
     * @param timeout how long to wait before the process is killed
     * @return the version, or empty when the runtime fails, hangs or prints none
     */
    public static Optional<String> version(Launch launch, Duration timeout) {
        Process process;
        try {
            ProcessBuilder builder = new ProcessBuilder(launch.cliPath().toString(), "--version")
                    .redirectErrorStream(true)
                    .redirectInput(ProcessBuilder.Redirect.from(new File("/dev/null")));
            builder.environment().clear();
            builder.environment().putAll(launch.environment());
            process = builder.start();
        } catch (IOException | RuntimeException notStartable) {
            return Optional.empty();
        }
        CompletableFuture<String> output = CompletableFuture.supplyAsync(() -> read(process.getInputStream()));
        try {
            if (!process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS)) {
                return Optional.empty();
            }
            if (process.exitValue() != 0) {
                return Optional.empty();
            }
            Matcher matcher = VERSION.matcher(output.get(1, TimeUnit.SECONDS));
            return matcher.find() ? Optional.of(matcher.group(1)) : Optional.empty();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return Optional.empty();
        } catch (Exception unreadable) {
            return Optional.empty();
        } finally {
            process.descendants().forEach(ProcessHandle::destroyForcibly);
            process.destroyForcibly();
        }
    }

    private record Candidate(String folder, Source source) {
    }

    private static Lookup explicit(String chosen, Path fence) {
        String prefix = CLI_PATH_VARIABLE + " is " + chosen + ", ";
        Path file;
        try {
            file = Path.of(chosen);
        } catch (InvalidPathException unparsable) {
            return rejected(prefix + "which is not a path");
        }
        if (!file.isAbsolute()) {
            return rejected(prefix + "which is not an absolute path");
        }
        if (!Files.isRegularFile(file) || !Files.isExecutable(file)) {
            return rejected(prefix + "which is not an executable file");
        }
        Optional<Path> real = realPath(file);
        if (real.isEmpty()) {
            return rejected(prefix + "which cannot be resolved");
        }
        if (inside(real.get(), fence)) {
            return rejected(prefix + "which lies inside the workspace folder");
        }
        return new Lookup(Status.FOUND, file, Source.COPILOT_CLI_PATH, List.of(),
                "found at " + file + " (" + Source.COPILOT_CLI_PATH.label() + ")");
    }

    private static Lookup rejected(String detail) {
        return new Lookup(Status.REJECTED, null, null, List.of(), detail);
    }

    private static List<String> npmPrefixes(Environment environment) {
        List<String> prefixes = new ArrayList<>();
        addAbsolute(prefixes, environment.npmConfigPrefix(), environment.home());
        if (environment.npmrc() != null) {
            try {
                for (String line : Files.readAllLines(environment.npmrc(), StandardCharsets.UTF_8)) {
                    String trimmed = line.trim();
                    int equals = trimmed.indexOf('=');
                    if (equals > 0 && trimmed.substring(0, equals).trim().equalsIgnoreCase("prefix")) {
                        addAbsolute(prefixes, trimmed.substring(equals + 1).trim(), environment.home());
                    }
                }
            } catch (IOException | RuntimeException unreadable) {
                // no .npmrc, or one we cannot read: no prefix from it
            }
        }
        return prefixes;
    }

    private static void addAbsolute(List<String> prefixes, String value, Path home) {
        if (value == null || value.isBlank()) {
            return;
        }
        String expanded = value;
        if (expanded.startsWith("~/") && home != null && home.isAbsolute()) {
            expanded = home.resolve(expanded.substring(2)).toString();
        }
        try {
            if (Path.of(expanded).isAbsolute() && !prefixes.contains(expanded)) {
                prefixes.add(expanded);
            }
        } catch (InvalidPathException unparsable) {
            // not a folder name
        }
    }

    private static String npmPrefixVariable(Map<String, String> environment) {
        for (Map.Entry<String, String> entry : environment.entrySet()) {
            if (entry.getKey().equalsIgnoreCase("npm_config_prefix")) {
                return entry.getValue();
            }
        }
        return null;
    }

    private static Path realFolder(Path workspace) {
        if (workspace == null) {
            return null;
        }
        return realPath(workspace).orElse(workspace.toAbsolutePath().normalize());
    }

    private static Optional<Path> realPath(Path path) {
        try {
            return Optional.of(path.toRealPath());
        } catch (IOException | SecurityException unresolvable) {
            return Optional.empty();
        }
    }

    private static boolean inside(Path real, Path fence) {
        return fence != null && real.startsWith(fence);
    }

    private static String trimSlashes(String folder) {
        String trimmed = folder;
        while (trimmed.length() > 1 && trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed;
    }

    private static String read(InputStream stream) {
        try (stream) {
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException unreadable) {
            return "";
        }
    }
}
