package dev.spectroscope.core.copilot;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 495: the Copilot CLI's device flow, read from what {@code copilot login
 * --device-code} prints. The fake prints the three lines card 478 recorded from
 * the real CLI 1.0.94 ({@code evidence/478/login-device*.log}).
 */
@Timeout(value = 30, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class CopilotCliLoginTest {

    @TempDir
    Path dir;

    private Path fakeCli(String body) throws Exception {
        Path cli = dir.resolve("copilot");
        Files.writeString(cli, "#!/bin/sh\n"
                + "printf '%s\\n' \"$@\" > '" + dir.resolve("args") + "'\n"
                + "env > '" + dir.resolve("env") + "'\n"
                + body);
        Files.setPosixFilePermissions(cli, PosixFilePermissions.fromString("rwx------"));
        return cli;
    }

    @Test
    void theCodeAndAddressAreReadAndASuccessNamesTheLogin() throws Exception {
        Path cli = fakeCli("echo 'To authenticate, visit https://github.com/login/device and enter code 2B8A-BAC6'\n"
                + "echo 'Waiting for authorization...'\n"
                + "sleep 0.2\n"
                + "echo 'Signed in successfully as octo-fixture.'\n");

        CopilotCliLogin.Run run = new CopilotCliLogin(cli, Map.of("PATH", "/usr/bin:/bin")).start();

        assertEquals(new CopilotCliLogin.Prompt("https://github.com/login/device", "2B8A-BAC6"),
                run.prompt().get(5, TimeUnit.SECONDS));
        assertEquals(new CopilotCliLogin.Outcome(true, "octo-fixture", null), run.outcome().get(5, TimeUnit.SECONDS));
        assertEquals(List.of("login", "--device-code"), Files.readAllLines(dir.resolve("args")));
    }

    @Test
    void aFailureKeepsTheCliWords() throws Exception {
        Path cli = fakeCli("echo 'To authenticate, visit https://github.com/login/device and enter code D3CD-CEDC'\n"
                + "echo 'Login failed: Error: Device code expired before authorization completed' >&2\n"
                + "exit 1\n");

        CopilotCliLogin.Run run = new CopilotCliLogin(cli, Map.of("PATH", "/usr/bin:/bin")).start();

        CopilotCliLogin.Outcome outcome = run.outcome().get(5, TimeUnit.SECONDS);
        assertFalse(outcome.signedIn());
        assertEquals("Error: Device code expired before authorization completed", outcome.message());
    }

    @Test
    void anExitWithoutEitherLineSaysTheExitCode() throws Exception {
        Path cli = fakeCli("exit 3\n");

        CopilotCliLogin.Run run = new CopilotCliLogin(cli, Map.of("PATH", "/usr/bin:/bin")).start();

        CopilotCliLogin.Outcome outcome = run.outcome().get(5, TimeUnit.SECONDS);
        assertFalse(outcome.signedIn());
        assertTrue(outcome.message().contains("exit code 3"), outcome.message());
        assertTrue(run.prompt().isCompletedExceptionally(), "no code was printed");
    }

    @Test
    void theLoginRunsWithoutAnyTokenVariable() throws Exception {
        Path cli = fakeCli("echo 'Signed in successfully as octo-fixture.'\n");
        Map<String, String> parent = Map.of("PATH", "/usr/bin:/bin", "COPILOT_GITHUB_TOKEN", "a", "GH_TOKEN", "b",
                "GITHUB_TOKEN", "c", "HOME", dir.toString());

        new CopilotCliLogin(cli, parent).start().outcome().get(5, TimeUnit.SECONDS);

        String env = Files.readString(dir.resolve("env"));
        assertFalse(env.contains("COPILOT_GITHUB_TOKEN="), env);
        assertFalse(env.contains("GH_TOKEN="), env);
        assertFalse(env.contains("GITHUB_TOKEN="), env);
        assertTrue(env.contains("HOME=" + dir), "the rest passes through");
    }

    @Test
    void cancelStopsTheProcess() throws Exception {
        Path cli = fakeCli("echo 'To authenticate, visit https://github.com/login/device and enter code 2B8A-BAC6'\n"
                + "exec sleep 30\n");

        CopilotCliLogin.Run run = new CopilotCliLogin(cli, Map.of("PATH", "/usr/bin:/bin")).start();
        run.prompt().get(5, TimeUnit.SECONDS);
        run.cancel();

        CopilotCliLogin.Outcome outcome = run.outcome().get(5, TimeUnit.SECONDS);
        assertFalse(outcome.signedIn());
    }
}
