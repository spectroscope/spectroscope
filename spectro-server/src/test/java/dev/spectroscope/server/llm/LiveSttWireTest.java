package dev.spectroscope.server.llm;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.wire.LlmWireRecorder;
import dev.spectroscope.server.session.FakeSocket;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.web.socket.CloseStatus;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 184 applied to the live route: a stream of guesses is a stream of model
 * outputs, and it belongs on the record — as guesses.
 *
 * <p>The batch route already records the spoken bytes and the transcript. A live
 * session is a different animal: one socket, one handshake, and then dozens of
 * partials before the answer. What must never happen is a record that reads as
 * though the model said the partial, which is the one dishonesty this card set
 * exists to remove.</p>
 */
class LiveSttWireTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** An upstream that records what it was told and replays what a test wants. */
    private static final class FakeUpstream implements LiveSttUpstream {
        final List<String> sent = new ArrayList<>();
        Listener listener;

        @Override
        public Link open(Listener listener) {
            this.listener = listener;
            return new Link() {
                @Override
                public void send(String frame) {
                    sent.add(frame);
                }

                @Override
                public void close() {
                    // nothing to release in a fake
                }
            };
        }

        void says(String raw) {
            listener.onFrame(raw);
        }
    }

    private LiveSttSocketHandler handler(FakeUpstream upstream, LlmWireRecorder recorder,
            SttRoute route, String key) {
        return new LiveSttSocketHandler(
                () -> new LiveSttSocketHandler.Setup(route, key, LiveSttProtocol.DEFAULT_MODEL),
                upstream, () -> recorder);
    }

    /** Every line in the wire file, parsed. */
    private List<JsonNode> linesOf(Path file) throws IOException {
        if (!Files.exists(file)) {
            return List.of();
        }
        List<JsonNode> out = new ArrayList<>();
        for (String raw : Files.readAllLines(file)) {
            if (!raw.isBlank()) {
                out.add(JSON.readTree(raw));
            }
        }
        return out;
    }

    @Test
    void theRequestIsOnRecordBeforeAnyoneHasSpoken(@TempDir Path dir) throws Exception {
        // The tap persists a request immediately for a reason: a crash mid-stream
        // must still leave evidence that a call went out. A live session is the
        // case that reason was written for — it can stay open for minutes.
        Path wireFile = dir.resolve("stt.llm.jsonl");
        FakeUpstream upstream = new FakeUpstream();
        try (LlmWireRecorder recorder = new LlmWireRecorder(wireFile, 1_000_000)) {
            handler(upstream, recorder, SttRoute.HOSTED, "sk-real")
                    .afterConnectionEstablished(new FakeSocket("w1", "ws://localhost/ws/stt"));
        }

        List<JsonNode> lines = linesOf(wireFile);
        assertEquals(1, lines.size(), "the request, and nothing that has not happened yet");
        JsonNode request = lines.get(0);
        assertEquals("llm_request", request.path("type").asText());
        assertEquals("openai", request.path("provider").asText());
        assertEquals(LiveSttProtocol.DEFAULT_MODEL, request.path("model").asText());
        assertEquals("websocket", request.path("transport").asText());
        assertEquals(LiveSttProtocol.URL, request.path("url").asText());
        assertTrue(request.path("body").asText().contains("session.update"),
                "the handshake is what actually went over the socket first");
    }

    @Test
    void everyPartialIsOnRecord_asAPartial(@TempDir Path dir) throws Exception {
        Path wireFile = dir.resolve("stt.llm.jsonl");
        FakeUpstream upstream = new FakeUpstream();
        try (LlmWireRecorder recorder = new LlmWireRecorder(wireFile, 1_000_000)) {
            LiveSttSocketHandler handler = handler(upstream, recorder, SttRoute.HOSTED, "sk-real");
            FakeSocket socket = new FakeSocket("w2", "ws://localhost/ws/stt");
            handler.afterConnectionEstablished(socket);
            upstream.says("{\"type\":\"session.updated\"}");
            upstream.says("{\"type\":\"conversation.item.input_audio_transcription.delta\","
                    + "\"delta\":\" Hello\"}");
            upstream.says("{\"type\":\"conversation.item.input_audio_transcription.completed\","
                    + "\"transcript\":\"Hello there.\"}");
            handler.afterConnectionClosed(socket, CloseStatus.NORMAL);
        }

        JsonNode response = linesOf(wireFile).stream()
                .filter(l -> l.path("type").asText().equals("llm_response"))
                .findFirst().orElseThrow();
        List<String> recorded = new ArrayList<>();
        response.path("lines").forEach(l -> recorded.add(l.asText()));

        assertEquals(3, recorded.size(), "every frame the provider sent, in order");
        // The decisive property: a reader can tell a guess from the answer,
        // because the provider's OWN type rides along untouched. Nothing here
        // flattens a delta into "the transcript".
        assertTrue(recorded.get(1).contains("input_audio_transcription.delta"), recorded.get(1));
        assertTrue(recorded.get(1).contains("Hello"), recorded.get(1));
        assertTrue(recorded.get(2).contains("input_audio_transcription.completed"),
                recorded.get(2));
        assertFalse(recorded.get(1).contains("completed"),
                "a partial must never be recorded wearing the answer's label");
    }

    @Test
    void aClosedBrowserSocketLeavesNoDanglingRequest(@TempDir Path dir) throws Exception {
        // A request line with no response beside it reads as a call that never
        // came back — which is a real failure mode, so it must not be what an
        // ordinary "the user stopped talking and closed the tab" looks like.
        Path wireFile = dir.resolve("stt.llm.jsonl");
        FakeUpstream upstream = new FakeUpstream();
        try (LlmWireRecorder recorder = new LlmWireRecorder(wireFile, 1_000_000)) {
            LiveSttSocketHandler handler = handler(upstream, recorder, SttRoute.HOSTED, "sk-real");
            FakeSocket socket = new FakeSocket("w3", "ws://localhost/ws/stt");
            handler.afterConnectionEstablished(socket);
            handler.afterConnectionClosed(socket, CloseStatus.NORMAL);
        }

        List<JsonNode> lines = linesOf(wireFile);
        assertEquals(2, lines.size());
        assertEquals("llm_response", lines.get(1).path("type").asText());
        assertEquals(200, lines.get(1).path("status").asInt());
    }

    @Test
    void anUpstreamRefusalIsRecordedAsAFailure(@TempDir Path dir) throws Exception {
        Path wireFile = dir.resolve("stt.llm.jsonl");
        FakeUpstream upstream = new FakeUpstream();
        try (LlmWireRecorder recorder = new LlmWireRecorder(wireFile, 1_000_000)) {
            LiveSttSocketHandler handler = handler(upstream, recorder, SttRoute.HOSTED, "sk-real");
            FakeSocket socket = new FakeSocket("w4", "ws://localhost/ws/stt");
            handler.afterConnectionEstablished(socket);
            upstream.says("{\"type\":\"error\",\"error\":{\"message\":\"rate limit reached\"}}");
            handler.afterConnectionClosed(socket, CloseStatus.NORMAL);
        }

        JsonNode response = linesOf(wireFile).stream()
                .filter(l -> l.path("type").asText().equals("llm_response"))
                .findFirst().orElseThrow();
        assertTrue(response.path("error").asText().contains("rate limit reached"));
        assertFalse(response.path("status").asInt(0) == 200,
                "a refused session that records a 200 is the record lying");
    }

    @Test
    void aRefusedRouteRecordsNothingAtAll(@TempDir Path dir) throws Exception {
        // No model was called and no audio left, so a record would be a claim
        // about a call that never happened — the same rule the batch path
        // follows for a body no model could read.
        Path wireFile = dir.resolve("stt.llm.jsonl");
        FakeUpstream upstream = new FakeUpstream();
        try (LlmWireRecorder recorder = new LlmWireRecorder(wireFile, 1_000_000)) {
            handler(upstream, recorder, SttRoute.LOCAL, "sk-real")
                    .afterConnectionEstablished(new FakeSocket("w5", "ws://localhost/ws/stt"));
        }
        assertTrue(linesOf(wireFile).isEmpty(), "nothing happened, so nothing is on record");
    }

    @Test
    void theRecordedRequestSizeIsTheHandshakeAndNotTheSpokenAudio(@TempDir Path dir)
            throws Exception {
        // ⚠️ The one honest asymmetry between the two routes, pinned so nobody
        // reads it as a measurement of how much was said. On the batch route
        // requestBytes IS the audio (base64). Here it is the handshake, because
        // a websocket has no single request body and the appends flow after it.
        // Whoever compares the two files must not conclude that live sessions
        // are tiny.
        Path wireFile = dir.resolve("stt.llm.jsonl");
        FakeUpstream upstream = new FakeUpstream();
        try (LlmWireRecorder recorder = new LlmWireRecorder(wireFile, 1_000_000)) {
            LiveSttSocketHandler handler = handler(upstream, recorder, SttRoute.HOSTED, "sk-real");
            FakeSocket socket = new FakeSocket("w6", "ws://localhost/ws/stt");
            handler.afterConnectionEstablished(socket);
            upstream.says("{\"type\":\"session.updated\"}");
            handler.handleTextMessage(socket, new org.springframework.web.socket.TextMessage(
                    "{\"type\":\"audio\",\"data\":\"" + "A".repeat(4_000) + "\"}"));
            handler.afterConnectionClosed(socket, CloseStatus.NORMAL);
        }

        JsonNode request = linesOf(wireFile).get(0);
        long recorded = request.path("bodyBytes").asLong();
        assertTrue(recorded < 500,
                "the handshake is a few hundred bytes; " + recorded + " means audio crept in");
        assertFalse(request.path("body").asText().contains("AAAA"),
                "the spoken bytes are NOT on this record — see the javadoc, this is deliberate");
    }

    @Test
    void theBrowserIsToldWhereItsOwnRecordIs(@TempDir Path dir) throws Exception {
        // The batch route answers with a `wire` object because voice happens
        // before any session exists and there is no socket to mirror it onto.
        // Here there IS a socket, so the record announces itself on it.
        Path wireFile = dir.resolve("stt.llm.jsonl");
        FakeUpstream upstream = new FakeUpstream();
        FakeSocket socket = new FakeSocket("w7", "ws://localhost/ws/stt");
        try (LlmWireRecorder recorder = new LlmWireRecorder(wireFile, 1_000_000)) {
            LiveSttSocketHandler handler = handler(upstream, recorder, SttRoute.HOSTED, "sk-real");
            handler.afterConnectionEstablished(socket);
            upstream.says("{\"type\":\"session.updated\"}");
            handler.afterConnectionClosed(socket, CloseStatus.NORMAL);
        }

        String down = socket.textJoined();
        assertTrue(down.contains("\"type\":\"wire\""), down);
        JsonNode wire = JSON.readTree(down.lines()
                .filter(t -> t.contains("\"type\":\"wire\"")).findFirst().orElseThrow());
        assertNotNull(wire.path("xid").asText(null), "a record nobody can look up is no record");
        assertEquals("websocket", wire.path("transport").asText());
    }
}
