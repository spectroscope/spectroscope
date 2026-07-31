package dev.spectroscope.server;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The real {@code spectro-pty} helper against a real shell. These are the tests
 * that decide whether the mechanism works at all, and they check the three things
 * a fake cannot: the child really has a controlling terminal, a resize really
 * reaches it, and <b>no process outlives the connection</b> — including the case
 * where the JVM is killed hard enough that no shutdown hook ever runs.
 *
 * <p>Skipped when the helper has not been built ({@code scripts/build-spectro-pty.sh}),
 * so a checkout without a C toolchain still goes green.</p>
 */
class SpectroPtyHelperTest {

    private static HelperPtyProvider provider;

    @BeforeAll
    static void locateHelper() {
        // A plain POSIX shell, not the operator's: these assertions are about the
        // pty, and an oh-my-zsh prompt would make the output machine-unfriendly.
        provider = new HelperPtyProvider(HelperPtyProvider::locate, () -> "/bin/sh");
        assumeTrue(provider.available(),
                "spectro-pty is not built — run scripts/build-spectro-pty.sh");
    }

    @Test
    void theShellRunsOnARealTerminal() throws Exception {
        Path cwd = Files.createTempDirectory("spectro-pty-tty");
        try (PtyProvider.Pty pty = provider.open(cwd, 24, 80)) {
            Drain drain = Drain.on(pty);
            pty.write("tty\n".getBytes());
            // Darwin names PTYs /dev/ttysNNN, Linux /dev/pts/N — the check must know both,
            // or a green Linux helper fails its own test (the build script's verify pattern
            // learned the same lesson). "/dev/" is the token both worlds emit; none of the
            // probe's reachable failure strings contain either name, so the gate holds.
            String seen = drain.await("/dev/", 10_000);
            assertTrue(seen.contains("/dev/tty") || seen.contains("/dev/pts/"),
                    "the child has no controlling terminal:\n" + seen);
        }
    }

    @Test
    void theShellStartsInTheGivenWorkspace() throws Exception {
        Path cwd = Files.createTempDirectory("spectro-pty-cwd").toRealPath();
        Files.writeString(cwd.resolve("written-by-the-agent.txt"), "hi");
        try (PtyProvider.Pty pty = provider.open(cwd, 24, 80)) {
            Drain drain = Drain.on(pty);
            pty.write("ls\n".getBytes());
            String seen = drain.await("written-by-the-agent.txt", 10_000);
            assertTrue(seen.contains("written-by-the-agent.txt"),
                    "the shell does not share the agent's world:\n" + seen);
        }
    }

    @Test
    void aResizeReachesTheChild() throws Exception {
        Path cwd = Files.createTempDirectory("spectro-pty-size");
        try (PtyProvider.Pty pty = provider.open(cwd, 24, 80)) {
            Drain drain = Drain.on(pty);
            pty.resize(48, 173);
            pty.write("stty size\n".getBytes());
            String seen = drain.await("48 173", 10_000);
            assertTrue(seen.contains("48 173"), "SIGWINCH/TIOCSWINSZ did not land:\n" + seen);
        }
    }

    @Test
    void closingTheSessionLeavesNoProcessBehind() throws Exception {
        Path cwd = Files.createTempDirectory("spectro-pty-reap");
        PtyProvider.Pty pty = provider.open(cwd, 24, 80);
        Drain drain = Drain.on(pty);
        pty.write("echo ready\n".getBytes());
        drain.await("ready", 10_000);
        long helperPid = pty.pid();
        List<Long> family = new ArrayList<>();
        long appear = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (family.isEmpty() && System.nanoTime() < appear) {
            family = descendants(helperPid);
            Thread.sleep(50);
        }
        assertTrue(pty.alive());
        assertTrue(!family.isEmpty(), "the helper never forked a shell");

        pty.close();

        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        List<Long> stragglers = new ArrayList<>();
        while (System.nanoTime() < deadline) {
            stragglers = alive(helperPid, family);
            if (stragglers.isEmpty()) {
                break;
            }
            Thread.sleep(100);
        }
        assertTrue(stragglers.isEmpty(), "these processes outlived the shell session: " + stragglers);
    }

