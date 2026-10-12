package dev.spectroscope.server.llm;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.wire.LlmWireRecorder;
import dev.spectroscope.server.session.FakeSocket;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Deque;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.Executor;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 527 criteria 1 and 2 on the socket: the local route is accepted and
 * bound to a {@link LocalWhisperUpstream}, its answers reach the browser as
 * the partial and final it already knows (a replacing partial, a window final
 * that keeps the socket open), and every chunk run's wall time is on the
 * record and in the {@code wire} frame.
 *
 * <p>The model is {@code LiveSttSocketHandlerTest}: no network and no whisper.
 * The upstream is the real one; the runner behind it is a fake, the steps are
 * ticked by hand and the runs drained from a queue.</p>
 */
class LiveSttLocalRouteTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Where the window folders of a test go, so none is left in the system temp folder. */
    @TempDir
    Path tempRoot;

    /** A scripted whisper with a fixed wall time per run. */
    private static final class FakeRunner implements LocalWhisperUpstream.WindowRunner {
        final Deque<String> answers = new ArrayDeque<>();
        int runs;

        int warmUps;

        @Override
        public Optional<String> transcribe(Path wav, String language) throws IOException {
            byte[] bytes = Files.readAllBytes(wav);
            boolean silent = true;
            for (int i = 44; i < bytes.length && silent; i++) {
                silent = bytes[i] == 0;
            }
            if (silent) {
                // The warm up before ready (criterion 8): one clip of silence.
                warmUps++;
                return Optional.empty();
            }
            runs++;
            String next = answers.isEmpty() ? "" : answers.removeFirst();
            return next.isEmpty() ? Optional.empty() : Optional.of(next);
        }
    }

    /** Runs drained by the test. */
    private static final class Queue implements Executor {
        final Deque<Runnable> waiting = new ArrayDeque<>();

        @Override
        public void execute(Runnable command) {
            waiting.add(command);
        }

        void drain() {
            while (!waiting.isEmpty()) {
                waiting.removeFirst().run();
            }
        }
    }

    /** An upstream that must never be opened in these tests. */
    private static final class Hosted implements LiveSttUpstream {
        boolean opened;

        @Override
        public Link open(Listener listener) {
            opened = true;
            throw new AssertionError("the hosted upstream was opened on the local route");
        }
    }

    private final FakeRunner runner = new FakeRunner();
    private final Queue runs = new Queue();
    private final List<LiveSttUpstream.Link> links = new ArrayList<>();
    /** The real upstream, with the open session kept so the test can tick it.
     *  Built per open, because the temp folder is injected after construction. */
    private final LiveSttUpstream local = listener -> {
        LiveSttUpstream.Link link = new LocalWhisperUpstream(
                () -> new LocalWhisperUpstream.Settings("en", 2000, 30_000, 600, 0.02), runner, runs, null,
                tempRoot).open(listener);
        links.add(link);
        return link;
    };

    private LiveSttSocketHandler.Setup localSetup(boolean ready) {
        return new LiveSttSocketHandler.Setup(SttRoute.LOCAL, "", LiveSttProtocol.DEFAULT_MODEL,
                new LiveSttSocketHandler.LocalSetup(ready, "ggml-small.bin", "en", 2000));
    }

    private void tick() {
        ((LocalWhisperUpstream.Session) links.get(links.size() - 1)).tick();
        runs.drain();
    }

    private static TextMessage audio(double seconds) {
        byte[] pcm = new byte[(int) (seconds * 16_000) * 2];
        for (int i = 0; i < pcm.length; i += 2) {
            short s = (short) (Math.sin(i * Math.PI * 220 / 16_000) * 12_000);
            pcm[i] = (byte) s;
            pcm[i + 1] = (byte) (s >> 8);
        }
        return new TextMessage("{\"type\":\"audio\",\"data\":\"" + Base64.getEncoder().encodeToString(pcm) + "\"}");
    }

    private static List<JsonNode> frames(FakeSocket socket) throws IOException {
        List<JsonNode> out = new ArrayList<>();
        for (FakeSocket.Frame frame : socket.frames()) {
            out.add(JSON.readTree(frame.payload()));
        }
        return out;
    }

    private static JsonNode lastOfType(FakeSocket socket, String type) throws IOException {
        JsonNode found = null;
        for (JsonNode frame : frames(socket)) {
            if (frame.path("type").asText().equals(type)) {
                found = frame;
            }
        }
        return found;
    }

    @Test
    void aLocalRouteThatCanRunIsAcceptedAndBoundToTheLocalUpstream() throws Exception {
        Hosted hosted = new Hosted();
        FakeSocket socket = new FakeSocket("l1", "ws://localhost/ws/stt");

        LiveSttSocketHandler.withLocalRoute(() -> localSetup(true), hosted, local).afterConnectionEstablished(socket);
        runs.drain();

        assertFalse(hosted.opened, "a local route never reaches the provider");
        assertEquals(1, links.size(), "the local upstream was opened");
        assertNull(socket.closed.get(), "the socket stays open for the recording");
        assertNotNull(lastOfType(socket, "ready"), "the local handshake was answered as ready");
        assertEquals(1, runner.warmUps, "after one warm up run");
        assertTrue(lastOfType(socket, "ready").has("warmupMs"), "the browser learns how long the warm up took");
    }

    @Test
    void theLoadingFrameReachesTheBrowserBeforeReady() throws Exception {
        // Card 528 criterion 2: whisper-cli loads the model in its warm up, so
        // the browser hears loading first and shows the card until ready.
        FakeSocket socket = new FakeSocket("l1b", "ws://localhost/ws/stt");

        LiveSttSocketHandler.withLocalRoute(() -> localSetup(true), new Hosted(), local).afterConnectionEstablished(socket);
        runs.drain();

        List<String> types = frames(socket).stream().map(f -> f.path("type").asText()).toList();
        assertEquals(List.of("loading", "ready"), types);
        assertEquals("whisper-cli", lastOfType(socket, "loading").path("engine").asText());
    }

    @Test
    void aResidentServerNamesItsEngineAndSendsNoLoading(@TempDir Path dir) throws Exception {
        // Card 528: the model is already loaded, so no loading frame; the
        // handshake and the record name whisper-server, never its port.
        LocalWhisperUpstream.WindowRunner resident = new LocalWhisperUpstream.WindowRunner() {
            @Override
            public Optional<String> transcribe(Path wav, String language) {
                return Optional.empty();
            }

            @Override
            public boolean loadsModel() {
                return false;
            }

            @Override
            public void warmUp(Path silentWav, String language) {
                // the probe of a server that is up
            }

            @Override
            public String engine() {
                return "whisper-server";
            }
        };
        LiveSttUpstream serverUpstream = listener -> LocalWhisperUpstream.perSession(
                () -> new LocalWhisperUpstream.Settings("en", 2000, 30_000, 600, 0.02), () -> resident, runs, null,
                tempRoot).open(listener);
        Path wireFile = dir.resolve("stt.llm.jsonl");
        FakeSocket socket = new FakeSocket("l1c", "ws://localhost/ws/stt");
        try (LlmWireRecorder recorder = new LlmWireRecorder(wireFile, 1_000_000)) {
            LiveSttSocketHandler handler = new LiveSttSocketHandler(
                    () -> new LiveSttSocketHandler.Setup(SttRoute.LOCAL, "", LiveSttProtocol.DEFAULT_MODEL,
                            new LiveSttSocketHandler.LocalSetup(true, "ggml-small.bin", "en", 2000, "whisper-server")),
                    new Hosted(), serverUpstream, () -> recorder);
            handler.afterConnectionEstablished(socket);
            runs.drain();
            handler.afterConnectionClosed(socket, CloseStatus.NORMAL);
        }

        List<String> types = frames(socket).stream().map(f -> f.path("type").asText()).toList();
        assertFalse(types.contains("loading"), "no loading card for a model that is loaded: " + types);
        assertTrue(types.contains("ready"), types.toString());
        JsonNode request = JSON.readTree(Files.readAllLines(wireFile).get(0));
        assertEquals("process://whisper-server", request.path("url").asText());
        assertTrue(request.path("body").asText().contains("\"engine\":\"whisper-server\""),
                request.path("body").asText());
        assertFalse(Files.readString(wireFile).contains("127.0.0.1"), "no address on the record");
    }

    @Test
    void aLocalRouteWithoutWhisperOrModelIsStillRefusedByName() throws Exception {
        FakeSocket socket = new FakeSocket("l2", "ws://localhost/ws/stt");

        LiveSttSocketHandler.withLocalRoute(() -> localSetup(false), new Hosted(), local).afterConnectionEstablished(socket);
        runs.drain();

        assertTrue(socket.textJoined().contains("\"reason\":\"localRoute\""), socket.textJoined());
        assertTrue(links.isEmpty());
        assertNotNull(socket.closed.get());
    }

    @Test
    void aChunkRunReachesTheBrowserAsAPartialThatReplaces() throws Exception {
        runner.answers.add("hello");
        runner.answers.add("hello there");
        FakeSocket socket = new FakeSocket("l3", "ws://localhost/ws/stt");
        LiveSttSocketHandler handler = LiveSttSocketHandler.withLocalRoute(() -> localSetup(true), new Hosted(), local);
        handler.afterConnectionEstablished(socket);
        runs.drain();

        handler.handleTextMessage(socket, audio(1.0));
        tick();
        handler.handleTextMessage(socket, audio(1.0));
        tick();

        JsonNode partial = lastOfType(socket, "partial");
        assertEquals("hello there", partial.path("text").asText());
        assertTrue(partial.path("replace").asBoolean(), "the window's whole text, not a delta");
        assertTrue(partial.has("durationMs"), "the browser learns how long a run takes");
        assertEquals(2, runner.runs);
    }

    @Test
    void aClosedWindowArrivesAsAFinalWithMoreAndTheSocketStaysOpen() throws Exception {
        runner.answers.add("Hello there.");
        FakeSocket socket = new FakeSocket("l4", "ws://localhost/ws/stt");
        LiveSttSocketHandler handler = LiveSttSocketHandler.withLocalRoute(() -> localSetup(true), new Hosted(), local);
        handler.afterConnectionEstablished(socket);
        runs.drain();

        handler.handleTextMessage(socket, audio(1.0));
        handler.handleTextMessage(socket, new TextMessage("{\"type\":\"audio\",\"data\":\""
                + Base64.getEncoder().encodeToString(new byte[16_000 * 2]) + "\"}"));
        tick();

        JsonNode window = lastOfType(socket, "final");
        assertEquals("Hello there.", window.path("text").asText());
        assertTrue(window.path("more").asBoolean(), "the recording goes on after a window");
        assertNull(socket.closed.get(), "a window final does not end the session");
        assertNull(lastOfType(socket, "wire"), "nor the record");
    }

    @Test
    void theFinalAfterCommitEndsTheSessionWithEveryRunOnTheWireFrame(@TempDir Path dir) throws Exception {
        runner.answers.add("hello");
        runner.answers.add("Hello there.");
        Path wireFile = dir.resolve("stt.llm.jsonl");
        FakeSocket socket = new FakeSocket("l5", "ws://localhost/ws/stt");
        try (LlmWireRecorder recorder = new LlmWireRecorder(wireFile, 1_000_000)) {
            LiveSttSocketHandler handler = new LiveSttSocketHandler(() -> localSetup(true), new Hosted(), local,
                    () -> recorder);
            handler.afterConnectionEstablished(socket);
            runs.drain();
            handler.handleTextMessage(socket, audio(1.0));
            tick();
            handler.handleTextMessage(socket, audio(0.5));
            handler.handleTextMessage(socket, new TextMessage("{\"type\":\"commit\"}"));
            runs.drain();
        }

        JsonNode fin = lastOfType(socket, "final");
        assertEquals("Hello there.", fin.path("text").asText());
        assertFalse(fin.path("more").asBoolean());
        assertNotNull(socket.closed.get(), "the server says the last word and hangs up, as on the hosted route");

        JsonNode wire = lastOfType(socket, "wire");
        assertNotNull(wire, "the record announces itself before the socket closes");
        assertEquals("whisper-cpp", wire.path("provider").asText());
        assertEquals("ggml-small.bin", wire.path("model").asText());
        assertEquals("process", wire.path("transport").asText());
        assertEquals(LiveSttProtocol.LOCAL_URL, wire.path("url").asText());
        assertEquals(2, wire.path("chunks").asInt(), "two runs: one step and the final");
        assertEquals(2, wire.path("chunkDurationsMs").size());
        assertEquals(0, wire.path("chunksSkipped").asInt());
        assertEquals(2000, wire.path("chunkMs").asLong());
        assertTrue(wire.has("warmupMs"), "the warm up is on the wire frame next to the chunk times");

        List<JsonNode> lines = new ArrayList<>();
        for (String raw : Files.readAllLines(wireFile)) {
            lines.add(JSON.readTree(raw));
        }
        JsonNode request = lines.get(0);
        assertEquals("whisper-cpp", request.path("provider").asText());
        assertTrue(request.path("body").asText().contains("\"rate\":16000"), request.path("body").asText());
        JsonNode response = lines.stream()
                .filter(l -> l.path("type").asText().equals("llm_response"))
                .findFirst().orElseThrow();
        List<String> runLines = new ArrayList<>();
        response.path("lines").forEach(l -> {
            // Card 528: the loading line is on the record too, and is no run.
            if (l.asText().contains("spectro.local.") && !l.asText().contains(LiveSttProtocol.LOCAL_LOADING)) {
                runLines.add(l.asText());
            }
        });
        assertEquals(2, runLines.size(), "every run is on the record: " + response);
        assertTrue(runLines.stream().allMatch(l -> l.contains("\"durationMs\"")),
                "each with its own wall time: " + runLines);
    }

    @Test
    void aKilledSocketClosesTheLocalSession() throws Exception {
        FakeSocket socket = new FakeSocket("l6", "ws://localhost/ws/stt");
        LiveSttSocketHandler handler = LiveSttSocketHandler.withLocalRoute(() -> localSetup(true), new Hosted(), local);
        handler.afterConnectionEstablished(socket);
        runs.drain();
        handler.handleTextMessage(socket, audio(1.0));

        handler.afterConnectionClosed(socket, CloseStatus.GOING_AWAY);
        ((LocalWhisperUpstream.Session) links.get(0)).tick();

        assertTrue(runs.waiting.isEmpty(), "a closed session runs nothing more");
    }
}
