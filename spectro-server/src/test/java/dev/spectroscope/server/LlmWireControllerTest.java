package dev.spectroscope.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.core.wire.LlmWireRecorder;
import dev.spectroscope.core.wire.LlmWireTap;
import dev.spectroscope.core.wire.LlmWireTap.WireOutcome;
import dev.spectroscope.core.wire.LlmWireTap.WireRequest;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The llm-wire read side (card 184): the sidecar download, the bodiless index
 * and the single-exchange lookup, plus the delete cascade next door. The
 * Gradle test task points {@code user.home} into the build directory, so the
 * recorder and the endpoints share a sidecar folder that never touches the
 * real home. The files are written through the REAL recorder, never faked, so
 * these tests read exactly what a live session leaves behind.
 */
class LlmWireControllerTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private final LlmWireController controller = new LlmWireController();

    private static MockHttpServletRequest local() {
        return new MockHttpServletRequest();
    }

    private static String freshId() {
        return "test-wire-" + UUID.randomUUID().toString().substring(0, 8);
    }

    /**
     * Writes one finished streamed exchange through the real recorder and
     * returns its xid (captured from the metadata listener).
     */
    private static String recordStreamedExchange(String sessionId) {
        AtomicReference<String> xid = new AtomicReference<>();
        try (LlmWireRecorder recorder = LlmWireRecorder.forSession(sessionId)) {
            recorder.onExchange(meta -> xid.set(meta.xid()));
            LlmWireTap tap = recorder.bound("main", 1);
            LlmWireTap.Exchange exchange = tap.begin(new WireRequest(
                    "anthropic", "claude-sonnet-5", "http", "POST",
                    "https://api.anthropic.com/v1/messages",
                    Map.of("x-api-key", "sk-secret", "content-type", "application/json"),
                    "bytes", "{\"model\":\"claude-sonnet-5\"}", 1000L));
            exchange.line("data: {\"type\":\"message_start\"}");
            exchange.line("data: {\"type\":\"message_stop\"}");
            exchange.end(new WireOutcome(200, "bytes", null, false, null, 1600L));
        }
        return xid.get();
    }

    /** Writes one request that never got its response (crash mid-stream shape). */
    private static void recordUnansweredRequest(String sessionId) {
        try (LlmWireRecorder recorder = LlmWireRecorder.forSession(sessionId)) {
            recorder.bound("main", 2).begin(new WireRequest(
                    "anthropic", "claude-sonnet-5", "http", "POST",
                    "https://api.anthropic.com/v1/messages", null,
                    "bytes", "{\"turn\":2}", 2000L));
        }
    }

    // ---- GET /api/sessions/{id}/llm-wire (the whole sidecar) ---------------

    @Test
    void servesTheSidecarVerbatimAsAnNdjsonDownload() throws Exception {
        String id = freshId();
        recordStreamedExchange(id);

        ResponseEntity<String> res = controller.download(id, local());
        assertEquals(200, res.getStatusCode().value());
        String onDisk = Files.readString(LlmWireRecorder.fileFor(id));
        assertEquals(onDisk, res.getBody(), "the download is the sidecar, byte for byte");
        assertTrue(res.getBody().contains("\"llm_request\""));

        assertEquals(new org.springframework.http.MediaType("application", "x-ndjson",
                java.nio.charset.StandardCharsets.UTF_8), res.getHeaders().getContentType());
        assertEquals("nosniff", res.getHeaders().getFirst("X-Content-Type-Options"));
        String disposition = res.getHeaders().getFirst("Content-Disposition");
        assertNotNull(disposition);
        assertTrue(disposition.contains("attachment"), "a download, never an inline render");
        assertTrue(disposition.contains(id + ".llm.jsonl"), "downloads with its sidecar name");
    }

    @Test
    void answers404WhenTheSidecarIsAbsent() {
        assertEquals(404, controller.download("test-wire-absent00", local())
                .getStatusCode().value());
        assertEquals(404, controller.index("test-wire-absent00", local())
                .getStatusCode().value());
        assertEquals(404, controller.exchange("test-wire-absent00",
                UUID.randomUUID().toString(), local()).getStatusCode().value());
    }

    // ---- GET /api/sessions/{id}/llm-wire/index -----------------------------

    @Test
    void indexPairsTheTwoLinesByXidAndCarriesNoBodies() {
        String id = freshId();
        String answeredXid = recordStreamedExchange(id);
        recordUnansweredRequest(id);

        ResponseEntity<List<Map<String, Object>>> res = controller.index(id, local());
        assertEquals(200, res.getStatusCode().value());
        List<Map<String, Object>> index = res.getBody();
        assertNotNull(index);
        assertEquals(2, index.size(), "one entry per exchange, answered or not");

        Map<String, Object> answered = index.get(0);
        assertEquals(answeredXid, answered.get("xid"));
        assertEquals("main", answered.get("agentId"));
        assertEquals(1, answered.get("turn"));
        assertEquals("chat", answered.get("kind"));
        assertEquals("anthropic", answered.get("provider"));
        assertEquals("claude-sonnet-5", answered.get("model"));
        assertEquals("https://api.anthropic.com/v1/messages", answered.get("url"));
        assertEquals(200, answered.get("status"));
        assertEquals((long) "{\"model\":\"claude-sonnet-5\"}"
                .getBytes(java.nio.charset.StandardCharsets.UTF_8).length,
                answered.get("requestBytes"));
        assertEquals(2, answered.get("responseLines"));
        assertEquals(false, answered.get("aborted"));
        assertEquals("bytes", answered.get("fidelity"));
        assertEquals(600L, answered.get("durationMs"));
        assertEquals(1600L, answered.get("ts"));

        Map<String, Object> unanswered = index.get(1);
        assertEquals(2, unanswered.get("turn"));
        assertNull(unanswered.get("status"), "a request without a response answers status null");
        assertEquals(0, unanswered.get("responseLines"));
        assertEquals(0L, unanswered.get("responseBytes"));
        assertNull(unanswered.get("durationMs"));
        assertEquals(2000L, unanswered.get("ts"), "unanswered entries fall back to the request stamp");

        for (Map<String, Object> entry : index) {
            assertFalse(entry.containsKey("body"), "the index never carries a body");
            assertFalse(entry.containsKey("lines"), "the index never carries stream lines");
            assertFalse(entry.containsKey("headers"), "the index carries metadata only");
        }
    }

    // ---- GET /api/sessions/{id}/llm-wire/exchange/{xid} --------------------

    @Test
    void exchangeServesBothParsedLinesAndNullForAMissingResponse() throws Exception {
        String id = freshId();
        String answeredXid = recordStreamedExchange(id);
        recordUnansweredRequest(id);

        ResponseEntity<Map<String, Object>> res = controller.exchange(id, answeredXid, local());
        assertEquals(200, res.getStatusCode().value());
        Map<String, Object> pair = res.getBody();
        assertNotNull(pair);
        JsonNode request = JSON.valueToTree(pair.get("request"));
        assertEquals("llm_request", request.path("type").asText());
        assertEquals("{\"model\":\"claude-sonnet-5\"}", request.path("body").asText());
        assertEquals("REDACTED(9 chars)", request.path("headers").path("x-api-key").asText(),
                "the sidecar itself already redacted the credential value");
        JsonNode response = JSON.valueToTree(pair.get("response"));
        assertEquals("llm_response", response.path("type").asText());
        assertEquals(2, response.path("lines").size());

        // The unanswered request comes back with an explicit null response.
        String unansweredXid = null;
        for (String line : Files.readAllLines(LlmWireRecorder.fileFor(id))) {
            JsonNode node = JSON.readTree(line);
            if ("llm_request".equals(node.path("type").asText())
                    && !answeredXid.equals(node.path("xid").asText())) {
                unansweredXid = node.path("xid").asText();
            }
        }
        assertNotNull(unansweredXid);
        ResponseEntity<Map<String, Object>> open = controller.exchange(id, unansweredXid, local());
        assertEquals(200, open.getStatusCode().value());
        assertTrue(open.getBody().containsKey("response"));
        assertNull(open.getBody().get("response"));
    }

    @Test
    void exchangeAnswers404ForAnUnknownXid() {
        String id = freshId();
        recordStreamedExchange(id);
        assertEquals(404, controller.exchange(id, UUID.randomUUID().toString(), local())
                .getStatusCode().value());
    }

    // ---- the fences --------------------------------------------------------

    @Test
    void refusesIdsThatAreNotPlainSessionBasenames() {
        // The id lands in a file path; "../.." must never escape the sidecar dir.
        for (String evil : new String[] {"../secrets", "..", "a/b", "a.llm", ".hidden", ""}) {
            assertRefused(controller.download(evil, local()), "download", evil);
            assertRefused(controller.index(evil, local()), "index", evil);
            assertRefused(controller.exchange(evil, UUID.randomUUID().toString(), local()),
                    "exchange", evil);
        }
    }

    @Test
    void refusesXidsThatAreNotUuidShaped() {
        String id = freshId();
        recordStreamedExchange(id);
        for (String evil : new String[] {"../x", "not-a-uuid", "", "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAA?"}) {
            assertRefused(controller.exchange(id, evil, local()), "exchange xid", evil);
        }
    }

    @Test
    void refusesAForeignCaller() {
        String id = freshId();
        recordStreamedExchange(id);
        MockHttpServletRequest rebound = local();
        rebound.setServerName("attacker.example");
        assertEquals(404, controller.download(id, rebound).getStatusCode().value());
        assertEquals(404, controller.index(id, rebound).getStatusCode().value());
        assertEquals(404, controller.exchange(id, UUID.randomUUID().toString(), rebound)
                .getStatusCode().value());
        MockHttpServletRequest remote = local();
        remote.setRemoteAddr("203.0.113.7");
        assertEquals(404, controller.download(id, remote).getStatusCode().value());
    }

    private static void assertRefused(ResponseEntity<?> res, String endpoint, String input) {
        int status = res.getStatusCode().value();
        assertTrue(status == 404 || status == 400,
                endpoint + " must refuse \"" + input + "\", got " + status);
    }

    // ---- the delete cascade ------------------------------------------------

    @Test
    void deletingASessionDeletesItsSidecarWithIt() {
        String id = freshId();
        SessionStore store = new SessionStore(id);
        store.append(new RunEvent.RunStart("r1", "main", null, "hi", null, null, 1L));
        recordStreamedExchange(id);
        Path sidecar = LlmWireRecorder.fileFor(id);
        assertTrue(Files.exists(sidecar));

        assertEquals(204, new SessionsController().deleteSession(id).getStatusCode().value());
        assertTrue(Files.notExists(sidecar), "the sidecar dies with its session");
    }
}
