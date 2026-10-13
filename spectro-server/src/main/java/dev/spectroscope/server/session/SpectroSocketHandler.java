package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.server.fleet.FleetAggregator;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * One agent and one session per WebSocket connection. The handler owns no run
 * state itself — it holds a SessionConnection per open socket and forwards the
 * three client messages (user_message / permission_response / abort) to it.
 * Incoming frames are parsed with Jackson, never by string matching (tool
 * inputs and client frames are untrusted input).
 */
@Component
public class SpectroSocketHandler extends TextWebSocketHandler {

    /** One shared configured mapper for the whole module (module convention). */
    private final ObjectMapper mapper = new ObjectMapper();

    /** The server-hosted fleet hub (opt-in) — every connection may tap it. */
    private final FleetAggregator fleet;

    /**
     * Who is live on this server (card 212). This map used to be the only place
     * that knew, and it is private with no accessor — which is exactly why a
     * browser could never draw a second run as live. The registry is the public
     * half of the same fact, and it also enforces one socket per session id.
     */
    private final LiveSessions liveSessions;

    /** Every session's browser (cards 201, 218, 226) — the precedence directory:
     *  the desktop pane when its shell is attached, the server's own headless
     *  Chrome for a {@code spectro web} reader otherwise, never both. */
    private final dev.spectroscope.server.browser.PrecedenceBrowserFaces browser;

    /** The operator's side of every session's browser (card 227): where a live
     *  session registers its recorder, its launch supervisor and its project
     *  folder for the view socket's control row and start page. */
    private final dev.spectroscope.server.browser.SessionBrowserBridge browserBridge;

    /** Per-connection state, keyed by the Spring session id. */
    private final Map<String, SessionConnection> connections = new ConcurrentHashMap<>();

    /** Card 580: reads the settings for a new connection; a test hands in its own. */
    private volatile java.util.function.Supplier<SpectroConfig> settingsLoader =
            () -> SpectroConfig.load(SpectroConfig.Overrides.none());

    /** @param loader card 580: what reads the settings for a new connection, for tests */
    void useSettingsLoader(java.util.function.Supplier<SpectroConfig> loader) {
        this.settingsLoader = loader;
    }

    SpectroSocketHandler(FleetAggregator fleet, LiveSessions liveSessions,
                         dev.spectroscope.server.browser.PrecedenceBrowserFaces browser,
                         dev.spectroscope.server.browser.SessionBrowserBridge browserBridge) {
        this.fleet = fleet;
        this.liveSessions = liveSessions;
        this.browser = browser;
        this.browserBridge = browserBridge;
    }

    /**
     * A new socket becomes a new SessionConnection — config is loaded fresh per
     * connection, an optional {@code ?resume=<id>} reopens a stored session.
     *
     * @param socket the freshly opened WebSocket session; its id keys the connection map
     */
    @Override
    public void afterConnectionEstablished(WebSocketSession socket) {
        // ?resume=<id> reopens an old session from the JSONL store; absent = new.
        String resumeId = queryParam(socket, "resume");
        // Card 580: the write count before the read, so a write during it
        // still reaches this connection once it listens.
        long settingsWrites = liveSessions == null ? 0 : liveSessions.settingsWrites();
        // Config + provider + system prompt exactly as the CLI builds them.
        SpectroConfig config = settingsLoader.get();
        SessionConnection connection =
                new SessionConnection(socket, mapper, config, resumeId, fleet, liveSessions);
        connection.settingsReadAfter(settingsWrites);
        // The session's browser (cards 201, 226). The precedence directory
        // resolves per call: the desktop pane when a shell is attached, the
        // server's headless Chrome for a web reader otherwise. Each face reads
        // card 199's opt-in itself, so the fence is the same on every half
        // whether or not a session socket ever opened.
        connection.useBrowser(browser);
        // Card 227: and at the bridge the view socket reads, so the operator's
        // control row and start page can reach THIS session's recorder,
        // supervisor and folder the moment it has an id.
        connection.useBrowserBridge(browserBridge);
        connections.put(socket.getId(), connection);
        // A resume that cannot load its session closes the socket itself — and
        // so does a resume of a session another socket already holds.
        connection.start();
    }

