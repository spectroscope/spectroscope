package dev.spectroscope.core.config;

import dev.spectroscope.core.tools.ToolPath;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 528 criterion 4: what {@code sttRunner} runs on this machine. The
 * server, the socket, the status page and the doctor all read this one rule.
 */
class SttRunnerChoiceTest {

    private static final ToolPath.Lookup SERVER =
            new ToolPath.Lookup("whisper-server", "/opt/homebrew/bin/whisper-server", List.of("/opt/homebrew/bin"));
    private static final ToolPath.Lookup CLI =
            new ToolPath.Lookup("whisper-cli", "/opt/homebrew/bin/whisper-cli", List.of("/opt/homebrew/bin"));
    private static final ToolPath.Lookup NO_SERVER =
            new ToolPath.Lookup("whisper-server", null, List.of("/usr/bin"));
    private static final ToolPath.Lookup NO_CLI =
            new ToolPath.Lookup("whisper-cli", null, List.of("/usr/bin"));

    @Test
    void autoRunsTheMeasuredPickWhenWhisperServerIsInstalled() {
        SttRunnerChoice choice = SttRunnerChoice.resolve("auto", SERVER, CLI);

        assertEquals(SttStreaming.STT_RUNNER_AUTO_PICK, choice.running());
        assertEquals("auto", choice.configured());
        assertFalse(choice.fallback());
        assertTrue(choice.ready());
    }

    @Test
    void autoRunsWhisperCliWithoutWhisperServer() {
        SttRunnerChoice choice = SttRunnerChoice.resolve("auto", NO_SERVER, CLI);

        assertEquals("cli", choice.running());
        assertFalse(choice.fallback(), "auto asked for nothing in particular");
        assertEquals("/opt/homebrew/bin/whisper-cli", choice.binary());
    }

    @Test
    void serverRunsTheServerWithItsPath() {
        SttRunnerChoice choice = SttRunnerChoice.resolve("server", SERVER, CLI);

        assertEquals("server", choice.running());
        assertEquals("whisper-server", choice.engine());
        assertEquals("/opt/homebrew/bin/whisper-server", choice.binary());
    }

    @Test
    void serverWithoutWhisperServerFallsBackToWhisperCliAndSaysSo() {
        SttRunnerChoice choice = SttRunnerChoice.resolve("server", NO_SERVER, CLI);

        assertEquals("cli", choice.running());
        assertEquals("whisper-cli", choice.engine());
        assertTrue(choice.fallback());
        assertTrue(choice.ready());
    }

    @Test
    void cliRunsWhisperCliEvenWhenWhisperServerIsThere() {
        SttRunnerChoice choice = SttRunnerChoice.resolve("cli", SERVER, CLI);

        assertEquals("cli", choice.running());
        assertFalse(choice.fallback());
    }

    @Test
    void nothingIsReadyWhenTheChosenProgramIsMissing() {
        assertFalse(SttRunnerChoice.resolve("cli", SERVER, NO_CLI).ready(), "cli was asked for and is missing");
        assertFalse(SttRunnerChoice.resolve("auto", NO_SERVER, NO_CLI).ready());
        assertFalse(SttRunnerChoice.resolve("server", NO_SERVER, NO_CLI).ready());
    }

    @Test
    void anUnsetValueReadsAsAuto() {
        assertEquals("auto", SttRunnerChoice.resolve(null, SERVER, CLI).configured());
        assertEquals("auto", SttRunnerChoice.resolve(" ", SERVER, CLI).configured());
    }
}
