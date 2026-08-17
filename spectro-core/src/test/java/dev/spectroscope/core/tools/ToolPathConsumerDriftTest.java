package dev.spectroscope.core.tools;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 251: the two consumers of the PATH policy, held textually so the pin
 * survives a machine that happens not to need the enrichment.
 *
 * <p>The behavioural tests next door are the real proof, but both of them are
 * only as sharp as the difference between this host's PATH and the policy's
 * output. On a machine whose login shell already exports every directory the
 * policy knows — which is the machine this was written on — deleting the
 * enrichment leaves them green. So the wiring itself is asserted: that
 * {@link ShellCommand}'s spawn routes its environment through
 * {@code applyEnvironment}, and that doctor asks {@code ToolPath} rather than
 * reading {@code System.getenv("PATH")} back out on its own.
 *
 * <p>Comments are stripped before matching so a sentence quoting a call cannot
 * stand in for the call.
 */
class ToolPathConsumerDriftTest {

    @Test
    void theShellRunnerRoutesEveryChildEnvironmentThroughThePolicy() throws IOException {
        String source = stripComments(read("spectro-core/src/main/java/dev/spectroscope/core/"
                + "tools/ShellCommand.java"));

        assertTrue(source.contains("applyEnvironment(builder.environment(), extraEnv)"),
                "ShellCommand.run must lay the environment through applyEnvironment —"
                        + " otherwise the policy is a fold nobody consults");
        assertFalse(source.contains("builder.environment().putAll(extraEnv)"),
                "the old bare overlay is back: extraEnv over the inherited PATH, which is"
                        + " exactly the Finder case the card is about");
        assertTrue(source.contains("environment.put(\"PATH\", ToolPath.resolve().path())"),
                "applyEnvironment must take the PATH from ToolPath");
    }

    @Test
    void doctorPrintsThePolicysOwnAnswer() throws IOException {
        String source = stripComments(read("spectro-cli/src/main/java/dev/spectroscope/cli/"
                + "DoctorCommand.java"));

        assertTrue(source.contains("ToolPath.resolve()"),
                "doctor must report the PATH the agent's shells actually get, from the same"
                        + " policy that hands it to them");
        assertTrue(source.contains("toolPathLines("),
                "the line is assembled by the testable builder, not inline in call()");
    }

    /**
     * Reads a repository file as text.
     *
     * @param relative path from the repository root
     * @return the file's contents
     * @throws IOException when the file cannot be read
     */
    private static String read(String relative) throws IOException {
        Path file = repoRoot().resolve(relative);
        assertTrue(Files.isRegularFile(file), "no such source file: " + file);
        return Files.readString(file, StandardCharsets.UTF_8);
    }

    /**
     * Removes block and line comments, so prose about a call cannot satisfy an
     * assertion about the call.
     *
     * @param source java source text
     * @return the same text with comments blanked
     */
    private static String stripComments(String source) {
        return source.replaceAll("(?s)/\\*.*?\\*/", "").replaceAll("(?m)//.*$", "");
    }

    /** Walk up from the module dir to the directory that carries the Gradle settings.
     *  @return the repository root */
    private static Path repoRoot() {
        Path dir = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (dir != null && !Files.isRegularFile(dir.resolve("settings.gradle.kts"))) {
            dir = dir.getParent();
        }
        if (dir == null) {
            throw new IllegalStateException("no settings.gradle.kts above "
                    + System.getProperty("user.dir"));
        }
        return dir;
    }
}
