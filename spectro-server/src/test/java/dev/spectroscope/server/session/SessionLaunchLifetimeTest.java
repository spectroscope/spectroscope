package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.launch.LaunchEntry;
import dev.spectroscope.core.launch.LaunchSupervisor;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.net.ServerSocket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * What "closed" means for what a session LAUNCHED (card 202) — the same
 * question {@code SessionBrowserLifetimeTest} answers for its browser, and the
 * same answer: the socket going away.
 *
 * <p>This test does not assert that a method was called. It puts a real
 * {@code python3 -m http.server} under a real connection, closes the
 * connection, and then asks the operating system whether that pid is gone. An
 * orphaned dev server is the defect the whole reaper exists for, and a mock
 * would have proved nothing about it.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class SessionLaunchLifetimeTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    @EnabledOnOs({OS.MAC, OS.LINUX})
    void closingASessionKillsWhatItLaunched(@TempDir Path project) throws Exception {
        SessionConnection connection = new SessionConnection(
                new FakeSocket("ws-launch-1", "ws://localhost/ws"), JSON, config(), null,
                null, null);
        connection.start();

        int port = freePort();
        Files.writeString(project.resolve("index.html"), "<h1>under test</h1>");
        LaunchSupervisor.Outcome outcome = connection.launches.start(
                new LaunchEntry("web", port, "python3",
                        List.of("-m", "http.server", String.valueOf(port)), null, List.of()),
                project, Duration.ofSeconds(30));
        assertThat(outcome.ok()).as("the app under test came up: %s", outcome.problem()).isTrue();
        long pid = outcome.running().pid();
        assertThat(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false))
                .as("the launched server is alive, pid %s", pid).isTrue();

        connection.onClose();

        assertThat(gone(pid))
                .as("the session closing takes its launched server with it — otherwise it "
                        + "holds port %s after the session that started it is gone, pid %s",
                        port, pid)
                .isTrue();
        assertThat(connection.launches.running())
                .as("and the session's supervisor holds nothing afterwards")
                .isEmpty();
    }

    @Test
    void aSessionThatLaunchedNothingClosesWithoutComplaint() {
        SessionConnection connection = new SessionConnection(
                new FakeSocket("ws-launch-2", "ws://localhost/ws"), JSON, config(), null,
                null, null);
        connection.start();

        connection.onClose();   // an empty supervisor closes nothing and throws nothing

        assertThat(connection.launches.running()).isEmpty();
    }

    private static boolean gone(long pid) throws InterruptedException {
        for (int attempt = 0; attempt < 100; attempt++) {
            if (ProcessHandle.of(pid).map(handle -> !handle.isAlive()).orElse(true)) {
                return true;
            }
            TimeUnit.MILLISECONDS.sleep(100);
        }
        return false;
    }

    private static int freePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    private static SpectroConfig config() {
        return SpectroConfig.load(SpectroConfig.Overrides.none());
    }
}
