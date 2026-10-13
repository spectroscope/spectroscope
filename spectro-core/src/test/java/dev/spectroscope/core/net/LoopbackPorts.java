package dev.spectroscope.core.net;

import java.io.IOException;
import java.net.BindException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Card 582: ports on 127.0.0.1 for tests, and the held-port trick that shows
 * why a probe must bind the address it later dials.
 *
 * <p>On macOS a wildcard bind ({@code new ServerSocket(0)}) does not see a
 * listener on 127.0.0.1, and TCP ports are handed out in sequence
 * ({@code sysctl net.inet.tcp.randomize_ports} is 0). A wildcard probe can
 * therefore return a port that another process holds on 127.0.0.1. Measured
 * in {@code kanban/evidence/582/probe-blind.log}: 10 of 10 wildcard probes got
 * a held port, 0 of 10 probes bound to 127.0.0.1 did.</p>
 */
public final class LoopbackPorts {

    /** macOS default ephemeral range (sysctl net.inet.ip.portrange.first and last). */
    private static final int FIRST_PORT = 49152;
    private static final int LAST_PORT = 65535;

    private LoopbackPorts() {
    }

    /** @return 127.0.0.1, without a name lookup */
    public static InetAddress loopback() throws UnknownHostException {
        return InetAddress.getByAddress(new byte[] {127, 0, 0, 1});
    }

    /**
     * A port nobody listens on at 127.0.0.1, probed there and released. Another
     * process can still bind it after the release; that window is not closed.
     *
     * @return the port number
     */
    public static int dead() throws IOException {
        try (ServerSocket probe = new ServerSocket(0, 1, loopback())) {
            return probe.getLocalPort();
        }
    }

    /**
     * Holds the next {@code count} ports the allocator will hand out, as
     * listeners on 127.0.0.1. Ports someone else already holds are skipped.
     *
     * @param count how many ports to hold
     * @return the held ports, to be closed by the caller
     */
    public static Held holdNext(int count) throws IOException {
        int cursor;
        try (ServerSocket wildcard = new ServerSocket(0)) {
            cursor = wildcard.getLocalPort();
        }
        InetAddress loopback = loopback();
        List<ServerSocket> sockets = new ArrayList<>();
        Set<Integer> ports = new HashSet<>();
        for (int i = 1; i <= count; i++) {
            int port = cursor + i > LAST_PORT ? cursor + i - (LAST_PORT - FIRST_PORT + 1) : cursor + i;
            try {
                sockets.add(new ServerSocket(port, 1, loopback));
                ports.add(port);
            } catch (BindException alreadyTaken) {
                // another process holds it, which serves the same purpose
            }
        }
        return new Held(sockets, ports);
    }

    /** Listeners on 127.0.0.1 ahead of the allocator. */
    public static final class Held implements AutoCloseable {

        private final List<ServerSocket> sockets;
        private final Set<Integer> ports;

        private Held(List<ServerSocket> sockets, Set<Integer> ports) {
            this.sockets = sockets;
            this.ports = Set.copyOf(ports);
        }

        /** @return whether this port is one of the held ones */
        public boolean contains(int port) {
            return ports.contains(port);
        }

        /**
         * The premise of every test that uses this: a wildcard probe taken now
         * lands on a held port. False on a kernel that allocates at random or
         * that sees the loopback listener, where the defect cannot be shown.
         *
         * @return whether a wildcard probe was handed a held port
         */
        public boolean blindsAWildcardProbe() throws IOException {
            try (ServerSocket wildcard = new ServerSocket(0)) {
                return ports.contains(wildcard.getLocalPort());
            }
        }

        @Override
        public void close() throws IOException {
            for (ServerSocket socket : sockets) {
                socket.close();
            }
        }
    }
}
