package dev.spectroscope.core.trace;

import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The registry semantics (KONZEPT §4.3, sharpened by the card-16 design
 * review): required ports carry the load and fail the run exactly like the
 * inline sink they replace; registered ports are isolated — one broken
 * auxiliary consumer never costs the others their events, and never the run
 * its life. Durability first: every required port sees an event before any
 * registered one, regardless of call order at construction.
 */
class TracingPortsTest {

    private static RunEvent event(String text, long ts) {
        return new RunEvent.TextDelta("main", text, ts);
    }

    /** Test double: records what it saw, optionally into a shared call log. */
    private static final class Recorder implements TracingPort {
        final List<RunEvent> seen = new ArrayList<>();
        private final String name;
        private final List<String> log;

        Recorder(String name, List<String> log) {
            this.name = name;
            this.log = log;
        }

        @Override
        public void onEvent(RunEvent ev) {
            seen.add(ev);
            if (log != null) {
                log.add(name);
            }
        }
    }

    /** Test double: a port that always throws — the broken auxiliary consumer. */
    private static final class Broken implements TracingPort {
        int calls = 0;
        final RuntimeException failure = new IllegalStateException("sink on fire");

        @Override
        public void onEvent(RunEvent ev) {
            calls++;
            throw failure;
        }
    }

    @Test
    void requiredPortsSeeEveryEventBeforeRegisteredOnes() {
        List<String> log = new ArrayList<>();
        Recorder jsonl = new Recorder("jsonl", log);
        Recorder bus = new Recorder("bus", log);
        // Registered first on purpose: durability order must not depend on
        // the construction order a call site happens to choose.
        TracingPorts tracing = new TracingPorts().register(bus).require(jsonl);

        tracing.onEvent(event("a", 1));
        tracing.onEvent(event("b", 2));

        assertEquals(2, jsonl.seen.size());
        assertEquals(2, bus.seen.size());
        assertEquals(List.of("jsonl", "bus", "jsonl", "bus"), log,
                "every event is durable (required) before it is published (registered)");
    }

    @Test
    void aThrowingRegisteredPortIsIsolatedAndTheOthersKeepReceiving() {
        Broken broken = new Broken();
        Recorder after = new Recorder("after", null);
        TracingPorts tracing = new TracingPorts().register(broken).register(after);

        assertDoesNotThrow(() -> {
            tracing.onEvent(event("a", 1));
            tracing.onEvent(event("b", 2));
        });

        assertEquals(2, after.seen.size(), "the broken neighbour costs nobody their events");
        assertEquals(2, broken.calls, "a broken port keeps being offered events — it may recover");
    }

    @Test
    void theFirstFailureOfARegisteredPortWarnsOnStderrOnce() {
        ByteArrayOutputStream captured = new ByteArrayOutputStream();
        PrintStream originalErr = System.err;
        System.setErr(new PrintStream(captured, true, StandardCharsets.UTF_8));
        try {
            TracingPorts tracing = new TracingPorts().register(new Broken());
            tracing.onEvent(event("a", 1));
            tracing.onEvent(event("b", 2));
            tracing.onEvent(event("c", 3));
        } finally {
            System.setErr(originalErr);
        }

        String warnings = captured.toString(StandardCharsets.UTF_8);
        long lines = warnings.lines().filter(line -> line.contains("Broken")).count();
        assertEquals(1, lines, "warn once per broken port, not once per event: " + warnings);
        assertTrue(warnings.contains("sink on fire"), "the warning names the failure");
    }

    @Test
    void aThrowingRequiredPortPropagatesLikeTheInlineSinkItReplaces() {
        Broken broken = new Broken();
        Recorder never = new Recorder("never", null);
        TracingPorts tracing = new TracingPorts().require(broken).register(never);

        RuntimeException thrown =
                assertThrows(RuntimeException.class, () -> tracing.onEvent(event("a", 1)));

        assertSame(broken.failure, thrown, "required failures surface unwrapped");
        assertEquals(0, never.seen.size(),
                "when durability fails, nothing downstream pretends the event happened");
    }
}
