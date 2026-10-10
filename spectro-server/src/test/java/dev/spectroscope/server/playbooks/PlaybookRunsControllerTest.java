package dev.spectroscope.server.playbooks;

import dev.spectroscope.core.playbook.run.PlaybookRecorder;
import dev.spectroscope.server.session.SessionsController;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 482: the run list and the graph file of one session, and the delete
 * cascade that takes both away. The Gradle test task points user.home into
 * the build directory, so the sidecar folder never touches the real home.
 */
class PlaybookRunsControllerTest {

    private static final String DONE = "abcdefabcdef";
    private static final String OPEN = "0123456789ab";

    private final PlaybookRunsController controller = new PlaybookRunsController();

    private static MockHttpServletRequest local() {
        return new MockHttpServletRequest();
    }

    private static String freshId() {
        return "t482-" + UUID.randomUUID().toString().substring(0, 8);
    }

    private static void sidecar(String id) throws IOException {
        Files.createDirectories(PlaybookRecorder.folder());
        Files.writeString(PlaybookRecorder.fileFor(id), String.join("\n",
                "{\"type\":\"playbook_start\",\"run\":\"" + DONE + "\",\"playbook\":\"spectro\",\"ts\":1000}",
                "{\"type\":\"step_start\",\"run\":\"" + DONE + "\",\"node\":\"a\",\"ts\":1100}",
                "{\"type\":\"playbook_start\",\"run\":\"" + OPEN + "\",\"playbook\":\"other\",\"ts\":2000}",
                "{\"type\":\"playbook_end\",\"run\":\"" + DONE + "\",\"stopReason\":\"done\",\"ts\":3000}",
                "this line is torn {",
                ""), StandardCharsets.UTF_8);
    }

    private static Path graph(String id, String run, String text) throws IOException {
        Path file = PlaybookRecorder.graphFileFor(id, run);
        Files.createDirectories(file.getParent());
        Files.writeString(file, text);
        return file;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> rows(ResponseEntity<List<Map<String, Object>>> res) {
        return res.getBody();
    }

    @Test
    void theRunListHasOneRowPerRunInOrderWithItsStopReasonOrNone() throws IOException {
        String id = freshId();
        sidecar(id);
        graph(id, DONE, "{}\n");

        List<Map<String, Object>> runs = rows(controller.runs(id, local()));

        assertEquals(2, runs.size());
        assertEquals(Map.of("run", DONE, "playbook", "spectro", "startedAt", 1000L, "stopReason", "done",
                "live", false, "graph", id + "." + DONE + ".graph.jsonl"), withoutNulls(runs.get(0)));
        assertEquals(OPEN, runs.get(1).get("run"));
        assertEquals(null, runs.get(1).get("stopReason"));
        assertEquals(false, runs.get(1).get("live"));
    }

    @Test
    void aRunInFlightIsLive() throws IOException {
        String id = freshId();
        sidecar(id);
        PlaybookRunsLive.started(id, OPEN);
        try {
            assertEquals(true, rows(controller.runs(id, local())).get(1).get("live"));
        } finally {
            PlaybookRunsLive.ended(id, OPEN);
        }
    }

    @Test
    void aSessionWithoutASidecarHasNoRuns() {
        assertEquals(List.of(), rows(controller.runs(freshId(), local())));
    }

    @Test
    void theGraphIsServedAsTheFileWithTheNdjsonTypeAndNosniff() throws IOException {
        String id = freshId();
        String text = "{\"type\":\"graph_start\"}\n{\"type\":\"node_start\",\"node\":\"a\"}\n";
        graph(id, DONE, text);

        ResponseEntity<String> res = controller.graph(id, DONE, local());

        assertEquals(200, res.getStatusCode().value());
        assertEquals(text, res.getBody());
        assertEquals("application/x-ndjson;charset=UTF-8", res.getHeaders().getContentType().toString());
        assertEquals("nosniff", res.getHeaders().getFirst("X-Content-Type-Options"));
    }

    @Test
    void aTornTailDoesNotTurnTheGraphIntoA404() throws IOException {
        String id = freshId();
        Path file = graph(id, DONE, "");
        Files.write(file, new byte[] {'{', '}', '\n', (byte) 0xE2, (byte) 0x82});

        ResponseEntity<String> res = controller.graph(id, DONE, local());

        assertEquals(200, res.getStatusCode().value());
        assertTrue(res.getBody().startsWith("{}\n"));
        assertTrue(res.getBody().contains("�"));
    }

    @Test
    void badIdsAndForeignCallersGetANotFound() throws IOException {
        String id = freshId();
        graph(id, DONE, "{}\n");
        MockHttpServletRequest remote = new MockHttpServletRequest();
        remote.setRemoteAddr("203.0.113.7");
        MockHttpServletRequest crossSite = new MockHttpServletRequest();
        crossSite.addHeader("Origin", "https://evil.example");

        assertEquals(404, controller.graph(id, "../x", local()).getStatusCode().value());
        assertEquals(404, controller.graph(id, "ABCDEFABCDEF", local()).getStatusCode().value());
        assertEquals(404, controller.graph("../" + id, DONE, local()).getStatusCode().value());
        assertEquals(404, controller.graph(id, OPEN, local()).getStatusCode().value());
        assertEquals(404, controller.graph(id, DONE, remote).getStatusCode().value());
        assertEquals(404, controller.graph(id, DONE, crossSite).getStatusCode().value());
        assertEquals(404, controller.runs(id, remote).getStatusCode().value());
        assertEquals(404, controller.runs("a b", local()).getStatusCode().value());
    }

    // ---- DELETE /api/sessions/{id} ---------------------------------------- //

    @Test
    void deletingASessionTakesItsSidecarAndItsGraphFilesAndNoOnesElse() throws IOException {
        String id = freshId();
        String other = id + "-other";
        sidecar(id);
        Path mine = graph(id, DONE, "{}\n");
        Path mineToo = graph(id, OPEN, "{}\n");
        Path theirs = graph(other, DONE, "{}\n");
        Path theirSidecar = PlaybookRecorder.fileFor(other);
        Files.writeString(theirSidecar, "{}\n");

        assertEquals(204, new SessionsController().deleteSession(id).getStatusCode().value());

        assertFalse(Files.exists(PlaybookRecorder.fileFor(id)));
        assertFalse(Files.exists(mine));
        assertFalse(Files.exists(mineToo));
        assertTrue(Files.exists(theirs), "a session whose id starts the same way keeps its graph");
        assertTrue(Files.exists(theirSidecar));
        new SessionsController().deleteSession(other);
        assertFalse(Files.exists(theirs));
    }

    private static Map<String, Object> withoutNulls(Map<String, Object> row) {
        Map<String, Object> out = new java.util.LinkedHashMap<>(row);
        out.values().removeIf(java.util.Objects::isNull);
        return out;
    }
}
