package dev.spectroscope.core.local;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;

/**
 * Where this install's {@code llama-server} comes from: the packaged app ships
 * one next to itself ({@code spectro.bundle.bin}), and a bare server jar or CLI
 * uses whatever the operator installed on the {@code PATH}
 * ({@code brew install llama.cpp}). Absent is a legitimate answer — the built-in
 * provider then has no runtime, and the faces say so rather than promising a
 * model that would fail to spawn after a multi-gigabyte download.
 *
 * <p>This lives in core, not in the server module, because two faces ask the
 * same question: the server's model chooser and the CLI's doctor (card 164).
 * The lookup takes its roots as arguments, so the rule is testable without a
 * system property or a real PATH.</p>
 */
public final class LlamaServerBinary {

    /** The executable's file name in a bundle dir or a PATH entry. */
    public static final String EXECUTABLE = "llama-server";

    /** The system property the packaged app sets to its bundled binary dir. */
    public static final String BUNDLE_DIR_PROPERTY = "spectro.bundle.bin";

    private LlamaServerBinary() {
    }

    /** Which of the two places supplied the binary — the faces word their line
     *  differently for each ("came with the app" versus "you installed it"). */
    public enum Source { BUNDLE, PATH }

    /**
     * A located binary.
     *
     * @param path   the executable
     * @param source where it was found
     */
    public record Found(Path path, Source source) {}

    /**
     * The binary for the running process: the bundle dir first, then the PATH.
     *
     * @return the located binary, or empty when this machine has none
     */
    public static Optional<Found> find() {
        return findIn(System.getProperty(BUNDLE_DIR_PROPERTY), System.getenv("PATH"));
    }

    /**
     * The same lookup over injected roots — the seam the tests use.
     *
     * @param bundleDir the packaged app's binary dir, or null/blank when this is
     *                  not a packaged build
     * @param pathEnv   the {@code PATH} value to search, or null/blank for none
     * @return the located binary, or empty when neither root holds an executable
     */
    public static Optional<Found> findIn(String bundleDir, String pathEnv) {
        if (bundleDir != null && !bundleDir.isBlank()) {
            Path bundled = Path.of(bundleDir).resolve(EXECUTABLE);
            if (Files.isExecutable(bundled)) {
                return Optional.of(new Found(bundled, Source.BUNDLE));
            }
        }
        if (pathEnv == null || pathEnv.isBlank()) {
            return Optional.empty();
        }
        for (String entry : pathEnv.split(File.pathSeparator)) {
            if (entry.isBlank()) {
                continue;
            }
            try {
                Path candidate = Path.of(entry, EXECUTABLE);
                if (Files.isExecutable(candidate)) {
                    return Optional.of(new Found(candidate, Source.PATH));
                }
            } catch (RuntimeException malformedEntry) {
                // a junk PATH entry is not an answer either way — keep looking
            }
        }
        return Optional.empty();
    }

    /** The yes/no form of {@link #find()}.
     *  @return true when a bundled or PATH llama-server is executable */
    public static boolean available() {
        return find().isPresent();
    }

    /** The yes/no form of {@link #findIn} — the seam the tests use.
     *  @param bundleDir the packaged app's binary dir, or null/blank
     *  @param pathEnv   the {@code PATH} value to search, or null/blank
     *  @return true when either root holds an executable llama-server */
    public static boolean availableIn(String bundleDir, String pathEnv) {
        return findIn(bundleDir, pathEnv).isPresent();
    }

    /** The command the launcher execs: the bundled path when there is one, else
     *  the bare name, resolved by the operating system through the PATH.
     *  @return an executable name or absolute path for {@code ProcessBuilder} */
    public static String command() {
        return find().filter(f -> f.source() == Source.BUNDLE)
                .map(f -> f.path().toString())
                .orElse(EXECUTABLE);
    }
}
