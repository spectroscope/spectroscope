package dev.spectroscope.core.peer;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * The frames on a peer socket (card 502 criteria 3 and 4, concept section
 * Inbox): newline delimited JSON, one object per line, snake case fields.
 *
 * <p>The connecting side reads {@code hello} first, which names the pid and
 * start instant of the process it reached, and writes {@code auth} first. Then
 * {@code message}, {@code notify_when_idle}, {@code peer_idle_notice},
 * {@code peer_message_status} and {@code rename} may follow in either
 * direction of the protocol.</p>
 */
public final class PeerFrames {

    /** The type names a reader accepts. */
    public static final Set<String> TYPES = Set.of("hello", "auth", "message", "notify_when_idle",
            "peer_idle_notice", "peer_message_status", "rename");

    static final ObjectMapper JSON = new ObjectMapper();

    private PeerFrames() {
    }

    /** @return a fresh UUID for a message */
    public static String newMsgId() {
        return UUID.randomUUID().toString();
    }

    /**
     * @param pid       the listening process
     * @param procStart its start instant
     * @return the frame the listening side writes first
     */
    public static ObjectNode hello(long pid, String procStart) {
        ObjectNode frame = typed("hello");
        frame.put("pid", pid);
        frame.put("procStart", procStart);
        frame.put("protocol", PeerLimits.PROTOCOL);
        return frame;
    }

    /**
     * @param token     the receiver's token, read from its key file
     * @param pid       the sending process
     * @param procStart the sending process's start instant
     * @return the frame the connecting side writes first
     */
    public static ObjectNode auth(String token, long pid, String procStart) {
        ObjectNode frame = typed("auth");
        frame.put("token", token);
        frame.put("pid", pid);
        frame.put("procStart", procStart);
        return frame;
    }

    /**
     * @param envelope the message
     * @return its frame
     */
    public static ObjectNode message(PeerEnvelope envelope) {
        ObjectNode frame = typed("message");
        frame.put("msg_id", envelope.msgId());
        frame.put("to_session", envelope.toSession());
        frame.put("from", envelope.from());
        frame.put("from_session", envelope.fromSession());
        frame.put("from_name", envelope.fromName());
        frame.put("from_mode", envelope.fromMode());
        ArrayNode chain = frame.putArray("hop_chain");
        envelope.hopChain().forEach(chain::add);
        frame.put("priority", envelope.priority() == null ? "next" : envelope.priority());
        frame.put("text", envelope.text());
        frame.put("summary", envelope.summary());
        return frame;
    }

    /**
     * @param frame a {@code message} frame
     * @return the envelope it carries; the pids are left to the receiver
     */
    public static PeerEnvelope envelope(JsonNode frame) {
        List<String> chain = new ArrayList<>();
        frame.path("hop_chain").forEach(hop -> chain.add(hop.asText()));
        return PeerEnvelope.builder()
                .msgId(text(frame, "msg_id"))
                .toSession(text(frame, "to_session"))
                .from(text(frame, "from"))
                .fromSession(text(frame, "from_session"))
                .fromName(text(frame, "from_name"))
                .fromMode(text(frame, "from_mode"))
                .hopChain(chain)
                .priority(text(frame, "priority"))
                .text(text(frame, "text"))
                .summary(text(frame, "summary"))
                .build();
    }

    /**
     * @param origMsgId the message this status is about
     * @param toSession the session that sent it
     * @param status    the outcome
     * @param from      the reporting side's reply address
     * @param drop      the guard that tripped, for {@code dropped}; else null
     * @param detail    a sentence for the operator, or null
     * @return the frame
     */
    public static ObjectNode status(String origMsgId, String toSession, PeerStatus status, String from,
                                    DropReason drop, String detail) {
        ObjectNode frame = typed("peer_message_status");
        frame.put("orig_msg_id", origMsgId);
        frame.put("to_session", toSession);
        frame.put("status", status.wireName());
        frame.put("from", from);
        frame.put("reason", drop != null ? drop.text() : PeerNotices.statusReason(status));
        if (drop != null) {
            frame.put("drop_reason", drop.wireName());
        }
        if (detail != null) {
            frame.put("status_detail", detail);
        }
        return frame;
    }

    /**
     * @param msgId       the subscription's id
     * @param from        the subscriber's reply address
     * @param fromSession the subscribing session
     * @param fromMode    the subscriber's class
     * @param toSession   the session to watch
     * @return the frame
     */
    public static ObjectNode notifyWhenIdle(String msgId, String from, String fromSession, String fromMode,
                                            String toSession) {
        ObjectNode frame = typed("notify_when_idle");
        frame.put("msg_id", msgId);
        frame.put("from", from);
        frame.put("from_session", fromSession);
        frame.put("from_mode", fromMode);
        frame.put("to_session", toSession);
        return frame;
    }

    /**
     * @param origMsgId   the subscription it answers
     * @param state       {@code idle}, {@code exited} or {@code unavailable}
     * @param finishedAt  when the watched session finished, epoch millis, or null
     * @param detail      at most a short sanitised line, or null
     * @param from        the watched side's reply address
     * @param fromSession the watched session
     * @return the frame
     */
    public static ObjectNode idleNotice(String origMsgId, String state, Long finishedAt, String detail,
                                        String from, String fromSession) {
        ObjectNode frame = typed("peer_idle_notice");
        frame.put("orig_msg_id", origMsgId);
        frame.put("state", state);
        frame.put("finished_at", finishedAt);
        frame.put("detail", detail);
        frame.put("from", from);
        frame.put("from_session", fromSession);
        return frame;
    }

    /**
     * @param session the renamed session
     * @param oldName its name before
     * @param name    its name now
     * @return the frame
     */
    public static ObjectNode rename(String session, String oldName, String name) {
        ObjectNode frame = typed("rename");
        frame.put("session", session);
        frame.put("old_name", oldName);
        frame.put("name", name);
        return frame;
    }

    /**
     * Reads one line.
     *
     * @param line one line off the socket
     * @return the frame, or empty for anything that is not a known frame
     */
    public static Optional<JsonNode> parse(String line) {
        try {
            JsonNode node = JSON.readTree(line);
            if (node != null && node.isObject() && TYPES.contains(node.path("type").asText())) {
                return Optional.of(node);
            }
        } catch (Exception broken) {
            // Not JSON: not a frame.
        }
        return Optional.empty();
    }

    /** @param frame a frame @return its one line, without the newline */
    public static String line(JsonNode frame) {
        try {
            return JSON.writeValueAsString(frame);
        } catch (Exception impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static ObjectNode typed(String type) {
        ObjectNode frame = JSON.createObjectNode();
        frame.put("type", type);
        return frame;
    }

    private static String text(JsonNode frame, String field) {
        JsonNode value = frame.get(field);
        return value == null || value.isNull() ? null : value.asText();
    }
}
