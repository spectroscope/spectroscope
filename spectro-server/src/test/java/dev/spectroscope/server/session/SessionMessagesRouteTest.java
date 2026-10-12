package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.peer.MessagesSidecar;
import dev.spectroscope.core.peer.PeerEnvelope;
import dev.spectroscope.core.peer.PeerStatus;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * Card 503, criterion 9 at the HTTP route: {@code GET /api/sessions/{id}/messages}
 * answers the frames of the session's sidecar under the user's
 * {@code ~/.spectro/messages}, in file order; an id of the wrong shape is a
 * 404; a session id without a sidecar answers an empty list.
 */
class SessionMessagesRouteTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private final MockMvc mvc = MockMvcBuilders.standaloneSetup(new SessionsController()).build();
    private final String session = "20261011-140000-" + UUID.randomUUID().toString().substring(0, 8);
    private final Path dir = Path.of(System.getProperty("user.home"), ".spectro", "messages");

    @AfterEach
    void removeSidecar() throws Exception {
        if (!Files.isDirectory(dir)) {
            return;
        }
        try (var files = Files.list(dir)) {
            for (Path file : files.filter(f -> f.getFileName().toString().startsWith(session)).toList()) {
                Files.deleteIfExists(file);
            }
        }
    }

    @Test
    void aRecordedSidecarComesBackAsItsFramesInOrder() throws Exception {
        MessagesSidecar sidecar = new MessagesSidecar(dir);
        PeerEnvelope in = PeerEnvelope.builder().msgId("m1").from("uds:/x.sock/s2").fromSession("s2")
                .fromName("Other-01").fromMode("prompting").toSession(session).text("which files?")
                .summary("which files?").build();
        PeerEnvelope out = PeerEnvelope.builder().msgId("m2").from("uds:/y.sock/" + session)
                .fromSession(session).fromName("ForgeDemo-a1").toSession("s2").text("Parser.java")
                .summary("Parser.java").build();
        sidecar.envelope(session, "received", in, "ForgeDemo-a1");
        sidecar.status(session, "received", "m1", PeerStatus.DELIVERED, "delivered");
        sidecar.envelope(session, "sent", out, "Other-01");

        MvcResult result = mvc.perform(get("/api/sessions/" + session + "/messages")).andReturn();
        assertThat(result.getResponse().getStatus()).isEqualTo(200);
        JsonNode frames = JSON.readTree(result.getResponse().getContentAsString());
        assertThat(frames.size()).isEqualTo(3);
        assertThat(frames.get(0).path("type").asText()).isEqualTo("peer_message");
        assertThat(frames.get(0).path("msgId").asText()).isEqualTo("m1");
        assertThat(frames.get(0).path("direction").asText()).isEqualTo("received");
        assertThat(frames.get(0).path("text").asText()).isEqualTo("which files?");
        assertThat(frames.get(1).path("kind").asText()).isEqualTo("status");
        assertThat(frames.get(1).path("status").asText()).isEqualTo("delivered");
        assertThat(frames.get(2).path("msgId").asText()).isEqualTo("m2");
        assertThat(frames.get(2).path("direction").asText()).isEqualTo("sent");
    }

    @Test
    void anIdOfTheWrongShapeIsNotFound() throws Exception {
        assertThat(mvc.perform(get("/api/sessions/-leading-hyphen/messages")).andReturn().getResponse()
                .getStatus()).isEqualTo(404);
        assertThat(mvc.perform(get("/api/sessions/a_b/messages")).andReturn().getResponse()
                .getStatus()).isEqualTo(404);
        assertThat(mvc.perform(get("/api/sessions/..%2F..%2Fetc/messages")).andReturn().getResponse()
                .getStatus()).isEqualTo(404);
    }

    @Test
    void aSessionWithoutASidecarAnswersAnEmptyList() throws Exception {
        MvcResult result = mvc.perform(get("/api/sessions/" + session + "/messages")).andReturn();
        assertThat(result.getResponse().getStatus()).isEqualTo(200);
        assertThat(JSON.readTree(result.getResponse().getContentAsString()).size()).isZero();
    }
}
