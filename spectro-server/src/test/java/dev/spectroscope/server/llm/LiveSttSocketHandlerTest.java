package dev.spectroscope.server.llm;

import dev.spectroscope.server.session.FakeSocket;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The live transcription socket: what it refuses, what it forwards, and what it
 * takes with it when the browser goes away.
 *
 * <p>No network anywhere in here. The upstream is a seam for the same reason
 * {@code CommandRunner} and {@link HostedStt} are seams — a test that needs a key
 * and a provider is a test nobody runs.</p>
 */
class LiveSttSocketHandlerTest {

    /** An upstream that records what it was told and replays what a test wants. */
    private static final class FakeUpstream implements LiveSttUpstream {
        final List<String> sent = new ArrayList<>();
        boolean opened;
        boolean closed;
        Listener listener;

        @Override
        public Link open(Listener listener) {
            this.opened = true;
            this.listener = listener;
            return new Link() {
                @Override
                public void send(String frame) {
                    sent.add(frame);
                }

                @Override
                public void close() {
                    closed = true;
                }
            };
        }

        /** Pretend the far side said something. */
        void says(String raw) {
            listener.onFrame(raw);
        }
    }

    private LiveSttSocketHandler handlerFor(FakeUpstream upstream, SttRoute route, String key) {
        return new LiveSttSocketHandler(
                () -> new LiveSttSocketHandler.Setup(route, key, LiveSttProtocol.DEFAULT_MODEL),
                upstream);
    }

    @Test
    void aLocalRouteIsRefusedByNameAndNothingIsOpened() throws Exception {
        // The rule with teeth: someone who chose the offline route does not get
        // their audio sent to a provider because they wanted live text. The
        // reason is named so the UI can say which of the two things is wrong.
        FakeUpstream upstream = new FakeUpstream();
        FakeSocket socket = new FakeSocket("s1", "ws://localhost:8080/ws/stt");

        handlerFor(upstream, SttRoute.LOCAL, "sk-real").afterConnectionEstablished(socket);

        assertTrue(socket.textJoined().contains("\"reason\":\"localRoute\""));
        assertFalse(upstream.opened, "no audio may leave on a route that did not ask for it");
        assertNotNull(socket.closed.get(), "a socket that cannot work says so and ends");
    }

    @Test
    void theHostedRouteWithoutAKeyIsItsOwnRefusal() throws Exception {
        FakeUpstream upstream = new FakeUpstream();
        FakeSocket socket = new FakeSocket("s2", "ws://localhost:8080/ws/stt");

        handlerFor(upstream, SttRoute.HOSTED, "  ").afterConnectionEstablished(socket);

        assertTrue(socket.textJoined().contains("\"reason\":\"noKey\""));
        assertFalse(upstream.opened);
    }

    @Test
    void aWorkingRouteOpensUpstreamAndConfiguresItBeforeAnyAudio() throws Exception {
        FakeUpstream upstream = new FakeUpstream();
        FakeSocket socket = new FakeSocket("s3", "ws://localhost:8080/ws/stt");

        handlerFor(upstream, SttRoute.HOSTED, "sk-real").afterConnectionEstablished(socket);

        assertTrue(upstream.opened);
        assertEquals(1, upstream.sent.size(), "exactly the session update, nothing else yet");
        assertTrue(upstream.sent.get(0).contains("\"type\":\"session.update\""));
        assertTrue(upstream.sent.get(0).contains("24000"));
    }

    @Test
    void audioSpokenBeforeTheSessionIsReadyIsHeldAndThenSent() throws Exception {
        // Appending before session.updated means the samples are graded against
        // whatever the session defaulted to — a rate we did not choose. Holding
        // is the honest fix; dropping would lose the first word of every take.
        FakeUpstream upstream = new FakeUpstream();
        FakeSocket socket = new FakeSocket("s4", "ws://localhost:8080/ws/stt");
        LiveSttSocketHandler handler = handlerFor(upstream, SttRoute.HOSTED, "sk-real");
        handler.afterConnectionEstablished(socket);

        handler.handleTextMessage(socket, new TextMessage("{\"type\":\"audio\",\"data\":\"AQID\"}"));
        assertEquals(1, upstream.sent.size(), "still only the session update");

        upstream.says("{\"type\":\"session.updated\"}");

        assertEquals(2, upstream.sent.size(), "the held audio went up on ready");
        assertTrue(upstream.sent.get(1).contains("input_audio_buffer.append"));
        assertTrue(upstream.sent.get(1).contains("AQID"));
    }

