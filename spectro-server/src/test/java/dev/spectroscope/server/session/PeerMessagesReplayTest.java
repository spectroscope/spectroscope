package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.peer.MessagesSidecar;
import dev.spectroscope.core.peer.PeerEnvelope;
import dev.spectroscope.core.peer.PeerStatus;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 503, criterion 9 at the server: a stored session's
 * {@code .messages.jsonl} comes back as {@code peer_message} frames, one per
 * line, in the order of the file, for the page to fold through the same
 * reducer case as a live one.
 */
class PeerMessagesReplayTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void everySidecarLineBecomesOneFrame(@TempDir Path dir) {
        MessagesSidecar sidecar = new MessagesSidecar(dir);
        String session = "20261011-120000-abcdef12";
        PeerEnvelope in = PeerEnvelope.builder().msgId("m1").from("uds:/x.sock/s2").fromSession("s2")
                .fromName("Other-01").fromMode("bypass").toSession(session).text("which files?")
                .summary("which files?").build();
        PeerEnvelope out = PeerEnvelope.builder().msgId("m2").from("uds:/y.sock/" + session)
                .fromSession(session).fromName("ForgeDemo-a1").toSession("s2").text("Parser.java")
                .summary("Parser.java").build();
        sidecar.envelope(session, "received", in, "ForgeDemo-a1");
        sidecar.status(session, "received", "m1", PeerStatus.DELIVERED, "this session's model has the message");
        sidecar.envelope(session, "sent", out, "Other-01");
        sidecar.status(session, "sent", "m2", PeerStatus.HELD, "held");

        List<Map<String, Object>> frames = PeerMessagesReplay.frames(sidecar, session);
        assertThat(frames).hasSize(4);
        JsonNode first = JSON.valueToTree(frames.get(0));
        assertThat(first.path("type").asText()).isEqualTo("peer_message");
        assertThat(first.path("kind").asText()).isEqualTo("message");
        assertThat(first.path("direction").asText()).isEqualTo("received");
        assertThat(first.path("msgId").asText()).isEqualTo("m1");
        assertThat(first.path("from").asText()).isEqualTo("Other-01");
        assertThat(first.path("fromSession").asText()).isEqualTo("s2");
        assertThat(first.path("text").asText()).isEqualTo("which files?");
        assertThat(first.path("replay").asBoolean()).isTrue();
        JsonNode third = JSON.valueToTree(frames.get(2));
        assertThat(third.path("direction").asText()).isEqualTo("sent");
        assertThat(third.path("name").asText()).isEqualTo("Other-01");
        JsonNode fourth = JSON.valueToTree(frames.get(3));
        assertThat(fourth.path("kind").asText()).isEqualTo("status");
        assertThat(fourth.path("status").asText()).isEqualTo("held");
        assertThat(PeerMessagesReplay.frames(sidecar, "../etc")).isEmpty();
        assertThat(PeerMessagesReplay.frames(sidecar, "20261011-130000-00000000")).isEmpty();
    }
}
