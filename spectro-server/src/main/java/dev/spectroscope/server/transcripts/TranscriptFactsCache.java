package dev.spectroscope.server.transcripts;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Function;

/**
 * Remembers what {@link TranscriptFacts#fold} found, keyed the way any honest
 * file cache is keyed: path plus last-modified plus size.
 *
 * <p>Card 151 records the cost of getting this wrong on the sibling endpoint —
 * {@code /api/sessions} re-parses the whole store on every call because nothing
 * sits here. The same shape of defect on this dialog would be worse, because
 * these files are two orders of magnitude larger: the operator's store is
 * 1.37 GiB across 167 session transcripts, the largest of them 82 MiB.</p>
 *
 * <h2>Why both halves of the stamp</h2>
 * <p>Neither alone is enough for a store with a live session in it.</p>
 * <ul>
 *   <li><b>Size alone</b> misses an edit that keeps the length, which is rare
 *       for an append-only log but free to rule out.</li>
 *   <li><b>Modified time alone</b> misses an append that lands inside the same
 *       filesystem timestamp tick, and the transcript the operator is talking
 *       into right now is appended to constantly. That is the case that would
 *       serve a stale model list for the rest of the server's life.</li>
 * </ul>
 *
 * <p>Together they also answer the other half of that requirement — that a
 * growing file must not be re-read on every poll. A poll that finds the same
 * stamp is served from here without touching the file, and the client hook
 * keys its own memo on the same stamp, so an unchanged row does not even ask.
 * Only a transcript that actually moved is read again.</p>
 *
 * <h2>Where it lives</h2>
 * <p>In this process, and nowhere else. There is no sidecar index file on
 * purpose: a cache on disk would have to be invalidated against a store this
 * server does not own and does not watch, and the failure mode of a wrong
 * on-disk index is a permanently wrong row. A server restart therefore starts
 * cold, and a cold ask costs exactly one fold. That is a real cost and it is
 * written into the commit message rather than hidden here.</p>
 */
final class TranscriptFactsCache {

    /**
     * How many folded transcripts are kept. The listing serves at most 300 rows
     * and the dialog only ever asks for the ones on screen, so this holds a
     * whole browse of the largest store the listing can describe, with room for
     * a second store beside it. Entries are small — a handful of strings and
     * three ints — so the ceiling is about bounding growth, not about bytes.
     */
    static final int MAX_ENTRIES = 512;

    /**
     * Joins the three parts of a cache key. A NUL, because it is the one byte a
     * path cannot contain, so no filename can spell a key that belongs to
     * another file. Written as an escape rather than typed into the string: a
     * literal NUL in a source file makes git call it binary, and a file with no
     * diff and no blame is not reviewable.
     */
    private static final String SEP = "\0";

    /** The fold, injected so a test can count reads instead of timing them. */
    private final Function<Path, TranscriptFacts.Facts> fold;

    /** Access-ordered, so eviction drops the least recently asked-for row. */
    private final Map<String, TranscriptFacts.Facts> entries =
            Collections.synchronizedMap(new LinkedHashMap<>(64, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, TranscriptFacts.Facts> eldest) {
                    return size() > MAX_ENTRIES;
                }
            });

    /** Production wiring: the real fold. */
    TranscriptFactsCache() {
        this(TranscriptFacts::fold);
    }

    /**
     * Seam for tests.
     *
     * @param fold what to call on a miss
     */
    TranscriptFactsCache(Function<Path, TranscriptFacts.Facts> fold) {
        this.fold = fold;
    }

    /**
     * The facts for one transcript, folded only if this exact file state has
     * not been folded before.
     *
     * @param file the absolute transcript path
     * @return the facts; a file that cannot be stat-ed is folded every time
     *         rather than cached under a stamp that means nothing
     */
    TranscriptFacts.Facts facts(Path file) {
        String key = stamp(file);
        if (key == null) {
            return fold.apply(file);
        }
        TranscriptFacts.Facts warm = entries.get(key);
        if (warm != null) {
            return warm;
        }
        TranscriptFacts.Facts fresh = fold.apply(file);
        // Stamped again after the read, not before: a transcript that grew
        // WHILE it was being folded would otherwise be filed under the state it
        // had at the start, and that entry would never be revisited. Losing the
        // caching of one in-flight read is the cheap side of that trade.
        String after = stamp(file);
        if (key.equals(after)) {
            entries.put(key, fresh);
        }
        return fresh;
    }

    /** How many entries are held; the eviction test reads this. */
    int size() {
        return entries.size();
    }

    /**
     * The cache key: identity plus both halves of the file's state.
     *
     * @param file the transcript path
     * @return the key, or null when the file cannot be stat-ed
     */
    private static String stamp(Path file) {
        try {
            var attributes = Files.readAttributes(file, java.nio.file.attribute.BasicFileAttributes.class);
            return file.toAbsolutePath() + SEP + attributes.lastModifiedTime().toMillis()
                    + SEP + attributes.size();
        } catch (IOException gone) {
            return null;
        }
    }
}
