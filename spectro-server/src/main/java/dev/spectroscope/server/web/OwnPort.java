package dev.spectroscope.server.web;

/**
 * The port this server listens on, once it has bound (card 472).
 *
 * <p>The browser fence lets the app's own code graph view through on loopback
 * without the {@code allowLocalhost} opt-in, and only on this port. The port is
 * known only after the web server has started, so the fences read it per
 * judgment rather than at construction. {@code OwnPortGuard} records it.</p>
 */
public final class OwnPort {

    private static volatile int port;

    private OwnPort() {
    }

    /**
     * The bound port.
     *
     * @return the port, or 0 before the server has bound
     */
    public static int get() {
        return port;
    }

    /**
     * Records the bound port.
     *
     * @param bound the port the web server listens on
     */
    public static void set(int bound) {
        port = bound;
    }
}
