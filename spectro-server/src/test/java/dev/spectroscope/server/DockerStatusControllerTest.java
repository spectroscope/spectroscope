package dev.spectroscope.server;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The Docker probe endpoint (card 137), exercised directly through its seams so
 * the three states are proven without touching the operator's daemon.
 *
 * <p>The state that earns this class is {@code unreachable}: a binary on PATH
 * with a dead daemon. A probe that answers "ready" to a PATH hit is the silent
 * false success this card exists to avoid, so that case is asserted first and
 * separately from the happy path.
 */
class DockerStatusControllerTest {

    /** A legitimate operator request: loopback peer + localhost Host. */
    private static MockHttpServletRequest local() {
        return new MockHttpServletRequest();
    }

    private static DockerStatusController controller(
            boolean binary, boolean compose, String dockerHost, DockerPing.Probe ping) {
        return new DockerStatusController(() -> binary, () -> compose, () -> dockerHost, ping);
    }

    @Test
    void absentWhenTheBinaryIsNotOnPath() {
        AtomicBoolean probed = new AtomicBoolean(false);
        DockerStatusController controller = controller(false, false, null, socket -> {
            probed.set(true);
            return true;
        });
        Map<String, Object> out = controller.status(local()).getBody();
        assertNotNull(out);
        assertEquals("absent", out.get("docker"));
        assertFalse(probed.get(), "no socket probe when there is nothing installed");
        assertEquals(false, out.get("remote"));
    }

    @Test
    void unreachableWhenTheDaemonDoesNotAnswer() {
        // The load-bearing case: docker IS installed, the daemon is not running.
        // A naive PATH-only probe calls this "ready" and sends the user off to
        // run a compose command that cannot work.
        DockerStatusController controller = controller(true, true, null, socket -> {
            throw new java.io.IOException("Connection refused");
        });
        Map<String, Object> out = controller.status(local()).getBody();
        assertNotNull(out);
        assertEquals("unreachable", out.get("docker"));
        assertFalse(String.valueOf(out.get("detail")).isBlank(), "an honest sentence, not silence");
        assertFalse(String.valueOf(out.get("detail")).contains("\tat "), "never a stack trace");
    }

    @Test
    void unreachableWhenTheSocketAnswersWithSomethingElse() {
        // A socket file that exists and does not speak Docker is also a no.
        DockerStatusController controller = controller(true, true, null, socket -> false);
        Map<String, Object> out = controller.status(local()).getBody();
        assertNotNull(out);
        assertEquals("unreachable", out.get("docker"));
    }

    @Test
    void aPermissionFailureIsStillUnreachableAndSaysSo() {
        // Not "absent": the install is fine, the caller is not allowed in. The
        // Settings copy must never tell this user to download Docker again.
        DockerStatusController controller = controller(true, true, null, socket -> {
            throw new java.nio.file.AccessDeniedException(socket, null, "Permission denied");
        });
        Map<String, Object> out = controller.status(local()).getBody();
        assertNotNull(out);
        assertEquals("unreachable", out.get("docker"));
        assertTrue(
                String.valueOf(out.get("detail")).toLowerCase(java.util.Locale.ROOT).contains("permission"),
                "the detail names permission");
    }

    @Test
    void readyWhenThePingAnswers() {
        DockerStatusController controller = controller(true, true, null, socket -> true);
        Map<String, Object> out = controller.status(local()).getBody();
        assertNotNull(out);
        assertEquals("ready", out.get("docker"));
        assertEquals(true, out.get("compose"));
        assertEquals(false, out.get("remote"));
    }

    @Test
    void composeIsFalseWhenThePluginIsMissing() {
        DockerStatusController controller = controller(true, false, null, socket -> true);
        Map<String, Object> out = controller.status(local()).getBody();
        assertNotNull(out);
        assertEquals("ready", out.get("docker"));
        assertEquals(false, out.get("compose"));
    }

    @Test
    void aRemoteDockerHostIsReportedAsRemote() {
        AtomicBoolean probed = new AtomicBoolean(false);
        DockerStatusController controller = controller(true, true, "tcp://10.0.0.5:2375", socket -> {
            probed.set(true);
            return true;
        });
        Map<String, Object> out = controller.status(local()).getBody();
        assertNotNull(out);
        assertEquals(true, out.get("remote"));
        assertFalse(probed.get(), "a remote daemon is never probed over a local socket");
        assertFalse(String.valueOf(out.get("detail")).contains("10.0.0.5"), "only the scheme is echoed");
    }

    @Test
    void refusesADnsReboundHost() {
        // The answer fingerprints the operator's machine: whether Docker is
        // installed, whether it runs. Same bar as every other local endpoint.
        DockerStatusController controller = controller(true, true, null, socket -> true);
        MockHttpServletRequest rebound = local();
        rebound.setServerName("attacker.example");
        assertEquals(404, controller.status(rebound).getStatusCode().value());
        assertNull(controller.status(rebound).getBody(), "no fingerprint in the refusal");
    }

    @Test
    void refusesACrossSiteOrigin() {
        DockerStatusController controller = controller(true, true, null, socket -> true);
        MockHttpServletRequest crossSite = local();
        crossSite.addHeader("Origin", "https://evil.example");
        assertEquals(404, controller.status(crossSite).getStatusCode().value());
        assertNull(controller.status(crossSite).getBody());
    }

    @Test
    void refusesANonLocalCaller() {
        DockerStatusController controller = controller(true, true, null, socket -> true);
        MockHttpServletRequest remote = local();
        remote.setRemoteAddr("203.0.113.7"); // TEST-NET, not loopback
        assertEquals(404, controller.status(remote).getStatusCode().value());
        assertNull(controller.status(remote).getBody());
    }

    @Test
    void nothingIsStarted() {
        // The whole endpoint is a read. There is no seam here that could spawn a
        // process, and this test is the place that says so out loud: the probe
        // seam is the only impure thing, and it takes a socket path.
        AtomicBoolean probed = new AtomicBoolean(false);
        DockerStatusController controller = controller(true, true, null, socket -> {
            probed.set(true);
            assertNotNull(socket, "the probe is handed a path, never a command line");
            return true;
        });
        controller.status(local());
        assertTrue(probed.get());
    }
}
