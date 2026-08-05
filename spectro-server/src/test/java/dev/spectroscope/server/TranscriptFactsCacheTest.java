package dev.spectroscope.server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * The cache in front of the fold, pinned by counting reads rather than by a
 * timing — card 151's own acceptance criterion, for the same reason: a timing
 * assertion passes on a fast machine that is doing the wrong thing.
 */
class TranscriptFactsCacheTest {

    @TempDir
    Path store;

    private final AtomicInteger reads = new AtomicInteger();

    /** A fold that records how often it actually touched a file. */
    private TranscriptFacts.Facts counting(Path file) {
        reads.incrementAndGet();
        return TranscriptFacts.fold(file);
    }

    private Path write(String body) throws Exception {
        Path f = store.resolve("s.jsonl");
        Files.writeString(f, body);
        return f;
    }

    private static void stamp(Path f, long millis) throws Exception {
        Files.setLastModifiedTime(f, FileTime.fromMillis(millis));
    }

    @Test
    void anUnchangedTranscriptIsReadOnceNoMatterHowOftenItIsAsked() throws Exception {
        Path f = write("{\"type\":\"user\",\"promptSource\":\"user\",\"message\":{\"content\":\"a\"}}\n");
        stamp(f, 1_000_000);
        TranscriptFactsCache cache = new TranscriptFactsCache(this::counting);

        for (int i = 0; i < 20; i++) {
            cache.facts(f);
        }

        assertEquals(1, reads.get());
    }

    /**
     * The live session. A transcript being appended to right now must not serve
     * yesterday's count forever, and the size half of the key is what catches
     * it inside one filesystem timestamp tick.
     */
    @Test
    void aTranscriptThatGrewIsReadAgainEvenWhenTheClockDidNotMove() throws Exception {
        Path f = write("{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-4-8\"}}\n");
        stamp(f, 1_000_000);
        TranscriptFactsCache cache = new TranscriptFactsCache(this::counting);
        cache.facts(f);

        Files.writeString(f, "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-4-8\"}}\n"
                + "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-fable-5\"}}\n");
        stamp(f, 1_000_000); // same mtime on purpose: only the size moved
        TranscriptFacts.Facts after = cache.facts(f);

        assertEquals(2, reads.get());
        assertEquals(2, after.models().size(), "the second model must not be hidden by a warm entry");
    }

    @Test
    void aTranscriptRewrittenToTheSameSizeIsStillReadAgain() throws Exception {
        Path f = write("{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-4-8\"}}\n");
        stamp(f, 1_000_000);
        TranscriptFactsCache cache = new TranscriptFactsCache(this::counting);
        cache.facts(f);

        Files.writeString(f, "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-fable-4\"}}\n");
        stamp(f, 2_000_000); // same size, moved clock

        cache.facts(f);

        assertEquals(2, reads.get());
    }

    @Test
    void theCacheStopsGrowingAtItsCeiling() throws Exception {
        TranscriptFactsCache cache = new TranscriptFactsCache(this::counting);
        for (int i = 0; i < TranscriptFactsCache.MAX_ENTRIES + 40; i++) {
            Path f = store.resolve("s" + i + ".jsonl");
            Files.writeString(f, "{}\n");
            cache.facts(f);
        }

        assertEquals(TranscriptFactsCache.MAX_ENTRIES, cache.size());
    }

    @Test
    void theOldestAskIsTheOneEvicted() throws Exception {
        TranscriptFactsCache cache = new TranscriptFactsCache(this::counting);
        Path first = store.resolve("first.jsonl");
        Files.writeString(first, "{}\n");
        cache.facts(first);
        for (int i = 0; i < TranscriptFactsCache.MAX_ENTRIES; i++) {
            Path f = store.resolve("s" + i + ".jsonl");
            Files.writeString(f, "{}\n");
            cache.facts(f);
        }
        int before = reads.get();

        cache.facts(first);

        assertEquals(before + 1, reads.get(), "the first ask should have been evicted by now");
    }
}
