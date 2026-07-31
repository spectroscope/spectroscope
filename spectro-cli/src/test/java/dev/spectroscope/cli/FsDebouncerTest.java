package dev.spectroscope.cli;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.stream.IntStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The pure half of the fs trigger: quiet-period debounce, coalescing, the
 * bounded path list, the honest OVERFLOW block, and the relative-path fence.
 * Every case runs against injected clock values — the real WatchService only
 * appears in the smoke test of {@link FsWatchTriggerTest}.
 */
class FsDebouncerTest {

    private static FsDebouncer debouncer(List<String> log) {
        return new FsDebouncer("watch:/drop", 500, log::add);
    }

    private static FsDebouncer.Change created(String relPath) {
        return new FsDebouncer.Change("created", relPath, false);
    }

    @Test
    void theFirstEventOpensAFixedWindowAndDrainFiresOnlyAfterIt() {
        FsDebouncer debouncer = debouncer(new ArrayList<>());
        assertNull(debouncer.drain(1_000), "nothing offered, nothing fires");
        assertNull(debouncer.deadline(), "no window open");

        debouncer.offer(List.of(created("data.csv")), 1_000);
        assertEquals(1_500L, debouncer.deadline(), "the window anchors on the FIRST event");
        assertNull(debouncer.drain(1_499), "still inside the quiet period");

        Fire fire = debouncer.drain(1_500);
        assertEquals("fs", fire.kind());
        assertEquals("watch:/drop", fire.source());
        assertEquals(List.of("created data.csv"), fire.entries());
        assertEquals(0, fire.coalesced());
        assertNull(debouncer.deadline(), "drained — the window is closed");
        assertNull(debouncer.drain(2_500), "and stays closed until the next event");
    }

    @Test
    void everythingInsideTheWindowCoalescesIntoOneFireDeduplicated() {
        FsDebouncer debouncer = debouncer(new ArrayList<>());
        debouncer.offer(List.of(created("data.csv")), 1_000);
        debouncer.offer(List.of(new FsDebouncer.Change("modified", "report.md", false)), 1_200);
        debouncer.offer(List.of(created("data.csv")), 1_400); // a repeat says nothing new

        Fire fire = debouncer.drain(1_500);
        assertEquals(List.of("created data.csv", "modified report.md"), fire.entries());
        assertEquals(1_500L, 1_000 + 500, "the window did NOT slide on later events");
    }

    @Test
    void thePathListIsBoundedAndTheRestIsCounted() {
        FsDebouncer debouncer = debouncer(new ArrayList<>());
        List<FsDebouncer.Change> burst = IntStream.range(0, 25)
                .mapToObj(i -> created("file-" + i + ".txt")).toList();
        debouncer.offer(burst, 1_000);

        Fire fire = debouncer.drain(1_500);
        assertEquals(20, fire.entries().size(), "at most 20 named paths per fire");
        assertEquals(5, fire.extra(), "the rest is an honest count, never silently gone");
    }

    @Test
    void overflowYieldsTheHonestRereadBlock() {
        FsDebouncer debouncer = debouncer(new ArrayList<>());
        debouncer.offer(List.of(FsDebouncer.Change.overflowed()), 1_000);

        Fire fire = debouncer.drain(1_500);
        assertTrue(fire.overflow());
        assertTrue(fire.contextBlock(1).contains("changes overflowed — re-read the directory"),
                fire.contextBlock(1));
    }

    @Test
    void pathsEscapingTheWatchedRootAreRefusedNotForwarded() {
        // The fence: event paths are RELATIVE to the canonical root. An
        // absolute or parent-escaping path (impossible from a real
        // WatchService, possible from a buggy or fake seam) must never reach
        // the prompt as if it lived under the root.
        List<String> log = new ArrayList<>();
        FsDebouncer debouncer = debouncer(log);
        debouncer.offer(List.of(
                new FsDebouncer.Change("created", "/etc/passwd", false),
                new FsDebouncer.Change("created", "../outside.txt", false)), 1_000);

        assertNull(debouncer.deadline(), "only refused paths — no window, no fire");
        assertNull(debouncer.drain(2_000));
        assertTrue(log.stream().anyMatch(line -> line.contains("refused")),
                "the refusal is loud, not silent: " + log);

        debouncer.offer(List.of(created("ok.txt"),
                new FsDebouncer.Change("created", "nested/../../escape.txt", false)), 3_000);
        Fire fire = debouncer.drain(3_500);
        assertEquals(List.of("created ok.txt"), fire.entries(),
                "the safe path fires alone; the escape never rides along");
        assertFalse(fire.contextBlock(1).contains("escape.txt"));
    }
}
