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
    void absentOnlyWhenNeitherTheBinaryNorTheDaemonIsThere() {
        // This test used to assert that a missing binary short-circuits BEFORE
        // the socket is asked. That premise was measured false on 2026-08-02: a
        // GUI-launched desktop app inherits the launchd PATH and never sees
        // /usr/local/bin/docker, so "not on PATH" is not evidence that Docker is
        // not installed. The short-circuit is gone; "absent" now costs one
        // socket read, and it has to, because it is the state that tells the
        // operator to go and download something.
        AtomicBoolean probed = new AtomicBoolean(false);
        DockerStatusController controller = controller(false, false, null, socket -> {
            probed.set(true);
            throw new java.io.IOException("No such file or directory");
        });
        Map<String, Object> out = controller.status(local()).getBody();
        assertNotNull(out);
        assertEquals("absent", out.get("docker"));
        assertTrue(probed.get(), "the daemon gets the last word before we call it absent");
        assertEquals(false, out.get("remote"));
    }

    @Test
    void aRunningDaemonOutranksAMissingBinary() {
        // The false negative this closes, reproduced live against the shipped
        // 0.5.0 jar: PATH=/usr/bin:/bin:/usr/sbin:/sbin answered
        // docker:"absent" while `docker info` reported a running daemon, and
        // Settings offered the Docker download to that operator. A daemon that
        // answers is the end of the argument, whatever PATH holds.
        DockerStatusController controller = controller(false, true, null, socket -> true);
        Map<String, Object> out = controller.status(local()).getBody();
        assertNotNull(out);
        assertEquals("ready", out.get("docker"));
        assertEquals(false, out.get("remote"));
    }

    @Test
    void aMissingBinaryWithARemoteHostIsStillRemote() {
        // DOCKER_HOST wins over the PATH walk in both directions: we never probe
        // someone else's machine over a local socket, and we never call it
        // absent either.
        AtomicBoolean probed = new AtomicBoolean(false);
        DockerStatusController controller = controller(false, true, "ssh://user@build-box", socket -> {
            probed.set(true);
            return true;
        });
        Map<String, Object> out = controller.status(local()).getBody();
        assertNotNull(out);
        assertEquals(true, out.get("remote"));
        assertEquals("unreachable", out.get("docker"));
        assertFalse(probed.get(), "a remote daemon is never probed over a local socket");
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
    void aPermissionFailureIsStillUnreachableWhenTheBinaryWalkMissedToo() {
        // The corner the binary=true case above does not reach: the socket says
        // "you are not allowed in" AND our binary walk came up empty. That
        // combination is reachable on a real machine -- binaryDirs covers PATH
        // plus /usr/local/bin, /opt/homebrew/bin, /usr/bin and ~/.docker/bin, so
        // a snap-installed CLI under a stripped launchd PATH is invisible to us
        // while the daemon socket sits right there refusing us.
        //
        // A permission denial is evidence that Docker IS installed: something
        // owns that socket. Branching on the binary walk instead of on the
        // failure sends that operator to the download link.
        DockerStatusController controller = controller(false, false, null, socket -> {
            throw new java.nio.file.AccessDeniedException(socket, null, "Permission denied");
        });
        Map<String, Object> out = controller.status(local()).getBody();
        assertNotNull(out);
        assertEquals("unreachable", out.get("docker"));
        assertFalse(String.valueOf(out.get("detail")).contains("no docker executable"),
                "never the not-installed sentence when the socket refused us");
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
