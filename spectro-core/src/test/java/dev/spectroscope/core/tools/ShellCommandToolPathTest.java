package dev.spectroscope.core.tools;

import dev.spectroscope.core.CancelSignal;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

/**
 * Card 251, the consumer end: a policy nobody applies is a fold that ships dead.
 *
 * <p>{@link ShellCommand} is the one runner behind {@code run_command} and every
 * hook, so it is the single place that has to set the PATH. The map is seeded
 * with launchd's four directories — the environment the owner's Finder-launched
 * app really had — because the test JVM's own PATH already carries the toolchain
 * and an assertion against it would be green whether the policy is applied or
 * not.
 *
 * <p>The order inside {@code applyEnvironment} is load-bearing in the other
 * direction too: a caller that passes PATH explicitly must still win, which is
 * what {@link #anExplicitCallerPathStillWins()} holds. The textual half — that
 * {@code run} routes its builder through this method at all — is
 * ToolPathConsumerDriftTest.
 */
class ShellCommandToolPathTest {

    /** What the measured Finder case hands the JVM. */
    private static final String LAUNCHD = "/usr/bin:/bin:/usr/sbin:/sbin";

    @Test
    void aChildEnvironmentSeededWithLaunchdsPathIsReplacedByThePolicy() {
        Map<String, String> environment = new HashMap<>();
        environment.put("PATH", LAUNCHD);

        ShellCommand.applyEnvironment(environment, Map.of());

        assertEquals(ToolPath.resolve().path(), environment.get("PATH"),
                "the child must get the deliberate PATH, not the inherited one");
        assertNotEquals(LAUNCHD, environment.get("PATH"),
                "on a machine with a toolchain the policy has to change something");
    }

    @Test
    void anExplicitCallerPathStillWins() {
        // Hooks and tests hand entries down deliberately; the policy is a floor
        // under them, never an override of them.
        Map<String, String> environment = new HashMap<>();
        environment.put("PATH", LAUNCHD);

        ShellCommand.applyEnvironment(environment, Map.of("PATH", "/only/here"));

        assertEquals("/only/here", environment.get("PATH"));
    }

    @Test
    void everyOtherInheritedEntrySurvives() {
        Map<String, String> environment = new HashMap<>();
        environment.put("PATH", LAUNCHD);
        environment.put("HOME", "/Users/x");

        ShellCommand.applyEnvironment(environment, Map.of("SPECTRO_TOOL_NAME", "run_command"));

        assertEquals("/Users/x", environment.get("HOME"), "the policy touches PATH and nothing else");
        assertEquals("run_command", environment.get("SPECTRO_TOOL_NAME"));
    }

    @Test
    void aRealChildShellReadsThePathThePolicyDecided(@TempDir Path cwd) {
        ShellCommand.Result result = ShellCommand.run("printf %s \"$PATH\"", Map.of(), cwd,
                20, new CancelSignal(), 8000);

        assertEquals(0, result.exitCode(), result.output());
        assertEquals(ToolPath.resolve().path(), result.output(),
                "what the spawned shell sees is the whole point of the card");
    }

    @Test
    void aRealChildShellHonoursAnExplicitPath(@TempDir Path cwd) {
        // The live half of the ordering pin: swap the two lines in
        // applyEnvironment and this child prints the policy's PATH instead.
        ShellCommand.Result result = ShellCommand.run("printf %s \"$PATH\"",
                Map.of("PATH", "/usr/bin:/bin"), cwd, 20, new CancelSignal(), 8000);

        assertEquals("/usr/bin:/bin", result.output());
    }

    @Test
    void theChildCanStillRunASystemBinary(@TempDir Path cwd) {
        // The enrichment must not cost the shell its floor.
        ShellCommand.Result result = ShellCommand.run("uname -s", Map.of(), cwd,
                20, new CancelSignal(), 8000);

        assertEquals(0, result.exitCode(), result.output());
        assertFalse(result.output().isBlank(), "uname printed nothing");
    }
}
