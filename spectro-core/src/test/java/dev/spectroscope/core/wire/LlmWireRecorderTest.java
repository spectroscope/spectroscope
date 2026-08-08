package dev.spectroscope.core.wire;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.wire.LlmWireTap.WireOutcome;
import dev.spectroscope.core.wire.LlmWireTap.WireRequest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The recorder's honesty contract: what a provider hands in is what the sidecar
 * file carries — bodies verbatim, auth values never, the ledger complete even
 * past the ceiling.
 */
class LlmWireRecorderTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static WireRequest chatRequest(long ts) {
        return new WireRequest("openai", "gpt-5.2", "http", "POST",
                "https://api.openai.com/v1/chat/completions",
                Map.of("Authorization", "Bearer sk-secret-1234567890",
                        "Content-Type", "application/json"),
                "bytes", "{\"model\":\"gpt-5.2\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}",
                ts);
    }

    @Test
    void writesRequestAndResponseLinesPairedByXid(@TempDir Path dir) throws Exception {
        Path file = dir.resolve("s1.llm.jsonl");
        try (LlmWireRecorder recorder = new LlmWireRecorder(file, 1_000_000)) {
            LlmWireTap tap = recorder.bound("main", 3);
            LlmWireTap.Exchange exchange = tap.begin(chatRequest(1000));
            exchange.line("data: {\"choices\":[{\"delta\":{\"content\":\"He\"}}]}");
            exchange.line("data: [DONE]");
            exchange.end(new WireOutcome(200, "bytes", null, false, null, 4200));

            List<String> lines = Files.readAllLines(file);
            assertEquals(2, lines.size());
            JsonNode request = JSON.readTree(lines.get(0));
            JsonNode response = JSON.readTree(lines.get(1));

            assertEquals("llm_request", request.get("type").asText());
            assertEquals("main", request.get("agentId").asText());
            assertEquals(3, request.get("turn").asInt());
            assertEquals("chat", request.get("kind").asText());
            assertEquals("openai", request.get("provider").asText());
            assertEquals("gpt-5.2", request.get("model").asText());
            assertEquals("POST", request.get("method").asText());
            assertEquals("https://api.openai.com/v1/chat/completions", request.get("url").asText());
            assertEquals("bytes", request.get("fidelity").asText());
            // The body rides VERBATIM — this is the whole point of the file.
            assertEquals("{\"model\":\"gpt-5.2\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}",
                    request.get("body").asText());
            assertEquals(1000, request.get("ts").asLong());

            assertEquals("llm_response", response.get("type").asText());
            assertEquals(request.get("xid").asText(), response.get("xid").asText());
            assertEquals(200, response.get("status").asInt());
            assertEquals(2, response.get("lines").size());
            assertEquals("data: [DONE]", response.get("lines").get(1).asText());
            assertEquals(3200, response.get("durationMs").asLong());
            assertEquals(4200, response.get("ts").asLong());
        }
    }

    @Test
    void redactsAuthHeaderValuesButKeepsTheirNames(@TempDir Path dir) throws Exception {
        Path file = dir.resolve("s2.llm.jsonl");
        try (LlmWireRecorder recorder = new LlmWireRecorder(file, 1_000_000)) {
            LlmWireTap.Exchange exchange = recorder.bound("main", 1).begin(new WireRequest(
                    "anthropic", "m", "sdk", "POST", "https://api.anthropic.com/v1/messages",
                    Map.of("x-api-key", "sk-ant-secret", "anthropic-version", "2023-06-01"),
                    "sdk-json", "{}", 1));
            exchange.end(new WireOutcome(200, "bytes", null, false, null, 2));

            JsonNode request = JSON.readTree(Files.readAllLines(file).get(0));
            String redacted = request.get("headers").get("x-api-key").asText();
            assertFalse(redacted.contains("secret"), "auth value must never reach the file");
            assertTrue(redacted.contains("13"), "the redaction names the length: " + redacted);
            assertEquals("2023-06-01", request.get("headers").get("anthropic-version").asText());
        }
    }

    @Test
    void requestLineIsOnDiskBeforeTheResponseEnds(@TempDir Path dir) throws Exception {
        Path file = dir.resolve("s3.llm.jsonl");
        try (LlmWireRecorder recorder = new LlmWireRecorder(file, 1_000_000)) {
            recorder.bound("main", 1).begin(chatRequest(5));
            // No end() yet — a crash mid-stream must still leave the request on record.
            assertEquals(1, Files.readAllLines(file).size());
        }
    }

    @Test
    void ceilingWritesOneTruncationLineAndKeepsTheLedgerWithoutBodies(@TempDir Path dir) throws Exception {
        Path file = dir.resolve("s4.llm.jsonl");
        try (LlmWireRecorder recorder = new LlmWireRecorder(file, 600)) {
            LlmWireTap tap = recorder.bound("main", 1);
            LlmWireTap.Exchange first = tap.begin(new WireRequest("openai", "m", "http",
                    "POST", "http://x/v1/chat/completions", Map.of(), "bytes",
                    "A".repeat(700), 1));
            first.line("data: hello");
            first.end(new WireOutcome(200, "bytes", null, false, null, 2));
            LlmWireTap.Exchange second = tap.begin(new WireRequest("openai", "m", "http",
                    "POST", "http://x/v1/chat/completions", Map.of(), "bytes", "small", 3));
            second.end(new WireOutcome(200, "bytes", null, false, null, 4));

            List<String> lines = Files.readAllLines(file);
            // The ceiling marker lands FIRST — written the moment the ceiling was
            // hit, before the line whose body it dropped.
            JsonNode firstRequest = JSON.readTree(lines.stream()
                    .filter(l -> l.contains("\"llm_request\"")).findFirst().orElseThrow());
            // The first oversized body is dropped, honestly labeled, its size kept.
            assertNull(firstRequest.get("body"));
            assertEquals("ceiling", firstRequest.get("omitted").asText());
            assertEquals(700, firstRequest.get("bodyBytes").asLong());
            // Exactly one truncation marker, written when the ceiling was first hit.
            long markers = lines.stream().filter(l -> l.contains("\"llm_wire_truncated\"")).count();
            assertEquals(1, markers);
            // The ledger stays complete: every exchange still has its two lines.
            long requests = lines.stream().filter(l -> l.contains("\"llm_request\"")).count();
            long responses = lines.stream().filter(l -> l.contains("\"llm_response\"")).count();
            assertEquals(2, requests);
            assertEquals(2, responses);
            // LATCHING: once past the ceiling, even a small later body is
            // dropped — the marker means "bodies stop here", not "this one".
            JsonNode secondRequest = JSON.readTree(lines.stream()
                    .filter(l -> l.contains("\"llm_request\"")).skip(1).findFirst().orElseThrow());
            assertNull(secondRequest.get("body"));
            assertEquals("ceiling", secondRequest.get("omitted").asText());
        }
    }

    @Test
    void aClosedRecorderDropsLateLinesInsteadOfResurrectingTheFile(@TempDir Path dir) throws Exception {
        Path file = dir.resolve("s10.llm.jsonl");
        LlmWireRecorder recorder = new LlmWireRecorder(file, 1_000_000);
        LlmWireTap.Exchange exchange = recorder.bound("main", 1).begin(chatRequest(1));
        recorder.close();
        Files.deleteIfExists(file); // the user deleted the session mid-run
        exchange.end(new WireOutcome(200, "bytes", null, true, "tab closed", 2));
        // A late end() after close() must not recreate the file the user removed.
        assertFalse(Files.exists(file));
    }

    @Test
    void anExistingFileCountsTowardTheCeiling(@TempDir Path dir) throws Exception {
        Path file = dir.resolve("s11.llm.jsonl");
        Files.writeString(file, "x".repeat(500) + "\n");
        try (LlmWireRecorder recorder = new LlmWireRecorder(file, 600)) {
            // A resumed session (or the shared stt day file) must not get a
            // fresh allowance per recorder instance.
            LlmWireTap.Exchange exchange = recorder.bound("main", 1).begin(new WireRequest(
                    "openai", "m", "http", "POST", "http://x", Map.of(), "bytes",
                    "B".repeat(200), 1));
            exchange.end(new WireOutcome(200, "bytes", null, false, null, 2));
            List<String> lines = Files.readAllLines(file);
            JsonNode request = JSON.readTree(lines.stream()
                    .filter(l -> l.contains("\"llm_request\"")).findFirst().orElseThrow());
            assertNull(request.get("body"));
            assertEquals("ceiling", request.get("omitted").asText());
            assertEquals(1, lines.stream().filter(l -> l.contains("\"llm_wire_truncated\"")).count());
        }
    }

    @Test
    void aFileAlreadyPastTheCeilingGetsNoSecondMarker(@TempDir Path dir) throws Exception {
        Path file = dir.resolve("s12.llm.jsonl");
        Files.writeString(file, "y".repeat(700) + "\n"); // the crossing instance wrote its marker
        try (LlmWireRecorder recorder = new LlmWireRecorder(file, 600)) {
            LlmWireTap.Exchange exchange = recorder.bound("main", 1).begin(new WireRequest(
                    "openai", "m", "http", "POST", "http://x", Map.of(), "bytes", "small", 1));
            exchange.end(new WireOutcome(200, "bytes", null, false, null, 2));
            long markers = Files.readAllLines(file).stream()
                    .filter(l -> l.contains("\"llm_wire_truncated\"")).count();
            assertEquals(0, markers, "the marker belongs to the instance that crossed");
        }
    }

    @Test
    void interleavedExchangesFromTwoAgentsStayPairedByXid(@TempDir Path dir) throws Exception {
        Path file = dir.resolve("s5.llm.jsonl");
        try (LlmWireRecorder recorder = new LlmWireRecorder(file, 1_000_000)) {
            LlmWireTap.Exchange a = recorder.bound("main", 1).begin(chatRequest(1));
            LlmWireTap.Exchange b = recorder.bound("researcher", 1).begin(chatRequest(2));
            b.end(new WireOutcome(200, "bytes", null, false, null, 3));
            a.end(new WireOutcome(200, "bytes", null, false, null, 4));

            List<String> lines = Files.readAllLines(file);
            assertEquals(4, lines.size());
            JsonNode requestA = JSON.readTree(lines.get(0));
            JsonNode requestB = JSON.readTree(lines.get(1));
            JsonNode responseB = JSON.readTree(lines.get(2));
            JsonNode responseA = JSON.readTree(lines.get(3));
            assertNotEquals(requestA.get("xid").asText(), requestB.get("xid").asText());
            assertEquals(requestB.get("xid").asText(), responseB.get("xid").asText());
            assertEquals(requestA.get("xid").asText(), responseA.get("xid").asText());
            assertEquals("researcher", responseB.get("agentId").asText());
        }
    }

    @Test
    void abortedExchangeKeepsThePartialLinesAndSaysSo(@TempDir Path dir) throws Exception {
        Path file = dir.resolve("s6.llm.jsonl");
        try (LlmWireRecorder recorder = new LlmWireRecorder(file, 1_000_000)) {
            LlmWireTap.Exchange exchange = recorder.bound("main", 2).begin(chatRequest(1));
            exchange.line("data: {\"choices\":[{\"delta\":{\"content\":\"par\"}}]}");
            exchange.end(new WireOutcome(200, "bytes", null, true, "stream aborted", 9));

            JsonNode response = JSON.readTree(Files.readAllLines(file).get(1));
            assertTrue(response.get("aborted").asBoolean());
            assertEquals("stream aborted", response.get("error").asText());
            assertEquals(1, response.get("lines").size());
        }
    }

    @Test
    void listenerSeesTheFinishedExchangeMetadata(@TempDir Path dir) throws Exception {
        Path file = dir.resolve("s7.llm.jsonl");
        try (LlmWireRecorder recorder = new LlmWireRecorder(file, 1_000_000)) {
            AtomicReference<LlmWireRecorder.ExchangeMeta> seen = new AtomicReference<>();
            recorder.onExchange(seen::set);
            LlmWireTap.Exchange exchange = recorder.bound("main", 5).begin(chatRequest(1000));
            exchange.line("data: x");
            exchange.end(new WireOutcome(200, "bytes", null, false, null, 1500));

            LlmWireRecorder.ExchangeMeta meta = seen.get();
            assertEquals("main", meta.agentId());
            assertEquals(5, meta.turn());
            assertEquals("openai", meta.provider());
            assertEquals(200, meta.status());
            assertEquals(500, meta.durationMs());
            assertTrue(meta.requestBytes() > 0);
            assertEquals(1, meta.responseLines());
        }
    }

    @Test
    void noFileUntilTheFirstExchange(@TempDir Path dir) throws Exception {
        Path file = dir.resolve("s8.llm.jsonl");
        try (LlmWireRecorder recorder = new LlmWireRecorder(file, 1_000_000)) {
            assertFalse(Files.exists(file));
            recorder.bound("main", 1).begin(chatRequest(1));
            assertTrue(Files.exists(file));
        }
    }

    @Test
    void singleBodyResponseRidesVerbatim(@TempDir Path dir) throws Exception {
        Path file = dir.resolve("s9.llm.jsonl");
        try (LlmWireRecorder recorder = new LlmWireRecorder(file, 1_000_000)) {
            LlmWireTap.Exchange exchange = recorder.bound("main", 1, "image").begin(new WireRequest(
                    "openai", "gpt-image-2", "http", "POST",
                    "https://api.openai.com/v1/images/generations", Map.of(), "bytes",
                    "{\"prompt\":\"a cat on a beach\"}", 1));
            exchange.end(new WireOutcome(200, "bytes",
                    "{\"data\":[{\"b64_json\":\"aGVsbG8=\"}]}", false, null, 2));

            JsonNode response = JSON.readTree(Files.readAllLines(file).get(1));
            assertEquals("{\"data\":[{\"b64_json\":\"aGVsbG8=\"}]}", response.get("body").asText());
            assertNull(response.get("lines"));
        }
    }

    /**
     * Leg 2 (card 184). The socket used to hear about an exchange exactly once,
     * at close, so a request in flight was invisible and the finished row landed
     * AFTER its own text deltas. Measured on a real turn: the POST left at
     * 48.291, the first token arrived at 50.035, the stream closed at 50.138 —
     * and only the last of those reached the screen, so the trace showed the
     * answer above the request.
     */
    @Test
    void tellsTheSocketAboutARequestTheMOMENTItLeaves(@TempDir Path dir) throws Exception {
        java.util.List<LlmWireRecorder.RequestMeta> sent = new java.util.ArrayList<>();
        java.util.List<LlmWireRecorder.ExchangeMeta> closed = new java.util.ArrayList<>();
        try (LlmWireRecorder recorder = new LlmWireRecorder(dir.resolve("s1.llm.jsonl"), 1_000_000)) {
            recorder.onRequest(sent::add);
            recorder.onExchange(closed::add);

            LlmWireTap.Exchange exchange = recorder.bound("main", 1).begin(
                    new WireRequest("anthropic", "claude-opus-4-8", "https", "POST",
                            "https://api.anthropic.com/v1/messages", Map.of(), "bytes", "{\"a\":1}", 100L));

            // The point: the listener has already fired, and nothing has answered.
            assertEquals(1, sent.size(), "the request is announced before any answer exists");
            assertEquals(0, closed.size(), "and the close listener has not run");
            assertEquals(100L, sent.get(0).ts(), "stamped when it LEFT, not when it closed");
            assertEquals("https://api.anthropic.com/v1/messages", sent.get(0).url());
            assertEquals(7L, sent.get(0).requestBytes(), "the size it really posted: {\"a\":1} is seven bytes");

            exchange.end(new WireOutcome(200, "bytes", "{}", false, null, 1947L));
        }
        assertEquals(1, closed.size(), "the close still announces itself exactly once");
        assertEquals(sent.get(0).xid(), closed.get(0).xid(), "and the pair carries ONE id");
        assertEquals(1847L, closed.get(0).durationMs(), "close minus send, from the record itself");
    }

    /** A recorder nobody listens to must not care. */
    @Test
    void recordsJustAsWellWithNoSendListenerAtAll(@TempDir Path dir) throws Exception {
        Path file = dir.resolve("s2.llm.jsonl");
        try (LlmWireRecorder recorder = new LlmWireRecorder(file, 1_000_000)) {
            recorder.bound("main", 1).begin(
                    new WireRequest("ollama", "qwen3.5", "http", "POST",
                            "http://localhost:11434/api/chat", Map.of(), "bytes", "{}", 1L))
                    .end(new WireOutcome(200, "bytes", "{}", false, null, 2L));
        }
        assertTrue(Files.readString(file).contains("llm_request"));
    }
}
