package dev.spectroscope.server.browser;

import dev.spectroscope.core.launch.LaunchSupervisor;
import dev.spectroscope.core.wire.BrowserWireTap;

import org.springframework.stereotype.Component;

import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;

/**
 * What the operator's browser controls need from a LIVE session (card 227).
 *
 * <p>The view socket ({@code /ws/browser-view}) carries the operator's hand:
 * typed addresses, back/forward, the start page's play button. Three of the
 * things those verbs need live inside the session's own connection object and
 * nowhere else — the {@code .browser.jsonl} recorder (so an operator action is
 * recorded under the SAME epoch as the agent's, criterion 4), the
 * {@link LaunchSupervisor} (so a played configuration dies with the session,
 * card 202's lifetime rule), and the project folder the launch file is read
 * from. This bridge is the one place a session id resolves to them.
 *
 * <p><b>And the fight rule's ground truth (criterion 5).</b> "An agent is
 * driving right now" is measured on the same seam that records the agent's
 * call: {@link #agentGuard} wraps the session's tap, counts a call in flight
 * from {@code open} to {@code end}, and {@link #agentDriving} is what the view
 * socket refuses operator input on. Measuring anywhere else would let the
 * record and the lock disagree.
 *
 * <p>A session that is not registered here is simply not open on this server:
 * {@link #live} answers null and the caller says so, it does not guess.
 */
@Component
public final class SessionBrowserBridge {

    /**
     * One live session's browser-side collaborators.
     *
     * @param tap        the session's sidecar recorder — never null; the
     *                   detached tap when the session records nothing
     * @param launches   what this session has running (card 202)
     * @param projectDir where the launch file is read from, resolved per call
     *                   because a workspace can be picked mid-session; may
     *                   answer null while the session has no folder
     */
    public record Live(BrowserWireTap tap, LaunchSupervisor launches,
                       Supplier<Path> projectDir) {}

    private final Map<String, Live> sessions = new ConcurrentHashMap<>();

    /** How many agent browser calls are in flight per session id. */
    private final Map<String, AtomicInteger> driving = new ConcurrentHashMap<>();

    /**
     * Registers one live session. Latest wins, like the socket that owns it.
     *
     * @param sessionId the session's store id
     * @param entry     its collaborators
     */
    public void register(String sessionId, Live entry) {
        sessions.put(sessionId, entry);
    }

    /**
     * Forgets one session — called when its socket closes, beside the recorder.
     *
     * @param sessionId the session's store id
     */
    public void unregister(String sessionId) {
        sessions.remove(sessionId);
        driving.remove(sessionId);
    }

    /**
     * The live entry of one session.
     *
     * @param sessionId the session's store id
     * @return the entry, or null when no open socket holds that session here
     */
    public Live live(String sessionId) {
        return sessionId == null ? null : sessions.get(sessionId);
    }

    /**
     * Whether an AGENT browser call is in flight for this session right now.
     *
     * @param sessionId the session's store id
     * @return true between an agent call's open and its end
     */
    public boolean agentDriving(String sessionId) {
        AtomicInteger count = sessionId == null ? null : driving.get(sessionId);
        return count != null && count.get() > 0;
    }

    /**
     * Wraps a session's tap so every agent call marks the session as driven
     * while it is in flight. The count lives here rather than in the recorder
     * because the CLI's detached tap must count too — a fight rule that only
     * fired when recording happened to be on would be a fence with a gate in it.
     *
     * @param sessionId resolves the session id at CALL time — a connection
     *                  mints its id lazily, and capturing it early would pin null
     * @param delegate  resolves the real tap at call time, like the tools do
     * @return the guarded tap to hand to the browser tools
     */
    public BrowserWireTap agentGuard(Supplier<String> sessionId, Supplier<BrowserWireTap> delegate) {
        return (tool, agentId, callId, input, pageUrl, actor) -> {
            String session = sessionId.get();
            if (session != null) {
                driving.computeIfAbsent(session, key -> new AtomicInteger()).incrementAndGet();
            }
            BrowserWireTap real = delegate.get();
            BrowserWireTap.Call inner = (real == null ? BrowserWireTap.none() : real)
                    .open(tool, agentId, callId, input, pageUrl, actor);
            AtomicBoolean released = new AtomicBoolean(false);
            return new BrowserWireTap.Call() {
                @Override
                public String cid() {
                    return inner.cid();
                }

                @Override
                public int epoch() {
                    return inner.epoch();
                }

                @Override
                public void image(String mediaType, String blobPath, String sha256,
                                  int width, int height, long bytes) {
                    inner.image(mediaType, blobPath, sha256, width, height, bytes);
                }

                @Override
                public String imageSha256() {
                    return inner.imageSha256();
                }

                @Override
                public void end(boolean ok, String result, String endedOn) {
                    inner.end(ok, result, endedOn);
                    // Once, even when a failure races a natural close: the
                    // recorder dedupes its lines, and this guard must not let
                    // a second end free a count another call still holds.
                    if (session != null && released.compareAndSet(false, true)) {
                        AtomicInteger count = driving.get(session);
                        if (count != null) {
                            count.decrementAndGet();
                        }
                    }
                }
            };
        };
    }
}
