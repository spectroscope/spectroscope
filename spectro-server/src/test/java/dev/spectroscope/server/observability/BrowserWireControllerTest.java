package dev.spectroscope.server.observability;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.core.wire.BrowserWireRecorder;
import dev.spectroscope.core.wire.BrowserWireTap;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;
import dev.spectroscope.server.session.SessionsController;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The browser-wire read side (card 204): the sidecar download, the bodiless
 * index and the single-action lookup — gated, loopback-fenced, per session.
 *
 * <p>The Gradle test task points {@code user.home} into the build directory, so
 * the recorder and the endpoints share a sidecar folder that never touches the
 * real home. The files are written through the REAL recorder, never faked, so
 * these tests read exactly what a live session leaves behind.
 */
class BrowserWireControllerTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private final BrowserWireController controller = new BrowserWireController();

    private static MockHttpServletRequest local() {
        return new MockHttpServletRequest();
    }

    private static String freshId() {
        return "test-browser-" + UUID.randomUUID().toString().substring(0, 8);
    }

    private static ObjectNode args(Map<String, String> fields) {
        ObjectNode node = JSON.createObjectNode();
        fields.forEach(node::put);
        return node;
    }

    /** Drives one recorded browser run and hands back its two call ids. */
    private static List<String> recordARun(String sessionId, String host) {
        try (BrowserWireRecorder recorder = BrowserWireRecorder.forSession(sessionId)) {
            BrowserWireTap.Call navigate = recorder.open("browser_navigate", "main", "toolu_1",
                    args(Map.of("url", host)), null);
            navigate.end(true, "Opened " + host + ". The pane is showing it now.", host);
            BrowserWireTap.Call shot = recorder.open("browser_computer", "main", "toolu_2",
                    args(Map.of("action", "screenshot")), host);
            shot.image("image/png", "images/deadbeef.png", "deadbeef", 1100, 760, 11034);
            shot.end(true, "Screenshot of " + host + " — attached for you to see.", host);
            return List.of(navigate.cid(), shot.cid());
        }
    }

    // ---- GET /api/sessions/{id}/browser-wire ------------------------------- //

    @Test
    void servesTheSidecarVerbatimAsAnNdjsonDownload() throws Exception {
        String id = freshId();
        recordARun(id, "https://example.com");

        ResponseEntity<String> res = controller.download(id, local());
        assertEquals(200, res.getStatusCode().value());
        assertEquals(Files.readString(BrowserWireRecorder.fileFor(id)), res.getBody(),
                "the download is the sidecar, byte for byte");
        assertEquals(new org.springframework.http.MediaType("application", "x-ndjson",
                StandardCharsets.UTF_8), res.getHeaders().getContentType());
        assertEquals("nosniff", res.getHeaders().getFirst("X-Content-Type-Options"));
        String disposition = res.getHeaders().getFirst("Content-Disposition");
        assertNotNull(disposition);
        assertTrue(disposition.contains("attachment"), "a download, never an inline render");
        assertTrue(disposition.contains(id + ".browser.jsonl"));
    }

    @Test
    void theIndexIsTheLedgerAndCarriesNoArgumentsOrResults() {
        String id = freshId();
        List<String> cids = recordARun(id, "https://example.com");

        ResponseEntity<List<Map<String, Object>>> res = controller.index(id, local());
        assertEquals(200, res.getStatusCode().value());
        List<Map<String, Object>> rows = res.getBody();
        assertNotNull(rows);
        assertEquals(2, rows.size());
        assertEquals(cids.get(0), rows.get(0).get("cid"));
        assertEquals("browser_navigate", rows.get(0).get("tool"));
        assertEquals(1, rows.get(0).get("epoch"));
        assertEquals(true, rows.get(0).get("ok"));
        assertEquals("https://example.com", rows.get(0).get("pageUrl"));
        // The screenshot row names its blob, which is how the replay view knows
        // there is a picture to load without reading a single argument.
        assertEquals("images/deadbeef.png", rows.get(1).get("blobPath"));
        assertEquals("deadbeef", rows.get(1).get("sha256"));

        String asJson = String.valueOf(rows);
        assertFalse(asJson.contains("Opened https://example.com"),
                "the ledger is bodiless: one sidecar can be far bigger than the session");
        assertFalse(asJson.contains("attached for you to see"));
        // Both halves, named: neither the arguments the model wrote nor the text
        // it read back may ride the ledger. The first version of this check named
        // only result text, and a leak of the INPUT would have passed it.
        assertFalse(rows.stream().anyMatch(r -> r.containsKey("input")),
                "the arguments stay behind the drill-in");
        assertFalse(rows.stream().anyMatch(r -> r.containsKey("result")),
                "and so does the result text");
    }

    @Test
    void oneActionServesItsTwoRecordedLines() {
        String id = freshId();
        List<String> cids = recordARun(id, "https://example.com");

        ResponseEntity<Map<String, Object>> res = controller.action(id, cids.get(0), local());
        assertEquals(200, res.getStatusCode().value());
        Map<String, Object> pair = res.getBody();
        assertNotNull(pair);
        JsonNode call = (JsonNode) pair.get("call");
        JsonNode result = (JsonNode) pair.get("result");
        assertEquals("browser_navigate", call.path("tool").asText());
        assertEquals("https://example.com", call.path("input").path("url").asText());
        assertTrue(result.path("result").asText().startsWith("Opened https://example.com"));
    }

    @Test
    void aCallStillWaitingForItsOutcomeServesWithANullResult() {
        String id = freshId();
        String cid;
        try (BrowserWireRecorder recorder = BrowserWireRecorder.forSession(id)) {
            cid = recorder.open("browser_navigate", "main", "toolu_1",
                    args(Map.of("url", "https://slow.example")), null).cid();
        }
        Map<String, Object> pair = controller.action(id, cid, local()).getBody();
        assertNotNull(pair);
        assertNotNull(pair.get("call"));
        assertEquals(null, pair.get("result"), "an open call has no outcome to invent");
    }

    // ---- the epochs -------------------------------------------------------- //

    @Test
    void theIndexKeepsTwoBrowsersApart() {
        // Criterion of card 218 read through card 204: a session that had two
        // browsers must not produce a trace that pretends they were one.
        String id = freshId();
        recordARun(id, "https://one.example");
        recordARun(id, "https://two.example");

        List<Map<String, Object>> rows = controller.index(id, local()).getBody();
        assertNotNull(rows);
        assertEquals(4, rows.size());
        assertEquals(List.of(1, 1, 2, 2), rows.stream().map(r -> r.get("epoch")).toList());
    }

    // ---- the fences -------------------------------------------------------- //

    @Test
    void refusesAForeignSessionId() throws Exception {
        // The one the card asks to be PROVEN rather than asserted. Two shapes of
        // "foreign": an id that is not this machine's session at all, and an id
        // crafted to reach a file that IS there but belongs to somebody else.
        String mine = freshId();
        String yours = freshId();
        recordARun(mine, "https://mine.example");
        recordARun(yours, "https://yours.example");

        // 1. Another session's id serves that session's OWN record and never
        //    mine — one file per id, no crossing.
        String served = controller.download(yours, local()).getBody();
        assertNotNull(served);
        assertTrue(served.contains("https://yours.example"));
        assertFalse(served.contains("https://mine.example"));

        // 2. An id nothing on this machine ever minted is refused outright.
        assertEquals(404, controller.download("test-browser-nobody", local())
                .getStatusCode().value());
        assertEquals(404, controller.index("test-browser-nobody", local())
                .getStatusCode().value());
        assertEquals(404, controller.action("test-browser-nobody",
                UUID.randomUUID().toString(), local()).getStatusCode().value());

        // 3. The real attack: an id shaped to climb out of the browser-wire
        //    folder into the llm-wire one, where the FULL prompts live. Without
        //    the shape check this reads a neighbour's provider traffic.
        Path victim = Path.of(System.getProperty("user.home"), ".spectro", "llm-wire",
                "test-victim.llm.jsonl");
        Files.createDirectories(victim.getParent());
        Files.writeString(victim, "{\"type\":\"llm_request\",\"body\":\"THE-SECRET-PROMPT\"}\n");
        for (String climb : new String[] {
            "../llm-wire/test-victim", "../../.spectro/llm-wire/test-victim",
            "..", "a/b", "a.llm", ".hidden", "", "test-victim.llm"}) {
            assertRefused(controller.download(climb, local()), "download", climb);
            assertRefused(controller.index(climb, local()), "index", climb);
            assertRefused(controller.action(climb, UUID.randomUUID().toString(), local()),
                    "action", climb);
        }
        // And nothing anywhere served the victim's bytes.
        assertFalse(String.valueOf(controller.download("../llm-wire/test-victim", local())
                .getBody()).contains("THE-SECRET-PROMPT"));
    }

    @Test
    void refusesAForeignCaller() {
        String id = freshId();
        recordARun(id, "https://example.com");

        MockHttpServletRequest rebound = local();
        rebound.setServerName("attacker.example");
        assertEquals(404, controller.download(id, rebound).getStatusCode().value());
        assertEquals(404, controller.index(id, rebound).getStatusCode().value());

        MockHttpServletRequest remote = local();
        remote.setRemoteAddr("203.0.113.7");
        assertEquals(404, controller.download(id, remote).getStatusCode().value());
        assertEquals(404, controller.index(id, remote).getStatusCode().value());

        // The CSRF half: a browser tab on evil.example calling loopback.
        MockHttpServletRequest crossSite = local();
        crossSite.addHeader("Origin", "https://evil.example");
        assertEquals(404, controller.download(id, crossSite).getStatusCode().value());
        assertEquals(404, controller.index(id, crossSite).getStatusCode().value());
        assertEquals(404, controller.action(id, UUID.randomUUID().toString(), crossSite)
                .getStatusCode().value());
    }

    @Test
    void refusesCidsThatAreNotUuidShapedAndSaysSoDifferently() {
        // The first version of this test asserted 404-or-400 and was green with
        // the shape check REMOVED: a bogus cid matches no line, so the scan
        // 404s on its own. A check no test can tell the absence of is not a
        // check. So the two facts are now told apart — 400 "you asked wrong",
        // 404 "nothing here" — which is both honest and measurable.
        String id = freshId();
        List<String> cids = recordARun(id, "https://example.com");
        for (String evil : new String[] {"../x", "not-a-uuid", "",
            "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAA?", "DEADBEEF-DEAD-BEEF-DEAD-BEEFDEADBEEF"}) {
            assertEquals(400, controller.action(id, evil, local()).getStatusCode().value(),
                    "a malformed cid is a bad request, refused before the file is opened: " + evil);
        }
        // Well-shaped and unknown is the other fact, and it must not answer 400.
        assertEquals(404, controller.action(id, UUID.randomUUID().toString(), local())
                .getStatusCode().value());
        assertEquals(200, controller.action(id, cids.get(0), local()).getStatusCode().value());
    }

    private static void assertRefused(ResponseEntity<?> res, String endpoint, String input) {
        int status = res.getStatusCode().value();
        assertTrue(status == 404 || status == 400,
                endpoint + " must refuse \"" + input + "\", got " + status);
    }

    // ---- the delete cascade ------------------------------------------------ //

    @Test
    void deletingASessionDeletesItsBrowserRecordWithIt() {
        // The browser record holds every address the agent visited. A session a
        // reader deleted must not leave that behind — the llm-wire's own cascade,
        // extended to the fourth file of the family.
        String id = freshId();
        SessionStore store = new SessionStore(id);
        store.append(new RunEvent.RunStart("r1", "main", null, "hi", null, null, 1L));
        recordARun(id, "https://example.com");
        Path sidecar = BrowserWireRecorder.fileFor(id);
        assertTrue(Files.exists(sidecar));

        assertEquals(204, new SessionsController().deleteSession(id).getStatusCode().value());
        assertTrue(Files.notExists(sidecar), "the browser record dies with its session");
    }

    @Test
    void anOrphanedBrowserRecordIsStillDeletable() {
        // Same argument card 184's review made for the stt day files: the cascade
        // is "delete whatever this id left behind", so a record without a session
        // must not answer 404 and stay on disk forever.
        String id = freshId();
        recordARun(id, "https://example.com");
        Path sidecar = BrowserWireRecorder.fileFor(id);
        assertTrue(Files.exists(sidecar));

        assertEquals(204, new SessionsController().deleteSession(id).getStatusCode().value());
        assertTrue(Files.notExists(sidecar));
    }
}
