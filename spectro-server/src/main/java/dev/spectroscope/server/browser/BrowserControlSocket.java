package dev.spectroscope.server.browser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.browser.BrowserFace;

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
 * <p>This class is also the {@link BrowserFace} the tools hold — one object, so
 * "is a browser attached" is answered by the socket that would carry the command
 * rather than by a flag somebody has to remember to clear.
 */
@Component
public class BrowserControlSocket extends TextWebSocketHandler implements BrowserFace {

    private static final Logger LOG = LoggerFactory.getLogger(BrowserControlSocket.class);
    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * How long one verb may take. Longer than the pane's own 30 s budget, so a
     * timeout here means the CHANNEL died rather than the page being slow — the
     * pane answers its own slow page with a sentence naming the URL.
     */
    static final Duration DEADLINE = Duration.ofSeconds(45);

    private volatile WebSocketSession shell;
    private volatile String pageUrl;
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
            pageUrl = null;
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
        if (frame.hasNonNull("pageUrl")) {
            pageUrl = frame.path("pageUrl").asText();
        }
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

    /** @return the address the pane is showing, or null when nothing is open */
    @Override
    public String pageUrl() {
        return pageUrl;
    }

    /**
     * Sends one verb and waits for its reply.
     *
     * @param verb the verb, from {@link BrowserFace}'s own list
     * @param args the verb's arguments
     * @return the reply, never null
     */
    @Override
    public Reply send(String verb, JsonNode args) {
        WebSocketSession current = shell;
        if (current == null || !current.isOpen()) {
            return Reply.failed(BrowserFace.DETACHED, pageUrl);
        }
        String id = UUID.randomUUID().toString();
        ObjectNode frame = JSON.createObjectNode();
        frame.put("id", id);
        frame.put("verb", verb);
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
            return Reply.failed("the control channel to the browser pane broke: "
                    + notSent.getMessage(), pageUrl);
        }
        JsonNode reply;
        try {
            reply = waiting.get(DEADLINE.toMillis(), TimeUnit.MILLISECONDS);
        } catch (TimeoutException tooSlow) {
            pending.remove(id);
            return Reply.failed("the browser pane did not answer within "
                    + DEADLINE.toSeconds() + " s", pageUrl);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            pending.remove(id);
            return Reply.failed("the wait for the browser pane was interrupted", pageUrl);
        } catch (java.util.concurrent.ExecutionException impossible) {
            pending.remove(id);
            return Reply.failed("the browser pane failed: " + impossible.getMessage(), pageUrl);
        }
        if (reply == null) {
            return Reply.failed("the browser pane disconnected before it answered", pageUrl);
        }
        String url = reply.hasNonNull("pageUrl") ? reply.path("pageUrl").asText() : pageUrl;
        if (!reply.path("ok").asBoolean(false)) {
            return Reply.failed(reply.path("error").asText("the browser pane refused"), url);
        }
        JsonNode value = reply.path("value");
        return Reply.ok(value.isMissingNode() ? JSON.createObjectNode() : value, url);
    }
}