    /**
     * Routes one client frame to the connection owning the socket: parsed as JSON
     * first, then dispatched on {@code type} — non-JSON and unknown types answer
     * a readable error event instead of throwing.
     *
     * @param socket the sending socket, resolved to its SessionConnection
     * @param message the raw text frame from the browser — untrusted input
     */
    @Override
    protected void handleTextMessage(WebSocketSession socket, TextMessage message) {
        SessionConnection connection = connections.get(socket.getId());
        if (connection == null) {
            return;
        }
        JsonNode frame;
        try {
            frame = mapper.readTree(message.getPayload());
        } catch (Exception invalid) {
            connection.sendError("Invalid message (not JSON).");
            return;
        }
        // Never run the agent loop on this Tomcat thread — SessionConnection
        // hands the work to a virtual thread and returns immediately.
        switch (frame.path("type").asText()) {
            // user_message may carry an additive attachments array
            // ({ mediaType, dataBase64 }) — decoded and stored by the connection.
            case "user_message" -> connection.onUserMessage(
                    frame.path("text").asText(""), frame.path("attachments"));
            case "permission_response" ->
                    connection.onPermissionResponse(
                            frame.path("callId").asText(), frame.path("allowed").asBoolean(),
                            frame.path("remember").asBoolean(false),
                            frame.path("persist").asBoolean(false));
            // Card 265: the answer to a parked question. Its own frame, not a
            // wider permission_response — that one carries allowlist work
            // ("remember", "persist") which answering a question must not trigger.
            case "question_response" -> connection.onQuestionResponse(
                    frame.path("callId").asText(), answersOf(frame.path("answers")),
                    frame.path("cancelled").asBoolean(false));
            // Card 504: the stop button also ends the session's loop.
            case "abort" -> connection.onStopFrame();
            // Card 261: the browser's liveness probe. Answered here on the
            // socket thread and NOT forwarded to the connection's run state —
            // the whole value of the probe is that a busy agent cannot delay it.
            case "ping" -> connection.sendPong();
            case "set_image_provider" ->                       // additive
                    connection.onSetImageProvider(frame.path("provider").asText());
            case "set_thinking" ->                             // thinking, additive
                    connection.onSetThinking(frame.path("enabled").asBoolean());
            case "set_reasoning" ->                            // picker reasoning control, additive (card 88)
                    connection.onSetReasoning(
                            frame.path("mode").asText(""), frame.path("effort").asText(""));
            // Card 390: the window the operator sets for this session from the
            // ring. The node goes through untouched: the connection decides
            // what may be set, and absent or null clears.
            case "set_window_override" ->                      // additive
                    connection.onSetWindowOverride(frame.path("tokens"));
            case "set_provider" ->                             // provider picker, additive
                    connection.onSetProvider(
                            frame.path("provider").asText(""), frame.path("model").asText(""),
                            frame.path("ask").asText(""));                 // card 556: echoed in the answer
            case "set_workspace" ->                            // workspace chooser: random | default | set
                    connection.onSetWorkspace(frame.path("mode").asText("set"), frame.path("path").asText(""));
            case "set_permission_mode" ->                      // composer gear, additive
                    connection.onSetPermissionMode(frame.path("mode").asText(""));
            // Card 466: the composer gear's tool groups. The node goes through
            // untouched: the connection decides what may be switched off.
            case "set_tool_groups_off" ->                      // composer gear, additive
                    connection.onSetToolGroupsOff(frame.path("groups"),
                            frame.path("save").asBoolean(false));
            // Card 493: the composer gear's Local mode switch. The frame goes
            // through untouched: the connection checks every part of it.
            case "set_local_mode" ->                           // composer gear, additive
                    connection.onSetLocalMode(frame);
            // Card 267: the operator states what this run is FOR and the command
            // that decides it. From a person at a browser, never from the model —
            // there is no goal tool in any registry, on purpose.
            case "set_goal" ->                                 // additive
                    connection.onSetGoal(frame.path("outcome").asText(""),
                            frame.path("check").asText(""));
            // Card 380: the operator hands the running turn one sentence. Its
            // own frame rather than a user_message, because a user_message
            // starts a run and this one starts nothing: it puts a line where
            // the loop reads it at its next safe point. The same separation
            // card 265 drew for question_response, and for the same reason.
            case "steering_message" ->                         // additive (card 380)
                    connection.onSteeringMessage(frame.path("text").asText(""));
            // Card 502: the operator's Deliver or Decline on a message another
            // agent sent while this session was idle and of another permission
            // class. From a person at a browser, never from a model.
            case "peer_message_decision" ->                    // additive (card 502)
                    connection.onPeerMessageDecision(frame.path("msgId").asText(""),
                            frame.path("deliver").asBoolean(false));
            // Card 503: the operator's own message from the page, a Reply in
            // the chat. From a person at a browser, never from a model.
            case "send_peer_message" ->                        // additive (card 503)
                    connection.onSendPeerMessage(frame.path("to").asText(null),
                            frame.path("toSession").asText(null), frame.path("text").asText(""));
            // Card 471: the web chat's two commands. Their own frames rather
            // than a user_message with a slash in it, because a command never
            // reaches the model as a prompt; the composer decides from the
            // whole draft that it is one.
            case "compact_context" -> connection.onCompactContext(); // additive (card 471)
            case "clear_context" -> connection.onClearContext();     // additive (card 471)
            // Card 554: /run-with-playbook <prompt> asks for the confirmation
            // sheet of the session's playbook; the answer is playbook_confirm.
            case "confirm_playbook" -> connection.onConfirmPlaybook(  // additive (card 554)
                    frame.path("dir").isTextual() ? frame.path("dir").asText() : null,
                    frame.path("prompt").asText(""));
            // Card 482: the confirmation sheet's Start. The hash is the one the
            // sheet showed; the connection refuses when the folder moved since.
            // Card 554: the prompt is the run's task and is required.
            // Card 584: picks, optional, are the models picked in the sheet per
            // step for this run; untrusted, the connection checks them again.
            // The second fix round: ask, optional, is the page's id for this
            // start; a refusal of the start answers it.
            case "start_playbook" -> connection.onStartPlaybook(frame.path("dir").asText(""),
                    frame.path("hash").asText(""), frame.path("prompt").asText(""), frame.path("picks"),
                    frame.path("ask").isTextual() ? frame.path("ask").asText() : null);
            // Card 554: the owner picked a playbook for this session (the
            // header dropdown or /playbook use). Absent or null withdraws it;
            // with none true it is the explicit "No playbook" (decision b).
            case "set_playbook" -> connection.onSetPlaybook(          // additive (card 554)
                    frame.path("dir").isTextual() ? frame.path("dir").asText() : null,
                    frame.path("none").asBoolean(false));
            // Card 506: Run on a workflow of the playbook module, with the
            // hash the module listed and the text typed beside it.
            // Card 554: from the chat a workflow is named, not listed with a
            // hash, and runs at once; the frame then carries name instead of
            // file and hash, and dir only when the page names one.
            case "start_workflow" -> {                                            // additive (card 506)
                if (frame.has("name")) {
                    connection.onStartWorkflowByName(
                            frame.path("dir").isTextual() ? frame.path("dir").asText() : null,
                            frame.path("name").asText(""), frame.path("input").asText(""),
                            frame.path("lang").asText("en"));
                } else {
                    connection.onStartWorkflow(frame.path("dir").asText(""),
                            frame.path("file").asText(""), frame.path("hash").asText(""),
                            frame.path("input").asText(""), frame.path("lang").asText("en"));
                }
            }
            // Card 498: a click into the message box of a stored session. Binds
            // the session to this socket and announces its folder; starts no
            // run and calls no model.
            case "wake_session" ->                             // additive (card 498)
                    connection.onWakeSession(frame.path("sessionId").asText(""));
            // Card 504: /loop from the chat and Stop on the loop chip. From a
            // person at a browser; the model paces a loop with schedule_wakeup.
            case "set_loop" -> connection.onSetLoop(frame);   // additive (card 504)
            // Card 558: the page asks for the session's skills, commands and
            // agents; the answer is session_items. Reads only.
            case "get_session_items" -> connection.onGetSessionItems(); // additive (card 558)
            case "graph_ask" -> connection.onGraphAsk(frame.path("question").asText("")); // additive (card 587)
            default -> connection.sendError("Unknown message type.");
        }
    }