    @Test
    void deltasReachTheBrowserAsPartialsAndTheTranscriptAsFinal() throws Exception {
        FakeUpstream upstream = new FakeUpstream();
        FakeSocket socket = new FakeSocket("s5", "ws://localhost:8080/ws/stt");
        handlerFor(upstream, SttRoute.HOSTED, "sk-real").afterConnectionEstablished(socket);

        upstream.says("{\"type\":\"session.updated\"}");
        upstream.says("{\"type\":\"conversation.item.input_audio_transcription.delta\","
                + "\"delta\":\" hello\"}");
        upstream.says("{\"type\":\"conversation.item.input_audio_transcription.completed\","
                + "\"transcript\":\"Hello there.\"}");

        String down = socket.textJoined();
        assertTrue(down.contains("\"type\":\"partial\""), down);
        assertTrue(down.contains("\" hello\""), down);
        assertTrue(down.contains("\"type\":\"final\""), down);
        assertTrue(down.contains("Hello there."), down);
    }

    @Test
    void anUpstreamErrorArrivesAsAnErrorAndNeverAsText() throws Exception {
        // Typing the provider's complaint into the composer as if the user had
        // said it is the failure this closes.
        FakeUpstream upstream = new FakeUpstream();
        FakeSocket socket = new FakeSocket("s6", "ws://localhost:8080/ws/stt");
        handlerFor(upstream, SttRoute.HOSTED, "sk-real").afterConnectionEstablished(socket);

        upstream.says("{\"type\":\"error\",\"error\":{\"message\":\"rate limit reached\"}}");

        String down = socket.textJoined();
        assertTrue(down.contains("\"type\":\"error\""), down);
        assertTrue(down.contains("rate limit reached"), down);
        assertFalse(down.contains("\"type\":\"partial\""), down);
    }

    @Test
    void lettingGoOfTheButtonCommitsTheBuffer() throws Exception {
        FakeUpstream upstream = new FakeUpstream();
        FakeSocket socket = new FakeSocket("s7", "ws://localhost:8080/ws/stt");
        LiveSttSocketHandler handler = handlerFor(upstream, SttRoute.HOSTED, "sk-real");
        handler.afterConnectionEstablished(socket);
        upstream.says("{\"type\":\"session.updated\"}");

        handler.handleTextMessage(socket, new TextMessage("{\"type\":\"commit\"}"));

        assertTrue(upstream.sent.stream().anyMatch(f -> f.contains("input_audio_buffer.commit")));
    }

    @Test
    void theUpstreamDiesWithTheBrowserSocket() throws Exception {
        // An upstream that outlives the page is a metered connection nobody is
        // watching. The same lesson the desktop shell paid for with a spawned
        // child that hung on no shutdown hook.
        FakeUpstream upstream = new FakeUpstream();
        FakeSocket socket = new FakeSocket("s8", "ws://localhost:8080/ws/stt");
        LiveSttSocketHandler handler = handlerFor(upstream, SttRoute.HOSTED, "sk-real");
        handler.afterConnectionEstablished(socket);

        handler.afterConnectionClosed(socket, CloseStatus.NORMAL);

        assertTrue(upstream.closed);
    }

    @Test
    void anUnreadableFrameFromTheBrowserDoesNotKillTheSession() throws Exception {
        // A socket that dies on a malformed frame takes the recording with it.
        FakeUpstream upstream = new FakeUpstream();
        FakeSocket socket = new FakeSocket("s9", "ws://localhost:8080/ws/stt");
        LiveSttSocketHandler handler = handlerFor(upstream, SttRoute.HOSTED, "sk-real");
        handler.afterConnectionEstablished(socket);
        upstream.says("{\"type\":\"session.updated\"}");

        handler.handleTextMessage(socket, new TextMessage("not json at all"));
        handler.handleTextMessage(socket, new TextMessage("{\"type\":\"audio\",\"data\":\"AQID\"}"));

        assertTrue(upstream.sent.stream().anyMatch(f -> f.contains("AQID")),
                "the session kept working after the bad frame");
    }
}
