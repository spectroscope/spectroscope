package dev.spectroscope.server.session;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.web.socket.TextMessage;

import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 261, the server half of the liveness probe.
 *
 * <p>The browser cannot tell a socket whose peer vanished without a FIN from a
 * run that is thinking: both are silence on an OPEN socket. It can tell them
 * apart by asking, which only works if this end answers. So the contract is two
 * words wide — the client sends {@code ping}, this end answers {@code pong} —
 * and it is pinned on both sides: here, and in
 * {@code spectro-web/src/transport/ws.test.ts}, which asserts the client sends
 * the literal frame this test feeds in.</p>
 *
 * <p>What would otherwise rot silently: the probe answered by the {@code default}
 * arm ({@code "Unknown message type."}) still PROVES liveness, because any frame
 * at all does. A regression would therefore keep the watchdog working while
 * quietly writing an error into the operator's chat every fifteen seconds. That
 * is why the refusal is asserted against, not merely the reply asserted for.</p>
 *
 * <p>This test pins the NEW server only, which was the review's point: a client
 * carrying the probe can also meet an OLDER server that has no such case. The
 * client half of that guard lives in {@code ws.ts#isUnknownTypeError} — it stops
 * probing a peer that answers with the refusal — and the exact text is held
 * against this handler by
 * {@code spectro-web/src/transport/unknownTypeRefusal.drift.test.ts}.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionLivenessProbeTest {

    @Test
    void aProbeIsAnsweredWithAPongAndNeverWithTheUnknownTypeRefusal() {
        SpectroSocketHandler handler = new SpectroSocketHandler(null, null, null, null);
        FakeSocket socket = new FakeSocket("ws-261-probe", "ws://localhost/ws");
        handler.afterConnectionEstablished(socket);

        handler.handleTextMessage(socket, new TextMessage("{\"type\":\"ping\"}"));

        assertThat(socket.textJoined())
                .as("the probe the browser sends is a known frame, not an unknown one")
                .doesNotContain("Unknown message type");
        assertThat(socket.textJoined())
                .as("and it is answered, or the watchdog has nothing to hear")
                .contains("\"type\":\"pong\"");
    }

    @Test
    void theAnswerCarriesNothingAboutTheRunItDidNotTouch() {
        // A heartbeat that grew a payload would be a second wire to keep in
        // step with the frozen one. It carries when, and that is all.
        SpectroSocketHandler handler = new SpectroSocketHandler(null, null, null, null);
        FakeSocket socket = new FakeSocket("ws-261-shape", "ws://localhost/ws");
        handler.afterConnectionEstablished(socket);

        handler.handleTextMessage(socket, new TextMessage("{\"type\":\"ping\"}"));

        String pong = socket.textJoined().lines()
                .filter(line -> line.contains("\"pong\""))
                .findFirst()
                .orElseThrow();
        assertThat(pong).matches("\\{(\"type\":\"pong\"|\"ts\":\\d+)(,(\"type\":\"pong\"|\"ts\":\\d+))?}");
    }
}
