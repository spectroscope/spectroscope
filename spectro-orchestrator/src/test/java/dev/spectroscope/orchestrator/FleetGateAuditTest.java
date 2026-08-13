package dev.spectroscope.orchestrator;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.Spectro;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.Tool;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 199's security criterion says the audit trail records EVERY gate
 * decision. A fleet lane runs unattended and approves every call it is asked
 * about ({@code request -> true}) — which is a deliberate stance, scoped by the
 * lane's own tool list, and it is also a gate decision. The review (finding F5)
 * found it was the one surface that decided and wrote nothing down.
 *
 * <p>So: a lane that calls a permission-guarded tool must leave a line behind,
 * naming the tool, the tier the shipped map gives it, and who decided.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class FleetGateAuditTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Calls the guarded tool once, then ends the turn. */
    private static final class CallsATool implements LlmProvider {
        private final AtomicInteger turns = new AtomicInteger();

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            if (turns.getAndIncrement() == 0) {
                return List.of(new PToolCall("c1", "touch_the_world",
                                JSON.createObjectNode().put("what", "everything")),
                        new PStop(PStop.StopReason.TOOL_USE));
            }
            return List.of(new PTextDelta("done"), new PStop(PStop.StopReason.END_TURN));
        }

        @Override
        public String providerName() {
            return "scripted";
        }
    }

    /** A tool that needs permission and does nothing at all. */
    private record Guarded() implements Tool {
        @Override
        public String name() {
            return "touch_the_world";
        }

        @Override
        public String description() {
            return "a guarded no-op";
        }

        @Override
        public JsonNode inputSchema() {
            return JSON.createObjectNode().put("type", "object");
        }

        @Override
        public boolean needsPermission() {
            return true;
        }

        @Override
        public String execute(JsonNode input, ToolContext context) {
            return "ok";
        }
    }

    @Test
    void aLaneApprovalIsWrittenDownLikeEveryOtherGateDecision(@TempDir Path tmp)
            throws IOException {
        String previousHome = System.setProperty("user.home", tmp.toString());
        try {
            var panel = Spectro.panel().model(new CallsATool()).workspace(tmp.resolve("ws"));
            panel.agent("bugs").task("touch it").tools(new Guarded());

            String runId = null;
            try (EventStream stream = panel.run()) {
                for (RunEvent event : stream) {
                    if (event instanceof RunEvent.RunStart start
                            && "panel".equals(start.agentId())) {
                        runId = start.runId();
                    }
                }
            }

            Path audit = tmp.resolve(".spectro").resolve("gate-audit")
                    .resolve(runId + ".gate.jsonl");
            assertTrue(Files.isRegularFile(audit),
                    "an unattended approval is still a decision: " + audit);
            List<String> lines = Files.readAllLines(audit);
            assertEquals(1, lines.size(), "one call, one line: " + lines);
            JsonNode line = JSON.readTree(lines.get(0));
            assertEquals("touch_the_world", line.path("tool").asText());
            assertEquals("allow", line.path("decision").asText());
            assertEquals("fleet-lane", line.path("decidedBy").asText(),
                    "the record says WHO approved: the lane's unattended stance, not a human");
            assertEquals("eval-execute", line.path("tier").asText(),
                    "a tool the shipped map does not name is eval-execute, and the line says so");
            assertEquals("bugs", line.path("agentId").asText());
        } finally {
            if (previousHome == null) {
                System.clearProperty("user.home");
            } else {
                System.setProperty("user.home", previousHome);
            }
        }
    }
}
