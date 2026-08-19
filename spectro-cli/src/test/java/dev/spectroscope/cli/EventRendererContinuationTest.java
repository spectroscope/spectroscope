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
 * Card 266 on the terminal — the twin of {@link EventRendererNoProgressTest},
 * and written because the review found it missing.
 *
 * <p>Card 262 lost exactly this once: {@code renderParentEvent} had no case for
 * its event, the event fell through {@code default}, and a run whose guard fired
 * left no line on the terminal at all. The leash's three decisions were only
 * compile-checked here — they were seen printing in the live AC-8 runs, but a
 * later edit that dropped the case would have printed nothing and stayed
 * green.</p>
 *
 * <p>Pinned on the DECISION word and the count, never on the sentence: the
 * evidence prose is written for a person and may be reworded, the wire name may
 * not. This is also the reason the assertion is not
 * {@code assertFalse(out.contains("continued"))} anywhere — "continued" is a
 * substring of nothing here, but the house has been bitten by a negative that
 * was true for its own opposite.</p>
 */
class EventRendererContinuationTest {

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

    private static RunEvent.Continuation held(String decision, int spent, String evidence) {
        return new RunEvent.Continuation(MAIN, decision, spent, 3, 3, 4, 4889, evidence, 1000L);
    }

    @Test
    void theTerminalSaysTheRunWasHeldAndWhichContinuationThisIs() {
        String out = rendered(held("continued", 1,
                "continued: 3 of 4 steps open, continuation 1 of 3"));

        assertTrue(out.contains("continued"),
                "the decision is the fact a reader can act on. Got: " + out);
        assertTrue(out.contains("continuation 1 of 3"),
                "and which one of how many, so an evening is countable. Got: " + out);
    }

    @Test
    void bothRefusalsReadOnTheTerminalToo() {
        // A refusal that nobody can see is the silence card 264 was cut to end,
        // so it has to print exactly as loudly as a restart. The underscore
        // becomes a space for a person; the word itself survives.
        String exhausted = rendered(held("budget_exhausted", 3,
                "not continued: 3 of 4 steps open, and this run's budget of 3"
                        + " continuations is spent"));
        assertTrue(exhausted.contains("budget exhausted"), "got: " + exhausted);
        assertTrue(exhausted.contains("budget of 3 continuations is spent"),
                "got: " + exhausted);

        String stuck = rendered(held("no_progress", 1,
                "not continued: nothing has changed since continuation 1 — the same plan,"
                        + " and no tool call that came back clean"));
        assertTrue(stuck.contains("no progress"), "got: " + stuck);
        assertTrue(stuck.contains("nothing has changed since continuation 1"),
                "got: " + stuck);
    }
}
