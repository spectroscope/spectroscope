package dev.spectroscope.core.graph;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The one dialect both artifact files are written in: compact JSON, one record
 * per line, {@code type} first and {@code ts} last.
 *
 * <p>Compact means no space after any separator, and non-ASCII goes out RAW
 * rather than as a backslash-u escape. Both are load-bearing rather than taste:
 * one viewer reads these files and the RunEvent wire, and {@code head -1} showing
 * a human a whole readable record is the property the format was chosen for.</p>
 */
final class GraphJson {

    private static final ObjectMapper MAPPER = JsonMapper.builder().build();

    private GraphJson() {
    }

    /**
     * The size a value would take on the wire, best-effort and never throwing.
     *
     * <p>Measuring may not take a run down, so an unserializable value falls back
     * to its own text and then to zero. It is measured on the compact,
     * non-escaped JSON, so a German or emoji-bearing corpus counts the same here
     * as it does in the reference implementation.</p>
     */
    static int utf8Bytes(Object value) {
        try {
            return MAPPER.writeValueAsString(value).getBytes(StandardCharsets.UTF_8).length;
        } catch (Exception first) {
            try {
                return String.valueOf(value).getBytes(StandardCharsets.UTF_8).length;
            } catch (RuntimeException second) {
                return 0;
            }
        }
    }

    /** One record as the single line it becomes on disk, without its line end. */
    static String line(Map<String, Object> record) {
        try {
            return MAPPER.writeValueAsString(record);
        } catch (Exception failure) {
            throw new IllegalArgumentException(
                    "the record cannot be written as JSON: " + failure.getMessage(), failure);
        }
    }

    /**
     * Puts {@code type} first and {@code ts} last, stamping the timestamp only
     * when the caller left it out.
     *
     * <p>Enforced here rather than only in the builders, because the runtime is
     * allowed to hand a record over that it built by hand — so the guarantee has
     * to belong to whoever writes the line.</p>
     */
    static LinkedHashMap<String, Object> ordered(Map<String, Object> record, long nowMillis) {
        LinkedHashMap<String, Object> out = new LinkedHashMap<>();
        if (record.containsKey("type")) {
            out.put("type", record.get("type"));
        }
        record.forEach((key, value) -> {
            if (!"type".equals(key) && !"ts".equals(key)) {
                out.put(key, value);
            }
        });
        Object stamped = record.get("ts");
        out.put("ts", stamped == null ? nowMillis : stamped);
        return out;
    }
}
