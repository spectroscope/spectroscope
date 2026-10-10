package dev.spectroscope.core.playbook.run;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.graph.Redaction;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The playbook sidecar, one per session beside the sessions folder: which step
 * ran on which model, what each check answered, every nod. One O_APPEND write
 * per line, a latching ceiling, and every string through the shared redaction
 * table, because the file holds addresses, answers and check output.
 */
public final class PlaybookRecorder implements AutoCloseable {

    public static final long DEFAULT_CEILING_BYTES = 16L * 1024 * 1024;
    public static final Set<String> TYPES = Set.of("playbook_start", "step_start", "step_end", "check", "nod",
            "privacy", "playbook_end");
    private static final Pattern SESSION_ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9-]*");
    private static final Pattern RUN_ID = Pattern.compile("[0-9a-f]{12}");
    private static final ObjectMapper JSON = new ObjectMapper();

    private final Path file;
    private final long ceiling;
    private long written;
    private boolean latched;
    private boolean closed;

    /** @param file where to append; @param ceilingBytes the size at which it stops with one truncation line */
    public PlaybookRecorder(Path file, long ceilingBytes) {
        this.file = file;
        this.ceiling = ceilingBytes;
        long size = 0;
        try {
            size = Files.exists(file) ? Files.size(file) : 0;
        } catch (IOException unreadable) {
            size = 0;
        }
        this.written = size;
    }

    /** @return {@code ~/.spectro/playbook-runs} */
    public static Path folder() {
        return Path.of(System.getProperty("user.home"), ".spectro", "playbook-runs");
    }

    /** @param sessionId a session id; @return its sidecar; @throws IllegalArgumentException when it is not a plain id */
    public static Path fileFor(String sessionId) {
        if (sessionId == null || !SESSION_ID.matcher(sessionId).matches()) {
            throw new IllegalArgumentException("not a session id: " + sessionId);
        }
        return folder().resolve(sessionId + ".playbook.jsonl");
    }

    /** @return the graph artifact of one run; ids never hold a dot, so the dot keeps sessions apart */
    public static Path graphFileFor(String sessionId, String runId) {
        if (sessionId == null || !SESSION_ID.matcher(sessionId).matches()
                || runId == null || !RUN_ID.matcher(runId).matches()) {
            throw new IllegalArgumentException("not a session and run id: " + sessionId + " " + runId);
        }
        return folder().resolve(sessionId + "." + runId + ".graph.jsonl");
    }

    /** @return the file this recorder appends to */
    public Path file() {
        return file;
    }

    /**
     * @param type   one of {@link #TYPES}
     * @param fields the fields in order; type goes first and ts last
     */
    public synchronized void record(String type, Map<String, Object> fields) {
        if (!TYPES.contains(type)) {
            throw new IllegalArgumentException("not a playbook sidecar type: " + type);
        }
        if (closed || latched) {
            return;
        }
        Map<String, Object> line = new LinkedHashMap<>();
        line.put("type", type);
        fields.forEach((k, v) -> line.put(k, redact(v)));
        line.put("ts", System.currentTimeMillis());
        byte[] bytes = encode(line);
        if (written + bytes.length > ceiling) {
            latched = true;
            Map<String, Object> marker = new LinkedHashMap<>();
            marker.put("type", "truncated");
            marker.put("ts", System.currentTimeMillis());
            append(encode(marker));
            return;
        }
        append(bytes);
    }

    /** @return the value with every string a redaction rule fires on replaced by its rule and size band */
    static Object redact(Object value) {
        if (value instanceof String s) {
            String rule = Redaction.firstRule(s);
            if (rule == null) {
                return s;
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("redacted", rule);
            out.put("bytes", Redaction.bucket(s));
            return out;
        }
        if (value instanceof Map<?, ?> m) {
            Map<String, Object> out = new LinkedHashMap<>();
            m.forEach((k, v) -> out.put(String.valueOf(k), redact(v)));
            return out;
        }
        if (value instanceof List<?> l) {
            List<Object> out = new ArrayList<>();
            l.forEach(v -> out.add(redact(v)));
            return out;
        }
        return value;
    }

    private static byte[] encode(Map<String, Object> line) {
        try {
            return (JSON.writeValueAsString(line) + "\n").getBytes(StandardCharsets.UTF_8);
        } catch (IOException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private void append(byte[] bytes) {
        try {
            Files.createDirectories(file.getParent());
            try (FileChannel channel = FileChannel.open(file, StandardOpenOption.CREATE,
                    StandardOpenOption.WRITE, StandardOpenOption.APPEND)) {
                channel.write(ByteBuffer.wrap(bytes));
            }
            written += bytes.length;
        } catch (IOException failure) {
            System.err.println("playbook sidecar not written: " + failure.getMessage());
        }
    }

    @Override
    public synchronized void close() {
        closed = true;
    }
}
