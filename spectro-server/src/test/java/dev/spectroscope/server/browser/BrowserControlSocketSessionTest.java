package dev.spectroscope.server.browser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.browser.BrowserFace;
import dev.spectroscope.core.browser.BrowserFaces;
import dev.spectroscope.server.session.FakeSocket;

import org.junit.jupiter.api.Test;
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
        int before = frames(shell).length;
        CompletableFuture<BrowserFace.Reply> sent = CompletableFuture.supplyAsync(() ->
                control.forSession(sessionId)
                        .send("navigate", JSON.createObjectNode().put("url", pageUrl)));
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
        control.handleTextMessage(shell, new TextMessage(
                "{\"id\":\"" + frame.path("id").asText() + "\",\"ok\":true,"
                        + "\"value\":" + value + ",\"pageUrl\":\"" + pageUrl + "\"}"));
        return new Exchange(frame, sent.get());
    }
}
