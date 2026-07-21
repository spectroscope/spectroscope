package dev.spectroscope.server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The spawn logic's security core (block 3b), unit-tested with a launcher that
 * CAPTURES the command instead of running it: the opt-in + hub gate, the FORCED
 * readonly permission (a UI-spawned node can never run commands or write), the
 * validated args (no shell — a ProcessBuilder arg array), and the child-JVM
 * fallback that runs the CLI off the server's own classpath.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class NodeSpawnerTest {

    /** A launcher that records the command rather than starting a process. */
    private static final class Capturing implements NodeSpawner.Launcher {
        private final AtomicReference<List<String>> command = new AtomicReference<>();

        @Override
        public void start(List<String> cmd) {
            command.set(cmd);
        }

        List<String> command() {
            return command.get();
        }
    }

    @Test
    void spawnIsAllowedOnlyWhenOptedInAndTheHubIsUp() {
        Capturing cap = new Capturing();
        try (FleetAggregator hubOn = new FleetAggregator("0")) {
            assertFalse(new NodeSpawner(false, "", hubOn, cap).allowed(),
                    "opt-in OFF → not allowed even with a hub");
            assertTrue(new NodeSpawner(true, "", hubOn, cap).allowed(),
                    "opted in + hub up → allowed");
        }
        try (FleetAggregator hubOff = new FleetAggregator("")) {
            assertFalse(new NodeSpawner(true, "", hubOff, cap).allowed(),
                    "no hub → not allowed even when opted in");
        }
    }

    @Test
    void spawnForcesReadonlyAndCarriesTheValidatedArgs() throws Exception {
        Capturing cap = new Capturing();
        try (FleetAggregator hubOn = new FleetAggregator("0")) {
            NodeSpawner spawner = new NodeSpawner(true, "/usr/local/bin/spectro", hubOn, cap);

            String id = spawner.spawn(new SpawnRequest("scan the logs", "fleet-x", "reviewer", "node-7", false));

            assertEquals("node-7", id);
            List<String> c = cap.command();
            assertEquals("/usr/local/bin/spectro", c.get(0), "the configured launcher runs first");
            assertTrue(c.contains("node"), "the node subcommand");
            assertEquals("readonly", c.get(c.indexOf("--permissions") + 1),
                    "a UI-spawned node is FORCED readonly — no runCommand, no write, even on a gate bypass");
            assertTrue(c.contains("--prompt=scan the logs"),
                    "the prompt rides as an attached value — never re-readable as a flag");
            assertEquals("fleet-x", c.get(c.indexOf("--context") + 1));
            assertEquals("reviewer", c.get(c.indexOf("--role") + 1));
            assertEquals("node-7", c.get(c.indexOf("--id") + 1));
            assertEquals("127.0.0.1:" + hubOn.port(), c.get(c.indexOf("--hub") + 1),
                    "the node joins THIS server's loopback hub");
            assertFalse(c.contains("--linger"), "linger not requested");
        }
    }

    @Test
    void spawnFallsBackToAChildJvmOnTheServerClasspathAndHonoursLinger() throws Exception {
        Capturing cap = new Capturing();
        try (FleetAggregator hubOn = new FleetAggregator("0")) {
            String id = new NodeSpawner(true, "", hubOn, cap)
                    .spawn(new SpawnRequest("go", "fleet-x", null, null, true));

            assertTrue(id.startsWith("node-"), "an id is generated when the caller gives none");
            List<String> c = cap.command();
            assertTrue(c.get(0).endsWith("java") || c.get(0).endsWith("java.exe"),
                    "no launcher configured → spawn a child JVM");
            assertTrue(c.contains("dev.spectroscope.cli.SpectroCli"),
                    "running the CLI off the server's own classpath");
            assertEquals("worker", c.get(c.indexOf("--role") + 1), "role defaults to worker");
            assertTrue(c.contains("--linger"), "linger honoured");
        }
    }

    @Test
    void spawnRejectsMissingPromptAndUnsafeIdentifiers() {
        Capturing cap = new Capturing();
        try (FleetAggregator hubOn = new FleetAggregator("0")) {
            NodeSpawner s = new NodeSpawner(true, "", hubOn, cap);
            assertThrows(IllegalArgumentException.class,
                    () -> s.spawn(new SpawnRequest("", "fleet-x", null, null, false)), "blank prompt");
            assertThrows(IllegalArgumentException.class,
                    () -> s.spawn(new SpawnRequest("go", "bad topic!", null, null, false)), "unsafe context");
            assertThrows(IllegalArgumentException.class,
                    () -> s.spawn(new SpawnRequest("go", "fleet-x", "r m -rf", null, false)), "unsafe role");
            assertThrows(IllegalArgumentException.class,
                    () -> s.spawn(new SpawnRequest("go", "fleet-x", null, "../../etc", false)), "unsafe id");
            // The argv-injection guard: a leading dash would become a flag.
            assertThrows(IllegalArgumentException.class,
                    () -> s.spawn(new SpawnRequest("go", "fleet-x", "--linger", null, false)),
                    "an option-shaped role is refused");
            assertThrows(IllegalArgumentException.class,
                    () -> s.spawn(new SpawnRequest("go", "--permissions", null, null, false)),
                    "an option-shaped context is refused");
        }
    }

    @Test
    void aDashPrefixedPromptIsAValueNotAnInjectedFlag() throws Exception {
        Capturing cap = new Capturing();
        try (FleetAggregator hubOn = new FleetAggregator("0")) {
            new NodeSpawner(true, "", hubOn, cap)
                    .spawn(new SpawnRequest("--permissions auto", "fleet-x", null, null, false));
            List<String> c = cap.command();
            assertTrue(c.contains("--prompt=--permissions auto"),
                    "a prompt that looks like a flag is bound as the attached --prompt value");
            assertEquals("readonly", c.get(c.indexOf("--permissions") + 1),
                    "the real, forced --permissions is still readonly");
        }
    }

    @Test
    void spawnIsRateLimitedToStopAForkBomb() throws Exception {
        Capturing cap = new Capturing();
        long[] fakeNow = {1_000_000L};
        try (FleetAggregator hubOn = new FleetAggregator("0")) {
            NodeSpawner s = new NodeSpawner(true, "", hubOn, cap, () -> fakeNow[0]);
            for (int i = 0; i < NodeSpawner.MAX_PER_WINDOW; i++) {
                s.spawn(new SpawnRequest("go", "fleet-x", null, null, false)); // within the window
            }
            assertThrows(IllegalStateException.class,
                    () -> s.spawn(new SpawnRequest("go", "fleet-x", null, null, false)),
                    "the " + (NodeSpawner.MAX_PER_WINDOW + 1) + "th spawn in the window is rate-limited");

            fakeNow[0] += NodeSpawner.WINDOW_MS + 1; // the window rolls over
            String id = s.spawn(new SpawnRequest("go", "fleet-x", null, null, false));
            assertTrue(id.startsWith("node-"), "after the window, spawning resumes");
        }
    }

    @Test
    void loopbackDetectionAcceptsLocalAndRejectsRemote() {
        assertTrue(FleetController.isLoopback("127.0.0.1"));
        assertTrue(FleetController.isLoopback("0:0:0:0:0:0:0:1"));
        assertTrue(FleetController.isLoopback("::1"));
        assertFalse(FleetController.isLoopback("10.0.0.5"), "a LAN address is not loopback");
        assertFalse(FleetController.isLoopback("203.0.113.7"), "a public address is not loopback");
        assertFalse(FleetController.isLoopback("not-an-address"), "an unparseable addr is refused, not trusted");
    }

    @Test
    void fatJarClasspathIsDetectedSoSpawnDoesNotFalselySucceed() {
        String sep = java.io.File.pathSeparator;
        assertTrue(NodeSpawner.looksLikeFatJar("/opt/spectro/spectro-server.jar"),
                "a single jar is a packaged server — the child -cp cannot see the CLI");
        assertTrue(NodeSpawner.looksLikeFatJar(null));
        assertTrue(NodeSpawner.looksLikeFatJar(""));
        assertFalse(NodeSpawner.looksLikeFatJar("/a/classes" + sep + "/b/lib.jar"),
                "a multi-entry (dev) classpath is not a fat jar");
        assertFalse(NodeSpawner.looksLikeFatJar("/project/build/classes/java/main"),
                "a class directory is not a fat jar");
    }

    @Test
    void hostHeaderCheckAcceptsLocalhostAndRejectsARebindingDomain() {
        // The DNS-rebinding defense: a rebinding page reaches loopback but its
        // Host is the attacker's domain (JS cannot forge Host), so it is rejected.
        assertTrue(FleetController.isLocalHostName("localhost"));
        assertTrue(FleetController.isLocalHostName("127.0.0.1"));
        assertTrue(FleetController.isLocalHostName("::1"));
        assertTrue(FleetController.isLocalHostName("[::1]"), "an IPv6 literal's brackets are stripped");
        assertFalse(FleetController.isLocalHostName("attacker.com"), "a rebinding Host is refused");
        assertFalse(FleetController.isLocalHostName("localhost.attacker.com"),
                "a suffix trick is not localhost");
        assertFalse(FleetController.isLocalHostName(null));
        assertFalse(FleetController.isLocalHostName(""));
    }
}
