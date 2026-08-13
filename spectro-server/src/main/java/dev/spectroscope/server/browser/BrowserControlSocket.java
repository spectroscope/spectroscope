package dev.spectroscope.server.browser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.browser.BrowserFace;
import dev.spectroscope.core.browser.BrowserFaces;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.BooleanSupplier;

/**
 * The control channel to the visible browser (cards 200 and 201).
 *
 * <p><b>Which way it points, and why.</b> The Electron main process opens this
 * socket back to the server rather than the server reaching into the shell.
 * Card 200 section 9.3 left the shape open and recommended exactly this: the
 * alternative is a preload script plus {@code ipcMain}, and
 * {@code navigationGuard.ts} names "this shell has no preload script at all" as
 * a security property rather than an omission. A main-process client keeps that
 * property intact.
 *
 * <p><b>One shell at a time.</b> A second connection replaces the first, because
 * two panes answering one verb would give the agent whichever reply arrived
 * first and the operator whichever pane he happened to be looking at. The
 * replaced shell is closed politely.
 *
 * <p><b>Nothing here waits forever.</b> Every send parks a future with a
 * deadline. A shell that is killed mid-command, a page that never finishes
 * loading and a control channel that dies between the send and the reply all
 * become an {@code ERROR:} sentence on the next turn instead of an agent that
 * stopped.
 *
 * <p><b>One browser per SESSION, over this one channel (card 218).</b> The
 * channel stayed single because there is one shell; what changed is that every
 * command names the session it is for, and the shell keeps a browser per name.
 * This class is therefore a {@link BrowserFaces} directory rather than a single
 * {@link BrowserFace}: "is a shell attached" is answered by the socket that
 * would carry the command, and "what is my page" is answered per session.
 *
 * <p>The key is always the server's own session id. Nothing a model writes and
 * nothing a remote caller posts can choose it, which is what keeps two sessions
 * from reaching each other through the tool surface.
 */
@Component
public class BrowserControlSocket extends TextWebSocketHandler implements BrowserFaces {

    private static final Logger LOG = LoggerFactory.getLogger(BrowserControlSocket.class);
    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * How long one verb may take. Longer than the pane's own 30 s budget, so a
     * timeout here means the CHANNEL died rather than the page being slow — the
     * pane answers its own slow page with a sentence naming the URL.
     */
    static final Duration DEADLINE = Duration.ofSeconds(45);

    private volatile WebSocketSession shell;
    /**
     * The last address each session's browser reported, so a failure sentence
     * can name the page it happened on.
     *
     * <p>Per session, because card 201 kept one field and two sessions would
     * therefore have overwritten each other's address — the tools would have
     * named the wrong page in the one place the house rule says a failure must
     * name the right one.
     */
    private final Map<String, String> pageUrls = new ConcurrentHashMap<>();
    private final Map<String, CompletableFuture<JsonNode>> pending = new ConcurrentHashMap<>();

    /**
     * The net-fence opt-in and the filter-list switch, read fresh per command so
     * a setting saved mid-session lands on the next call rather than the next
     * launch.
     *
     * <p>These default to the REAL settings rather than to {@code false}/{@code
     * true} constants, and that is a correction a live run paid for: while the
     * defaults were constants and the true values were installed by whoever
     * opened a session socket, the shell's own request hook enforced a policy
     * the tools had already decided differently. The two halves of one fence
     * must not depend on an unrelated event having fired first, so the object
     * that owns the channel also owns the answer.
     */
    private volatile BooleanSupplier allowLocalhost =
            () -> dev.spectroscope.core.config.SpectroConfig
                    .load(dev.spectroscope.core.config.SpectroConfig.Overrides.none())
                    .allowLocalhost();

    /** The filter list, on unless the operator says otherwise. */
    private volatile BooleanSupplier adblock =
            () -> !"off".equalsIgnoreCase(String.valueOf(System.getenv("SPECTRO_BROWSER_ADBLOCK")));

    /**
     * Overrides where the two settings come from. A seam for tests and for a
     * face that resolves its configuration differently; production needs no
     * caller, because the defaults above already read the real thing.
     *
     * @param allowLocalhostSetting card 199's local-verify-loop opt-in
     * @param adblockSetting        whether the filter list is on
     */
    public void useSettings(BooleanSupplier allowLocalhostSetting, BooleanSupplier adblockSetting) {
        this.allowLocalhost = allowLocalhostSetting;
        this.adblock = adblockSetting;
    }