    @Test
    void theChildDiesEvenWhenTheJvmIsKilledOutright() throws Exception {
        // A `kill -9` of the server runs no shutdown hook and calls no destroy().
        // What still happens is that the helper's stdin pipe closes, and that is
        // the helper's own signal to take its process group down with it. Proven
        // here by closing only the pipe, exactly as a dead JVM would.
        Path helper = HelperPtyProvider.locate();
        Path cwd = Files.createTempDirectory("spectro-pty-orphan");
        ProcessBuilder pb = new ProcessBuilder(
                helper.toString(), "24", "80", "--", "/bin/sh", "-i");
        pb.directory(cwd.toFile());
        pb.redirectErrorStream(true);
        Process raw = pb.start();
        try {
            List<Long> family = new ArrayList<>();
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (family.isEmpty() && System.nanoTime() < deadline) {
                family = descendants(raw.pid());
                Thread.sleep(50);
            }
            assertTrue(!family.isEmpty(), "no shell to orphan");

            raw.getOutputStream().close(); // the pipe a dead JVM leaves behind

            assertTrue(raw.waitFor(10, TimeUnit.SECONDS), "the helper ignored stdin EOF");
            List<Long> stragglers = new ArrayList<>();
            deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            while (System.nanoTime() < deadline) {
                stragglers = alive(raw.pid(), family);
                if (stragglers.isEmpty()) {
                    break;
                }
                Thread.sleep(100);
            }
            assertTrue(stragglers.isEmpty(), "orphaned after a hard JVM death: " + stragglers);
        } finally {
            raw.destroyForcibly();
        }
    }

    @Test
    void twoTabsAreTwoIndependentChildren() throws Exception {
        Path cwd = Files.createTempDirectory("spectro-pty-tabs");
        try (PtyProvider.Pty one = provider.open(cwd, 24, 80);
                PtyProvider.Pty two = provider.open(cwd, 24, 80)) {
            assertNotEquals(one.pid(), two.pid());
            Drain first = Drain.on(one);
            Drain second = Drain.on(two);
            one.write("echo TAB-ONE\n".getBytes());
            two.write("echo TAB-TWO\n".getBytes());
            assertTrue(first.await("TAB-ONE", 10_000).contains("TAB-ONE"));
            assertTrue(second.await("TAB-TWO", 10_000).contains("TAB-TWO"));
        }
    }

    // ---- helpers ---------------------------------------------------------------

    /** Every descendant pid of {@code pid}, snapshot. */
    private static List<Long> descendants(long pid) {
        return ProcessHandle.of(pid)
                .map(h -> h.descendants().map(ProcessHandle::pid).toList())
                .orElse(List.of());
    }

    /** Which of the helper and its recorded family are still running. */
    private static List<Long> alive(long helperPid, List<Long> family) {
        List<Long> out = new ArrayList<>();
        if (ProcessHandle.of(helperPid).filter(ProcessHandle::isAlive).isPresent()) {
            out.add(helperPid);
        }
        for (Long pid : family) {
            if (ProcessHandle.of(pid).filter(ProcessHandle::isAlive).isPresent()) {
                out.add(pid);
            }
        }
        return out;
    }

    /** Collects pty output on a thread so the test can wait for a marker. */
    private static final class Drain {
        private final StringBuffer seen = new StringBuffer();

        static Drain on(PtyProvider.Pty pty) {
            Drain drain = new Drain();
            Thread thread = new Thread(() -> {
                try (InputStream in = pty.output()) {
                    byte[] buf = new byte[4096];
                    int n;
                    while ((n = in.read(buf, 0, buf.length)) > 0) {
                        drain.seen.append(new String(buf, 0, n));
                    }
                } catch (Exception done) {
                    // the pty closed — nothing to report
                }
            }, "pty-test-drain");
            thread.setDaemon(true);
            thread.start();
            return drain;
        }

        String await(String needle, long millis) throws InterruptedException {
            long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(millis);
            while (System.nanoTime() < deadline) {
                if (seen.indexOf(needle) >= 0) {
                    return seen.toString();
                }
                Thread.sleep(50);
            }
            return seen.toString();
        }
    }
}
