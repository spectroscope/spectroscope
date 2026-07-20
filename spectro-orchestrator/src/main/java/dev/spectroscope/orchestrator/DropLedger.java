package dev.spectroscope.orchestrator;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Bookkeeping for frames a local subscriber had to drop: contiguous
 * per-(topic, sender, epoch) stretches, announced as {@link BusGap}s. A gap
 * names ONLY sequences that were actually dropped — a frame that slipped
 * into a freed queue slot between two drops splits the stretch instead of
 * being swallowed by it (the review's spurious-gap finding: a single
 * blindly-extended range could announce a delivered frame as lost).
 *
 * <p>Not thread-safe; the caller (the subscriber's monitor) serializes
 * record and drain.</p>
 */
final class DropLedger {

    private record Key(String topic, String sender, long epoch) {
    }

    /** key → ordered contiguous [firstDropped, lastDropped] stretches. */
    private final Map<Key, List<long[]>> stretches = new LinkedHashMap<>();

    /** Notes one dropped frame; extends the last stretch only when contiguous. */
    void record(String topic, String sender, long epoch, long sequence) {
        List<long[]> ranges =
                stretches.computeIfAbsent(new Key(topic, sender, epoch), key -> new ArrayList<>());
        long[] last = ranges.isEmpty() ? null : ranges.get(ranges.size() - 1);
        if (last != null && sequence == last[1] + 1) {
            last[1] = sequence;
        } else {
            ranges.add(new long[] {sequence, sequence});
        }
    }

    /** @return every recorded stretch as a gap, in record order; empties the ledger */
    List<BusGap> drain() {
        if (stretches.isEmpty()) {
            return List.of();
        }
        List<BusGap> gaps = new ArrayList<>();
        stretches.forEach((key, ranges) -> ranges.forEach(range ->
                gaps.add(new BusGap(key.topic(), key.sender(), key.epoch(),
                        range[0], range[1]))));
        stretches.clear();
        return gaps;
    }
}
