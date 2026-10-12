package dev.spectroscope.core.peer;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.regex.Pattern;

/**
 * The {@code .messages.jsonl} sidecar of a session (card 502, concept section
 * Wire): one line per envelope and one per status change, beside the
 * session's other sidecars. The session file itself gets no new record type.
 */
public final class MessagesSidecar {

    private static final Logger log = LoggerFactory.getLogger(MessagesSidecar.class);
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern SESSION_ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9_-]{0,127}");

    private final Path dir;
    private final Object lock = new Object();

    /** @param dir where the sidecars live, usually {@link #defaultDir()} */
    public MessagesSidecar(Path dir) {
        this.dir = dir;
    }

    /** @return {@code ~/.spectro/messages} */
    public static Path defaultDir() {
        return Path.of(System.getProperty("user.home"), ".spectro", "messages");
    }

    /**
     * @param sessionId a session
     * @return its sidecar, or null for an id that is not a session id
     */
    public Path fileFor(String sessionId) {
        if (sessionId == null || !SESSION_ID.matcher(sessionId).matches()) {
            return null;
        }
        return dir.resolve(sessionId + ".messages.jsonl");
    }

    /**
     * One envelope.
     *
     * @param sessionId the session whose sidecar takes the line
     * @param direction {@code sent} or {@code received}
     * @param envelope  the message
     * @param toName    the recipient's name, or null
     */
    public void envelope(String sessionId, String direction, PeerEnvelope envelope, String toName) {
        ObjectNode line = JSON.createObjectNode();
        line.put("type", "envelope");
        line.put("ts", System.currentTimeMillis());
        line.put("direction", direction);
        line.put("msg_id", envelope.msgId());
        line.put("from", envelope.from());
        line.put("from_session", envelope.fromSession());
        line.put("from_name", envelope.fromName());
        line.put("to_session", envelope.toSession());
        line.put("to_name", toName);
        line.put("mode", envelope.fromMode());
        if (envelope.verifiedPeerPid() != null) {
            line.put("verified_pid", envelope.verifiedPeerPid());
        }
        line.putPOJO("hop_chain", envelope.hopChain());
        line.put("summary", envelope.summary());
        line.put("text", envelope.text());
        append(sessionId, line);
    }

    /**
     * One status change.
     *
     * @param sessionId the session whose sidecar takes the line
     * @param direction {@code sent} for a status about a message this session sent, else {@code received}
     * @param msgId     the message
     * @param status    the new status
     * @param reason    the reason, or null
     */
    public void status(String sessionId, String direction, String msgId, PeerStatus status, String reason) {
        ObjectNode line = JSON.createObjectNode();
        line.put("type", "status");
        line.put("ts", System.currentTimeMillis());
        line.put("direction", direction);
        line.put("msg_id", msgId);
        line.put("status", status.wireName());
        line.put("reason", reason);
        append(sessionId, line);
    }

    /**
     * Card 503: every line of a session's sidecar, for replay.
     *
     * @param sessionId the session
     * @return the lines in file order; empty for no file, an id that is not a session id, or an unreadable file
     */
    public java.util.List<com.fasterxml.jackson.databind.JsonNode> read(String sessionId) {
        Path file = fileFor(sessionId);
        if (file == null || !Files.isRegularFile(file)) {
            return java.util.List.of();
        }
        java.util.List<com.fasterxml.jackson.databind.JsonNode> lines = new java.util.ArrayList<>();
        try {
            for (String raw : Files.readAllLines(file, StandardCharsets.UTF_8)) {
                if (raw.isBlank()) {
                    continue;
                }
                try {
                    lines.add(JSON.readTree(raw));
                } catch (IOException torn) {
                    // A torn line is skipped, as the session reader skips one.
                }
            }
        } catch (IOException unreadable) {
            log.warn("cannot read the messages sidecar of {}: {}", sessionId, unreadable.toString());
            return java.util.List.of();
        }
        return lines;
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
                log.warn("cannot append to the messages sidecar of {}: {}", sessionId, failure.toString());
            }
        }
    }
}
