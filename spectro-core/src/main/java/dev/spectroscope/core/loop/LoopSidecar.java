package dev.spectroscope.core.loop;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * The {@code .loop.jsonl} sidecar of a session (card 504, concept section
 * Wire): one line per loop start, wakeup armed, wakeup held, wakeup fired,
 * loop end, end heard by a client and goal check in. The session file gets no new record type.
 *
 * <p>The sidecar is also where a wakeup is held while no client is attached:
 * a driver built after a restart reads the last loop that did not end and the
 * last wakeup armed for it ({@link LoopDriver#restore}).</p>
 */
public final class LoopSidecar {

    private static final Logger log = LoggerFactory.getLogger(LoopSidecar.class);
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern SESSION_ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9_-]{0,127}");

    private final Path dir;
    private final Object lock = new Object();

    /** @param dir where the sidecars live, usually {@link #defaultDir()} */
    public LoopSidecar(Path dir) {
        this.dir = dir;
    }

    /** @return {@code ~/.spectro/loops} */
    public static Path defaultDir() {
        return Path.of(System.getProperty("user.home"), ".spectro", "loops");
    }

    /**
     * @param sessionId a session
     * @return its sidecar, or null for an id that is not a session id
     */
    public Path fileFor(String sessionId) {
        if (sessionId == null || !SESSION_ID.matcher(sessionId).matches()) {
            return null;
        }
        return dir.resolve(sessionId + ".loop.jsonl");
    }

    /**
     * @param sessionId       the session
     * @param loopId          the loop
     * @param pacing          {@code fixed} or {@code self}
     * @param prompt          the task
     * @param intervalSeconds the fixed interval, or null
     * @param startedAt       when it started
     */
    void loopStart(String sessionId, String loopId, String pacing, String prompt, Integer intervalSeconds,
                   long startedAt) {
        ObjectNode line = line("loop_start", startedAt);
        line.put("loopId", loopId);
        line.put("pacing", pacing);
        line.put("prompt", prompt);
        if (intervalSeconds != null) {
            line.put("intervalSeconds", intervalSeconds);
        }
        append(sessionId, line);
    }

    /**
     * @param sessionId the session
     * @param loopId    the loop
     * @param wakeup    the wakeup armed
     * @param isTask    true when it fires the loop's own task, which the {@code loop_start}
     *                  line holds once; the line then leaves the prompt out (fix round 2: a fixed
     *                  loop re-arms on every fire)
     * @param now       when
     */
    void armed(String sessionId, String loopId, SessionLoop.Wakeup wakeup, boolean isTask, long now) {
        ObjectNode line = line("wakeup_armed", now);
        line.put("loopId", loopId);
        line.put("wakeupId", wakeup.id());
        line.put("scheduledFor", wakeup.scheduledFor());
        line.put("reason", wakeup.reason());
        if (!isTask) {
            line.put("prompt", wakeup.prompt());
        }
        if (wakeup.requestedSeconds() != null) {
            line.put("requestedSeconds", wakeup.requestedSeconds());
        }
        line.put("delaySeconds", wakeup.delaySeconds());
        line.put("wasClamped", wakeup.wasClamped());
        line.put("keepalive", wakeup.keepalive());
        append(sessionId, line);
    }

    /**
     * @param sessionId the session
     * @param loopId    the loop
     * @param wakeup    the wakeup that fell due
     * @param why       {@code detached} or {@code busy}
     * @param now       when
     */
    void held(String sessionId, String loopId, SessionLoop.Wakeup wakeup, String why, long now) {
        ObjectNode line = line("loop_held", now);
        line.put("loopId", loopId);
        line.put("wakeupId", wakeup.id());
        line.put("why", why);
        append(sessionId, line);
    }

    /**
     * @param sessionId the session
     * @param loopId    the loop
     * @param wakeup    the wakeup that fired
     * @param expansion {@code full}, {@code reminder}, {@code verbatim} or {@code fixed}
     * @param now       when
     */
    void fired(String sessionId, String loopId, SessionLoop.Wakeup wakeup, String expansion, long now) {
        ObjectNode line = line("loop_fire", now);
        line.put("loopId", loopId);
        line.put("wakeupId", wakeup.id());
        line.put("scheduledFor", wakeup.scheduledFor());
        line.put("driftMs", now - wakeup.scheduledFor());
        line.put("reason", wakeup.reason());
        line.put("expansion", expansion);
        line.put("keepalive", wakeup.keepalive());
        append(sessionId, line);
    }

    /**
     * @param sessionId the session
     * @param loopId    the loop
     * @param reason    {@code model_stopped}, {@code aged_out} or {@code user_abort}
     * @param now       when
     */
    void ended(String sessionId, String loopId, String reason, long now) {
        ObjectNode line = line("loop_end", now);
        line.put("loopId", loopId);
        line.put("reason", reason);
        append(sessionId, line);
    }

    /**
     * Fix round 1: an attached client heard the loop's end, so a restart does
     * not tell it again.
     *
     * @param sessionId the session
     * @param loopId    the loop
     * @param now       when
     */
    void endSeen(String sessionId, String loopId, long now) {
        ObjectNode line = line("loop_end_seen", now);
        line.put("loopId", loopId);
        append(sessionId, line);
    }

    /**
     * Card 504, criterion 3: a goal check in while background children ran.
     *
     * @param sessionId       the session
     * @param count           the check ins of this deferral, 1-based
     * @param deferredMinutes how long the check had been deferred
     * @param children        how many children still ran
     */
    public void checkIn(String sessionId, int count, long deferredMinutes, int children) {
        ObjectNode line = line("goal_checkin", System.currentTimeMillis());
        line.put("count", count);
        line.put("deferredMinutes", deferredMinutes);
        line.put("children", children);
        append(sessionId, line);
    }

    /**
     * @param sessionId the session
     * @return the lines in file order; empty for no file, a bad id or an unreadable file
     */
    public List<JsonNode> read(String sessionId) {
        Path file = fileFor(sessionId);
        if (file == null || !Files.isRegularFile(file)) {
            return List.of();
        }
        List<JsonNode> lines = new ArrayList<>();
        try {
            for (String raw : Files.readAllLines(file, StandardCharsets.UTF_8)) {
                if (raw.isBlank()) {
                    continue;
                }
                try {
                    lines.add(JSON.readTree(raw));
                } catch (IOException torn) {
                    // a torn line is skipped, as the session reader skips one
                }
            }
        } catch (IOException unreadable) {
            log.warn("cannot read the loop sidecar of {}: {}", sessionId, unreadable.toString());
            return List.of();
        }
        return lines;
    }

    private static ObjectNode line(String type, long ts) {
        ObjectNode line = JSON.createObjectNode();
        line.put("type", type);
        line.put("ts", ts);
        return line;
    }

    private void append(String sessionId, ObjectNode line) {
        Path file = fileFor(sessionId);
        if (file == null) {
            return;
        }
        synchronized (lock) {
            try {
                Files.createDirectories(dir);
                Files.write(file, (JSON.writeValueAsString(line) + "\n").getBytes(StandardCharsets.UTF_8),
                        StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            } catch (IOException failure) {
                log.warn("cannot append to the loop sidecar of {}: {}", sessionId, failure.toString());
            }
        }
    }
}
