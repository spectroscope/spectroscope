package dev.spectroscope.cli;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.copilot.CopilotRuntime;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 497: the doctor's row for the Copilot runtime. Found at a path with a
 * version, not installed with the install line, or not supported off macOS.
 */
class DoctorCopilotRuntimeLineTest {

    private static final Path BREW = Path.of("/opt/homebrew/bin/copilot");
    private static final List<String> SEARCHED = List.of("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin");

    @AfterEach
    void cleanHome() throws IOException {
        Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
        Files.deleteIfExists(SpectroConfig.CONFIG_PATH);
    }

    // the row itself

    @Test
    void aFoundRuntimeNamesItsPathItsSourceAndItsVersion() {
        DoctorCommand.Line line = DoctorCommand.copilotRuntimeLine(found(), Optional.of("1.0.94"), false);

        assertEquals(DoctorCommand.Kind.PASS, line.kind());
        assertEquals("copilot runtime: found at /opt/homebrew/bin/copilot (Homebrew), version 1.0.94",
                line.message());
    }

    @Test
    void aMissingRuntimeIsANoteWithTheInstallLineAndTheFoldersSearched() {
        DoctorCommand.Line line = DoctorCommand.copilotRuntimeLine(notInstalled(), Optional.empty(), false);

        assertEquals(DoctorCommand.Kind.INFO, line.kind(), "not chosen as the provider, so only a note");
        assertTrue(line.message().startsWith("copilot runtime: not installed"), line.message());
        assertTrue(line.message().contains(CopilotRuntime.INSTALL_LINE), line.message());
        for (String folder : SEARCHED) {
            assertTrue(line.message().contains(folder), folder + " is not named: " + line.message());
        }
    }

    @Test
    void aMissingRuntimeTurnsTheDoctorRedWhenCopilotIsTheProvider() {
        DoctorCommand.Line line = DoctorCommand.copilotRuntimeLine(notInstalled(), Optional.empty(), true);

        assertEquals(DoctorCommand.Kind.FAIL, line.kind());
        assertTrue(line.message().contains(CopilotRuntime.INSTALL_LINE), line.message());
    }

    @Test
    void aRuntimeThatGivesNoVersionIsRedOnlyForTheCopilotProvider() {
        assertEquals(DoctorCommand.Kind.FAIL,
                DoctorCommand.copilotRuntimeLine(found(), Optional.empty(), true).kind());
        DoctorCommand.Line note = DoctorCommand.copilotRuntimeLine(found(), Optional.empty(), false);
        assertEquals(DoctorCommand.Kind.INFO, note.kind());
        assertTrue(note.message().contains("did not report a version"), note.message());
    }

    @Test
    void aRejectedChoiceSaysWhy() {
        CopilotRuntime.Lookup rejected = new CopilotRuntime.Lookup(CopilotRuntime.Status.REJECTED, null, null,
                List.of(), "COPILOT_CLI_PATH is /tmp/x, which is not an executable file");

        DoctorCommand.Line line = DoctorCommand.copilotRuntimeLine(rejected, Optional.empty(), true);

        assertEquals(DoctorCommand.Kind.FAIL, line.kind());
        assertEquals("copilot runtime: COPILOT_CLI_PATH is /tmp/x, which is not an executable file",
                line.message());
    }

    @Test
    void offMacOsTheRowSaysNotSupportedAndNeverFails() {
        CopilotRuntime.Lookup unsupported = CopilotRuntime.find(
                CopilotRuntime.Environment.builder().os("Linux").build(), null);

        for (boolean selected : List.of(false, true)) {
            DoctorCommand.Line line = DoctorCommand.copilotRuntimeLine(unsupported, Optional.empty(), selected);
            assertEquals(DoctorCommand.Kind.INFO, line.kind());
            assertEquals("copilot runtime: not supported on this platform (macOS only)", line.message());
        }
    }

    // the drift guard: the row exists whenever the provider can be chosen

    @Test
    void theCopilotProviderNameHasItsOwnDoctorCheck() {
        assertEquals(DoctorCommand.ProviderCheck.COPILOT,
                DoctorCommand.providerCheckFor(CopilotRuntime.PROVIDER),
                "the day copilot joins the known providers, the doctor must already know it");
    }

    @Test
    void theRuntimeRowIsPrintedWhateverProviderIsConfigured() throws IOException {
        for (String provider : SpectroConfig.knownProviders()) {
            String out = doctorOutputFor(provider);
            assertTrue(out.contains("copilot runtime: "),
                    "the doctor for provider " + provider + " has no copilot runtime row:\n" + out);
        }
    }

    // helpers

    private static CopilotRuntime.Lookup found() {
        return new CopilotRuntime.Lookup(CopilotRuntime.Status.FOUND, BREW, CopilotRuntime.Source.HOMEBREW,
                SEARCHED.subList(0, 1), "found at " + BREW + " (Homebrew)");
    }

    private static CopilotRuntime.Lookup notInstalled() {
        return new CopilotRuntime.Lookup(CopilotRuntime.Status.NOT_INSTALLED, null, null, SEARCHED,
                "not installed. Install it with: " + CopilotRuntime.INSTALL_LINE);
    }

    private static String doctorOutputFor(String provider) throws IOException {
        Files.createDirectories(SpectroConfig.USER_SETTINGS_PATH.getParent());
        Files.writeString(SpectroConfig.USER_SETTINGS_PATH, "{\"provider\": \"" + provider + "\"}");
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
