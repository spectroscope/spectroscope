package dev.spectroscope.server.llm;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import dev.spectroscope.core.wire.LlmWireRecorder;
import dev.spectroscope.core.wire.LlmWireTap;

import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.time.LocalDate;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;

/**
 * Text that appears while someone is still speaking (card 187 step 6).
 *
 * <p>The browser captures at {@code captureRate}, appends base64 PCM16 as it
 * goes, and this bridges it to the provider's realtime transcription session.
 * The key never leaves the server — which is the whole reason this is a socket
 * here rather than a socket the page opens itself.</p>
 *
 * <p><b>What it refuses, and why by name.</b> A local route is not upgraded to a
 * hosted one to satisfy a live setting: someone who chose the offline path did
 * not consent to their voice leaving the machine, and wanting live text is not
 * that consent. The refusal carries a {@code reason} the UI already has a
 * sentence for ({@code voice.live.localRoute}, {@code voice.live.noKey}), so a
 * greyed control can say which of the two things is wrong instead of being
 * mysteriously grey.</p>
 *
 * <p><b>Audio is held until the session is configured.</b> Appending before
 * {@code session.updated} arrives means the samples are graded against whatever
 * the session defaulted to rather than the format we asked for. Holding costs a
 * few hundred milliseconds of latency once; dropping would cost the first word
 * of every take.</p>
 *
 * <p><b>The upstream dies with the browser socket.</b> An upstream nobody is
 * watching is a metered connection nobody is paying attention to — the same
 * lesson the desktop shell paid for with a spawned child that hung on no
 * shutdown hook.</p>
 *
 * <p><b>Every partial is on the llm-wire record, as a partial</b> (card 184).
 * One socket is one exchange: the handshake is the request, every frame the
 * provider sends is a response line verbatim, and the close is the outcome. The
 * frames keep the provider's own {@code type}, so a reader can tell a guess from
 * the answer without this code having to flatten one into the other — which is
 * the dishonesty the card set exists to remove. A session that was refused
 * records NOTHING, because no model was called and no audio left.</p>
 *
 * <p>⚠️ <b>One honest asymmetry against the batch route, named rather than
 * discovered:</b> the spoken bytes are NOT on this record. On the batch route
 * {@code requestBytes} is the audio itself, base64; here it is the handshake,
 * because a websocket has no single request body and the appends flow after it.
 * The record is therefore complete about what the model SAID and incomplete
 * about what it HEARD. Closing that needs a second body on the tap's request
 * half, which is a change to a contract five providers share, not a rider on
 * this one.</p>
 */
public final class LiveSttSocketHandler extends TextWebSocketHandler {

    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * What the server decides about a live session, read fresh per connection —
     * a key or a provider choice can change while the server runs.
     *
     * @param route where a recording would go right now
     * @param key the hosted provider's key, possibly blank
     * @param model the transcription model to configure
     */
    public record Setup(SttRoute route, String key, String model) {}

    /** One open browser socket and the upstream behind it. */
    private static final class Live implements LiveSttUpstream.Listener {
        private final WebSocketSession browser;
        private LiveSttUpstream.Link link;
        /** Audio that arrived before the session was configured. */
        private final List<String> held = new ArrayList<>();
        private boolean ready;
        /** The one exchange this session is, or null when nothing was opened. */
        private LlmWireTap.Exchange exchange;
        /** The first thing that went wrong upstream, which is what the outcome
         *  should say — a later close status would overwrite the cause. */
        private String failure;
        /** Once ended, never again: a second end would append a second response
         *  line to the same request and the file would claim two answers. */
        private boolean ended;

        Live(WebSocketSession browser) {
            this.browser = browser;
        }

