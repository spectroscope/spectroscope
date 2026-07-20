package dev.spectroscope.mcp.notes;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/**
 * A hand-rolled scored full-text match over the notes — the teaching point is
 * that "search" here is just a small program, not Lucene. Each note gets a
 * score built from two signals per query term:
 *
 * <ul>
 *   <li><b>term frequency</b> — how often the term occurs in the note text; and</li>
 *   <li><b>a substring bonus</b> — a flat bump when the term appears at all, so a
 *       note that mentions the term beats one that never does even if the raw
 *       frequency is close.</li>
 * </ul>
 *
 * Notes with a zero score (no query term present) are dropped; the rest are
 * returned highest-first, truncated to {@code limit}.
 */
public final class Ranker {

    private static final double SUBSTRING_BONUS = 2.0;

    /** Static search only — never instantiated. */
    private Ranker() {
    }

    /**
     * One search hit: the source note file, its score, and a snippet.
     *
     * @param file the note file name the hit came from
     * @param score the summed term score — higher ranks first
     * @param snippet the note's first line, trimmed for display
     */
    public record Hit(String file, double score, String snippet) {
    }

    /**
     * Ranks {@code notes} against {@code query}, returning the top {@code limit}
     * scoring hits highest-first. A blank query or {@code limit <= 0} yields an
     * empty list; notes that match no term are excluded.
     *
     * @param notes the notes to rank — typically the store's full listing
     * @param query free text; split on whitespace, each term matched independently
     * @param limit the maximum number of hits to return
     * @return the top hits, highest score first, ties broken by file name
     */
    public static List<Hit> search(List<NotesStore.Note> notes, String query, int limit) {
        if (query == null || query.isBlank() || limit <= 0) {
            return List.of();
        }
        List<String> terms = terms(query);
        if (terms.isEmpty()) {
            return List.of();
        }

        List<Hit> hits = new ArrayList<>();
        for (NotesStore.Note note : notes) {
            String haystack = note.text().toLowerCase(Locale.ROOT);
            double score = 0.0;
            for (String term : terms) {
                int freq = countOccurrences(haystack, term);
                if (freq > 0) {
                    score += freq + SUBSTRING_BONUS;
                }
            }
            if (score > 0.0) {
                hits.add(new Hit(note.file(), score, snippet(note.text())));
            }
        }

        hits.sort(Comparator
                .comparingDouble(Hit::score).reversed()
                .thenComparing(Hit::file));
        return hits.size() > limit ? new ArrayList<>(hits.subList(0, limit)) : hits;
    }

    /**
     * Splits the query into lower-cased whitespace-separated terms — the unit
     * the scorer counts.
     *
     * @param query the raw search text
     */
    private static List<String> terms(String query) {
        return Arrays.stream(query.toLowerCase(Locale.ROOT).split("\\s+"))
                .filter(t -> !t.isBlank())
                .toList();
    }

    /**
     * Counts non-overlapping occurrences of the term — plain indexOf scanning,
     * both sides already lower-cased by the caller.
     *
     * @param haystack the note text to scan
     * @param term one query term
     */
    private static int countOccurrences(String haystack, String term) {
        int count = 0;
        int from = 0;
        int idx;
        while ((idx = haystack.indexOf(term, from)) >= 0) {
            count++;
            from = idx + term.length();
        }
        return count;
    }

    /**
     * A one-line snippet for the result — the first line, trimmed to length.
     *
     * @param text the full note text
     */
    private static String snippet(String text) {
        String firstLine = text.strip();
        int nl = firstLine.indexOf('\n');
        if (nl >= 0) {
            firstLine = firstLine.substring(0, nl).strip();
        }
        return firstLine.length() > 120 ? firstLine.substring(0, 117) + "..." : firstLine;
    }
}
