package dev.spectroscope.core.launch;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;

/**
 * Card 540: a port number for a test whose command binds the port itself.
 *
 * <p>The launch tests took a port with {@code new ServerSocket(0)} and gave it to
 * {@code python3 -m http.server}. On this Mac the kernel hands such a bind a port
 * that another process already holds at a narrower address: a listener or a bound
 * socket on {@code 127.0.0.1}, or an IPv4 wildcard listener beside Java's IPv6 one.
 * The http.server then starts, but a connect to {@code localhost} reaches the
 * other holder. The supervisor sees a stranger answering before the start, or no
 * answer at all, and the start fails after its whole budget (card 503's gate:
 * 30.154 s; this card's package run: 30.175 s, "already answering before it
 * started"). Measured on 2026-10-11 with {@code kanban/evidence/540/tools/PickProbe.java}:
 * of 16000 ports taken the old way, localhost answered on 13.</p>
 *
 * <p>So a candidate counts only when a bind at {@code localhost}, the host the
 * supervisor's probe dials, takes it with SO_REUSEADDR off. That one bind refuses
 * all five holders in {@code holder-matrix.log}; with SO_REUSEADDR on, or at the
 * wildcard, it misses the IPv4 wildcard listener. Over 16000 picks it rejected
 * 58 candidates and left none that localhost answered on
 * ({@code pick-probe-modes.log}). The number is still given back before the
 * command binds it; macOS hands out ephemeral ports in sequence
 * ({@code port-allocation.log}), so it comes round again only after the whole
 * range has been used.</p>
 */
final class ClaimablePorts {

    /** Candidates tried before giving up; 58 of 16000 were rejected when measured. */
    private static final int ATTEMPTS = 1_000;

    private ClaimablePorts() {
    }

    /**
     * A port nobody holds at localhost or at the wildcard, taken and released.
     *
     * @return the port number
     * @throws IOException when no candidate passes the check
     */
    static int free() throws IOException {
        for (int attempt = 0; attempt < ATTEMPTS; attempt++) {
            int candidate;
            try (ServerSocket socket = new ServerSocket(0)) {
                candidate = socket.getLocalPort();
            }
            if (claimable(candidate)) {
                return candidate;
            }
        }
        throw new IOException("no claimable port in " + ATTEMPTS + " candidates");
    }

    /**
     * Whether a launch test can hand this port to a command that binds every address.
     *
     * @param port the port to check
     * @return false when a bind at localhost with SO_REUSEADDR off is refused
     */
    static boolean claimable(int port) {
        try (ServerSocket socket = new ServerSocket()) {
            socket.setReuseAddress(false);
            socket.bind(new InetSocketAddress(InetAddress.getByName("localhost"), port));
            return true;
        } catch (IOException held) {
            return false;
        }
    }
}
