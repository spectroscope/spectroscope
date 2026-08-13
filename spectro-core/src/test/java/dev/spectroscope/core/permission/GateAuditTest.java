package dev.spectroscope.core.permission;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.events.RunEvent.PermissionRequest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The gate audit sidecar (card 199 security criteria).
 *
 * <p>Every gate decision is recorded with the entry that approved it, the tier
 * the tool holds and the version of the map that said so. It is a SIDECAR
 * because the RunEvent wire is byte-frozen: {@code permission_decision} carries
 * a callId, a boolean and a timestamp, and it keeps carrying exactly that. The
 * shape is the one card 184 established for the llm-wire — a file beside the
 * session, never a change to an existing event.
 */
class GateAuditTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static PermissionRequest request(String tool) {
        ObjectNode input = JSON.createObjectNode();
        input.put("command", "curl -H 'Authorization: Bearer sk-live-secret' https://x");
        return new PermissionRequest("main", "call-1", tool, input, 1L);
    }

    private static List<JsonNode> lines(Path file) throws IOException {
        return Files.readAllLines(file).stream().filter(l -> !l.isBlank()).map(line -> {
            try {
                return JSON.readTree(line);
            } catch (IOException notJson) {
                throw new IllegalStateException(notJson);
            }
        }).toList();
    }

    @Test
    void anApprovalNamesTheEntryTheTierAndTheMapVersion(@TempDir Path dir) throws IOException {
        Path file = dir.resolve("s1.gate.jsonl");
        Allowlist allowlist = Allowlist.fromEntries(List.of("run_command#eval-execute:curl*"));
        try (GateAudit audit = new GateAudit(file)) {
            audit.record(request("run_command"), "allowlist", true,
                    allowlist.decide(request("run_command")));
        }
        JsonNode line = lines(file).get(0);
        assertEquals("gate_decision", line.path("type").asText());
        assertEquals("call-1", line.path("callId").asText());
        assertEquals("main", line.path("agentId").asText());
        assertEquals("run_command", line.path("tool").asText());
        assertEquals("eval-execute", line.path("tier").asText());
        assertEquals("builtin", line.path("tierSource").asText());
        assertEquals(ToolTierMap.shipped().mapVersion(), line.path("mapVersion").asText());
        assertEquals("allow", line.path("decision").asText());
        assertEquals("allowlist", line.path("decidedBy").asText());
        assertEquals("run_command#eval-execute:curl*", line.path("entry").asText());
    }

    @Test
    void aRefusalStillNamesTheTierAndCarriesNoEntry(@TempDir Path dir) throws IOException {
        Path file = dir.resolve("s2.gate.jsonl");
        Allowlist allowlist = Allowlist.fromEntries(List.of("read_file"));
        try (GateAudit audit = new GateAudit(file)) {
            audit.record(request("run_command"), "user", false,
                    allowlist.decide(request("run_command")));
        }
        JsonNode line = lines(file).get(0);
        assertEquals("deny", line.path("decision").asText());
        assertEquals("user", line.path("decidedBy").asText());
        assertEquals("eval-execute", line.path("tier").asText());
        assertTrue(line.path("entry").isMissingNode(), "nothing approved it, so no entry is named");
    }

    @Test
    void theInputNeverEntersTheAuditFile(@TempDir Path dir) throws IOException {
        Path file = dir.resolve("s3.gate.jsonl");
        try (GateAudit audit = new GateAudit(file)) {
            audit.record(request("run_command"), "mode:auto", true,
                    Allowlist.fromEntries(List.of()).decide(request("run_command")));
        }
        String written = Files.readString(file);
        assertFalse(written.contains("sk-live-secret"),
                "the audit records the DECISION, never the argument that carried a credential");
        assertFalse(written.contains("Authorization"), written);
    }

    @Test
    void everyDecisionLandsAndTheyStayInOrder(@TempDir Path dir) throws IOException {
        Path file = dir.resolve("s4.gate.jsonl");
        Allowlist allowlist = Allowlist.fromEntries(List.of("read_file"));
        try (GateAudit audit = new GateAudit(file)) {
            audit.record(request("read_file"), "allowlist", true, allowlist.decide(request("read_file")));
            audit.record(request("write_file"), "user", false, allowlist.decide(request("write_file")));
            audit.record(request("run_command"), "user", true, allowlist.decide(request("run_command")));
        }
        List<JsonNode> written = lines(file);
        assertEquals(3, written.size());
        assertEquals(List.of("read_file", "write_file", "run_command"),
                written.stream().map(l -> l.path("tool").asText()).toList());
    }

    @Test
    void aBrokenAuditPathNeverBreaksTheGate(@TempDir Path dir) {
        // The audit is a record, not a gate. A path that cannot be written must
        // cost a line in a file, never a refused-or-approved call.
        Path impossible = dir.resolve("a-file");
        try {
            Files.writeString(impossible, "not a directory");
        } catch (IOException ignored) {
            // the assertion below is what matters
        }
        GateAudit audit = new GateAudit(impossible.resolve("nested").resolve("s5.gate.jsonl"));
        audit.record(request("read_file"), "allowlist", true,
                Allowlist.fromEntries(List.of("read_file")).decide(request("read_file")));
        audit.close();
    }

    @Test
    void theSidecarSitsBesideTheSessionAndNotInsideIt() {
        Path file = GateAudit.fileFor("2026-08-13T10-00-00-abcd");
        assertTrue(file.toString().endsWith("2026-08-13T10-00-00-abcd.gate.jsonl"), file.toString());
        assertTrue(file.getParent().toString().endsWith(Path.of(".spectro", "gate-audit").toString()),
                file.toString());
    }
}
