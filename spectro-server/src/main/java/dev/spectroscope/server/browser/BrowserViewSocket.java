package dev.spectroscope.server.browser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.browser.BrowserFace;
import dev.spectroscope.core.browser.headless.HeadlessBrowserFace;
import dev.spectroscope.core.net.NetFence;
import dev.spectroscope.core.wire.BrowserWireTap;

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
 * {"type":"screenshot","sessionId":s}
 * {"type":"input","sessionId":s, ...browser_computer's own argument names}
 *                                    action, coordinate, ref, text,
 *                                    scroll_direction, scroll_amount, duration
 * {"type":"launch_list","sessionId":s}          the start page's data (card 227)
 * {"type":"launch_play","sessionId":s,"name":n} start a configuration and open it
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
 * {"type":"refused","sentence":...}   a fence refusal, the desktop being live,
 *                                     or an agent call holding the browser
 * {"type":"error","sentence":...}     a frame this handler could not read
 * {"type":"launch_configs","sessionId":s,"ok":bool,"sentence"?,
 *  "configs":[{"name","address","attaches","up","exitCode"?}],"skipped":n,
 *  "location"?,"shadowed"?:[...]}   which launch file answered, card 350
 * {"type":"launch_played","sessionId":s,"name":n,"ok":bool,"up":bool,
 *  "url"?,"sentence"?}
 * </pre>
 *
 * <h2>Who may drive, per face (card 227)</h2>
 *
 * <p>NAVIGATION verbs — {@code navigate}, {@code back}, {@code forward}, the
 * play button — run on whichever face is live, desktop pane included: the
 * desktop face's control row is React above the native hole, and its verbs
 * travel this channel to the SAME per-session browser the agent drives.
 * {@code input} stays web-face-only: on the desktop face the operator's hand
 * is on the real pane, and a second synthetic driver is exactly the race the
 * one-browser rule exists to prevent. {@code screenshot} is read-only and
 * serves both faces.
 *
 * <p><b>The fight rule (criterion 5, pinned on the card):</b> while an AGENT
 * browser call is in flight for a session, every operator driving verb answers
 * one terse {@code refused} sentence instead of interleaving; between calls
 * the operator drives freely. Screenshot, watching and the launch listing pass
 * — they race nothing.
 *
 * <p><b>What is recorded (criterion 4):</b> every operator NAVIGATION records
 * through the session's own {@code .browser.jsonl} recorder — same file, same
 * epoch as the agent's calls — with the additive {@code actor:"operator"}
 * field, so a replay can never attribute a human's address to the model.
 * Operator {@code input} is deliberately NOT recorded: the desktop pane does
 * not record a human hand on the page either, and a sidecar that logged every
 * operator keystroke would be a keylogger, not a trace.
 *
 * <p><b>What this channel trusts</b> is what {@code /ws} trusts: loopback plus
 * an accepted Origin, nothing more — stated in {@code docs/BROWSER.md} beside
 * the same statement for the control channel. Input carries no permission
 * gate, deliberately: it is the operator's own hand, the exact parity of
 * clicking inside the desktop pane. A NAVIGATE is fenced like everything else
 * that dials, and the refusal sentence goes back where the operator typed.
 * {@code launch_play} runs a configuration the project's own launch file
 * names, as the operator's click — the same trust as typing into the app's
 * terminal, and the same lifetime: what it starts dies with the session.
 */
@Component
public class BrowserViewSocket extends TextWebSocketHandler {

    private static final Logger LOG = LoggerFactory.getLogger(BrowserViewSocket.class);
    private static final ObjectMapper JSON = new ObjectMapper();

    /** The widest frame worth casting — the segment scales it down anyway. */
    static final int MAX_FRAME_WIDTH = 1280;
    static final int MAX_FRAME_HEIGHT = 800;

    /** The fight rule's one terse sentence (card 227, criterion 5). */
    static final String AGENT_DRIVING = "an agent browser call is in flight for this "
            + "session — the controls unlock when it returns";

    private final PrecedenceBrowserFaces faces;

    /** The live sessions' recorders, supervisors and folders (card 227). */
    private final SessionBrowserBridge bridge;

    /** Which session each viewer socket is watching. */
    private final Map<String, String> watching = new ConcurrentHashMap<>();

    /** The one viewer per session — the newest wins, like shells on /ws/browser. */
    private final Map<String, WebSocketSession> viewers = new ConcurrentHashMap<>();

    /**
     * @param faces  the precedence directory: which face is live, whose page,
     *               and the fence for typed addresses
     * @param bridge the live sessions' browser-side collaborators — the
     *               sidecar tap, the launch supervisor, the project folder,
     *               and the fight rule's in-flight answer
     */
    public BrowserViewSocket(PrecedenceBrowserFaces faces, SessionBrowserBridge bridge) {
        this.faces = faces;
        this.bridge = bridge;
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
            case "back", "forward" -> history(socket, sessionId, type);
            case "screenshot" -> screenshot(socket, sessionId);
            case "input" -> input(socket, sessionId, frame);
            case "launch_list" -> launchList(socket, sessionId);
            case "launch_play" -> launchPlay(socket, sessionId, frame.path("name").asText(""));
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
        if (replaced != null && !replaced.getId().equals(socket.getId())
                && "web".equals(faces.live())) {
            // Only where a cast was actually lost. With the desktop face live
            // both windows merely read state, and "took over" would be a
            // sentence about nothing (card 227: the shell window watches too).
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
        if (sessionId.isBlank()) {
            send(socket, error("navigate needs a sessionId"));
            return;
        }
        if (refuseWhenNoEngine(socket, "navigate") || refuseWhileAgentDrives(socket, sessionId)) {
            return;
        }
        NetFence.Refusal refusal = faces.judgeNavigate(url);
        if (refusal != null) {
            send(socket, refused(refusal.sentence()));
            return;
        }
        recorded(sessionId, "navigate", JSON.createObjectNode().put("url", url),
                () -> faces.forSession(sessionId).send("navigate",
                        JSON.createObjectNode().put("url", url)),
                reply -> answerVerb(socket, "navigate", reply));
        send(socket, state(sessionId));
        startCastIfLive(socket, sessionId);
    }

    /** back/forward: the two verbs that exist only for a person (card 227). */
    private void history(WebSocketSession socket, String sessionId, String direction) {
        if (sessionId.isBlank()) {
            send(socket, error(direction + " needs a sessionId"));
            return;
        }
        if (refuseWhenNoEngine(socket, direction) || refuseWhileAgentDrives(socket, sessionId)) {
            return;
        }
        recorded(sessionId, direction, JSON.createObjectNode(),
                () -> faces.forSession(sessionId).send(direction, JSON.createObjectNode()),
                reply -> answerVerb(socket, direction, reply));
        send(socket, state(sessionId));
        startCastIfLive(socket, sessionId);
    }

    /** The screenshot control: read-only, so no fight gate and no record. */
    private void screenshot(WebSocketSession socket, String sessionId) {
        if (sessionId.isBlank()) {
            send(socket, error("screenshot needs a sessionId"));
            return;
        }
        if (refuseWhenNoEngine(socket, "screenshot")) {
            return;
        }
        answerVerb(socket, "screenshot",
                faces.forSession(sessionId).send("screenshot", JSON.createObjectNode()));
    }

    private void input(WebSocketSession socket, String sessionId, JsonNode frame) {
        if (sessionId.isBlank()) {
            send(socket, error("input needs a sessionId"));
            return;
        }
        if (refuseUnlessWebIsLive(socket, "input") || refuseWhileAgentDrives(socket, sessionId)) {
            return;
        }
        ObjectNode args = frame.deepCopy();
        args.remove("type");
        args.remove("sessionId");
        answerVerb(socket, "input", faces.forSession(sessionId).send("input", args));
    }

    /**
     * One operator navigation, recorded around its run (criterion 4): the call
     * line lands before the engine moves, the result line closes it with what
     * came back — the exact arrangement the agent's tools have, through the
     * SAME recorder, so the two kinds of line share a file and an epoch.
     *
     * @param sessionId whose browser and whose record
     * @param verbName  the verb, which is also the recorded tool name
     * @param input     the operator's arguments, as recorded
     * @param run       runs the verb on the live face
     * @param answer    sends the verb's answer to the operator
     */
    private void recorded(String sessionId, String verbName, ObjectNode input,
            java.util.function.Supplier<BrowserFace.Reply> run,
            java.util.function.Consumer<BrowserFace.Reply> answer) {
        BrowserWireTap.Call record = tapFor(sessionId).open(verbName, null, null, input,
                faces.forSession(sessionId).pageUrl(), BrowserWireTap.OPERATOR);
        BrowserFace.Reply reply = run.get();
        record.end(reply.ok(), reply.ok() ? String.valueOf(reply.value()) : reply.error(),
                reply.pageUrl());
        answer.accept(reply);
    }

    /** The session's sidecar tap, or the detached one for a session not open here. */
    private BrowserWireTap tapFor(String sessionId) {
        SessionBrowserBridge.Live live = bridge.live(sessionId);
        return live == null || live.tap() == null ? BrowserWireTap.none() : live.tap();
    }

    /** Sends one verb's reply as a verb frame. */
    private void answerVerb(WebSocketSession socket, String verb, BrowserFace.Reply reply) {
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
     * The one-browser rule for INPUT: with the desktop pane live, synthetic
     * input does not race the operator's own hand on the real pane.
     *
     * @return true when the caller must stop
     */
    private boolean refuseUnlessWebIsLive(WebSocketSession socket, String what) {
        if ("web".equals(faces.live())) {
            return false;
        }
        String sentence = "desktop".equals(faces.live())
                ? "the desktop pane is live for this session — one browser per session, "
                        + "and the desktop face wins; watch it in the desktop app"
                : "no browser engine can serve this " + what + ": no desktop pane is "
                        + "attached and no Chrome/Chromium was found on the server";
        send(socket, refused(sentence));
        return true;
    }

    /**
     * The navigation verbs run on WHICHEVER face is live (card 227) — only a
     * server with no engine at all refuses.
     *
     * @return true when the caller must stop
     */
    private boolean refuseWhenNoEngine(WebSocketSession socket, String what) {
        if (!"none".equals(faces.live())) {
            return false;
        }
        send(socket, refused("no browser engine can serve this " + what + ": no desktop "
                + "pane is attached and no Chrome/Chromium was found on the server"));
        return true;
    }

    /**
     * The fight rule (criterion 5): an agent call in flight holds the browser.
     *
     * @return true when the caller must stop
     */
    private boolean refuseWhileAgentDrives(WebSocketSession socket, String sessionId) {
        if (!bridge.agentDriving(sessionId)) {
            return false;
        }
        send(socket, refused(AGENT_DRIVING));
        return true;
    }

    private static ObjectNode refused(String sentence) {
        return JSON.createObjectNode().put("type", "refused").put("sentence", sentence);
    }

    // ---- the start page's two verbs (card 227, criterion 2) ----------------

    /** What this session's project can start, with what is up NOW. */
    private void launchList(WebSocketSession socket, String sessionId) {
        ObjectNode answer = JSON.createObjectNode();
        answer.put("type", "launch_configs");
        answer.put("sessionId", sessionId);
        SessionBrowserBridge.Live live = bridge.live(sessionId);
        if (live == null) {
            answer.put("ok", false);
            answer.put("sentence", "this session is not open on this server");
            send(socket, answer);
            return;
        }
        java.nio.file.Path project = live.projectDir().get();
        if (project == null) {
            answer.put("ok", false);
            answer.put("sentence", "this session has no project folder yet");
            send(socket, answer);
            return;
        }
        java.util.Optional<dev.spectroscope.core.launch.LaunchFile> read;
        try {
            read = dev.spectroscope.core.launch.LaunchFile.readFrom(project);
        } catch (IllegalArgumentException unreadable) {
            answer.put("ok", false);
            // The reader names the location it failed on (card 350: there are two
            // now), so a prefix here would be a guess about which one that was.
            answer.put("sentence", unreadable.getMessage());
            send(socket, answer);
            return;
        }
        answer.put("ok", true);
        com.fasterxml.jackson.databind.node.ArrayNode configs = answer.putArray("configs");
        int skipped = 0;
        if (read.isPresent()) {
            skipped = read.get().skipped();
            // Card 350: the operator is told WHICH of the two files answered, and
            // which one it shadowed. A precedence nobody can see is the silent
            // disagreement the card exists to prevent.
            answer.put("location", read.get().location());
            com.fasterxml.jackson.databind.node.ArrayNode shadowed =
                    answer.putArray("shadowed");
            read.get().shadowed().forEach(shadowed::add);
            for (dev.spectroscope.core.launch.LaunchEntry entry : read.get().entries()) {
                ObjectNode row = configs.addObject();
                row.put("name", entry.name());
                String address = entry.address();
                if (address == null) {
                    row.putNull("address");
                } else {
                    row.put("address", address);
                }
                row.put("attaches", entry.attaches());
                boolean up = live.launches().running(entry.name()).isPresent();
                row.put("up", up);
                live.launches().exited(entry.name())
                        .ifPresent(gone -> row.put("exitCode", gone.code()));
            }
        }
        answer.put("skipped", skipped);
        send(socket, answer);
    }

    /**
     * The play button: bring one configuration up through the SESSION's own
     * supervisor (its lifetime stays the session's, card 202), then point the
     * session's browser at it — fenced, recorded as the operator's navigation.
     *
     * <p>On a virtual thread, because a start legitimately waits for a port
     * (up to the supervisor's budget) and this handler must not hold the
     * socket's thread for it.
     */
    private void launchPlay(WebSocketSession socket, String sessionId, String name) {
        if (sessionId.isBlank() || name.isBlank()) {
            send(socket, error("launch_play needs a sessionId and a configuration name"));
            return;
        }
        SessionBrowserBridge.Live live = bridge.live(sessionId);
        if (live == null) {
            send(socket, played(sessionId, name, false, false, null,
                    "this session is not open on this server"));
            return;
        }
        if (bridge.agentDriving(sessionId)) {
            send(socket, played(sessionId, name, false, false, null, AGENT_DRIVING));
            return;
        }
        java.nio.file.Path project = live.projectDir().get();
        if (project == null) {
            send(socket, played(sessionId, name, false, false, null,
                    "this session has no project folder yet"));
            return;
        }
        Thread.startVirtualThread(() -> runPlay(socket, sessionId, name, live, project));
    }

    /** The play's slow half — everything after the guards, off the socket thread. */
    private void runPlay(WebSocketSession socket, String sessionId, String name,
            SessionBrowserBridge.Live live, java.nio.file.Path project) {
        dev.spectroscope.core.launch.LaunchEntry entry;
        try {
            java.util.Optional<dev.spectroscope.core.launch.LaunchFile> read =
                    dev.spectroscope.core.launch.LaunchFile.readFrom(project);
            entry = read.flatMap(file -> file.find(name)).orElse(null);
        } catch (IllegalArgumentException unreadable) {
            send(socket, played(sessionId, name, false, false, null,
                    unreadable.getMessage()));
            return;
        }
        if (entry == null) {
            send(socket, played(sessionId, name, false, false, null,
                    "no configuration of that name in "
                            + dev.spectroscope.core.launch.LaunchFile.LOCATIONS_SENTENCE));
            return;
        }
        dev.spectroscope.core.launch.LaunchSupervisor.Outcome outcome = live.launches()
                .start(entry, project, dev.spectroscope.core.launch.LaunchSupervisor.DEFAULT_BUDGET);
        if (!outcome.ok()) {
            send(socket, played(sessionId, name, false, false, null, outcome.problem()));
            return;
        }
        String address = outcome.running().address();
        NetFence.Refusal refusal = faces.judgeNavigate(address);
        if (refusal != null) {
            // Card 202's split, held here too: the server is UP, the browser
            // stays away, and the sentence is the fence's own — it names the
            // one setting between the operator and the page.
            send(socket, played(sessionId, name, false, true, null, refusal.sentence()));
            return;
        }
        if ("none".equals(faces.live())) {
            send(socket, played(sessionId, name, false, true, null,
                    "the configuration is up, and no browser engine can open it: no desktop "
                            + "pane is attached and no Chrome/Chromium was found on the server"));
            return;
        }
        recorded(sessionId, "navigate", JSON.createObjectNode().put("url", address),
                () -> faces.forSession(sessionId).send("navigate",
                        JSON.createObjectNode().put("url", address)),
                reply -> send(socket, played(sessionId, name, reply.ok(), true,
                        reply.ok() ? (reply.pageUrl() == null ? address : reply.pageUrl()) : null,
                        reply.ok() ? null : reply.error())));
        send(socket, state(sessionId));
        WebSocketSession viewer = viewers.get(sessionId);
        if (viewer != null) {
            send(viewer, state(sessionId));
            startCastIfLive(viewer, sessionId);
        }
    }

    /** One launch_played frame. */
    private static ObjectNode played(String sessionId, String name, boolean ok, boolean up,
            String url, String sentence) {
        ObjectNode frame = JSON.createObjectNode();
        frame.put("type", "launch_played");
        frame.put("sessionId", sessionId);
        frame.put("name", name);
        frame.put("ok", ok);
        frame.put("up", up);
        if (url != null) {
            frame.put("url", url);
        }
        if (sentence != null) {
            frame.put("sentence", sentence);
        }
        return frame;
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
