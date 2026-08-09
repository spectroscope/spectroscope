package dev.spectroscope.server.llm;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
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

        Live(WebSocketSession browser) {
            this.browser = browser;
        }

        @Override
        public synchronized void onFrame(String raw) {
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
                case FINAL -> tell("final", read.text(), null);
                case ERROR -> tell("error", read.text(), "upstream");
                case IGNORE -> {
                    // A real event with nothing in it for a composer.
                }
            }
        }

        @Override
        public void onClosed(String reason) {
            tell("closed", reason, null);
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
            try {
                browser.sendMessage(new TextMessage(out.toString()));
            } catch (IOException gone) {
                // The page went away mid-frame. afterConnectionClosed does the
                // cleanup; there is nobody left to tell about this.
            }
        }
    }

    private final Supplier<Setup> setup;
    private final LiveSttUpstream upstream;
    private final Map<String, Live> live = new ConcurrentHashMap<>();

    /**
     * @param setup what the server decides about a live session, per connection
     * @param upstream the provider connection, a seam for tests
     */
    public LiveSttSocketHandler(Supplier<Setup> setup, LiveSttUpstream upstream) {
        this.setup = setup;
        this.upstream = upstream;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession browser) throws Exception {
        Setup now = setup.get();
        Live session = new Live(browser);
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
        session.link.send(LiveSttProtocol.sessionUpdate(now.model()));
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
        if (session != null && session.link != null) {
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
