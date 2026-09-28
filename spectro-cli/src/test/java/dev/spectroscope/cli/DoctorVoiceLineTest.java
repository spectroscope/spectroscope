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
        assertEquals("voice input: whisper-cli + ggml-small.bin ready (source: settings) (/voice)",
                line.message());
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
}
