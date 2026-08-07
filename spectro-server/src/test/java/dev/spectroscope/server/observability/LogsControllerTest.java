package dev.spectroscope.server.observability;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockHttpServletRequest;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The live server-log endpoint (card 85): tail + incremental delta reads for
 * the doctor page's log pane, behind the full local fence — the log names
 * workspaces, prompts-in-errors and model hosts, none of which a foreign
 * page may read.
 */
class LogsControllerTest {

    @TempDir
    Path dir;

    private Path logFile(String content) throws IOException {
        Path file = dir.resolve("spectroscope.log");
        Files.writeString(file, content, StandardCharsets.UTF_8);
        return file;
    }

    private static MockHttpServletRequest local() {
        return new MockHttpServletRequest();
    }

    @Test
    void tailWithoutOffsetReturnsTheLastLinesAndTheFileSize() throws IOException {
        Path file = logFile("one\ntwo\nthree\nfour\n");
        LogsController controller = new LogsController(() -> file);
        Map<String, Object> out = controller.logs(null, 2, local()).getBody();
        assertEquals("three\nfour\n", out.get("content"));
        assertEquals(Files.size(file), out.get("offset"));
    }

    @Test
    void anOffsetReadsOnlyTheDeltaSinceLastPoll() throws IOException {
        Path file = logFile("first line\n");
        LogsController controller = new LogsController(() -> file);
        long offset = (long) controller.logs(null, 200, local()).getBody().get("offset");
        Files.writeString(file, "second line\n", StandardCharsets.UTF_8,
                java.nio.file.StandardOpenOption.APPEND);
        Map<String, Object> out = controller.logs(offset, 200, local()).getBody();
        assertEquals("second line\n", out.get("content"));
        assertEquals(Files.size(file), out.get("offset"));
    }

    @Test
    void aShrunkFileResetsToAFreshTailInsteadOfFailing() throws IOException {
        // Logback rotation truncates the live file — a stale offset past EOF
        // must fall back to the tail, never 500 or return garbage.
        Path file = logFile("after rotation\n");
        LogsController controller = new LogsController(() -> file);
        Map<String, Object> out = controller.logs(999_999L, 200, local()).getBody();
        assertEquals("after rotation\n", out.get("content"));
        assertEquals(Files.size(file), out.get("offset"));
    }

    @Test
    void aMissingFileAnswersEmptyNotAnError() {
        LogsController controller = new LogsController(() -> dir.resolve("absent.log"));
        Map<String, Object> out = controller.logs(null, 200, local()).getBody();
        assertEquals("", out.get("content"));
        assertEquals(0L, out.get("offset"));
    }

    @Test
    void theResponseIsCappedEvenForAHugeDelta() throws IOException {
        // A first poll against a fat log must not ship megabytes: the delta is
        // capped from the END (the newest bytes win — it is a tail).
        StringBuilder fat = new StringBuilder();
        for (int i = 0; i < 40_000; i++) {
            fat.append("line ").append(i).append("\n");
        }
        Path file = logFile(fat.toString());
        LogsController controller = new LogsController(() -> file);
        Map<String, Object> out = controller.logs(0L, 100_000, local()).getBody();
        String content = (String) out.get("content");
        assertTrue(content.length() <= LogsController.MAX_RESPONSE_BYTES,
                "delta must be capped, got " + content.length());
        assertTrue(content.endsWith("line 39999\n"), "the newest bytes win");
        assertEquals(Files.size(file), out.get("offset"));
    }

    @Test
    void refusesADnsReboundHost() throws IOException {
        Path file = logFile("secret workspace path\n");
        LogsController controller = new LogsController(() -> file);
        MockHttpServletRequest rebound = local();
        rebound.setServerName("attacker.example");
        assertEquals(404, controller.logs(null, 200, rebound).getStatusCode().value());
        assertNull(controller.logs(null, 200, rebound).getBody());
    }

    @Test
    void refusesACrossSiteOrigin() throws IOException {
        Path file = logFile("x\n");
        LogsController controller = new LogsController(() -> file);
        MockHttpServletRequest crossSite = local();
        crossSite.addHeader("Origin", "https://evil.example");
        assertEquals(404, controller.logs(null, 200, crossSite).getStatusCode().value());
    }

    @Test
    void refusesANonLocalCaller() throws IOException {
        Path file = logFile("x\n");
        LogsController controller = new LogsController(() -> file);
        MockHttpServletRequest remote = local();
        remote.setRemoteAddr("203.0.113.7"); // TEST-NET, not loopback
        assertEquals(404, controller.logs(null, 200, remote).getStatusCode().value());
    }
}
