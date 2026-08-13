package dev.spectroscope.server.browser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.browser.BrowserFace;
import dev.spectroscope.core.browser.BrowserFaces;
import dev.spectroscope.server.session.FakeSocket;

import org.junit.jupiter.api.Test;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;

import java.time.Duration;
import java.util.concurrent.CompletableFuture;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;

/**
 * The control channel, once a browser belongs to a session (card 218).
 *
 * <p>Card 201 shipped one channel carrying one pane, so every session's tool
 * calls addressed the same page. What this pins is the addressing: which session
 * a command is for travels on the wire, the shell's answer is filed under that
 * session, and closing one session says so without waiting for anybody.
 */
class BrowserControlSocketSessionTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** A session id shaped like the store's own: stamp plus a uuid8. */
    private static final String A = "20260813-120000-aaaaaaaa";
    private static final String B = "20260813-130000-bbbbbbbb";

    @Test
    void everyCommandNamesTheSessionItIsFor() throws Exception {
        FakeSocket shell = attachedShell();
        BrowserControlSocket control = attach(shell);

        JsonNode frame = drive(control, shell, A, "{\"title\":\"A's page\"}",
                "http://localhost:5173/a").frame();

        assertEquals(A, frame.path("sessionId").asText(),
                "the shell cannot key a browser to a session it was never told: " + frame);
        assertEquals("navigate", frame.path("verb").asText());
    }

    @Test
    void twoSessionsKeepTheirOwnPage() throws Exception {
        FakeSocket shell = attachedShell();
        BrowserControlSocket control = attach(shell);

        drive(control, shell, A, "{}", "http://localhost:5173/a");
        drive(control, shell, B, "{}", "http://localhost:5173/b");

        assertEquals("http://localhost:5173/a", control.forSession(A).pageUrl());
        assertEquals("http://localhost:5173/b", control.forSession(B).pageUrl(),
                "one session's answer must not overwrite the other's");
    }

    @Test
    void aRefusalFromTheShellComesBackAsARefusal() throws Exception {
        // Found live, not by reading: while the address moved into a per-session
        // map this class stopped reading the shell's `ok`, and every refusal the
        // pane produced — "no page is open in this session's browser yet" among
        // them — arrived as a success with an empty value, which BrowserTools
        // renders to the model as the word "undefined". A tool that reports
        // nothing wrong when the browser said what was wrong is worse than one
        // that fails.
        FakeSocket shell = attachedShell();
        BrowserControlSocket control = attach(shell);

        BrowserFace.Reply reply = answer(control, shell, A,
                "{\"ok\":false,\"error\":\"no page is open in this session's browser yet\","
                        + "\"pageUrl\":null}");

        assertFalse(reply.ok(), "the shell refused and the face said it worked");
        assertNotNull(reply.error());
        assertTrue(reply.error().contains("no page is open"), reply.error());
    }

    @Test
    void closingASessionSaysSoAndDoesNotWaitForAnybody() {
        FakeSocket shell = attachedShell();
        BrowserControlSocket control = attach(shell);

        // No reply is ever fed, and this must still return: the close runs on the
        // thread that is tearing a socket down. Waiting 45 s for a shell that may
        // already be gone would hold that thread for the whole deadline.
        assertTimeoutPreemptively(Duration.ofSeconds(5), () -> control.closeSession(A));

        String sent = shell.textJoined();
        assertTrue(sent.contains("close_session"), sent);
        assertTrue(sent.contains(A), sent);
    }

    @Test
    void aClosedSessionForgetsWhereItsBrowserWas() throws Exception {
        FakeSocket shell = attachedShell();
        BrowserControlSocket control = attach(shell);
        drive(control, shell, A, "{}", "http://localhost:5173/a");
        assertNotNull(control.forSession(A).pageUrl());

        control.closeSession(A);

        assertNull(control.forSession(A).pageUrl(),
                "a session that is gone has no address for a failure sentence to name");
    }

    @Test
    void anAddressFiledByAReplacedShellDoesNotSurviveTheReplacement() throws Exception {
        // Measured in review: /ws/browser authenticates nothing and the newest
        // connection wins, which is in policy — but a client that took the
        // channel, answered one frame with a pageUrl of its choosing and left,
        // leaked that address into the REAL shell. afterConnectionClosed only
        // cleared the map when the closing socket was still the current one, and
        // a replaced socket never is: the replacement had already taken the field
        // before its close arrived. The operator's address line, and every
        // browser tool's "names the page it happened on" sentence, then cited a
        // page nothing was showing.
        FakeSocket first = attachedShell();
        BrowserControlSocket control = attach(first);
        drive(control, first, A, "{}", "http://rogue.invalid/");
        assertEquals("http://rogue.invalid/", control.forSession(A).pageUrl(),
                "the first shell really filed an address");

        FakeSocket replacement = new FakeSocket("shell-2", "ws://127.0.0.1:8746/ws/browser");
        control.afterConnectionEstablished(replacement);
        // The replaced socket's close arrives afterwards, which is the whole
        // point: by then it is no longer the shell, so it clears nothing.
        control.afterConnectionClosed(first, CloseStatus.NORMAL);

        assertNull(control.forSession(A).pageUrl(),
                "an address filed by a shell that is gone outlived it");
    }

    @Test
    void theEmptyDirectoryHandsOutADetachedFacePerSession() {
        BrowserFaces none = BrowserFaces.none();

        BrowserFace face = none.forSession(A);

        assertFalse(none.attached());
        assertFalse(face.attached());
        assertNull(face.pageUrl());
        assertFalse(face.send("navigate", JSON.createObjectNode()).ok());
        none.closeSession(A);   // a directory with nothing in it closes nothing, loudly or not
    }

    // ---- the harness ---------------------------------------------------------

    /** One command sent and answered, with the frame the shell saw. */
    private record Exchange(JsonNode frame, BrowserFace.Reply reply) {}

    /** Every frame the shell has been sent, one per line, in order. */
    private static String[] frames(FakeSocket shell) {
        String joined = shell.textJoined();
        return joined.isEmpty() ? new String[0] : joined.split("\n");
    }

    private static FakeSocket attachedShell() {
        return new FakeSocket("shell-1", "ws://127.0.0.1:8746/ws/browser");
    }

    private static BrowserControlSocket attach(FakeSocket shell) {
        BrowserControlSocket control = new BrowserControlSocket();
        control.useSettings(() -> true, () -> false);
        control.afterConnectionEstablished(shell);
        return control;
    }

    /**
     * Sends one navigate for a session and answers it as the shell would.
     *
     * <p>{@code send} blocks on the reply, so the command goes on its own thread
     * and this one plays the shell: read the frame, answer its id.
     */
    private Exchange drive(BrowserControlSocket control, FakeSocket shell,
            String sessionId, String value, String pageUrl) throws Exception {
        return exchange(control, shell, sessionId, frameId ->
                "{\"id\":\"" + frameId + "\",\"ok\":true,\"value\":" + value
                        + ",\"pageUrl\":\"" + pageUrl + "\"}");
    }

    /**
     * Sends one navigate and answers it with a whole frame of the test's choosing.
     *
     * @param control the channel
     * @param shell   the socket playing the shell
     * @param session whose browser
     * @param body    the reply frame, without its id
     * @return the reply the face produced
     */
    private BrowserFace.Reply answer(BrowserControlSocket control, FakeSocket shell,
            String session, String body) throws Exception {
        return exchange(control, shell, session, frameId ->
                "{\"id\":\"" + frameId + "\"," + body.substring(1)).reply();
    }

    /**
     * Sends one navigate, waits for it to reach the shell, and answers it.
     *
     * @param control   the channel
     * @param shell     the socket playing the shell
     * @param sessionId whose browser
     * @param answer    builds the reply frame from the command's id
     * @return the frame the shell saw and the reply the face produced
     */
    private Exchange exchange(BrowserControlSocket control, FakeSocket shell,
            String sessionId, java.util.function.Function<String, String> answer)
            throws Exception {
        int before = frames(shell).length;
        CompletableFuture<BrowserFace.Reply> sent = CompletableFuture.supplyAsync(() ->
                control.forSession(sessionId)
                        .send("navigate", JSON.createObjectNode()
                                .put("url", "http://localhost:5173/")));
        String raw = null;
        for (int wait = 0; wait < 200 && raw == null; wait++) {
            String[] seen = frames(shell);
            if (seen.length > before) {
                raw = seen[before];
            } else {
                Thread.sleep(10);
            }
        }
        assertNotNull(raw, "the command never reached the shell");
        JsonNode frame = JSON.readTree(raw);
        control.handleTextMessage(shell,
                new TextMessage(answer.apply(frame.path("id").asText())));
        return new Exchange(frame, sent.get());
    }
}