    /**
     * A desktop shell attached. The previous one, if any, is closed.
     *
     * @param session the shell's socket
     */
    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        WebSocketSession previous = shell;
        shell = session;
        if (previous != null && previous.isOpen() && !previous.getId().equals(session.getId())) {
            try {
                previous.close(CloseStatus.NORMAL.withReason("replaced by a newer browser pane"));
            } catch (IOException alreadyGone) {
                LOG.debug("the replaced browser shell was already gone", alreadyGone);
            }
        }
        LOG.info("browser control channel attached");
    }

    /**
     * The shell went away: every parked command fails now rather than at its
     * deadline, because a dead channel is knowable immediately.
     *
     * @param session the socket that closed
     * @param status  why it closed
     */
    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        if (shell != null && shell.getId().equals(session.getId())) {
            shell = null;
            // Every page in that shell died with it. Keeping the addresses would
            // let a tool name a page nothing is showing any more.
            pageUrls.clear();
        }
        pending.values().forEach(future -> future.complete(null));
        pending.clear();
        LOG.info("browser control channel detached ({})", status);
    }

    /**
     * One reply from the shell, matched to the command that is waiting for it.
     *
     * @param session the shell's socket
     * @param message the reply frame
     */
    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        JsonNode frame;
        try {
            frame = JSON.readTree(message.getPayload());
        } catch (IOException notJson) {
            LOG.debug("the browser shell sent something that is not JSON", notJson);
            return;
        }
        if (frame.has("hello")) {
            return; // the greeting carries no reply to match
        }
        String id = frame.path("id").asText(null);
        if (id == null) {
            return;
        }
        // The address is filed by the SENDER, in send() below, because only the
        // sender knows which session this reply belongs to: the frame carries the
        // command id, and matching it back to a session here would mean keeping a
        // second map for a fact send() already has in hand.
        CompletableFuture<JsonNode> waiting = pending.remove(id);
        if (waiting != null) {
            waiting.complete(frame);
        }
    }

    /** @return whether a desktop browser pane is attached right now */
    @Override
    public boolean attached() {
        WebSocketSession current = shell;
        return current != null && current.isOpen();
    }

    /**
     * The browser belonging to one session.
     *
     * <p>A thin view onto this one channel, not a second object with state of
     * its own: it holds the id and nothing else, so a face handed to a tool
     * cannot go stale when the shell reconnects underneath it.
     *
     * @param sessionId the session's store id
     * @return that session's face
     */
    @Override
    public BrowserFace forSession(String sessionId) {
        return new SessionFace(sessionId);
    }

    /**
     * Ends one session's browser in the shell.
     *
     * <p>Written straight to the socket without parking a future: this runs on
     * the thread tearing the session's own socket down, and a shell that has
     * already gone must not hold it for the 45 s deadline. Nothing here reads
     * the answer, because there is nothing to do with it — the browser is gone
     * either way, and the shell forgets an id it does not know.
     *
     * @param sessionId the session that closed
     */
    @Override
    public void closeSession(String sessionId) {
        pageUrls.remove(sessionId);
        WebSocketSession current = shell;
        if (current == null || !current.isOpen()) {
            return;
        }
        ObjectNode frame = JSON.createObjectNode();
        frame.put("id", UUID.randomUUID().toString());
        frame.put("verb", "close_session");
        frame.put("sessionId", sessionId);
        frame.set("args", JSON.createObjectNode());
        try {
            synchronized (this) {
                current.sendMessage(new TextMessage(JSON.writeValueAsString(frame)));
            }
        } catch (IOException | RuntimeException gone) {
            LOG.debug("the browser shell was gone before the session could be closed", gone);
        }
    }

    /**
     * Tells the shell where the browser segment is and whose browser the app is
     * showing there.
     *
     * <p>The one command whose session may legitimately be null: a page that has
     * not started a session yet still reserved a rectangle, and the rectangle
     * belongs to the WINDOW rather than to any session. The shell records it and
     * shows nobody.
     *
     * @param sessionId the session the app is showing, or null when it has none
     * @param args      the rectangle and whether the segment is on screen
     * @return the reply, never null
     */
    public BrowserFace.Reply viewport(String sessionId, JsonNode args) {
        return send(sessionId, "viewport", args);
    }

    /**
     * Sends one verb for one session and waits for its reply.
     *
     * @param sessionId whose browser this is, or null for the window-level
     *                  {@code viewport} command
     * @param verb      the verb, from {@link BrowserFace}'s own list
     * @param args      the verb's arguments
     * @return the reply, never null
     */
    BrowserFace.Reply send(String sessionId, String verb, JsonNode args) {
        String pageUrl = sessionId == null ? null : pageUrls.get(sessionId);
        WebSocketSession current = shell;
        if (current == null || !current.isOpen()) {
            return BrowserFace.Reply.failed(BrowserFace.DETACHED, pageUrl);
        }
        String id = UUID.randomUUID().toString();
        ObjectNode frame = JSON.createObjectNode();
        frame.put("id", id);
        frame.put("verb", verb);
        // Beside the args, never inside them: this is not one verb's argument,
        // it is who is asking, and the shell refuses a browser command that names
        // nobody.
        if (sessionId == null) {
            frame.putNull("sessionId");
        } else {
            frame.put("sessionId", sessionId);
        }
        frame.set("args", args == null ? JSON.createObjectNode() : args);
        ObjectNode settings = JSON.createObjectNode();
        settings.put("allowLocalhost", allowLocalhost.getAsBoolean());
        settings.put("adblock", adblock.getAsBoolean());
        frame.set("settings", settings);

        CompletableFuture<JsonNode> waiting = new CompletableFuture<>();
        pending.put(id, waiting);
        try {
            // One writer at a time: a WebSocketSession is not safe for concurrent
            // sends, and two agents in two sessions share this one channel.
            synchronized (this) {
                current.sendMessage(new TextMessage(JSON.writeValueAsString(frame)));
            }
        } catch (IOException | RuntimeException notSent) {
            pending.remove(id);
            return BrowserFace.Reply.failed("the control channel to the browser pane broke: "
                    + notSent.getMessage(), pageUrl);
        }
        JsonNode reply;
        try {
            reply = waiting.get(DEADLINE.toMillis(), TimeUnit.MILLISECONDS);
        } catch (TimeoutException tooSlow) {
            pending.remove(id);
            return BrowserFace.Reply.failed("the browser pane did not answer within "
                    + DEADLINE.toSeconds() + " s", pageUrl);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            pending.remove(id);
            return BrowserFace.Reply.failed("the wait for the browser pane was interrupted", pageUrl);
        } catch (java.util.concurrent.ExecutionException impossible) {
            pending.remove(id);
            return BrowserFace.Reply.failed("the browser pane failed: " + impossible.getMessage(), pageUrl);
        }
        if (reply == null) {
            return BrowserFace.Reply.failed("the browser pane disconnected before it answered", pageUrl);
        }
        String url = pageUrl;
        if (reply.hasNonNull("pageUrl")) {
            url = reply.path("pageUrl").asText();
            if (sessionId != null) {
                pageUrls.put(sessionId, url);
            }
        }
        // The shell's own verdict, and it must be read before the value: a
        // refusal carries an `error` and no `value`, so treating it as a success
        // hands the model an empty object that BrowserTools renders as
        // "undefined". Card 218 dropped this line while moving the address into
        // a per-session map, and the live drive is what found it — every
        // refusal the pane produced came back as a quiet success.
        if (!reply.path("ok").asBoolean(false)) {
            return BrowserFace.Reply.failed(
                    reply.path("error").asText("the browser pane refused"), url);
        }
        JsonNode value = reply.path("value");
        return BrowserFace.Reply.ok(value.isMissingNode() ? JSON.createObjectNode() : value, url);
    }

    /**
     * One session's view onto the channel — the {@link BrowserFace} the seven
     * tools hold.
     *
     * <p>It carries the id and nothing else. Every question it can be asked is
     * forwarded with that id attached, so there is no path from a tool to any
     * other session's browser: not a wrong argument, not a stale reference, not
     * a missing null check. That is the whole isolation argument on the Java
     * side, and it is one field long.
     *
     * @param sessionId the session this face belongs to
     */
    private final class SessionFace implements BrowserFace {

        private final String sessionId;

        private SessionFace(String sessionId) {
            this.sessionId = sessionId;
        }

        /** @return whether a desktop browser pane is attached right now */
        @Override
        public boolean attached() {
            return BrowserControlSocket.this.attached();
        }

        /** @return the address THIS session's browser is showing, or null */
        @Override
        public String pageUrl() {
            return pageUrls.get(sessionId);
        }

        /**
         * @param verb the verb, from {@link BrowserFace}'s own list
         * @param args the verb's arguments
         * @return the reply, never null
         */
        @Override
        public Reply send(String verb, JsonNode args) {
            return BrowserControlSocket.this.send(sessionId, verb, args);
        }
    }
}
