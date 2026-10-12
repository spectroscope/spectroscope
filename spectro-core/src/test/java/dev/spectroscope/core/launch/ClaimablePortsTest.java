package dev.spectroscope.core.launch;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.OS;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 540: the port picker of the launch tests refuses a port that another
 * socket holds at localhost or at the wildcard, which the old picker handed out.
 */
class ClaimablePortsTest {

    @Test
    void aPortHeldOnTheLoopbackAddressIsNotClaimable() throws IOException {
        try (Socket holder = new Socket()) {
            holder.bind(new InetSocketAddress(InetAddress.getByName("localhost"), 0));
            int held = holder.getLocalPort();

            assertFalse(ClaimablePorts.claimable(held),
                    "a port held on the loopback address is not handed to a launch test, " + held);

            // The hazard itself, on macOS: the old picker's bind, SO_REUSEADDR on, takes the
            // same port. Linux refuses that bind ("Address already in use", review of card 540
            // in a Linux container), so there the old picker could not be handed this port and
            // only the assertion above applies.
            if (OS.MAC.isCurrentOs()) {
                try (ServerSocket old = new ServerSocket()) {
                    old.setReuseAddress(true);
                    old.bind(new InetSocketAddress(held));
                    assertTrue(old.isBound(), "test premise: a wildcard bind with SO_REUSEADDR takes " + held);
                }
            }
        }
    }

    @Test
    void aPortWithAListenerOnTheLoopbackAddressIsNotClaimable() throws IOException {
        try (ServerSocket listener = new ServerSocket(0, 8, InetAddress.getLoopbackAddress())) {
            assertFalse(ClaimablePorts.claimable(listener.getLocalPort()),
                    "a port somebody listens on at localhost is not handed out, " + listener.getLocalPort());
        }
    }

    @Test
    void aPortWithAnIpv4WildcardListenerIsNotClaimable() throws IOException {
        // The holder PickProbe found on this Mac: an IPv4 wildcard listener. A bind
        // at the wildcard, or at localhost with SO_REUSEADDR on, takes its port.
        try (java.nio.channels.ServerSocketChannel listener =
                     java.nio.channels.ServerSocketChannel.open(java.net.StandardProtocolFamily.INET)) {
            listener.bind(new InetSocketAddress(InetAddress.getByName("0.0.0.0"), 0));
            int port = ((InetSocketAddress) listener.getLocalAddress()).getPort();
            assertFalse(ClaimablePorts.claimable(port),
                    "a port with an IPv4 wildcard listener is not handed out, " + port);
        }
    }

    @Test
    void aServerOnThePickedPortIsTheOneLocalhostReaches() throws IOException {
        int port = ClaimablePorts.free();
        assertTrue(port > 0, "a port was picked");
        // What the launch tests need: a command that binds the picked port at every
        // address is the one a connect to localhost reaches, not another holder.
        try (ServerSocket server = new ServerSocket(port);
             Socket client = new Socket()) {
            server.setSoTimeout(10_000);
            client.connect(new InetSocketAddress(InetAddress.getByName("localhost"), port), 10_000);
            try (Socket accepted = server.accept()) {
                assertTrue(accepted.isConnected(), "localhost reached the server on " + port
                        + "; holders: " + holders(port));
            } catch (java.net.SocketTimeoutException stranger) {
                throw new AssertionError("a connect to localhost:" + port + " reached another holder;"
                        + " holders: " + holders(port), stranger);
            }
        }
    }

    /** Who holds the port, for the failure message. */
    private static String holders(int port) {
        try {
            Process lsof = new ProcessBuilder("lsof", "-nP", "-i", ":" + port)
                    .redirectErrorStream(true).start();
            String text = new String(lsof.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
            lsof.waitFor();
            return text.isBlank() ? "(lsof shows none)" : text;
        } catch (IOException | InterruptedException unavailable) {
            return "(lsof failed: " + unavailable + ")";
        }
    }
}
