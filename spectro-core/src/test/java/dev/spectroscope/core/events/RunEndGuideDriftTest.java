package dev.spectroscope.core.events;

import dev.spectroscope.core.PlanVerdict;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The guide's stop-reason list against what the loop can actually emit.
 *
 * <p>Chapter 15 enumerates every value of {@code run_end.stopReason}, and that
 * list is what a reader consults to decide whether a session ended well. Card
 * 264 adds one. The sentence and the code live in files that cannot import each
 * other, so the only way to keep them together is a test that goes and looks —
 * the shape {@code McpGuideDriftTest} and {@code HeadlessGuideDriftTest} already
 * use, for the reason this house learned the hard way: a stale doc line made a
 * later session build the same decision twice.</p>
 */
class RunEndGuideDriftTest {

    private static final Path EVENTS = Path.of("docs/guide-assets/parts/15-ref-events.html");
    private static final Path LOOP = Path.of("docs/guide-assets/parts/17-ref-loop.html");

    @Test
    void chapter15NamesTheVerdictAmongTheStopReasons() throws IOException {
        String part = collapsed(EVENTS);
        assumeTrue(part != null, "not running from a source checkout");
        int start = part.indexOf("class=\"name\">run_end<");
        assertTrue(start >= 0, "the run_end entry is gone from " + EVENTS);
        String section = part.substring(start, Math.min(part.length(), start + 900));
        assertTrue(section.contains(PlanVerdict.UNFINISHED_STOP_REASON),
                "chapter 15 lists the stop reasons and does not name the one card 264"
                        + " added, so a reader grading a session by this list will read an"
                        + " abandoned run as a value that cannot happen. Section: " + section);
        assertTrue(section.contains("plan"),
                "the new value is meaningless without the plan it is computed from —"
                        + " chapter 15 has to say where it comes from. Section: " + section);
    }

    @Test
    void chapter27SaysTheExitReadsThePlan() throws IOException {
        String part = collapsed(LOOP);
        assumeTrue(part != null, "not running from a source checkout");
        assertTrue(part.contains(PlanVerdict.UNFINISHED_STOP_REASON),
                "chapter 27 walks the loop exit by exit and still ends every voluntary"
                        + " one with the mapped stop reason. Since card 264 that exit reads"
                        + " the plan ledger first, which is the whole difference between a"
                        + " finished run and an abandoned one.");
    }

    /** One part file, whitespace-collapsed (the source is hand-wrapped), or null off a checkout. */
    private static String collapsed(Path part) throws IOException {
        Path root = repoRoot();
        if (root == null || !Files.isRegularFile(root.resolve(part))) {
            return null;
        }
        return Files.readString(root.resolve(part)).replaceAll("\\s+", " ");
    }

    /** Walks up to the directory holding the Gradle settings file. */
    private static Path repoRoot() {
        for (Path candidate = Path.of("").toAbsolutePath();
                candidate != null; candidate = candidate.getParent()) {
            if (Files.isRegularFile(candidate.resolve("settings.gradle.kts"))) {
                return candidate;
            }
        }
        return null;
    }
}
