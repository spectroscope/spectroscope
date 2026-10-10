package dev.spectroscope.server.playbooks;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.playbook.run.PlaybookRecorder;
import dev.spectroscope.server.web.LocalOrigin;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * The playbook runs of one session (card 482): a row per run read from the
 * sidecar, and the graph file of a run. Both are fenced like the other
 * session sidecar routes: a loopback caller, a loopback or absent Origin, a
 * plain id; anything else is a blank 404.
 */
@RestController
public class PlaybookRunsController {

    private static final Pattern SESSION_ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9-]*");
    private static final Pattern RUN_ID = Pattern.compile("[0-9a-f]{12}");
    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * {@code GET /api/sessions/{id}/playbook-runs}.
     *
     * @param id      the session
     * @param request the servlet request, for the local fence
     * @return one row per run in order of first appearance: {@code run},
     *         {@code playbook}, {@code startedAt}, {@code stopReason} (null
     *         while the run has no end), {@code live} and {@code graph}, the
     *         file name; an empty list for a session that never ran one; 404
     *         for a foreign caller or a malformed id
     */
    @GetMapping("/api/sessions/{id}/playbook-runs")
    public ResponseEntity<List<Map<String, Object>>> runs(@PathVariable String id, HttpServletRequest request) {
        if (!fenced(request) || !SESSION_ID.matcher(id).matches()) {
            return ResponseEntity.status(404).build();
        }
        Map<String, Map<String, Object>> byRun = new LinkedHashMap<>();
        Path sidecar = PlaybookRecorder.fileFor(id);
        if (Files.isRegularFile(sidecar, LinkOption.NOFOLLOW_LINKS)) {
            try (BufferedReader reader = Files.newBufferedReader(sidecar, StandardCharsets.UTF_8)) {
                String line;
                while ((line = reader.readLine()) != null) {
                    fold(id, line, byRun);
                }
            } catch (IOException unreadable) {
                // A sidecar that cannot be read lists the runs read so far; the torn tail rule.
            }
        }
        return ResponseEntity.ok(new ArrayList<>(byRun.values()));
    }

    /**
     * {@code GET /api/sessions/{id}/playbook-runs/{run}/graph}.
     *
     * @param id      the session
     * @param run     the run id, twelve lower hex digits
     * @param request the servlet request, for the local fence
     * @return 200 with the graph artifact as NDJSON; 404 for a foreign
     *         caller, a malformed id or a run without a graph file
     */
    @GetMapping("/api/sessions/{id}/playbook-runs/{run}/graph")
    public ResponseEntity<String> graph(@PathVariable String id, @PathVariable String run,
                                        HttpServletRequest request) {
        if (!fenced(request) || !SESSION_ID.matcher(id).matches() || !RUN_ID.matcher(run).matches()) {
            return ResponseEntity.status(404).build();
        }
        Path file = PlaybookRecorder.graphFileFor(id, run);
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
            return ResponseEntity.status(404).build();
        }
        try {
            // Decoded leniently, as the llm-wire download is: a torn UTF-8 tail
            // becomes U+FFFD instead of turning the whole file into a 404.
            String ndjson = new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
            return ResponseEntity.ok()
                    .contentType(new MediaType("application", "x-ndjson", StandardCharsets.UTF_8))
                    .header("X-Content-Type-Options", "nosniff")
                    .body(ndjson);
        } catch (IOException unreadable) {
            return ResponseEntity.status(404).build();
        }
    }

    private static void fold(String id, String line, Map<String, Map<String, Object>> byRun) {
        JsonNode node;
        try {
            node = JSON.readTree(line);
        } catch (IOException torn) {
            return;
        }
        if (node == null || !node.isObject()) {
            return;
        }
        String run = node.path("run").asText("");
        if (!RUN_ID.matcher(run).matches()) {
            return;
        }
        switch (node.path("type").asText()) {
            case "playbook_start" -> {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("run", run);
                row.put("playbook", node.path("playbook").asText(null));
                row.put("startedAt", node.path("ts").asLong(0));
                row.put("stopReason", null);
                row.put("live", PlaybookRunsLive.live(id, run));
                row.put("graph", id + "." + run + ".graph.jsonl");
                byRun.putIfAbsent(run, row);
            }
            case "playbook_end" -> {
                Map<String, Object> row = byRun.get(run);
                if (row != null) {
                    row.put("stopReason", node.path("stopReason").asText(null));
                }
            }
            default -> { }
        }
    }

    private static boolean fenced(HttpServletRequest request) {
        return LocalOrigin.isLocalOrigin(request) && LocalOrigin.originIsLoopbackOrAbsent(request);
    }
}
