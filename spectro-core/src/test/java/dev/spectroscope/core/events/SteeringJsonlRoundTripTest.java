package dev.spectroscope.core.events;

import dev.spectroscope.core.session.SessionStore;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * Card 380, criterion 6, the Java half of the JSONL round trip.
 *
 * <p>Two runs of one session go through {@link SessionStore#append}, the
 * writer every session file is written by: one run whose operator sentence
 * was read ({@code taken} true) and one that ended before it read one
 * ({@code taken} false). The file the writer produced must equal
 * {@code steering/steered-session.jsonl} byte for byte, and
 * {@link SessionStore#readSessionEvents} must give back the events that went
 * in.</p>
 *
 * <p>The web half, {@code spectro-web/src/state/steeringJsonl.test.ts}, reads
 * the same fixture through the page's JSONL import and its reducer. So the
 * bytes the page is tested on are the bytes this writer is tested to
 * produce.</p>
 *
 * <p>With no fixture on the classpath this test writes what the writer
 * produced to {@code build/steering-jsonl/steered-session.jsonl} and fails,
 * so a fixture is placed by hand, after reading it.</p>
 */
class SteeringJsonlRoundTripTest {

    private static final String FIXTURE = "/steering/steered-session.jsonl";

    /** Two runs: the first reads a sentence, the second ends before it does. */
    private static List<RunEvent> steeredSession() {
        return List.of(
                new RunEvent.RunStart("r1", "main", null, "list the files",
                        null, null, null, null, null, 1000L),
                new RunEvent.TurnStart("main", 1, 1001L),
                new RunEvent.TextDelta("main", "Looking at the API.", 1002L),
                new RunEvent.TurnStart("main", 2, 1003L),
                new RunEvent.SteeringMessage("main", "use the cached list, not the API",
                        true, 2, 1004L),
                new RunEvent.TextDelta("main", "Using the cached list.", 1005L),
                new RunEvent.RunEnd("r1", "end_turn", 1006L),
                new RunEvent.RunStart("r2", "main", null, "and now the tests",
                        null, null, null, null, null, 2000L),
                new RunEvent.TurnStart("main", 1, 2001L),
                new RunEvent.SteeringMessage("main", "skip the slow ones", false, 1, 2002L),
                new RunEvent.RunEnd("r2", "end_turn", 2003L));
    }

    @Test
    void theWriterProducesTheFixtureAndTheReaderGivesBackWhatWentIn() throws IOException {
        String id = "steering-jsonl-round-trip";
        Path file = SessionStore.sessionFile(id);
        Files.deleteIfExists(file);
        try {
            SessionStore store = new SessionStore(id);
            for (RunEvent event : steeredSession()) {
                store.append(event);
            }
            String written = Files.readString(file, StandardCharsets.UTF_8);

            String fixture = fixture();
            if (fixture == null) {
                Path out = Path.of("build", "steering-jsonl", "steered-session.jsonl");
                Files.createDirectories(out.getParent());
                Files.writeString(out, written, StandardCharsets.UTF_8);
                fail("no fixture at src/test/resources" + FIXTURE + "; the writer's output is at "
                        + out.toAbsolutePath() + ". Read it, then place it.");
            }
            assertEquals(fixture, written,
                    "the writer's bytes are the bytes the web test reads");

            assertEquals(steeredSession(), SessionStore.readSessionEvents(id),
                    "and the reader gives back every event that went in, in order");
        } finally {
            Files.deleteIfExists(file);
        }
    }

    private static String fixture() throws IOException {
        try (InputStream in = SteeringJsonlRoundTripTest.class.getResourceAsStream(FIXTURE)) {
            return in == null ? null : new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }
}
