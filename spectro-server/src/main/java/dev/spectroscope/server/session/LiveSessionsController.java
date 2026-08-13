package dev.spectroscope.server.session;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * The REST twin of the {@code live_sessions} socket frame (card 212).
 *
 * <p>The push is the fast path and the honest one: every change reaches every
 * open socket immediately. This endpoint is the FLOOR under it, and it exists
 * for the two cases a push cannot serve — a page that has just loaded and has
 * not folded a frame yet, and a client whose socket was down while something
 * started or finished. The rail polls it on a stated interval
 * ({@code LIVE_POLL_MS} in {@code spectro-web/src/state/liveSessions.ts}), so
 * "how stale can this be" has an answer that is a number rather than a hope.</p>
 *
 * <p>Read-only, and fenced like every other {@code /api} path by
 * {@link dev.spectroscope.server.web.ApiLocalFence}. It sits in its own
 * controller rather than in {@link SessionsController} because it is the one
 * session endpoint that reads live process state instead of the JSONL store,
 * and it needs the registry injected to do it.</p>
 */
@RestController
public class LiveSessionsController {

    private final LiveSessions liveSessions;

    LiveSessionsController(LiveSessions liveSessions) {
        this.liveSessions = liveSessions;
    }

    /**
     * Which sessions are live on this server right now.
     *
     * @return one row per live session — {@code id}, {@code running},
     *         {@code since} — oldest claim first; an empty list when nothing
     *         is live, which is a fact and not an error
     */
    @GetMapping("/api/sessions/live")
    public List<LiveSessions.LiveSession> live() {
        return liveSessions.snapshot();
    }
}
