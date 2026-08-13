package dev.spectroscope.cli;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The ./spectro-app launcher's `web` group, exercised as the shell script it is.
 *
 * <p>The help path is the one path a user reaches by typing the group's name with
 * nothing after it, so it has to survive a sibling that is having a bad day. Both
 * tests run a COPY of the real launcher in a sandbox next to a stub spectro-serve —
 * the script cds to its own directory and calls ./spectro-serve relative to that,
 * which is exactly the seam a stub needs.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class SpectroLauncherWebTest {

    private static final String[] VERBS = {
            "start", "dev", "stop", "restart", "status", "logs", "open", "doctor"
    };

    @Test
    void aBareWebGroupPrintsEveryVerbWhenSpectroServeStatusFails(@TempDir Path sandbox) throws Exception {
        installLauncher(sandbox);
        // A status that prints its banner and then fails — the shape of a sibling
        // that cannot answer (no jar, an unreadable .run, a doctor check that
        // decides to exit non-zero one day).
        installServeStub(sandbox, """
                #!/usr/bin/env bash
                printf 'banner\\n'
                printf '  the live block\\n'
                exit 1
                """);

        Result web = run(sandbox);

        assertEquals(0, web.exit(),
                "the informational path exits 0 even when the sibling's status fails:\n" + web.output());
        for (String verb : VERBS) {
            assertTrue(web.output().contains(verb),
                    "the overview still lists '" + verb + "':\n" + web.output());
        }
    }

    /**
     * A pin, not a discovery: the help path must stay free of the .env export that
     * every working verb gets. Reading the group's own menu is not consent to load
     * a file of API keys into the environment of whatever it forks.
     */
    @Test
    void theHelpPathSkipsTheEnvExport(@TempDir Path sandbox) throws Exception {
        installLauncher(sandbox);
        Files.writeString(sandbox.resolve(".env"), "SPECTRO_LAUNCHER_PROBE=leaked\n");
        // The stub reports what it inherited: the .env load happens before the case
        // dispatch, so a broken gate is visible from inside anything web_state forks.
        installServeStub(sandbox, """
                #!/usr/bin/env bash
                printf 'banner\\n'
                printf 'probe=%s\\n' "${SPECTRO_LAUNCHER_PROBE:-unset}"
                """);

        Result web = run(sandbox);

        assertEquals(0, web.exit(), web.output());
        assertTrue(web.output().contains("probe=unset"),
                "the help path exported no .env into its child:\n" + web.output());
    }

    // ── the sandbox ────────────────────────────────────────────────────────────

    private static void installLauncher(Path sandbox) throws Exception {
        Path launcher = sandbox.resolve("spectro-app");
        Files.copy(repoRoot().resolve("spectro-app"), launcher);
        makeExecutable(launcher);
    }

    private static void installServeStub(Path sandbox, String body) throws Exception {
        Path stub = sandbox.resolve("spectro-serve");
        Files.writeString(stub, body, StandardCharsets.UTF_8);
        makeExecutable(stub);
    }

    private static void makeExecutable(Path file) throws Exception {
        assertTrue(file.toFile().setExecutable(true), "made " + file.getFileName() + " executable");
    }

    /** Walk up from the module dir to the solution root that carries the launcher. */
    private static Path repoRoot() {
        Path dir = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (dir != null) {
            if (Files.isRegularFile(dir.resolve("spectro-app"))
                    && Files.isRegularFile(dir.resolve("settings.gradle.kts"))) {
                return dir;
            }
            dir = dir.getParent();
        }
        throw new IllegalStateException("no solution root above " + System.getProperty("user.dir"));
    }

    private record Result(int exit, String output) {}

    private static Result run(Path sandbox) throws Exception {
        Process p = new ProcessBuilder("bash", sandbox.resolve("spectro-app").toString(), "web")
                .directory(sandbox.toFile())
                .redirectErrorStream(true)
                .start();
        String output = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertTrue(p.waitFor(30, TimeUnit.SECONDS), "the launcher terminates");
        return new Result(p.exitValue(), output);
    }
}