        @Override
        public synchronized void onFrame(String raw) {
            // Recorded BEFORE it is interpreted, and verbatim: what the provider
            // sent is the fact, and our reading of it is not. A frame we cannot
            // parse is still evidence.
            if (exchange != null) {
                exchange.line(raw);
            }
            JsonNode frame;
            try {
                frame = JSON.readTree(raw);
            } catch (IOException unreadable) {
                // The provider is free to send us something we cannot parse; that
                // is not a reason to end a recording in progress.
                return;
            }
            LiveSttProtocol.Incoming read = LiveSttProtocol.read(frame);
            switch (read.kind()) {
                case READY -> {
                    ready = true;
                    for (String audio : held) {
                        link.send(LiveSttProtocol.append(audio));
                    }
                    held.clear();
                    tell("ready", null, null);
                }
                case PARTIAL -> tell("partial", read.text(), null);
                case FINAL -> {
                    tell("final", read.text(), null);
                    // The transcript IS the end of this exchange, so the record
                    // closes here rather than at disconnect — the `wire` frame
                    // rides the browser socket, and by the time
                    // afterConnectionClosed runs that socket is already gone.
                    // Measured twice in a real browser: closed at disconnect the
                    // frame never arrived, and closed by the BROWSER on `final`
                    // it arrived at a socket that was already shutting. So the
                    // server says the last word and then hangs up itself.
                    endRecord();
                    try {
                        browser.close(CloseStatus.NORMAL);
                    } catch (IOException alreadyGone) {
                        // The page hung up first. Nothing left to end.
                    }
                }
                case ERROR -> {
                    // Kept for the outcome: a session that ends after a refusal
                    // must not close with a 200 beside the refusal's own line.
                    failure = read.text();
                    tell("error", read.text(), "upstream");
                }
                case IGNORE -> {
                    // A real event with nothing in it for a composer.
                }
            }
        }

        @Override
        public void onClosed(String reason) {
            tell("closed", reason, null);
        }

        /**
         * Close the record, once.
         *
         * <p>A request line with no response beside it reads as a call that never
         * came back, which is a real failure mode — so it must not also be what
         * an ordinary "the user stopped talking and closed the tab" looks like.</p>
         */
        synchronized void endRecord() {
            if (exchange == null || ended) {
                return;
            }
            ended = true;
            exchange.end(new LlmWireTap.WireOutcome(
                    failure == null ? 200 : null, "bytes", null,
                    false, failure, System.currentTimeMillis()));
        }

        /** Queue or forward one append. */
        synchronized void audio(String base64) {
            if (base64 == null || base64.isEmpty()) {
                return;
            }
            if (ready) {
                link.send(LiveSttProtocol.append(base64));
            } else {
                held.add(base64);
            }
        }

        /** The speaker let go. Anything still held goes up first, in order. */
        synchronized void commit() {
            for (String audio : held) {
                link.send(LiveSttProtocol.append(audio));
            }
            held.clear();
            link.send(LiveSttProtocol.commit());
        }

        /**
         * Tell the browser where its own record is.
         *
         * <p>The batch route answers with a {@code wire} object because voice
         * happens before any session exists and there is no socket to mirror the
         * exchange onto (card 184 leg 2b). Here there IS a socket, so the record
         * announces itself on it — same need, one fewer workaround.</p>
         *
         * @param file the day file the record landed in
         * @param meta the closed exchange
         */
        void tellWire(String file, LlmWireRecorder.ExchangeMeta meta) {
            ObjectNode out = JSON.createObjectNode();
            out.put("type", "wire");
            out.put("session", file.replace(".llm.jsonl", ""));
            out.put("xid", meta.xid());
            out.put("agentId", meta.agentId());
            out.put("kind", meta.kind());
            out.put("provider", meta.provider());
            out.put("model", meta.model());
            out.put("transport", meta.transport());
            out.put("url", meta.url());
            out.put("status", meta.status());
            out.put("requestBytes", meta.requestBytes());
            out.put("responseBytes", meta.responseBytes());
            out.put("responseLines", meta.responseLines());
            out.put("fidelity", meta.fidelity());
            out.put("durationMs", meta.durationMs());
            out.put("ts", meta.ts());
            send(out);
        }

        /** One frame down to the browser, never throwing at the caller. */
        void tell(String type, String text, String reason) {
            ObjectNode out = JSON.createObjectNode();
            out.put("type", type);
            if (text != null) {
                out.put("text", text);
            }
            if (reason != null) {
                out.put("reason", reason);
            }
            send(out);
        }

