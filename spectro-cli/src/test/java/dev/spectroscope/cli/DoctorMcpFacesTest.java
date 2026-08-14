package dev.spectroscope.cli;

import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 220, AC 5: doctor and the run stop contradicting each other. Doctor's
 * probe used to print {@code reachable} naming no face, and the card's whole
 * reproduction was a reader concluding {@code spectro run} had the server's
 * tools when it had none. The faces line closes the reader's side of the gap:
 * reachability now says who mounts, and the answer tracks the {@code
 * headlessMcp} settings key the same config file carries.
 *
 * <p>The configured server here is a command that does not exist — measured at
 * 3 ms to fail (HEADLESS-MCP.md §2) — so the probe costs nothing and spawns
 * nothing, and the faces line prints either way, which is the point: which
 * faces mount is a property of the config, not of one server's health.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class DoctorMcpFacesTest {

    @AfterEach
    void cleanHome() throws IOException {
        Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
        Files.deleteIfExists(SpectroConfig.CONFIG_PATH);
    }

    private static String captureDoctorOutput() {
        PrintStream original = System.out;
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        System.setOut(new PrintStream(buffer, true, StandardCharsets.UTF_8));
        try {
            new DoctorCommand().call();
        } finally {
            System.setOut(original);
        }
        return buffer.toString(StandardCharsets.UTF_8);
    }

    private static void writeUserSettings(String json) throws IOException {
        Files.createDirectories(SpectroConfig.USER_SETTINGS_PATH.getParent());
        Files.writeString(SpectroConfig.USER_SETTINGS_PATH, json);
    }

    @Test
    void withTheOptInOffTheFacesLineNamesTheFlagAndTheKey(@org.junit.jupiter.api.io.TempDir
            java.nio.file.Path unused) throws IOException {
        writeUserSettings("""
                { "mcpServers": { "ghost": { "command": "/nonexistent-card-220-probe" } } }
                """);

        String out = captureDoctorOutput();
        assertTrue(out.contains("mounted by the repl and the web session"),
                "the faces line names who mounts today, got:\n" + out);
        assertTrue(out.contains("only with --mcp or headlessMcp"),
                "and it names BOTH halves of the owner's road for the headless faces,"
                        + " got:\n" + out);
    }

    @Test
    void withTheOptInOnTheFacesLineSaysHeadlessMountsToo() throws IOException {
        writeUserSettings("""
                { "headlessMcp": true,
                  "mcpServers": { "ghost": { "command": "/nonexistent-card-220-probe" } } }
                """);

        String out = captureDoctorOutput();
        assertTrue(out.contains("headless runs"),
                "with the key on, reachable finally implies mounted for every face,"
                        + " got:\n" + out);
        assertTrue(out.contains("headlessMcp is on"),
                "the line says WHY headless mounts — the setting, by name, got:\n" + out);
        assertTrue(out.contains("--no-mcp"),
                "and it names the one lever that still declines it per invocation,"
                        + " got:\n" + out);
    }
}