    /**
     * The answers of a {@code question_response} frame, read defensively — the
     * frame is untrusted input like every other, and a malformed answers array is
     * an empty list rather than a throw on the socket thread.
     *
     * @param answers the frame's {@code answers} node, of any shape
     * @return one string per answer, in order; empty when the node holds none
     */
    private static java.util.List<String> answersOf(JsonNode answers) {
        if (!answers.isArray()) {
            return java.util.List.of();
        }
        java.util.List<String> out = new java.util.ArrayList<>();
        answers.forEach(answer -> out.add(answer.asText("")));
        return java.util.List.copyOf(out);
    }

    /**
     * Drops the per-connection state when the socket goes away and lets the
     * connection cancel its run — the session's JSONL file deliberately survives.
     *
     * @param socket the closed socket whose connection entry is removed
     * @param status the container's close code — cleanup is unconditional, so unused
     */
    @Override
    public void afterConnectionClosed(WebSocketSession socket, CloseStatus status) {
        // Socket gone is not session gone: the JSONL file lives on. Cancel any
        // running run and release orphaned permission questions.
        SessionConnection connection = connections.remove(socket.getId());
        if (connection != null) {
            connection.onClose();
        }
    }

    /**
     * Reads one query parameter from the socket's handshake URI — no servlet
     * request exists on a WebSocket, so the query string is split by hand.
     *
     * @param socket the socket whose connect URI carries the query string
     * @param name the parameter to look up
     * @return the raw parameter value, or {@code null} when absent
     */
    private static String queryParam(WebSocketSession socket, String name) {
        String query = socket.getUri() != null ? socket.getUri().getQuery() : null;
        if (query == null) {
            return null;
        }
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            if (eq > 0 && pair.substring(0, eq).equals(name)) {
                return pair.substring(eq + 1);
            }
        }
        return null;
    }
}