        /** The one place a frame reaches the page, so a dead socket is handled once. */
        private void send(ObjectNode frame) {
            try {
                browser.sendMessage(new TextMessage(frame.toString()));
            } catch (IOException gone) {
                // The page went away mid-frame. afterConnectionClosed does the
                // cleanup; there is nobody left to tell about this.
            }
        }
    }

    private final Supplier<Setup> setup;
    private final LiveSttUpstream upstream;
    private final Supplier<LlmWireRecorder> recorders;
    private final Map<String, Live> live = new ConcurrentHashMap<>();

    /**
     * Production wiring: one recorder per connection, appending to the shared
     * day file voice already uses.
     *
     * @param setup what the server decides about a live session, per connection
     * @param upstream the provider connection, a seam for tests
     */
    public LiveSttSocketHandler(Supplier<Setup> setup, LiveSttUpstream upstream) {
        this(setup, upstream, () -> LlmWireRecorder.forSession(WIRE_SESSION_PREFIX + LocalDate.now()));
    }

    /**
     * Seam for tests: also where the record goes.
     *
     * @param setup what the server decides about a live session, per connection
     * @param upstream the provider connection
     * @param recorders one recorder per connection — a fresh instance, because
     *                  the exchange listener is per-recorder and a shared one
     *                  would hand a session someone else's record
     */
    LiveSttSocketHandler(Supplier<Setup> setup, LiveSttUpstream upstream,
            Supplier<LlmWireRecorder> recorders) {
        this.setup = setup;
        this.upstream = upstream;
        this.recorders = recorders;
    }

    /** Voice happens before any session exists, so its records share a day file —
     *  the same one {@code TranscribeController} writes the batch route into. */
    static final String WIRE_SESSION_PREFIX = "stt-";

    @Override
    public void afterConnectionEstablished(WebSocketSession browser) throws Exception {
        Setup now = setup.get();
        Live session = new Live(browser);
        // Nothing is recorded before this point on purpose: a refused route
        // called no model and sent no audio, so a record would be a claim about
        // a call that never happened.
        if (now.route() != SttRoute.HOSTED) {
            refuse(session, browser, "localRoute");
            return;
        }
        if (now.key() == null || now.key().isBlank()) {
            refuse(session, browser, "noKey");
            return;
        }
        try {
            session.link = upstream.open(session);
        } catch (IOException unreachable) {
            refuse(session, browser, "upstream");
            return;
        }
        live.put(browser.getId(), session);
        String handshake = LiveSttProtocol.sessionUpdate(now.model());
        LlmWireRecorder recorder = recorders.get();
        recorder.onExchange(meta -> session.tellWire(recorder.file().getFileName().toString(), meta));
        session.exchange = recorder.bound("composer", null, "stt").begin(
                new LlmWireTap.WireRequest("openai", now.model(), "websocket", null,
                        LiveSttProtocol.URL, null, "bytes", handshake,
                        System.currentTimeMillis()));
        session.link.send(handshake);
    }

    @Override
    protected void handleTextMessage(WebSocketSession browser, TextMessage message) {
        Live session = live.get(browser.getId());
        if (session == null) {
            return;
        }
        JsonNode frame;
        try {
            frame = JSON.readTree(message.getPayload());
        } catch (IOException unreadable) {
            // A malformed frame is one lost append, not a lost recording.
            return;
        }
        switch (frame.path("type").asText("")) {
            case "audio" -> session.audio(frame.path("data").asText(""));
            case "commit" -> session.commit();
            default -> {
                // Nothing else is part of this conversation.
            }
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession browser, CloseStatus status) {
        Live session = live.remove(browser.getId());
        if (session == null) {
            return;
        }
        // The record closes BEFORE the socket does: the exchange listener fires
        // on end(), and the `wire` frame it produces still needs a live socket
        // to ride down.
        session.endRecord();
        if (session.link != null) {
            session.link.close();
        }
    }

    /** Say why, then end it. A socket that cannot work must not look open. */
    private void refuse(Live session, WebSocketSession browser, String reason) {
        session.tell("error", null, reason);
        try {
            browser.close(CloseStatus.NORMAL);
        } catch (IOException alreadyGone) {
            // Nothing left to close.
        }
    }
}
