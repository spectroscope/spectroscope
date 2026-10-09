package dev.spectroscope.core.wire;

import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;

/**
 * Card 473, round three: one rule for every writer (the server's session, the
 * headless runner, the CLI) for which {@code run_start} carries the reference
 * and what it names. The first main {@code run_start} names the llm wire when
 * the writer records one; a browser wire is named only once it was written,
 * on the next main {@code run_start} after it appeared.
 */
class WireReferenceTest {

    private static String freshId() {
        return "20261009-120000-" + UUID.randomUUID().toString().substring(0, 8);
    }

    private static RunEvent.RunStart main(String runId) {
        return new RunEvent.RunStart(runId, "main", null, "p", "ollama", "m", null, null, null, 1L);
    }

    @Test
    void theFirstMainRunStartNamesTheLlmWireAndNoBrowserWireThatWasNeverWritten() {
        String id = freshId();
        WireReference ref = new WireReference(id, true);

        RunEvent.RunStart first = (RunEvent.RunStart) ref.stamp(main("r1"));
        assertEquals(id + ".llm.jsonl", first.llmWire());
        assertEquals(LlmWireRecorder.fileFor(id).getFileName().toString(), first.llmWire());
        assertNull(first.browserWire(), "no browser wire was written, so none is named");
        assertEquals(List.of(), first.children());

        RunEvent second = main("r2");
        assertSame(second, ref.stamp(second), "a second run_start says nothing new");
    }

    @Test
    void aBrowserWireIsNamedOnTheNextRunStartAfterItWasWritten() throws IOException {
        String id = freshId();
        WireReference ref = new WireReference(id, true);
        ref.stamp(main("r1"));

        Path browser = BrowserWireRecorder.fileFor(id);
        Files.createDirectories(browser.getParent());
        Files.writeString(browser, "{\"t\":\"call\"}\n");

        RunEvent.RunStart next = (RunEvent.RunStart) ref.stamp(main("r2"));
        assertEquals(id + ".browser.jsonl", next.browserWire());
        assertEquals(id + ".llm.jsonl", next.llmWire());
        RunEvent third = main("r3");
        assertSame(third, ref.stamp(third), "named once is enough");
    }

    @Test
    void aWriterThatRecordsNoLlmWireNamesNoneButStillMarksTheReference() {
        RunEvent.RunStart first = (RunEvent.RunStart) new WireReference(freshId(), false).stamp(main("r1"));
        assertNull(first.llmWire());
        assertEquals(List.of(), first.children());
    }

    @Test
    void childRunStartsAndOtherEventsPassUntouched() {
        WireReference ref = new WireReference(freshId(), true);
        RunEvent child = new RunEvent.RunStart("c1", "child-1", "main", "p", null, null, null, null, null, 1L);
        assertSame(child, ref.stamp(child));
        RunEvent text = new RunEvent.TextDelta("main", "x", 1L);
        assertSame(text, ref.stamp(text));
        // The main run_start after them still gets the reference.
        assertEquals(List.of(), ((RunEvent.RunStart) ref.stamp(main("r1"))).children());
    }
}
