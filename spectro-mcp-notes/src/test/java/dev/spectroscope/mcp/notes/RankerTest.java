package dev.spectroscope.mcp.notes;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RankerTest {

    private static NotesStore.Note note(String file, String text) {
        return new NotesStore.Note(file, text);
    }

    private static final List<NotesStore.Note> NOTES = List.of(
            note("a.txt", "the quick brown fox"),
            note("b.txt", "fox fox fox and another fox"),
            note("c.txt", "a lazy dog sleeps"),
            note("d.txt", "the brown dog and the brown fox"));

    @Test
    void higherTermFrequencyScoresHigher() {
        List<Ranker.Hit> hits = Ranker.search(NOTES, "fox", 10);
        // b has 4 occurrences, a and d have 1 each; b must rank first.
        assertEquals("b.txt", hits.get(0).file());
        assertTrue(hits.get(0).score() > hits.get(1).score());
    }

    @Test
    void limitIsHonored() {
        List<Ranker.Hit> hits = Ranker.search(NOTES, "the", 1);
        assertEquals(1, hits.size());
    }

    @Test
    void noMatchReturnsEmpty() {
        assertTrue(Ranker.search(NOTES, "elephant", 10).isEmpty());
    }

    @Test
    void multiTermQueryScoresCombinedSignals() {
        // d matches both "brown" and "dog" (and "fox"); it should outrank
        // c which matches only "dog".
        List<Ranker.Hit> hits = Ranker.search(NOTES, "brown dog", 10);
        assertEquals("d.txt", hits.get(0).file());
        List<String> files = hits.stream().map(Ranker.Hit::file).toList();
        assertTrue(files.contains("c.txt"));
        assertTrue(files.indexOf("d.txt") < files.indexOf("c.txt"));
    }

    @Test
    void blankQueryOrNonPositiveLimitReturnsEmpty() {
        assertTrue(Ranker.search(NOTES, "   ", 10).isEmpty());
        assertTrue(Ranker.search(NOTES, "fox", 0).isEmpty());
        assertTrue(Ranker.search(NOTES, "fox", -3).isEmpty());
    }

    @Test
    void hitCarriesSourceFileAndSnippet() {
        Ranker.Hit hit = Ranker.search(NOTES, "quick", 1).get(0);
        assertEquals("a.txt", hit.file());
        assertTrue(hit.snippet().contains("quick"));
    }
}
