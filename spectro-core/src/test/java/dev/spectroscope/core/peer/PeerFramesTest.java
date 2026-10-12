package dev.spectroscope.core.peer;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Card 502 criteria 3 and 4: the frames and their framing. */
class PeerFramesTest {

    private static Set<String> fields(JsonNode node) {
        Set<String> names = new TreeSet<>();
        node.fieldNames().forEachRemaining(names::add);
        return names;
    }

    private static PeerEnvelope envelope() {
        return PeerEnvelope.builder().msgId(PeerFrames.newMsgId()).toSession("20261011-100000-0000aaaa")
                .from("uds:/tmp/x/1.sock").fromSession("20261011-090000-abcdef12").fromName("ForgeDemo-7f")
                .fromMode("bypass").hopChain(List.of("0123456789abcdef01234567")).priority("next")
                .text("hello").summary("hi").build();
    }

    @Test
    void aMessageFrameCarriesTheFieldsOfTheConcept() {
        JsonNode frame = PeerFrames.message(envelope());
        assertEquals(Set.of("type", "msg_id", "to_session", "from", "from_session", "from_name", "from_mode",
                "hop_chain", "priority", "text", "summary"), fields(frame));
        assertEquals("message", frame.get("type").asText());
    }

    @Test
    void everyMessageCarriesAUuid() {
        String id = PeerFrames.newMsgId();
        assertEquals(id, UUID.fromString(id).toString());
        assertFalse(id.equals(PeerFrames.newMsgId()));
    }

    @Test
    void aMessageFrameReadsBackToTheSameEnvelope() {
        PeerEnvelope sent = envelope();
        assertEquals(sent, PeerFrames.envelope(PeerFrames.message(sent)));
    }

    @Test
    void aStatusFrameEchoesTheMessageIdAsOrigMsgId() {
        JsonNode status = PeerFrames.status("abc-1", "20261011-090000-abcdef12", PeerStatus.DROPPED,
                "uds:/tmp/y/2.sock", DropReason.DUPLICATE, "detail");
        assertEquals("peer_message_status", status.get("type").asText());
        assertEquals("abc-1", status.get("orig_msg_id").asText());
        assertEquals("dropped", status.get("status").asText());
        assertEquals("duplicate", status.get("drop_reason").asText());
        assertEquals(DropReason.DUPLICATE.text(), status.get("reason").asText());
        assertFalse(status.has("msg_id"));
    }

    @Test
    void theSixStatusesAreTheConceptsSix() {
        assertEquals(List.of("held", "denied", "expired", "delivered", "refused", "dropped"),
                List.of(PeerStatus.values()).stream().map(PeerStatus::wireName).toList());
    }

    @Test
    void theIdleRenameAndSubscriptionFramesHaveTheirFields() {
        assertEquals(Set.of("type", "msg_id", "from", "from_session", "from_mode", "to_session"),
                fields(PeerFrames.notifyWhenIdle("m1", "uds:/a", "s1", "prompting", "s2")));
        assertEquals(Set.of("type", "orig_msg_id", "state", "finished_at", "detail", "from", "from_session"),
                fields(PeerFrames.idleNotice("m1", "idle", 1L, "done", "uds:/b", "s2")));
        assertEquals(Set.of("type", "name", "old_name", "session"),
                fields(PeerFrames.rename("s2", "ForgeDemo-7f", "ForgeDemo-quiet-otter")));
    }

    @Test
    void theFirstFrameIsAuth() {
        JsonNode auth = PeerFrames.auth("t0k3n", 4711, "2026-10-11T08:00:00.000Z");
        assertEquals("auth", auth.get("type").asText());
        assertEquals("t0k3n", auth.get("token").asText());
        assertEquals(4711, auth.get("pid").asLong());
    }

    @Test
    void aLineAtTheCapIsReadAndOneCharacterMoreClosesTheConnection() throws IOException {
        String atCap = "x".repeat(PeerLimits.LINE_CAP_CHARS);
        LineReader reader = new LineReader(new ByteArrayInputStream((atCap + "\n").getBytes(StandardCharsets.UTF_8)));
        assertEquals(atCap, reader.readLine());
        assertNull(reader.readLine());
        LineReader tooLong = new LineReader(new ByteArrayInputStream(
                (atCap + "y\n").getBytes(StandardCharsets.UTF_8)));
        assertThrows(LineReader.LineTooLong.class, tooLong::readLine);
    }

    @Test
    void linesAreUtf8AndNewlineDelimited() throws IOException {
        LineReader reader = new LineReader(new ByteArrayInputStream(
                "{\"a\":\"Grüße\"}\n{\"b\":1}\n".getBytes(StandardCharsets.UTF_8)));
        assertEquals("{\"a\":\"Grüße\"}", reader.readLine());
        assertEquals("{\"b\":1}", reader.readLine());
        assertNull(reader.readLine());
    }

    @Test
    void anUnknownOrBrokenLineIsNotAFrame() {
        assertTrue(PeerFrames.parse("{\"type\":\"launch_missiles\"}").isEmpty());
        assertTrue(PeerFrames.parse("not json").isEmpty());
        assertTrue(PeerFrames.parse("{\"type\":\"message\"}").isPresent());
    }
}
