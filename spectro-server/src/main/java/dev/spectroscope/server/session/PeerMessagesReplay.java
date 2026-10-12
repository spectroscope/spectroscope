package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import dev.spectroscope.core.peer.MessagesSidecar;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Card 503, criterion 9: a stored session's {@code .messages.jsonl} as the
 * {@code peer_message} frames the page folds, one per line in the file's
 * order, each marked {@code replay}. The page merges them into the session's
 * events by time and folds them through the same reducer case as live ones;
 * the {@code agent_message} records with role {@code peer} in the session file
 * fold into the same blocks by {@code msgId}.
 */
final class PeerMessagesReplay {

    private PeerMessagesReplay() {
    }

    /**
     * @param sidecar   where the sidecars live
     * @param sessionId the stored session
     * @return one frame per sidecar line; empty for an unknown or malformed id
     */
    static List<Map<String, Object>> frames(MessagesSidecar sidecar, String sessionId) {
        List<Map<String, Object>> frames = new ArrayList<>();
        for (JsonNode line : sidecar.read(sessionId)) {
            Map<String, Object> frame = new LinkedHashMap<>();
            frame.put("type", "peer_message");
            String direction = line.path("direction").asText("received");
            frame.put("direction", direction);
            frame.put("msgId", line.path("msg_id").asText(null));
            frame.put("ts", line.path("ts").asLong(0));
            frame.put("replay", true);
            if ("envelope".equals(line.path("type").asText())) {
                frame.put("kind", "message");
                frame.put("name", "sent".equals(direction) ? line.path("to_name").asText(null)
                        : line.path("from_name").asText(null));
                frame.put("from", line.path("from_name").asText(null));
                frame.put("fromSession", line.path("from_session").asText(null));
                frame.put("fromMode", line.path("mode").asText(null));
                frame.put("toSession", line.path("to_session").asText(null));
                frame.put("summary", line.path("summary").asText(null));
                frame.put("text", line.path("text").asText(""));
            } else {
                frame.put("kind", "status");
                frame.put("status", line.path("status").asText(null));
                frame.put("reason", line.path("reason").asText(null));
            }
            frames.add(frame);
        }
        return frames;
    }
}
