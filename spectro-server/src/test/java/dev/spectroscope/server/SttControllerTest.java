package dev.spectroscope.server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 184 leg 2b: what speech needs, whether it is here, and the honest line
 * between the half this app can fetch and the half it must only report.
 */
class SttControllerTest {

    private static SttController controllerIn(Path models, String path) {
        return new SttController(models, path, url -> new ByteArrayInputStream(new byte[0]));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> sub(Map<String, Object> state, String key) {
        return (Map<String, Object>) state.get(key);
    }

    @Test
    void saysTheModelIsAbsentWhenItIs(@TempDir Path dir) {
        Map<String, Object> state = controllerIn(dir, "").state();
        assertEquals(false, sub(state, "model").get("present"));
        assertEquals(0L, sub(state, "model").get("bytes"));
        // The size it WOULD be, so a pane can say what the download costs before
        // anyone starts it.
        assertEquals(487_601_967L, sub(state, "model").get("expectedBytes"));
        assertEquals(false, state.get("ready"));
    }

    @Test
    void measuresTheModelItFinds(@TempDir Path dir) throws Exception {
        Files.writeString(dir.resolve("ggml-small.bin"), "not really 487 MB");
        Map<String, Object> state = controllerIn(dir, "").state();
        assertEquals(true, sub(state, "model").get("present"));
        assertEquals(17L, sub(state, "model").get("bytes"), "the size on disk, measured");
    }

    /** The whole point of the probe: readiness is a fact about right now, and a
     *  model can appear WHILE the server runs — which is what the download does. */
    @Test
    void noticesAModelThatAppearsAfterTheControllerWasBuilt(@TempDir Path dir) throws Exception {
        SttController controller = controllerIn(dir, "");
        assertEquals(false, sub(controller.state(), "model").get("present"));
        Files.writeString(dir.resolve("ggml-small.bin"), "arrived");
        assertEquals(true, sub(controller.state(), "model").get("present"),
                "probed on every call, never remembered from construction");
    }

    @Test
    void findsABinaryOnThePathAndNamesWhereItSits(@TempDir Path dir) throws Exception {
        Path bin = dir.resolve("bin");
        Files.createDirectories(bin);
        Path ffmpeg = bin.resolve("ffmpeg");
        Files.writeString(ffmpeg, "#!/bin/sh\n");
        ffmpeg.toFile().setExecutable(true);

        assertEquals(ffmpeg.toString(), SttController.onPath("ffmpeg", bin.toString()));
        assertNull(SttController.onPath("whisper-cli", bin.toString()), "absent is absent");
        // A file that is not executable is not a binary you can run.
        Files.writeString(bin.resolve("whisper-cli"), "text");
        assertNull(SttController.onPath("whisper-cli", bin.toString()));
    }

    @Test
    void ignoresEmptyPathSegmentsRatherThanSearchingTheWorkingDirectory(@TempDir Path dir) {
        assertNull(SttController.onPath("ffmpeg", "::"));
    }

    /** The line this card draws: the model is a button, the binaries are a
     *  sentence. An app that offered to `brew install` would be promising
     *  something it must not do and a DMG user could not use anyway. */
    @Test
    void reportsTheBinariesAndOffersAnInstructionRatherThanAButton(@TempDir Path dir) {
        Map<String, Object> state = controllerIn(dir, "").state();
        Map<String, Object> bins = sub(state, "binaries");
        assertEquals(false, sub(bins, "ffmpeg").get("found"));
        assertEquals(false, sub(bins, "whisper-cli").get("found"));
        assertNull(sub(bins, "ffmpeg").get("path"));
        assertNotNull(state.get("binaryHint"), "it says what to run, on this machine");
        assertFalse(String.valueOf(state.get("binaryHint")).isBlank());
    }

    @Test
    void staysSilentAboutTheInstructionOnceBothBinariesAreThere(@TempDir Path dir) throws Exception {
        Path bin = dir.resolve("bin");
        Files.createDirectories(bin);
        for (String name : SttController.BINARIES) {
            Path exe = bin.resolve(name);
            Files.writeString(exe, "#!/bin/sh\n");
            exe.toFile().setExecutable(true);
        }
        Files.writeString(dir.resolve("ggml-small.bin"), "present");

        Map<String, Object> state = controllerIn(dir, bin.toString()).state();
        assertNull(state.get("binaryHint"), "nothing to advise when nothing is missing");
        assertEquals(true, state.get("ready"), "model and both binaries: ready");
    }

    /** The digest is the script's, and the script's was measured against the
     *  real download. A pane may say "verified" only because of this. */
    @Test
    void pinsTheSameDigestTheSetupScriptDoes() throws Exception {
        String script = Files.readString(Path.of("..", "scripts", "setup-stt.sh"));
        assertTrue(script.contains(SttController.MODEL_SHA256),
                "the controller and the script must pin ONE digest, not two");
        assertTrue(script.contains(SttController.MODEL_URL), "and one url");
    }
}
