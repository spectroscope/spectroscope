package dev.spectroscope.cli;

import java.nio.file.Path;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.function.Consumer;

/**
 * The pure half of the fs trigger (card 72): raw watch events in, at most one
 * coalesced {@link Fire} out per quiet period. The window is FIXED, anchored
 * on the first event — a steady drip of changes must not defer the fire
 * forever. All timing arrives as caller-supplied millis, so every case pins
 * against injected clocks; only the thin {@link FsWatchTrigger} thread ever
 * passes wall-clock time.
 *
 * <p>The relative-path fence lives here: a real WatchService only hands out
 * names relative to the registered directory, but the seam is injectable —
 * an absolute or parent-escaping path must never reach a prompt as if it
 * lived under the watched root, so it is refused loudly and dropped.</p>
 */
final class FsDebouncer {

    /**
     * One raw watch event.
     *
     * @param kind     created | modified | deleted; null on overflow
     * @param relPath  the path RELATIVE to the watched root; null on overflow
     * @param overflow the WatchService lost events — honesty rides the fire
     */
    record Change(String kind, String relPath, boolean overflow) {
        static Change overflowed() {
            return new Change(null, null, true);
        }
    }

    private final String source;
    private final long windowMs;
    private final Consumer<String> log;

    private final LinkedHashSet<String> entries = new LinkedHashSet<>();
    private int extra;
    private boolean overflow;
    private long windowStart = -1;

    FsDebouncer(String source, long windowMs, Consumer<String> log) {
        this.source = source;
        this.windowMs = windowMs;
        this.log = log;
    }

    /**
     * Folds a batch of raw events in; the first ACCEPTED event opens the window.
     *
     * @param changes the polled batch (may be empty)
     * @param now     caller-supplied millis
     */
    synchronized void offer(List<Change> changes, long now) {
        for (Change change : changes) {
            if (change.overflow()) {
                overflow = true;
            } else if (unsafe(change.relPath())) {
                log.accept("watch: refused an event path outside the watched root: \""
                        + change.relPath() + "\"");
                continue;
            } else if (entries.size() < Fire.MAX_ENTRIES) {
                if (!entries.add(change.kind() + " " + change.relPath())) {
                    continue; // a repeat says nothing new
                }
            } else if (!entries.contains(change.kind() + " " + change.relPath())) {
                extra++;
            }
            if (windowStart < 0) {
                windowStart = now;
            }
        }
    }

    /**
     * @param now caller-supplied millis
     * @return the coalesced fire once the quiet period elapsed, else null
     */
    synchronized Fire drain(long now) {
        if (windowStart < 0 || now < windowStart + windowMs) {
            return null;
        }
        Fire fire = Fire.fs(source, List.copyOf(entries), extra, overflow);
        entries.clear();
        extra = 0;
        overflow = false;
        windowStart = -1;
        return fire;
    }

    /** @return the open window's fire deadline in millis, or null when closed —
     *          the trigger thread derives its poll timeout from this */
    synchronized Long deadline() {
        return windowStart < 0 ? null : windowStart + windowMs;
    }

    private static boolean unsafe(String relPath) {
        if (relPath == null || relPath.isBlank()) {
            return true;
        }
        Path path = Path.of(relPath);
        if (path.isAbsolute()) {
            return true;
        }
        for (Path part : path) {
            if ("..".equals(part.toString())) {
                return true;
            }
        }
        return false;
    }
}
