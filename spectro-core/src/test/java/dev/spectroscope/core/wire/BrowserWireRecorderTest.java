package dev.spectroscope.core.wire;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The browser recorder's honesty contract (card 204): what the MODEL saw is
 * what the sidecar carries, screenshots by reference, two browsers in one
 * session never pretending to be one.
 */
class BrowserWireRecorderTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static ObjectNode input(String field, String value) {
        return JSON.createObjectNode().put(field, value);
    }

    private static List<JsonNode> lines(Path file) throws Exception {
        List<JsonNode> out = new ArrayList<>();
        for (String line : Files.readAllLines(file)) {
            out.add(JSON.readTree(line));
        }
        return out;
    }

    private static JsonNode only(List<JsonNode> lines, String type) {
        return lines.stream().filter(l -> type.equals(l.path("type").asText()))
                .findFirst().orElseThrow(() -> new AssertionError("no " + type + " line"));
    }

    @Test
    void oneCallWritesTwoLinesPairedByCid(@TempDir Path dir) throws Exception {
        Path file = dir.resolve("s.browser.jsonl");
        try (BrowserWireRecorder recorder = new BrowserWireRecorder(file, 1 << 20)) {
            BrowserWireTap.Call call = recorder.open("browser_navigate", "main", "toolu_1",
                    input("url", "https://example.com"), null);
            call.end(true, "Opened https://example.com — \"Example\". The pane is showing it now.",
                    "https://example.com");
        }

        List<JsonNode> lines = lines(file);
        assertEquals(3, lines.size(), "an open marker plus the call's two lines");
        assertEquals("browser_open", lines.get(0).path("type").asText());
        assertEquals("browser_call", lines.get(1).path("type").asText());
        assertEquals("browser_result", lines.get(2).path("type").asText());
        assertEquals(lines.get(1).path("cid").asText(), lines.get(2).path("cid").asText());
        assertEquals("browser_navigate", lines.get(1).path("tool").asText());
        assertEquals("main", lines.get(1).path("agentId").asText());
        assertEquals("toolu_1", lines.get(1).path("callId").asText());
        assertEquals("https://example.com", lines.get(1).path("input").path("url").asText());
        assertTrue(lines.get(2).path("ok").asBoolean());
        assertTrue(lines.get(2).path("result").asText().startsWith("Opened https://example.com"));
        assertEquals("https://example.com", lines.get(2).path("pageUrl").asText());
    }

    @Test
    void theCallIsOnDiskBeforeItsOutcomeIsKnown(@TempDir Path dir) throws Exception {
        // The navigate that never returns is exactly the run worth replaying.
        // Written at open time, like the llm-wire's request line.
        Path file = dir.resolve("s.browser.jsonl");
        try (BrowserWireRecorder recorder = new BrowserWireRecorder(file, 1 << 20)) {
            recorder.open("browser_navigate", "main", "toolu_1",
                    input("url", "https://slow.example"), null);

            List<JsonNode> lines = lines(file);
            assertEquals(2, lines.size(), "open marker and the call, before any outcome exists");
            assertEquals("browser_call", lines.get(1).path("type").asText());
            assertFalse(lines.stream().anyMatch(l -> "browser_result".equals(l.path("type").asText())));
        }
    }

    @Test
    void aScreenshotIsAReferenceAndNeverBytes(@TempDir Path dir) throws Exception {
        Path file = dir.resolve("s.browser.jsonl");
        try (BrowserWireRecorder recorder = new BrowserWireRecorder(file, 1 << 20)) {
            BrowserWireTap.Call call = recorder.open("browser_computer", "main", "toolu_2",
                    input("action", "screenshot"), "https://example.com");
            call.image("image/png", "images/abc123.png", "abc123", 1100, 760, 11034);
            call.end(true, "Screenshot of https://example.com (1100x760, image/png, 11034 bytes)"
                    + " — attached for you to see.", "https://example.com");
        }

        String raw = Files.readString(file);
        assertFalse(raw.contains("dataBase64"), "the live payload's field name must not be here");
        assertFalse(raw.contains("iVBORw0KGgo"), "no PNG bytes, encoded or otherwise");
        JsonNode image = only(lines(file), "browser_result").path("image");
        assertEquals("images/abc123.png", image.path("blobPath").asText());
        assertEquals("abc123", image.path("sha256").asText());
        assertEquals("image/png", image.path("mediaType").asText());
        assertEquals(1100, image.path("width").asInt());
        assertEquals(11034, image.path("bytes").asLong());
    }

    @Test
    void twoBrowsersInOneSessionAreTwoEpochs(@TempDir Path dir) throws Exception {
        // Card 218: closing a session retires its browser, and a resume opens a
        // fresh one with fresh cookies. The sidecar appends across both, so a
        // trace that numbered them alike would replay two logins as one.
        Path file = dir.resolve("s.browser.jsonl");
        try (BrowserWireRecorder first = new BrowserWireRecorder(file, 1 << 20)) {
            first.open("browser_navigate", "main", "a", input("url", "https://one.example"), null)
                    .end(true, "Opened https://one.example.", "https://one.example");
            assertEquals(1, first.epoch());
        }
        try (BrowserWireRecorder second = new BrowserWireRecorder(file, 1 << 20)) {
            second.open("browser_navigate", "main", "b", input("url", "https://two.example"), null)
                    .end(true, "Opened https://two.example.", "https://two.example");
            assertEquals(2, second.epoch());
        }

        List<JsonNode> lines = lines(file);
        List<JsonNode> opens = lines.stream()
                .filter(l -> "browser_open".equals(l.path("type").asText())).toList();
        assertEquals(2, opens.size(), "one open marker per browser, not per file");
        assertEquals(1, opens.get(0).path("epoch").asInt());
        assertEquals(2, opens.get(1).path("epoch").asInt());
        List<Integer> callEpochs = lines.stream()
                .filter(l -> "browser_call".equals(l.path("type").asText()))
                .map(l -> l.path("epoch").asInt()).toList();
        assertEquals(List.of(1, 2), callEpochs);
        assertNotEquals(callEpochs.get(0), callEpochs.get(1));
    }

    @Test
    void anEpochIsClaimedOnlyWhenTheBrowserIsActuallyUsed(@TempDir Path dir) throws Exception {
        // A session that never calls a browser tool costs no Chromium session
        // (BrowserFaces' own promise) and must cost no file either.
        Path file = dir.resolve("s.browser.jsonl");
        try (BrowserWireRecorder recorder = new BrowserWireRecorder(file, 1 << 20)) {
            assertEquals(0, recorder.epoch(), "unclaimed until the first call");
        }
        assertFalse(Files.exists(file));
    }

    @Test
    void aCredentialInAnEvalStringIsRedactedWholeAndBucketed(@TempDir Path dir) throws Exception {
        // Card 184's open finding, not repeated: the marker reports a SIZE BAND
        // rather than the exact length, because an exact length is an oracle.
        Path file = dir.resolve("s.browser.jsonl");
        String key = "sk-ant-" + "api03-AAAAAAAAAAAAAAAAAAAAAAAA";
        String evaluated = "fetch('/x',{headers:{'x-api-key':'" + key + "'}})";
        try (BrowserWireRecorder recorder = new BrowserWireRecorder(file, 1 << 20)) {
            recorder.open("browser_eval", "main", "toolu_3",
                    input("text", evaluated),
                    "https://example.com")
                    .end(true, "true", "https://example.com");
        }

        String raw = Files.readString(file);
        assertFalse(raw.contains(key), "the credential itself must not be on disk");
        JsonNode text = only(lines(file), "browser_call").path("input").path("text");
        assertEquals("redacted", text.path("kind").asText());
        assertEquals("anthropic-key", text.path("rule").asText());
        // The band, and the proof that it IS a band: the string is 75 bytes and
        // the record must not be able to say so. That is card 184's open
        // credential-length finding, answered here rather than inherited.
        assertEquals(75, evaluated.getBytes(java.nio.charset.StandardCharsets.UTF_8).length);
        assertEquals("65-128", text.path("bytes").asText(), "a band, never the exact length");
        assertNotEquals("75", text.path("bytes").asText());
        assertFalse(text.has("value"));
    }

    @Test
    void aCredentialInAUrlAndInAResultIsRedactedToo(@TempDir Path dir) throws Exception {
        Path file = dir.resolve("s.browser.jsonl");
        String token = "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        try (BrowserWireRecorder recorder = new BrowserWireRecorder(file, 1 << 20)) {
            recorder.open("browser_navigate", "main", "toolu_4",
                    input("url", "https://example.com/callback?token=" + token), null)
                    .end(true, "Opened https://example.com/callback?token=" + token + ".",
                            "https://example.com/callback?token=" + token);
        }

        String raw = Files.readString(file);
        assertFalse(raw.contains(token), "not in the input, not in the result, not in the page url");
        assertEquals("github-pat",
                only(lines(file), "browser_call").path("input").path("url").path("rule").asText());
        JsonNode result = only(lines(file), "browser_result");
        // NON_NULL omits a redacted field rather than writing a null, so the
        // check is "absent", not "null" — a MissingNode is not a NullNode.
        assertFalse(result.hasNonNull("result"));
        assertEquals("github-pat", result.path("resultRedacted").path("rule").asText());
        assertEquals("github-pat", result.path("pageUrlRedacted").path("rule").asText());
    }

    @Test
    void pastTheCeilingTheLedgerStaysAndTheTextGoes(@TempDir Path dir) throws Exception {
        Path file = dir.resolve("s.browser.jsonl");
        try (BrowserWireRecorder recorder = new BrowserWireRecorder(file, 400)) {
            for (int i = 0; i < 6; i++) {
                recorder.open("browser_eval", "main", "toolu_" + i,
                        input("text", "x".repeat(120)), "https://example.com")
                        .end(true, "y".repeat(120), "https://example.com");
            }
        }

        List<JsonNode> lines = lines(file);
        assertEquals(1, lines.stream()
                .filter(l -> "browser_wire_truncated".equals(l.path("type").asText())).count(),
                "the marker latches: one, not one per call");
        assertEquals(6, lines.stream()
                .filter(l -> "browser_call".equals(l.path("type").asText())).count(),
                "every call is still on the ledger");
        JsonNode last = lines.get(lines.size() - 1);
        assertEquals("ceiling", last.path("omitted").asText());
        assertTrue(last.path("resultBytes").asLong() > 0, "the size survives the dropped text");
    }

    @Test
    void anIdIsNeverTrustedAsAPath() {
        assertThrows(IllegalArgumentException.class,
                () -> BrowserWireRecorder.fileFor("../llm-wire/victim"));
        assertThrows(IllegalArgumentException.class, () -> BrowserWireRecorder.fileFor("a/b"));
        assertThrows(IllegalArgumentException.class, () -> BrowserWireRecorder.fileFor("a.b"));
        assertThrows(IllegalArgumentException.class, () -> BrowserWireRecorder.fileFor(null));
        assertTrue(BrowserWireRecorder.fileFor("20260813-101500-ab12cd34").toString()
                .endsWith("20260813-101500-ab12cd34.browser.jsonl"));
    }

    @Test
    void theDetachedTapRecordsNothingAndStillNamesTheCall() {
        // The CLI and every test that has no session: the tools must not have a
        // second code path, so the null tap answers with a usable handle.
        BrowserWireTap.Call call = BrowserWireTap.none()
                .open("browser_eval", "main", "c", input("text", "1"), null);
        assertEquals(0, call.epoch());
        assertFalse(call.cid().isBlank());
        call.image("image/png", "images/x.png", "x", 1, 1, 1);
        call.end(true, "1", null);
    }

    @Test
    void anOperatorCallCarriesTheActorAndAnAgentCallStaysUnmarked(@TempDir Path dir)
            throws Exception {
        // Card 227 criterion 4: a replay must never attribute a human's
        // navigation to the model. The distinction is ONE additive field on the
        // call line, present only for the operator — so every sidecar written
        // before this card keeps its exact bytes, and absent reads as "agent",
        // which for those files is simply true: only agents could drive.
        Path file = dir.resolve("s.browser.jsonl");
        try (BrowserWireRecorder recorder = new BrowserWireRecorder(file, 1 << 20)) {
            recorder.open("navigate", null, null,
                            input("url", "https://example.com"), null, BrowserWireTap.OPERATOR)
                    .end(true, "opened", "https://example.com");
            recorder.open("browser_navigate", "main", "toolu_1",
                            input("url", "https://example.com"), null)
                    .end(true, "opened", "https://example.com");
        }

        List<JsonNode> lines = lines(file);
        JsonNode operatorCall = lines.get(1);
        JsonNode agentCall = lines.get(3);
        assertEquals("browser_call", operatorCall.path("type").asText());
        assertEquals("operator", operatorCall.path("actor").asText(),
                "the operator's line says who drove");
        assertFalse(operatorCall.has("agentId"),
                "an operator call names no agent — there was none");
        assertEquals("browser_call", agentCall.path("type").asText());
        assertFalse(agentCall.has("actor"),
                "an agent line keeps card 204's exact shape — absent means agent");
        assertEquals("main", agentCall.path("agentId").asText());
    }
}
