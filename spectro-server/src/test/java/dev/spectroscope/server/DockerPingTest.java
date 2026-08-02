package dev.spectroscope.server;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The pure half of the Docker probe (card 137). Everything here is a decision
 * about a string, so it is testable without a daemon, a socket or a machine
 * that happens to have Docker installed. The impure half is one socket read,
 * and it is behind a seam in the controller for exactly this reason.
 */
class DockerPingTest {

    @Test
    void readsA200StatusLine() {
        assertTrue(DockerPing.answeredOk("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK"));
    }

    @Test
    void rejectsA500StatusLine() {
        assertFalse(DockerPing.answeredOk("HTTP/1.1 500 Internal Server Error\r\n\r\n"));
    }

    @Test
    void rejectsAnEmptyResponse() {
        assertFalse(DockerPing.answeredOk(""));
        assertFalse(DockerPing.answeredOk(null));
    }

    @Test
    void rejectsGarbage() {
        // A socket that exists and speaks something other than HTTP is not a
        // Docker daemon. It must read as "no", never as a throw.
        assertFalse(DockerPing.answeredOk("\u0000\u0001binary noise"));
        assertFalse(DockerPing.answeredOk("200"));
        assertFalse(DockerPing.answeredOk("HTTP/1.1"));
    }

    @Test
    void remoteHostsAreNotProbedLocally() {
        // A tcp:// or ssh:// daemon is someone else's machine. We report it and
        // stop; opening a local socket would answer a question nobody asked.
        assertTrue(DockerPing.isRemote("tcp://10.0.0.5:2375"));
        assertTrue(DockerPing.isRemote("ssh://user@build-box"));
        assertFalse(DockerPing.isRemote("unix:///var/run/docker.sock"));
        assertFalse(DockerPing.isRemote(null));
        assertFalse(DockerPing.isRemote("   "));
    }

    @Test
    void namesOnlyTheSchemeOfARemoteHost() {
        // The detail line goes to a fenced caller, but a DOCKER_HOST can carry a
        // user and a host name. The scheme is the whole answer; the rest is not
        // ours to echo.
        assertEquals("ssh", DockerPing.schemeOf("ssh://user@build-box"));
        assertEquals("tcp", DockerPing.schemeOf("tcp://10.0.0.5:2375"));
        assertEquals("", DockerPing.schemeOf("no-scheme-here"));
        assertEquals("", DockerPing.schemeOf(null));
    }

    @Test
    void looksForTheComposePluginUnderBothHomes() {
        // Measured live: the server runs with -Duser.home pointed at an isolated
        // home (the house recipe for a clean first-run test, and what the desktop
        // shell can do too). The Docker CLI installs its plugins under the REAL
        // $HOME, so reading only the JVM property reports "no compose" on a
        // machine that plainly has it. Both homes are consulted.
        java.util.List<String> dirs = DockerPing.composePluginDirs("/real/home", "/tmp/isolated-home");
        assertTrue(dirs.contains("/real/home/.docker/cli-plugins"), dirs.toString());
        assertTrue(dirs.contains("/tmp/isolated-home/.docker/cli-plugins"), dirs.toString());
        // The system-wide locations are not home-dependent and must survive.
        assertTrue(dirs.contains("/usr/local/lib/docker/cli-plugins"), dirs.toString());
        assertTrue(dirs.contains("/opt/homebrew/lib/docker/cli-plugins"), dirs.toString());
    }

    @Test
    void toleratesAMissingHome() {
        java.util.List<String> dirs = DockerPing.composePluginDirs(null, null);
        assertFalse(dirs.isEmpty(), "the system-wide locations still apply");
        assertFalse(dirs.contains("null/.docker/cli-plugins"), "no path built from a null home");
        assertFalse(dirs.contains("/.docker/cli-plugins"), "no path built from a blank home");
    }

    @Test
    void doesNotListTheSameHomeTwice() {
        java.util.List<String> dirs = DockerPing.composePluginDirs("/same", "/same");
        assertEquals(1, dirs.stream().filter(d -> d.equals("/same/.docker/cli-plugins")).count());
    }

    @Test
    void looksForTheBinaryWhereDockerActuallyInstallsIt() {
        // Measured 2026-08-02, the same false negative the compose lookup above
        // already carries a list for. A GUI-launched macOS app inherits the
        // launchd PATH (/usr/bin:/bin:/usr/sbin:/sbin) and the desktop shell
        // spawns java with no env of its own, while Docker Desktop installs its
        // binary at /usr/local/bin/docker. Walking PATH alone therefore reports
        // "not installed" on a machine whose daemon is answering.
        java.util.List<String> dirs = DockerPing.binaryDirs(
                "/usr/bin:/bin:/usr/sbin:/sbin", "/real/home", "/tmp/isolated-home");
        assertTrue(dirs.contains("/usr/bin"), dirs.toString());
        assertTrue(dirs.contains("/usr/local/bin"), dirs.toString());
        assertTrue(dirs.contains("/opt/homebrew/bin"), dirs.toString());
        assertTrue(dirs.contains("/real/home/.docker/bin"), dirs.toString());
        assertTrue(dirs.contains("/tmp/isolated-home/.docker/bin"), dirs.toString());
    }

    @Test
    void theBinaryLookupSurvivesAnEmptyPath() {
        java.util.List<String> dirs = DockerPing.binaryDirs(null, null, null);
        assertTrue(dirs.contains("/usr/local/bin"), "the well-known locations do not depend on PATH");
        assertFalse(dirs.contains(""), "no blank directory");
        assertFalse(dirs.contains("null/.docker/bin"), "no path built from a null home");
    }

    @Test
    void doesNotListTheSameBinaryDirectoryTwice() {
        java.util.List<String> dirs = DockerPing.binaryDirs("/usr/local/bin:/usr/bin", null, null);
        assertEquals(1, dirs.stream().filter(d -> d.equals("/usr/local/bin")).count(), dirs.toString());
    }

    @Test
    void stripsTheUnixSchemeFromTheSocketPath() {
        assertEquals("/var/run/docker.sock", DockerPing.socketPathIn("unix:///var/run/docker.sock"));
        assertEquals("/tmp/d.sock", DockerPing.socketPathIn("/tmp/d.sock"));
        assertNull(DockerPing.socketPathIn(null));
        assertNull(DockerPing.socketPathIn("   "));
    }
}
