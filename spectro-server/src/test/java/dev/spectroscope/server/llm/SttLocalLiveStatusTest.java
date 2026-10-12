package dev.spectroscope.server.llm;

import dev.spectroscope.core.config.SttStreaming;
import dev.spectroscope.core.tools.ToolPath;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Card 527 criterion 6: {@code /api/stt/status} says whether the local route
 * can write along live and how often a whisper run covers the open window.
 */
class SttLocalLiveStatusTest {

    private static Function<String, ToolPath.Lookup> found(String folder) {
        return name -> new ToolPath.Lookup(name, folder + "/" + name, List.of(folder));
    }

    private static Function<String, ToolPath.Lookup> missing() {
        return name -> new ToolPath.Lookup(name, null, List.of("/usr/bin"));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> localLive(SttController controller) {
        return (Map<String, Object>) controller.state().get("localLive");
    }

    @Test
    void theStatusNamesTheChunkStepAndThatLocalLiveIsAvailable(@TempDir Path dir) throws Exception {
        Files.writeString(dir.resolve(SttController.MODEL_FILE), "present");
        SttController controller = new SttController(dir, found("/opt/homebrew/bin"),
                url -> new ByteArrayInputStream(new byte[0]), () -> "local", () -> false);

        Map<String, Object> live = localLive(controller);

        assertEquals(true, live.get("available"));
        assertEquals(SttStreaming.STT_LOCAL_CHUNK_MS, live.get("chunkMs"));
        assertEquals(SttStreaming.STT_LOCAL_WINDOW_MS, live.get("windowMs"));
        assertEquals(SttStreaming.STT_WARMUP_TIMEOUT_MS, live.get("warmupTimeoutMs"),
                "the browser waits this long for the model before it gives up");
    }

    @Test
    void withoutWhisperLocalLiveIsNotAvailable(@TempDir Path dir) throws Exception {
        Files.writeString(dir.resolve(SttController.MODEL_FILE), "present");
        SttController controller = new SttController(dir, missing(),
                url -> new ByteArrayInputStream(new byte[0]), () -> "local", () -> false);

        assertEquals(false, localLive(controller).get("available"));
    }
    @Test
    void aCustomModelAloneMakesLocalLiveAvailableAndNamesIt(@TempDir Path dir) throws Exception {
        Path custom = dir.resolve("elsewhere").resolve("ggml-large-v3.bin");
        Files.createDirectories(custom.getParent());
        Files.writeString(custom, "present");
        SttController controller = new SttController(dir, found("/opt/homebrew/bin"),
                url -> new ByteArrayInputStream(new byte[0]), () -> "local", () -> false,
                () -> "en", () -> custom);

        Map<String, Object> live = localLive(controller);

        assertEquals(true, live.get("available"),
                "the socket runs the configured model, so the status follows it");
        assertEquals("ggml-large-v3.bin", live.get("model"));
    }

    @Test
    void theDefaultFileAloneDoesNotOfferLiveWhenAnotherModelIsConfigured(@TempDir Path dir) throws Exception {
        Files.writeString(dir.resolve(SttController.MODEL_FILE), "present");
        Path custom = dir.resolve("missing-model.bin");
        SttController controller = new SttController(dir, found("/opt/homebrew/bin"),
                url -> new ByteArrayInputStream(new byte[0]), () -> "local", () -> false,
                () -> "en", () -> custom);

        assertEquals(false, localLive(controller).get("available"),
                "the socket would refuse the local route, so the status must not offer it");
    }

    private static Function<String, ToolPath.Lookup> only(String name) {
        return asked -> asked.equals(name)
                ? new ToolPath.Lookup(asked, "/opt/homebrew/bin/" + asked, List.of("/opt/homebrew/bin"))
                : new ToolPath.Lookup(asked, null, List.of("/opt/homebrew/bin"));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> runner(SttController controller) {
        return (Map<String, Object>) localLive(controller).get("runner");
    }

    private static SttController withRunner(Path dir, Function<String, ToolPath.Lookup> locator, String runner,
            WhisperServerRunner.Status server) {
        return new SttController(dir, locator, url -> new ByteArrayInputStream(new byte[0]), () -> "local",
                () -> false, () -> "en", () -> dir.resolve(SttController.MODEL_FILE), () -> runner, () -> server);
    }

    @Test
    void theStatusNamesTheRunnerItsPortAndThatTheServerIsUp(@TempDir Path dir) throws Exception {
        // Card 528 criterion 4.
        Files.writeString(dir.resolve(SttController.MODEL_FILE), "present");
        SttController controller = withRunner(dir, found("/opt/homebrew/bin"), "auto",
                new WhisperServerRunner.Status(true, 51234));

        assertEquals("auto", controller.state().get("runner"), "the setting, for the settings field");
        Map<String, Object> runner = runner(controller);
        assertEquals("auto", runner.get("configured"));
        assertEquals("server", runner.get("running"));
        assertEquals(51234, runner.get("port"));
        assertEquals(true, runner.get("up"));
        assertEquals(false, runner.get("fallback"));
        assertEquals(true, localLive(controller).get("available"));
    }

    @Test
    void aServerThatIsDownHasNoPort(@TempDir Path dir) throws Exception {
        Files.writeString(dir.resolve(SttController.MODEL_FILE), "present");
        SttController controller = withRunner(dir, found("/opt/homebrew/bin"), "server",
                new WhisperServerRunner.Status(false, null));

        Map<String, Object> runner = runner(controller);
        assertEquals("server", runner.get("running"));
        assertEquals(false, runner.get("up"));
        assertEquals(null, runner.get("port"));
    }

    @Test
    void whisperCliRunningNamesNoPortEvenWhileAServerIsUp(@TempDir Path dir) throws Exception {
        Files.writeString(dir.resolve(SttController.MODEL_FILE), "present");
        SttController controller = withRunner(dir, found("/opt/homebrew/bin"), "cli",
                new WhisperServerRunner.Status(true, 51234));

        Map<String, Object> runner = runner(controller);
        assertEquals("cli", runner.get("running"));
        assertEquals(false, runner.get("up"), "the server is not what runs");
        assertEquals(null, runner.get("port"));
    }

    @Test
    void serverWithoutWhisperServerSaysItFellBackToWhisperCli(@TempDir Path dir) throws Exception {
        Files.writeString(dir.resolve(SttController.MODEL_FILE), "present");
        SttController controller = withRunner(dir, only("whisper-cli"), "server",
                new WhisperServerRunner.Status(false, null));

        Map<String, Object> runner = runner(controller);
        assertEquals("cli", runner.get("running"));
        assertEquals(true, runner.get("fallback"));
        assertEquals(true, localLive(controller).get("available"), "whisper-cli can still stream");
    }

    @Test
    void whisperServerAloneMakesLocalLiveAvailable(@TempDir Path dir) throws Exception {
        Files.writeString(dir.resolve(SttController.MODEL_FILE), "present");
        SttController controller = withRunner(dir, only("whisper-server"), "auto",
                new WhisperServerRunner.Status(false, null));

        assertEquals(true, localLive(controller).get("available"),
                "the socket streams through the server, which is installed");
    }
}
