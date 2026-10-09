package dev.spectroscope.server.web;

import dev.spectroscope.core.net.NetFence;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;

/**
 * The one-shot tickets that let the operator's "Graph ready" chip open the
 * app's own code graph view (card 472).
 *
 * <p>The internal browser refuses loopback unless {@code allowLocalhost} is on.
 * The chip is the operator's own press, so it gets one exception, and only
 * that press gets it: the browser view socket mints a ticket when the chip is
 * pressed and navigates to the address {@link #viewAddress} builds. The fence
 * lets {@code /api/codegraph/view} through only while the ticket in its query
 * is live, and the view spends the ticket on the first load. No agent verb
 * mints one: {@code browser_navigate} judges with a fence that knows no
 * tickets, and an eval, a click or a redirect reaches the view without a live
 * ticket, so the loopback rule holds for them.</p>
 */
public final class AppPageTickets {

    /** How long a minted ticket stays live if nobody loads the page, in milliseconds. */
    public static final long LIFETIME_MS = 60_000;

    private static final AppPageTickets SHARED = new AppPageTickets(System::currentTimeMillis);

    private static final SecureRandom RANDOM = new SecureRandom();

    /** One live ticket: whose graph it opens and until when. */
    private record Entry(String sessionId, long expiresAt) {
    }

    private final Map<String, Entry> live = new ConcurrentHashMap<>();
    private final LongSupplier clock;

    /**
     * A ticket list on its own clock; production uses {@link #shared()}.
     *
     * @param clock the time source a ticket's lifetime is measured on
     */
    public AppPageTickets(LongSupplier clock) {
        this.clock = clock;
    }

    /**
     * The tickets this server process mints and checks.
     *
     * @return the shared instance
     */
    public static AppPageTickets shared() {
        return SHARED;
    }

    /**
     * Mints a ticket for one session's code graph view.
     *
     * @param sessionId the session whose folder's graph the ticket opens
     * @return the ticket, 32 hex characters
     */
    public String mint(String sessionId) {
        long now = clock.getAsLong();
        live.values().removeIf(entry -> entry.expiresAt() <= now);
        byte[] bytes = new byte[16];
        RANDOM.nextBytes(bytes);
        String ticket = HexFormat.of().formatHex(bytes);
        live.put(ticket, new Entry(sessionId, now + LIFETIME_MS));
        return ticket;
    }

    /**
     * Whether a ticket was minted, has not been spent and has not expired. The
     * browser fence asks this for every request to the view.
     *
     * @param ticket the ticket from the address, or null
     * @return whether it is live
     */
    public boolean isLive(String ticket) {
        if (ticket == null) {
            return false;
        }
        Entry entry = live.get(ticket);
        return entry != null && entry.expiresAt() > clock.getAsLong();
    }

    /**
     * Spends a ticket. Any try spends it, a wrong one included, so a ticket
     * serves at most one load and cannot be guessed at twice.
     *
     * @param ticket    the ticket from the address, or null
     * @param sessionId the session the load asks for
     * @return whether the ticket was live and minted for this session
     */
    public boolean redeem(String ticket, String sessionId) {
        if (ticket == null) {
            return false;
        }
        Entry entry = live.remove(ticket);
        return entry != null && entry.expiresAt() > clock.getAsLong() && entry.sessionId().equals(sessionId);
    }

    /**
     * The address of a session's code graph view on this server, with a fresh
     * ticket: plain http, {@code localhost}, the port the server listens on.
     *
     * @param sessionId the session
     * @param port      the port this server listens on
     * @return the address the operator's browser navigates to
     */
    public String viewAddress(String sessionId, int port) {
        return "http://localhost:" + port + NetFence.APP_PAGES.get(0)
                + "?sessionId=" + URLEncoder.encode(sessionId, StandardCharsets.UTF_8)
                + "&" + NetFence.APP_TICKET + "=" + mint(sessionId);
    }
}
