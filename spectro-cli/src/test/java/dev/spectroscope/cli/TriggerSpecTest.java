package dev.spectroscope.cli;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 72 flag grammar. Two of the refusals ARE the security fences: --listen
 * takes a bare port only (a host in the value is refused at parse time — the
 * loopback bind cannot be argued away), and --watch must canonicalize to an
 * existing directory before any watcher starts.
 */
class TriggerSpecTest {

    // --- --every -----------------------------------------------------------

    @Test
    void everyParsesTheDurationGrammar() {
        assertEquals(1_000L, TriggerSpec.parseEveryMs("1000ms"));
        assertEquals(30_000L, TriggerSpec.parseEveryMs("30s"));
        assertEquals(300_000L, TriggerSpec.parseEveryMs("5m"));
        assertEquals(7_200_000L, TriggerSpec.parseEveryMs("2h"));
    }

    @Test
    void everyRefusesSubSecondPeriodsAndJunk() {
        IllegalArgumentException spin = assertThrows(IllegalArgumentException.class,
                () -> TriggerSpec.parseEveryMs("500ms"));
        assertTrue(spin.getMessage().contains("at least 1s"), spin.getMessage());
        assertThrows(IllegalArgumentException.class, () -> TriggerSpec.parseEveryMs("5"));
        assertThrows(IllegalArgumentException.class, () -> TriggerSpec.parseEveryMs("often"));
        assertThrows(IllegalArgumentException.class, () -> TriggerSpec.parseEveryMs("5 m"));
        assertThrows(IllegalArgumentException.class, () -> TriggerSpec.parseEveryMs(""));
    }

    // --- --listen (the bind fence at parse time) ---------------------------

    @Test
    void listenTakesABarePortOnly() {
        assertEquals(8300, TriggerSpec.parseListenPort("8300"));
    }

    @Test
    void listenRefusesAnythingCarryingAHost() {
        // The fence's first half: a host cannot even be EXPRESSED. The bind
        // itself is loopback by construction (HttpTrigger pins that half).
        IllegalArgumentException refused = assertThrows(IllegalArgumentException.class,
                () -> TriggerSpec.parseListenPort("0.0.0.0:8300"));
        assertTrue(refused.getMessage().contains("bare port"), refused.getMessage());
        assertThrows(IllegalArgumentException.class,
                () -> TriggerSpec.parseListenPort("localhost:8300"));
        assertThrows(IllegalArgumentException.class,
                () -> TriggerSpec.parseListenPort("127.0.0.1:8300"));
        assertThrows(IllegalArgumentException.class, () -> TriggerSpec.parseListenPort("0"));
        assertThrows(IllegalArgumentException.class, () -> TriggerSpec.parseListenPort("70000"));
        assertThrows(IllegalArgumentException.class, () -> TriggerSpec.parseListenPort("port"));
    }

    // --- --watch (the root fence at boot time) -----------------------------

    @Test
    void watchCanonicalizesAnExistingDirectory(@TempDir Path dir) throws Exception {
        Path real = TriggerSpec.canonicalWatchRoot(dir.toString());
        assertEquals(dir.toRealPath(), real, "symlinks are resolved ONCE, at boot");
    }

    @Test
    void watchRefusesMissingPathsAndFiles(@TempDir Path dir) throws Exception {
        IllegalArgumentException missing = assertThrows(IllegalArgumentException.class,
                () -> TriggerSpec.canonicalWatchRoot(dir.resolve("nope").toString()));
        assertTrue(missing.getMessage().contains("does not exist"), missing.getMessage());

        Path file = Files.writeString(dir.resolve("a-file.txt"), "x");
        IllegalArgumentException notADir = assertThrows(IllegalArgumentException.class,
                () -> TriggerSpec.canonicalWatchRoot(file.toString()));
        assertTrue(notADir.getMessage().contains("directory"), notADir.getMessage());
    }

    // --- the assembled spec ------------------------------------------------

    @Test
    void parseAssemblesTheSpecAndMintsATokenOnlyForListen(@TempDir Path dir) {
        TriggerSpec spec = TriggerSpec.parse(dir.toString(), "8300", "5m");
        assertTrue(spec.any());
        assertEquals(8300, spec.listenPort());
        assertEquals(300_000L, spec.everyMs());
        assertEquals(32, spec.token().length(), "per-boot bearer token, 32 hex chars");
        assertTrue(spec.token().matches("[0-9a-f]{32}"));

        TriggerSpec noListen = TriggerSpec.parse(dir.toString(), null, null);
        assertNull(noListen.token(), "no HTTP surface, no token to leak");
        assertNull(noListen.everyMs());
    }

    @Test
    void describeNamesEveryTriggerForTheCardAndTheBootLine(@TempDir Path dir) throws Exception {
        TriggerSpec all = TriggerSpec.parse(dir.toString(), "8300", "5m");
        assertEquals("watch:" + dir.toRealPath() + " + listen:127.0.0.1:8300 + every:5m",
                all.describe());
        assertEquals("every:5m", TriggerSpec.parse(null, null, "5m").describe());
    }
}
