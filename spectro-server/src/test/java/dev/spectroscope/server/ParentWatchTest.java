package dev.spectroscope.server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * Card 396, criterion 7: a server the desktop app started does not outlive it.
 *
 * <p>On 2026-09-23 two JVMs of the desktop app kept running with parent PID 1
 * after their Electron parent died by SIGKILL, and both still listened on
 * their ports the next morning. This test starts a real server in its own JVM
 * under a fake parent, a {@code /bin/sh} that does nothing but wait for it,
 * kills that parent with SIGKILL, and watches the server.</p>
 *
 * <p>Each server gets a temporary home, a temporary working directory, port 0
 * and the loopback address, so it touches no real settings and no port anyone
 * else uses. Whatever this test started is ended in {@code finally}.</p>
 */
class ParentWatchTest {

    /** How long a server whose parent is gone may take to end: the JDK notices a
     *  parent that is not its child by polling, and the server then shuts down
     *  gracefully. The runs measured on 2026-09-24 are in the card's evidence. */
    private static final long GRACE_SECONDS = 20;

    /** How long the server may take to boot on a busy machine. */
    private static final long BOOT_SECONDS = 90;

    /** A server under its fake parent.
     *  @param parent the fake parent, a child of this test JVM
     *  @param server the server, the fake parent's child
     *  @param log    the server's log file in its temporary home */
    private record Started(Process parent, ProcessHandle server, Path log) {
    }

    private static Started startUnderFakeParent(Path dir, boolean desktopFlag) throws Exception {
        Path home = Files.createDirectories(dir.resolve("home"));
        Path work = Files.createDirectories(dir.resolve("work"));
        Path out = dir.resolve("server.out");
        List<String> command = new ArrayList<>(List.of("/bin/sh", "-c",
                "\"$@\" > \"$SERVER_OUT\" 2>&1 & echo $!; wait", "fake-parent",
                Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-Xmx256m", "-Duser.home=" + home));
        if (desktopFlag) {
            command.add("-Dspectro.bundle.bin=" + Files.createDirectories(dir.resolve("bin")));
        }
        command.addAll(List.of("-cp", System.getProperty("java.class.path"),
                SpectroServerApplication.class.getName(),
                "--server.port=0", "--server.address=127.0.0.1", "--SPECTRO_HUB_PORT="));
        ProcessBuilder builder = new ProcessBuilder(command).directory(work.toFile());
        builder.environment().put("SERVER_OUT", out.toString());
        Process parent = builder.start();
        String pidLine;
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(parent.getInputStream(), StandardCharsets.UTF_8))) {
            pidLine = reader.readLine();
        }
        ProcessHandle server = ProcessHandle.of(Long.parseLong(pidLine.strip())).orElseThrow();
        Path log = home.resolve(".spectro/logs/spectroscope.log");
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(BOOT_SECONDS);
        while (!read(log).contains("Tomcat started on port")) {
            if (!server.isAlive()) {
                fail("the server died while booting:\n" + read(out) + read(log));
            }
            if (System.nanoTime() > deadline) {
                server.destroyForcibly();
                fail("the server did not boot in " + BOOT_SECONDS + " s:\n" + read(out));
            }
            Thread.sleep(100);
        }
        assertEquals(parent.pid(), server.parent().map(ProcessHandle::pid).orElse(-1L),
                "test premise: the server's parent is the fake parent");
        return new Started(parent, server, log);
    }

    private static String read(Path file) {
        try {
            return Files.exists(file) ? Files.readString(file) : "";
        } catch (IOException unreadable) {
            return "";
        }
    }

    private static void end(Started started) {
        started.parent().destroyForcibly();
        if (started.server().isAlive()) {
            started.server().destroyForcibly();
        }
    }

    @Test
    @Timeout(value = 150, unit = TimeUnit.SECONDS)
    void aServerTheDesktopStartedEndsWithItsParent(@TempDir Path dir) throws Exception {
        Started started = startUnderFakeParent(dir, true);
        try {
            long killedAt = System.nanoTime();
            started.parent().destroyForcibly();
            started.parent().waitFor();
            try {
                started.server().onExit().get(GRACE_SECONDS, TimeUnit.SECONDS);
            } catch (TimeoutException stillThere) {
                fail("the server outlived its parent by " + GRACE_SECONDS + " s: PID "
                        + started.server().pid() + " still runs, parent now "
                        + started.server().parent().map(ProcessHandle::pid).orElse(-1L));
            }
            long millis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - killedAt);
            System.out.println("card-396 parent-watch: server ended " + millis
                    + " ms after its parent was killed");
            assertTrue(read(started.log()).contains("parent watch: PID " + started.parent().pid()
                    + " has ended"), "the server says why it ends:\n" + read(started.log()));
        } finally {
            end(started);
        }
    }

    /**
     * The other edge: without the desktop's flag nothing is watched, so a
     * server started with nohup from a shell that then exits keeps running.
     */
    @Test
    @Timeout(value = 150, unit = TimeUnit.SECONDS)
    void aServerStartedWithoutTheDesktopFlagOutlivesItsParent(@TempDir Path dir)
            throws Exception {
        Started started = startUnderFakeParent(dir, false);
        try {
            started.parent().destroyForcibly();
            started.parent().waitFor();
            Thread.sleep(5_000);
            assertTrue(started.server().isAlive(),
                    "no flag, no watch: the server must still run 5 s after its parent ended");
        } finally {
            end(started);
        }
    }
}
