package dev.spectroscope.server.browser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.browser.BrowserFace;
import dev.spectroscope.core.browser.headless.HeadlessBrowserFace;
import dev.spectroscope.core.net.NetFence;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The picture channel of the web face (card 226): {@code /ws/browser-view}.
 *
 * <p>The web UI's browser segment connects here to SEE the headless browser
 * and to drive it by hand — the two things the desktop operator gets from the
 * native pane. Frames come from CDP's own screencast; input and navigation go
 * back down the same session's face; and when the desktop pane is live, this
 * channel says so and drives nothing, because one browser per session means
 * exactly one.
 *
 * <h2>The wire, client to server</h2>
 *
 * <pre>
 * {"type":"watch","sessionId":s}     subscribe; a state frame answers, and the
 *                                    cast starts if that session has a page open
 * {"type":"unwatch"}                 stop watching
 * {"type":"navigate","sessionId":s,"url":u}
 * {"type":"back","sessionId":s}      {"type":"forward","sessionId":s}
 * {"type":"input","sessionId":s, ...browser_computer's own argument names}
 *                                    action, coordinate, ref, text,
 *                                    scroll_direction, scroll_amount, duration
 * </pre>
 *
 * <h2>The wire, server to client</h2>
 *
 * <pre>
 * {"type":"state","sessionId":s,"live":"desktop"|"web"|"none",
 *  "url":string|null,"attached":bool}
 * {"type":"frame","sessionId":s,"format":"jpeg","dataBase64":...,
 *  "deviceWidth":n,"deviceHeight":n,"ts":n}
 * {"type":"verb","verb":...,"ok":bool,"error"?,"url"?,"title"?,"detail"?}
 * {"type":"refused","sentence":...}   a fence refusal, or the desktop being live
 * {"type":"error","sentence":...}     a frame this handler could not read
 * </pre>
 *
 * <p><b>What this channel trusts</b> is what {@code /ws} trusts: loopback plus
 * an accepted Origin, nothing more — stated in {@code docs/BROWSER.md} beside
 * the same statement for the control channel. Input carries no permission
 * gate, deliberately: it is the operator's own hand, the exact parity of
 * clicking inside the desktop pane. A NAVIGATE is fenced like everything else
 * that dials, and the refusal sentence goes back where the operator typed.
 */
@Component
public class BrowserViewSocket extends TextWebSocketHandler {

    private static final Logger LOG = LoggerFactory.getLogger(BrowserViewSocket.class);
    private static final ObjectMapper JSON = new ObjectMapper();

    /** The widest frame worth casting — the segment scales it down anyway. */
    static final int MAX_FRAME_WIDTH = 1280;
    static final int MAX_FRAME_HEIGHT = 800;

    private final PrecedenceBrowserFaces faces;

    /** Which session each viewer socket is watching. */
    private final Map<String, String> watching = new ConcurrentHashMap<>();

    /** The one viewer per session — the newest wins, like shells on /ws/browser. */
    private final Map<String, WebSocketSession> viewers = new ConcurrentHashMap<>();

    /**
     * @param faces the precedence directory: which face is live, whose page,
     *              and the fence for typed addresses
     */
    public BrowserViewSocket(PrecedenceBrowserFaces faces) {
        this.faces = faces;
        // A face flip is news every watcher wants NOW: the segment that was
        // showing frames goes dark the moment the desktop takes over.
        faces.onFlip(() -> viewers.forEach((sessionId, viewer) ->
                send(viewer, state(sessionId))));
    }

    /**
     * One frame from the viewer.
     *
     * @param socket  the viewer's socket
     * @param message the frame
     */
    @Override
    public void handleTextMessage(WebSocketSession socket, TextMessage message) {
        JsonNode frame;
        try {
            frame = JSON.readTree(message.getPayload());
        } catch (IOException notJson) {
            send(socket, error("this channel speaks JSON frames"));
            return;
        }
        String type = frame.path("type").asText("");
        String sessionId = frame.path("sessionId").asText("");
        switch (type) {
            case "watch" -> watch(socket, sessionId);
            case "unwatch" -> unwatch(socket);
            case "navigate" -> navigate(socket, sessionId, frame.path("url").asText(""));
            case "back", "forward" -> verb(socket, sessionId, type, JSON.createObjectNode());
            case "input" -> input(socket, sessionId, frame);
            default -> send(socket, error("this channel does not know the frame type \""
                    + type.substring(0, Math.min(40, type.length())) + "\""));
        }
    }

    private void watch(WebSocketSession socket, String sessionId) {
        if (sessionId.isBlank()) {
            send(socket, error("watch needs the sessionId whose browser to show"));
            return;
        }
        String previous = watching.put(socket.getId(), sessionId);
        if (previous != null && !previous.equals(sessionId)) {
            stopCastIfOurs(socket, previous);
        }
        WebSocketSession replaced = viewers.put(sessionId, socket);
        if (replaced != null && !replaced.getId().equals(socket.getId())) {
            send(replaced, error("another viewer took over this session's browser"));
        }
        send(socket, state(sessionId));
        startCastIfLive(socket, sessionId);
    }

    private void unwatch(WebSocketSession socket) {
        String sessionId = watching.remove(socket.getId());
        if (sessionId != null) {
            stopCastIfOurs(socket, sessionId);
        }
    }

    private void navigate(WebSocketSession socket, String sessionId, String url) {
        if (refuseUnlessWebIsLive(socket, sessionId, "navigate")) {
            return;
        }
        NetFence.Refusal refusal = faces.judgeNavigate(url);
        if (refusal != null) {
            send(socket, JSON.createObjectNode()
                    .put("type", "refused")
                    .put("sentence", refusal.sentence()));
            return;
        }
        verb(socket, sessionId, "navigate", JSON.createObjectNode().put("url", url));
        send(socket, state(sessionId));
        startCastIfLive(socket, sessionId);
    }

    private void input(WebSocketSession socket, String sessionId, JsonNode frame) {
        if (refuseUnlessWebIsLive(socket, sessionId, "input")) {
            return;
        }
        ObjectNode args = frame.deepCopy();
        args.remove("type");
        args.remove("sessionId");
        verb(socket, sessionId, "input", args);
    }

    /** Runs one verb on the session's live face and answers a verb frame. */
    private void verb(WebSocketSession socket, String sessionId, String verb, JsonNode args) {
        if (sessionId.isBlank()) {
            send(socket, error(verb + " needs a sessionId"));
            return;
        }
        if (refuseUnlessWebIsLive(socket, sessionId, verb)) {
            return;
        }
        BrowserFace.Reply reply = faces.forSession(sessionId).send(verb, args);
        ObjectNode answer = JSON.createObjectNode();
        answer.put("type", "verb");
        answer.put("verb", verb);
        answer.put("ok", reply.ok());
        if (!reply.ok()) {
            answer.put("error", reply.error());
        } else if (reply.value() != null) {
            reply.value().fields().forEachRemaining(field ->
                    answer.set(field.getKey(), field.getValue()));
        }
        send(socket, answer);
    }

    /**
     * The one-browser rule at the wire: with the desktop pane live, this
     * channel drives nothing and says whose the browser is.
     *
     * @return true when the caller must stop
     */
    private boolean refuseUnlessWebIsLive(WebSocketSession socket, String sessionId,
            String what) {
        if ("web".equals(faces.live())) {
            return false;
        }
        String sentence = "desktop".equals(faces.live())
                ? "the desktop pane is live for this session — one browser per session, "
                        + "and the desktop face wins; watch it in the desktop app"
                : "no browser engine can serve this " + what + ": no desktop pane is "
                        + "attached and no Chrome/Chromium was found on the server";
        send(socket, JSON.createObjectNode().put("type", "refused").put("sentence", sentence));
        return true;
    }

    /** Starts the cast for a watcher when the web face is live and has a page. */
    private void startCastIfLive(WebSocketSession socket, String sessionId) {
        if (!socket.getId().equals(viewerIdFor(sessionId))) {
            return;
        }
        HeadlessBrowserFace face = faces.webFace(sessionId);
        if (face == null || !face.hasPage()) {
            return;
        }
        try {
            face.startScreencast(params -> relay(sessionId, params),
                    MAX_FRAME_WIDTH, MAX_FRAME_HEIGHT);
        } catch (RuntimeException castFailed) {
            send(socket, error("the screencast could not start: " + castFailed.getMessage()));
        }
    }

    private String viewerIdFor(String sessionId) {
        WebSocketSession viewer = viewers.get(sessionId);
        return viewer == null ? null : viewer.getId();
    }

    private void stopCastIfOurs(WebSocketSession socket, String sessionId) {
        WebSocketSession viewer = viewers.get(sessionId);
        if (viewer != null && viewer.getId().equals(socket.getId())) {
            viewers.remove(sessionId);
            HeadlessBrowserFace face = faces.webFace(sessionId);
            if (face != null) {
                face.stopScreencast();
            }
        }
    }

    /** One screencast frame to the session's viewer — already acked by the face. */
    private void relay(String sessionId, JsonNode params) {
        WebSocketSession viewer = viewers.get(sessionId);
        if (viewer == null || !viewer.isOpen()) {
            return;
        }
        JsonNode metadata = params.path("metadata");
        ObjectNode frame = JSON.createObjectNode();
        frame.put("type", "frame");
        frame.put("sessionId", sessionId);
        frame.put("format", "jpeg");
        frame.put("dataBase64", params.path("data").asText(""));
        frame.put("deviceWidth", metadata.path("deviceWidth").asInt(0));
        frame.put("deviceHeight", metadata.path("deviceHeight").asInt(0));
        frame.put("ts", metadata.path("timestamp").asDouble(0));
        send(viewer, frame);
    }

    /** The state frame: whose browser, which face, what address. */
    private ObjectNode state(String sessionId) {
        ObjectNode state = JSON.createObjectNode();
        state.put("type", "state");
        state.put("sessionId", sessionId);
        state.put("live", faces.live());
        state.put("attached", faces.attached());
        String url = faces.forSession(sessionId).pageUrl();
        if (url == null) {
            state.putNull("url");
        } else {
            state.put("url", url);
        }
        return state;
    }

    private static ObjectNode error(String sentence) {
        ObjectNode error = JSON.createObjectNode();
        error.put("type", "error");
        error.put("sentence", sentence);
        return error;
    }

    private void send(WebSocketSession socket, ObjectNode frame) {
        try {
            synchronized (socket) {
                socket.sendMessage(new TextMessage(frame.toString()));
            }
        } catch (IOException | RuntimeException gone) {
            LOG.debug("a browser viewer went away mid-send", gone);
        }
    }

    /**
     * A viewer disconnected: its watch ends and its cast stops.
     *
     * @param socket the viewer's socket
     * @param status why it closed
     */
    @Override
    public void afterConnectionClosed(WebSocketSession socket, CloseStatus status) {
        unwatch(socket);
    }
}
