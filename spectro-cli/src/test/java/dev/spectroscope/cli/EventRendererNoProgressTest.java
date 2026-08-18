package dev.spectroscope.cli;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.permission.Allowlist;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 262 review finding F6: the terminal never printed the guard's line.
 *
 * <p>The event carries an English sentence for exactly one reason, written onto
 * the card as decision 7 — the CLI transcript has no dictionary, so criterion 3
 * ("the harness says WHAT it saw") has to hold there through the prose. It did
 * not: {@code renderParentEvent} had no {@code NoProgress} case and the event
 * fell through {@code default}, so the only trace on the terminal was the
 * question that follows it. A run whose guard fired and was then waved through
 * left no line at all.</p>
 *
 * <p>Pinned on the DETECTOR word and the count, never on the sentence: the prose
 * is written for a person and may be reworded, the detector may not.</p>
 */
class EventRendererNoProgressTest {

    private static final String MAIN = "main";

    /** Renders the given events through the real renderer and returns stdout. */
    private static String rendered(RunEvent... events) {
        PrintStream original = System.out;
        ByteArrayOutputStream captured = new ByteArrayOutputStream();
        System.setOut(new PrintStream(captured, true, StandardCharsets.UTF_8));
        try {
            Ansi ansi = Ansi.forced(false); // plain text, and the spinner never draws
            EventRenderer renderer = new EventRenderer(ansi, new Spinner(ansi), MAIN,
                    () -> Allowlist.fromEntries(List.of()));
            for (RunEvent event : events) {
                renderer.render(event);
            }
        } finally {
            System.setOut(original);
        }
        return captured.toString(StandardCharsets.UTF_8);
    }

    @Test
    void theTerminalSaysWhichNetFiredAndHowOften() {
        String out = rendered(new RunEvent.NoProgress(MAIN, "identical_writes", 3,
                List.of("src/a.js", "src/b.js", "src/c.js", "src/d.js"),
                "The same 283 bytes have already gone to 3 paths (src/a.js, src/b.js,"
                        + " src/c.js), and another copy is starting: src/d.js.", 1000L));

        assertTrue(out.contains("identical_writes"),
                "the detector is the fact a reader can act on. Got: " + out);
        assertTrue(out.contains("3"), "and the count. Got: " + out);
        assertTrue(out.contains("another copy is starting: src/d.js"),
                "criterion 3 on the face with no dictionary: WHAT it saw, not that it saw"
                        + " something. Got: " + out);
    }

    @Test
    void aStalledPlanReadsAsItsOwnNetOnTheTerminal() {
        String out = rendered(new RunEvent.NoProgress(MAIN, "stalled_plan", 2,
                List.of("write the engine"),
                "The plan has not moved for 2 turns — 1 of 1 steps still open, same"
                        + " wording and same statuses.", 1000L));

        assertTrue(out.contains("stalled_plan"), "got: " + out);
        assertTrue(out.contains("has not moved for 2 turns"), "got: " + out);
    }
}
