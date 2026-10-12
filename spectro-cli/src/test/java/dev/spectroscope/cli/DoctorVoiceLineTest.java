package dev.spectroscope.cli;

import dev.spectroscope.core.tools.ToolPath;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 449: the doctor's voice line asks the same lookup as the STT status and
 * the voice runner, and when {@code whisper-cli} is missing it names the
 * folders that lookup searched.
 */
class DoctorVoiceLineTest {

    private static final Path MODEL = Path.of("/home/x/.spectro/models/ggml-small.bin");

    private static final List<String> SEARCHED =
            List.of("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin");

    private static ToolPath.Lookup missing() {
        return new ToolPath.Lookup("whisper-cli", null, SEARCHED);
    }

    private static ToolPath.Lookup found() {
        return new ToolPath.Lookup("whisper-cli", "/opt/homebrew/bin/whisper-cli", SEARCHED);
    }

    @Test
    void aMissingWhisperNamesEveryFolderSearched() {
        DoctorCommand.Line line = DoctorCommand.voiceInputLine(missing(), MODEL, true, "default");

        assertEquals(DoctorCommand.Kind.INFO, line.kind(), "optional infrastructure is a note");
        assertTrue(line.message().contains("whisper-cli missing"), line.message());
        for (String folder : SEARCHED) {
            assertTrue(line.message().contains(folder), folder + " is not named: " + line.message());
        }
        assertTrue(line.message().contains("scripts/setup-stt.sh"),
                "the setup hint stays: " + line.message());
    }

    @Test
    void aFoundWhisperAndAPresentModelAreReady() {
        DoctorCommand.Line line = DoctorCommand.voiceInputLine(found(), MODEL, true, "settings");

        assertEquals(DoctorCommand.Kind.PASS, line.kind());
        assertEquals("voice input: whisper-cli + ggml-small.bin ready (source: settings) (/voice);"
                + " live text in the app every 2 s (chunk step 2000 ms)", line.message());
    }

    @Test
    void theReadyLineNamesTheChunkStepOfLocalLiveText() {
        // Card 527: the local route writes along live, and the doctor says how
        // often a whisper run covers the open window.
        DoctorCommand.Line line = DoctorCommand.voiceInputLine(found(), MODEL, true, "default");

        assertTrue(line.message().contains("chunk step "
                + dev.spectroscope.core.config.SttStreaming.STT_LOCAL_CHUNK_MS + " ms"), line.message());
    }

    @Test
    void aMissingWhisperSaysNothingAboutLiveText() {
        DoctorCommand.Line line = DoctorCommand.voiceInputLine(missing(), MODEL, true, "default");

        assertTrue(!line.message().contains("chunk step"), line.message());
    }

    @Test
    void aFoundWhisperWithoutTheModelSaysPresentAndListsNoSearch() {
        DoctorCommand.Line line = DoctorCommand.voiceInputLine(found(), MODEL, false, "default");

        assertEquals(DoctorCommand.Kind.INFO, line.kind());
        assertTrue(line.message().contains("whisper-cli present"), line.message());
        assertTrue(line.message().contains("model (source: default) missing"), line.message());
        assertFalse(line.message().contains("/usr/sbin"),
                "the folder list is for a missing binary only: " + line.message());
    }

    private static final ToolPath.Lookup SERVER =
            new ToolPath.Lookup("whisper-server", "/opt/homebrew/bin/whisper-server", SEARCHED);
    private static final ToolPath.Lookup NO_SERVER = new ToolPath.Lookup("whisper-server", null, SEARCHED);

    @Test
    void theRunnerLineNamesTheResidentServerTheAppStartsOnTheLoopback() {
        // Card 528 criterion 4.
        DoctorCommand.Line line = DoctorCommand.voiceRunnerLine("auto", SERVER, found());

        assertEquals(DoctorCommand.Kind.INFO, line.kind());
        assertEquals("voice runner: sttRunner auto runs whisper-server (/opt/homebrew/bin/whisper-server);"
                + " the app starts it on 127.0.0.1 and a free port on the first press, keeps the model"
                + " loaded and stops it after 30 idle minutes; its port and whether it is up are in"
                + " /api/stt/status of the running app", line.message());
    }

    @Test
    void theRunnerLineSaysWhisperCliLoadsTheModelOnEveryPress() {
        DoctorCommand.Line line = DoctorCommand.voiceRunnerLine("cli", SERVER, found());

        assertEquals("voice runner: sttRunner cli runs whisper-cli (/opt/homebrew/bin/whisper-cli);"
                + " the model loads on every press", line.message());
    }

    @Test
    void theRunnerLineSaysWhyWhisperCliRunsWhenTheServerIsMissing() {
        DoctorCommand.Line line = DoctorCommand.voiceRunnerLine("server", NO_SERVER, found());

        assertTrue(line.message().startsWith("voice runner: sttRunner server runs whisper-cli"), line.message());
        assertTrue(line.message().contains("whisper-server missing (searched " + String.join(", ", SEARCHED) + ")"),
                line.message());
        assertTrue(line.message().contains("brew install whisper-cpp"), line.message());
    }
}
