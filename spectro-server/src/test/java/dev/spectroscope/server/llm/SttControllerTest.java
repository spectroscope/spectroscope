package dev.spectroscope.server.llm;

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
        return controllerIn(models, path, "auto", false);
    }

    /** The full seam: also what the settings say and whether a hosted key exists. */
    private static SttController controllerIn(Path models, String path, String configured,
                                              boolean keyPresent) {
        return new SttController(models, path, url -> new ByteArrayInputStream(new byte[0]),
                () -> configured, () -> keyPresent);
    }

    // ---- the two routes (card 187, the correction) --------------------------

    /**
     * The pane's whole job after the correction: say which way speech goes and
     * whether that way can run. A machine with a key and nothing installed is
     * READY, and a pane that answered "not installed" there would be describing
     * a route this call is not taking.
     */
    @Test
    void aKeyAndNothingInstalledIsAWorkingSetup(@TempDir Path dir) {
        Map<String, Object> state = controllerIn(dir, "", "auto", true).state();

        assertEquals("hosted", state.get("route"));
        assertEquals(true, state.get("speechWorks"), "a key is all the hosted route needs");
        assertEquals(false, state.get("ready"), "and the LOCAL route is still honestly not ready");
    }

    @Test
    void noKeyFallsBackToTheLocalRouteAndSaysWhatItNeeds(@TempDir Path dir) {
        Map<String, Object> state = controllerIn(dir, "", "auto", false).state();

        assertEquals("local", state.get("route"));
        assertEquals(false, state.get("speechWorks"));
        assertNotNull(state.get("binaryHint"), "the local route's obstacle is the one named");
    }

    @Test
    void anExplicitLocalChoiceIsNotOverriddenByTheMereExistenceOfAKey(@TempDir Path dir) {
        Map<String, Object> state = controllerIn(dir, "", "local", true).state();
        assertEquals("local", state.get("route"));
    }

    @Test
    void thePaneNamesTheHostedProviderItWouldUse(@TempDir Path dir) {
        Map<String, Object> state = controllerIn(dir, "", "openai", true).state();

        @SuppressWarnings("unchecked")
        Map<String, Object> hosted = (Map<String, Object>) state.get("hosted");
        assertEquals(true, hosted.get("keyPresent"));
        assertEquals("OPENAI_API_KEY", hosted.get("keyEnv"));
        assertEquals("gpt-transcribe", hosted.get("model"));
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
        Path whisper = bin.resolve("whisper-cli");
        Files.writeString(whisper, "#!/bin/sh\n");
        whisper.toFile().setExecutable(true);

        assertEquals(whisper.toString(), SttController.onPath("whisper-cli", bin.toString()));
        assertNull(SttController.onPath("llama-server", bin.toString()), "absent is absent");
        // A file that is not executable is not a binary you can run.
        Files.writeString(bin.resolve("llama-server"), "text");
        assertNull(SttController.onPath("llama-server", bin.toString()));
    }

    @Test
    void ignoresEmptyPathSegmentsRatherThanSearchingTheWorkingDirectory(@TempDir Path dir) {
        assertNull(SttController.onPath("whisper-cli", "::"));
    }

    /** The line this card draws: the model is a button, the binaries are a
     *  sentence. An app that offered to `brew install` would be promising
     *  something it must not do and a DMG user could not use anyway. */
    @Test
    void reportsTheBinariesAndOffersAnInstructionRatherThanAButton(@TempDir Path dir) {
        Map<String, Object> state = controllerIn(dir, "").state();
        Map<String, Object> bins = sub(state, "binaries");
        assertEquals(false, sub(bins, "whisper-cli").get("found"));
        assertNull(sub(bins, "whisper-cli").get("path"));
        // Card 187 step 5.4: the browser converts its own recording, so this path
        // needs ONE binary. A pane that still asked for ffmpeg would be asking a
        // reader to install something nothing here runs.
        assertNull(bins.get("ffmpeg"), "ffmpeg is not a requirement of this path any more");
        assertFalse(String.valueOf(state.get("binaryHint")).contains("ffmpeg"),
                "and the instruction must not name it either: " + state.get("binaryHint"));
        assertNotNull(state.get("binaryHint"), "it says what to run, on this machine");
        assertFalse(String.valueOf(state.get("binaryHint")).isBlank());
    }

    @Test
    void staysSilentAboutTheInstructionOnceTheBinaryIsThere(@TempDir Path dir) throws Exception {
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
        assertEquals(true, state.get("ready"), "model and binary: ready");
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
