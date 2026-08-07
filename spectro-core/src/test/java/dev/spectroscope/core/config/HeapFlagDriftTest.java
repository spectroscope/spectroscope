package dev.spectroscope.core.config;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The heap ceiling is assembled in four different languages, in four files that
 * share no module: a bash launcher, an Electron main written in TypeScript, and
 * two Gradle build scripts. Nothing links them, so the ordinary way this goes
 * wrong is that someone adds the flag to the one path they were looking at and
 * the other three keep the JVM default without a word.
 *
 * <p>This test reads those files off the disk and insists they all pass the same
 * number as {@link HeapBudget#MAX_RAM_PERCENT}. It is the same shape as the
 * desktop About drift guard: when a wire crosses projects that cannot import
 * each other, the test has to go and look.
 *
 * <p>A fifth path exists and cannot be covered here, deliberately: a plain
 * {@code java -jar spectro-server-x.y.z.jar}. No script assembles that command,
 * so no build change can reach it. That path is answered at runtime instead, by
 * the line {@code SpectroServerApplication} logs at boot.
 */
class HeapFlagDriftTest {

    /** Every file that assembles a JVM command line for a spectroscope process. */
    private static final List<String> LAUNCH_PATHS = List.of(
            "spectro-serve",                        // developers, self-hosters
            "spectro-desktop/src/main.ts",          // the shipped DMG, AppImage and deb
            "spectro-server/build.gradle.kts",      // ./gradlew :spectro-server:bootRun
            "spectro-cli/build.gradle.kts");        // the CLI zip's generated start script

    private static final Pattern FLAG = Pattern.compile("MaxRAMPercentage=(\\d+)");

    @Test
    void everyLaunchPathPassesTheSamePercentage() throws IOException {
        Path root = repoRoot();
        assumeTrue(root != null, "not running from a source checkout");

        for (String relative : LAUNCH_PATHS) {
            Path file = root.resolve(relative);
            assertTrue(Files.isRegularFile(file), "launch path vanished: " + relative);
            Matcher matcher = FLAG.matcher(Files.readString(file));
            assertTrue(matcher.find(),
                    relative + " hands the JVM no heap ceiling, so it silently keeps the 25% default"
                            + " while the other launch paths get " + HeapBudget.MAX_RAM_PERCENT + "%");
            do {
                assertEquals(String.valueOf(HeapBudget.MAX_RAM_PERCENT), matcher.group(1),
                        relative + " passes a different percentage than HeapBudget.MAX_RAM_PERCENT");
            } while (matcher.find());
        }
    }

    @Test
    void theFloorIsMeasuredAgainstTheCapTheServerActuallyEnforces() throws IOException {
        // HeapBudget mirrors the controller's cap because core cannot import the
        // server module. Read the real one off the disk rather than trust the copy:
        // raising the cap raises the heap a worst-case import needs, and that must
        // not be a thing anyone discovers from an OutOfMemoryError.
        Path root = repoRoot();
        assumeTrue(root != null, "not running from a source checkout");
        Path controller = root.resolve(
                "spectro-server/src/main/java/dev/spectroscope/server/transcripts/ClaudeTranscriptsController.java");
        assertTrue(Files.isRegularFile(controller), "the transcript controller moved");

        Matcher matcher = Pattern.compile("MAX_CONTENT_BYTES\\s*=\\s*([^;]+);")
                .matcher(Files.readString(controller));
        assertTrue(matcher.find(), "MAX_CONTENT_BYTES is gone from ClaudeTranscriptsController");
        assertEquals(HeapBudget.TRANSCRIPT_IMPORT_CAP_BYTES, evaluate(matcher.group(1)),
                "the server's transcript cap moved but HeapBudget's mirror of it did not,"
                        + " so the heap floor is now measured against the wrong number");
    }

    /**
     * Evaluates the constant's initializer, which is written as a product for
     * readability ({@code 64L * 1024 * 1024}) but may equally be a single number.
     *
     * @param expression the source text between {@code =} and {@code ;}
     * @return the value in bytes
     */
    private static long evaluate(String expression) {
        long product = 1L;
        for (String factor : expression.replace("_", "").replace("L", "").split("\\*")) {
            product *= Long.parseLong(factor.trim());
        }
        return product;
    }

    /**
     * Walks up from the module directory to the directory holding
     * {@code settings.gradle.kts}.
     *
     * @return the checkout root, or null when this runs outside one (a consumer
     *         building the published sources jar, for instance)
     */
    private static Path repoRoot() {
        Path here = Path.of("").toAbsolutePath();
        for (Path candidate = here; candidate != null; candidate = candidate.getParent()) {
            if (Files.isRegularFile(candidate.resolve("settings.gradle.kts"))) {
                return candidate;
            }
        }
        return null;
    }
}
