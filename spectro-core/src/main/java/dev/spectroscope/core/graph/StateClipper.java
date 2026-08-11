package dev.spectroscope.core.graph;

import java.nio.ByteBuffer;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Cuts one channel's value down to what the policy allows.
 *
 * <p>The single rule everything here serves: a truncated value is NEVER a shorter
 * value of the same type. Whatever ceiling fires, the value is replaced by a
 * marker object that names the ceiling and carries the TRUE size of what it
 * stands for. A shortened string that still looks like a whole string is the one
 * failure this layer exists to prevent.</p>
 *
 * <p>Clipping happens in the record builder and never in a sink. The sink
 * protocol is "here is a record"; a fan-out carrying a test collector or an
 * exporter would otherwise be handed the raw corpus while only the file on disk
 * was safe.</p>
 */
final class StateClipper {

    /** Deep enough for any real state, shallow enough that a cycle cannot outrun it. */
    private static final int MAX_DEPTH = 32;

    private final StatePolicy policy;
    private boolean truncated;

    StateClipper(StatePolicy policy) {
        this.policy = policy;
    }

    /**
     * Clips one channel. Never throws: a value that cannot be described says so
     * with a marker, because a channel that disappeared silently is worse than one
     * that is present and unreadable.
     */
    Object clip(Object value, StatePolicy.Cap cap) {
        truncated = false;
        try {
            return walk(value, cap, 0, Collections.newSetFromMap(new IdentityHashMap<>()));
        } catch (RuntimeException | StackOverflowError failure) {
            truncated = true;
            return unserializable(value);
        }
    }

    /** Whether the last {@link #clip} replaced anything with a marker. */
    boolean truncated() {
        return truncated;
    }

    private Object walk(Object value, StatePolicy.Cap cap, int depth, Set<Object> active) {
        if (depth > MAX_DEPTH) {
            truncated = true;
            return unserializable(value);
        }
        if (value == null || value instanceof Boolean) {
            return value;
        }
        if (value instanceof String text) {
            return clipString(text, cap);
        }
        if (value instanceof Double || value instanceof Float) {
            double number = ((Number) value).doubleValue();
            if (Double.isNaN(number) || Double.isInfinite(number)) {
                // A bare NaN or Infinity token is not JSON, and a strict reader
                // rejects the whole line over one channel.
                truncated = true;
                return unserializable(value);
            }
            return value;
        }
        if (value instanceof Number) {
            return value;
        }
        if (value instanceof Collection<?> items) {
            return clipList(new ArrayList<Object>(items), value, cap, depth, active);
        }
        if (value instanceof Object[] items) {
            return clipList(new ArrayList<Object>(List.of(items)), value, cap, depth, active);
        }
        if (value instanceof Map<?, ?> map) {
            return clipMap(map, cap, depth, active);
        }
        return clipString(text(value), cap);
    }

    private Object clipString(String text, StatePolicy.Cap cap) {
        if ("patterns".equals(policy.redaction())) {
            String rule = Redaction.firstRule(text);
            if (rule != null) {
                truncated = true;
                LinkedHashMap<String, Object> marker = new LinkedHashMap<>();
                marker.put("kind", "redacted");
                marker.put("rule", rule);
                marker.put("bytes", Redaction.bucket(text));
                return marker;
            }
        }
        int limit = byteLimit(cap);
        byte[] raw = text.getBytes(StandardCharsets.UTF_8);
        if (limit < 0 || raw.length <= limit) {
            return text;
        }
        truncated = true;
        LinkedHashMap<String, Object> marker = new LinkedHashMap<>();
        marker.put("kind", "str");
        marker.put("bytes", raw.length);
        // Code POINTS, not UTF-16 units: String.length() would silently double
        // the count for anything astral, and a size that is wrong for emoji is
        // wrong for the corpus most likely to need clipping.
        marker.put("chars", text.codePointCount(0, text.length()));
        marker.put("omitted", "cap");
        marker.put("head", head(raw, limit));
        return marker;
    }

    private Object clipList(List<Object> items, Object original, StatePolicy.Cap cap, int depth,
                            Set<Object> active) {
        if (!active.add(original)) {
            truncated = true;
            return unserializable(original);
        }
        try {
            if (cap instanceof StatePolicy.SampleCap sampled && items.size() > sampled.keep()) {
                truncated = true;
                List<Object> kept = new ArrayList<>();
                for (Object item : items.subList(0, sampled.keep())) {
                    kept.add(walk(item, cap, depth + 1, active));
                }
                LinkedHashMap<String, Object> marker = new LinkedHashMap<>();
                marker.put("kind", "list");
                marker.put("len", items.size());
                marker.put("bytes", GraphJson.utf8Bytes(original));
                marker.put("omitted", "cap");
                marker.put("sampled", sampled.keep());
                // The LEADING slice in the node's own order. Picking the "best"
                // elements would be a judgement the recorder is not entitled to,
                // and a rerank node already reordered the list for its own reasons.
                marker.put("items", kept);
                return marker;
            }
            List<Object> clipped = new ArrayList<>();
            for (Object item : items) {
                clipped.add(walk(item, cap, depth + 1, active));
            }
            return clipped;
        } finally {
            active.remove(original);
        }
    }

    private Object clipMap(Map<?, ?> map, StatePolicy.Cap cap, int depth, Set<Object> active) {
        if (!active.add(map)) {
            truncated = true;
            return unserializable(map);
        }
        try {
            // Maps are never sampled — a 500-key object is recorded whole, subject
            // only to the record cap. Dropping entries would lose key names, which
            // are the part a reader can still act on.
            LinkedHashMap<String, Object> clipped = new LinkedHashMap<>();
            map.forEach((key, value) ->
                    clipped.put(String.valueOf(key), walk(value, cap, depth + 1, active)));
            return clipped;
        } finally {
            active.remove(map);
        }
    }

    /**
     * The collapse of last resort: every channel of an over-long record becomes
     * this, carrying the true size of the ORIGINAL value. The line survives and
     * still names every channel, so a reader loses the values and never the fact
     * that they were written.
     */
    static Map<String, Object> channelMarker(Object original) {
        LinkedHashMap<String, Object> marker = new LinkedHashMap<>();
        marker.put("kind", "channel");
        marker.put("bytes", GraphJson.utf8Bytes(original));
        marker.put("omitted", "recordCap");
        return marker;
    }

    private static Map<String, Object> unserializable(Object value) {
        LinkedHashMap<String, Object> marker = new LinkedHashMap<>();
        marker.put("kind", "unserializable");
        marker.put("type", value == null ? "null" : value.getClass().getSimpleName());
        marker.put("omitted", "error");
        return marker;
    }

    private static String text(Object value) {
        try {
            return String.valueOf(value);
        } catch (RuntimeException failure) {
            return "";
        }
    }

    private static int byteLimit(StatePolicy.Cap cap) {
        if (cap instanceof StatePolicy.ByteCap fixed) {
            return fixed.bytes();
        }
        if (cap instanceof StatePolicy.SampleCap sampled) {
            return sampled.bytes();
        }
        return -1;
    }

    /**
     * A byte-exact prefix of the real value, with a half-written character at the
     * cut DROPPED rather than repaired. No ellipsis, no elision, nothing written:
     * a generated précis in an evidence file is the opposite of the product.
     */
    private static String head(byte[] raw, int limit) {
        CharsetDecoder decoder = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.IGNORE)
                .onUnmappableCharacter(CodingErrorAction.IGNORE);
        try {
            return decoder.decode(ByteBuffer.wrap(raw, 0, limit)).toString();
        } catch (Exception failure) {
            return "";
        }
    }
}
