package dev.spectroscope.cli;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.tools.ToolPath;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 251, criterion 3: doctor reports the PATH the agent's shells get, so the
 * next such mystery is a lookup instead of a hunt.
 *
 * <p>The line is held at both ends. The builder is asserted as a value, because
 * the provenance it prints — which directories the policy contributed — is the
 * half an operator acts on. And the real {@code call()} output is asserted for
 * the verbatim PATH, because a builder nobody prints reports nothing; that is
 * the same gap card 223 found in the web panel one floor up.
 */
class DoctorToolPathLineTest {

    @AfterEach
    void cleanHome() throws IOException {
        Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
        Files.deleteIfExists(SpectroConfig.CONFIG_PATH);
    }

    @Test
    void doctorPrintsTheEffectivePathVerbatim() {
        String output = captureDoctorOutput();

        assertTrue(output.contains("tool PATH"),
                "doctor says nothing about the PATH its own tools would get:\n" + output);
        assertTrue(output.contains(ToolPath.resolve().path()),
                "the effective PATH must be printed in full — a summary is not a lookup:\n"
                        + output);
    }

    @Test
    void theSummaryNamesTheDirectoriesThePolicyAdded() {
        List<DoctorCommand.Line> lines = DoctorCommand.toolPathLines(
                new ToolPath.Result("/opt/homebrew/bin:/usr/bin:/bin", List.of("/opt/homebrew/bin")));

        assertEquals(2, lines.size(), "a summary and the verbatim value");
        assertTrue(lines.get(0).message().contains("3 entries"), lines.get(0).message());
        assertTrue(lines.get(0).message().contains("1 added"), lines.get(0).message());
        assertTrue(lines.get(0).message().contains("/opt/homebrew/bin"), lines.get(0).message());
        assertEquals("tool PATH = /opt/homebrew/bin:/usr/bin:/bin", lines.get(1).message());
    }

    @Test
    void aTerminalLaunchIsReportedAsUntouched() {
        // From a shell that already exports the toolchain the policy is a no-op,
        // and saying so is what tells an operator the app is not the problem.
        List<DoctorCommand.Line> lines = DoctorCommand.toolPathLines(
                new ToolPath.Result("/opt/homebrew/bin:/usr/bin", List.of()));

        assertTrue(lines.get(0).message().contains("nothing added"), lines.get(0).message());
    }

    @Test
    void thePathLineIsNeverAVerdict() {
        // An unusual PATH is not an unhealthy install: this line must not move
        // the exit code, or a machine without homebrew fails doctor.
        List<DoctorCommand.Line> lines = DoctorCommand.toolPathLines(
                new ToolPath.Result("/usr/bin:/bin", List.of()));

        for (DoctorCommand.Line line : lines) {
            assertEquals(DoctorCommand.Kind.INFO, line.kind(), line.message());
        }
    }

    /**
     * Runs doctor with stdout captured — a standalone command, so the provider
     * check reads an env var and never the network.
     *
     * @return everything doctor printed
     */
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
}
