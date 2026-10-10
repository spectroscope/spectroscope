package dev.spectroscope.core.playbook.run;

import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.PermissionBroker;
import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class CommandCheckTest {

    @TempDir Path ws;

    @Test
    void exitZeroPassesAndTheGateSawTheLine() {
        List<RunEvent> events = new ArrayList<>();
        List<String> asked = new ArrayList<>();
        PermissionBroker broker = request -> {
            asked.add(request.name() + " " + request.input().path("command").asText());
            return true;
        };
        CheckResult r = CommandCheck.run("exit 0", ws, broker, line -> Optional.empty(), events::add,
                new CancelSignal(), "pb-run-1");
        assertEquals("pass", r.label());
        assertEquals(List.of("playbook_check exit 0"), asked);
        assertTrue(events.get(0) instanceof RunEvent.PermissionRequest req && "pb-run-1".equals(req.callId()));
        assertTrue(events.get(1) instanceof RunEvent.PermissionDecision d && d.allowed());
    }

    @Test
    void aNonZeroExitFailsWithTheCode() {
        CheckResult r = CommandCheck.run("exit 3", ws, request -> true, line -> Optional.empty(), e -> { },
                new CancelSignal(), "pb-run-2");
        assertEquals("fail", r.label());
        assertTrue(r.detail().startsWith("exit 3: exit 3"), r.detail());
    }

    @Test
    void aDeniedLineNeverRuns() {
        Path marker = ws.resolve("ran");
        CheckResult r = CommandCheck.run("touch " + marker, ws, request -> false, line -> Optional.empty(), e -> { },
                new CancelSignal(), "pb-run-3");
        assertEquals("fail", r.label());
        assertTrue(r.detail().contains("permission gate"), r.detail());
        assertTrue(!marker.toFile().exists(), "a denied check does not reach a shell");
    }

    @Test
    void theHostGuardRefusesBeforeTheGate() {
        List<String> asked = new ArrayList<>();
        CheckResult r = CommandCheck.run("kill 1", ws, request -> { asked.add("asked"); return true; },
                line -> Optional.of("refused: aimed at this app"), e -> { }, new CancelSignal(), "pb-run-4");
        assertEquals("fail", r.label());
        assertEquals(List.of(), asked);
    }

    @Test
    void varsAreSubstituted() {
        assertEquals("./gradlew test --rerun-tasks", CommandCheck.substitute("{test} --rerun-tasks",
                Map.of("test", "./gradlew test")));
    }
}
