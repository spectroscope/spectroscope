package dev.spectroscope.server;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The registry: who is allowed a shell, how many, and — the part the
 * llama-server lesson paid for — that nothing survives the JVM. Caps are checked
 * BEFORE a PTY is spawned, so a caller over the limit never gets a child process
 * that then has to be cleaned up.
 */
class ShellRegistryTest {

    private static final ShellSession.Sink SILENT = new ShellSession.Sink() {
        @Override
        public void data(byte[] chunk) {
        }

        @Override
        public void status(String json) {
        }

        @Override
        public void closeSocket(String reason) {
        }
    };

    @Test
    void tabsBeyondThePerSessionCapAreRefused() throws IOException {
        ShellRegistry registry = new ShellRegistry();
        List<FakePty> made = new ArrayList<>();
        try {
            for (int i = 0; i < ShellRegistry.MAX_PER_SESSION; i++) {
                registry.open("socket-" + i, "abc", () -> {
                    FakePty pty = FakePty.flood();
                    made.add(pty);
                    return pty;
                }, SILENT);
            }
            assertEquals(ShellRegistry.MAX_PER_SESSION, registry.live());
            assertThrows(ShellRegistry.TooManyShells.class,
                    () -> registry.open("socket-over", "abc", () -> {
                        throw new AssertionError("the cap must be checked BEFORE a pty is spawned");
                    }, SILENT));
        } finally {
            registry.closeAll();
        }
    }

    @Test
    void aSecondSessionGetsItsOwnAllowance() throws IOException {
        ShellRegistry registry = new ShellRegistry();
        try {
            for (int i = 0; i < ShellRegistry.MAX_PER_SESSION; i++) {
                registry.open("a-" + i, "session-a", FakePty::flood, SILENT);
            }
            registry.open("b-0", "session-b", FakePty::flood, SILENT);
            assertEquals(ShellRegistry.MAX_PER_SESSION + 1, registry.live());
        } finally {
            registry.closeAll();
        }
    }

    @Test
    void theProcessWideCapHolds() throws IOException {
        ShellRegistry registry = new ShellRegistry();
        try {
            int opened = 0;
            for (int s = 0; s < 20 && opened < ShellRegistry.MAX_TOTAL; s++) {
                for (int t = 0; t < ShellRegistry.MAX_PER_SESSION
                        && opened < ShellRegistry.MAX_TOTAL; t++) {
                    registry.open("s" + s + "-t" + t, "session-" + s, FakePty::flood, SILENT);
                    opened++;
                }
            }
            assertEquals(ShellRegistry.MAX_TOTAL, registry.live());
            assertThrows(ShellRegistry.TooManyShells.class,
                    () -> registry.open("one-more", "fresh-session", () -> {
                        throw new AssertionError("no pty for a caller over the process cap");
                    }, SILENT));
        } finally {
            registry.closeAll();
        }
    }

    @Test
    void closingASocketReapsThatChildOnly() throws IOException {
        ShellRegistry registry = new ShellRegistry();
        FakePty first = FakePty.flood();
        FakePty second = FakePty.flood();
        try {
            registry.open("one", "abc", () -> first, SILENT);
            registry.open("two", "abc", () -> second, SILENT);
            registry.close("one");
            assertTrue(first.closed.get(), "the closed tab's pty is reaped");
            assertTrue(second.alive(), "the other tab keeps running");
            assertEquals(1, registry.live());
        } finally {
            registry.closeAll();
        }
    }

    @Test
    void aShutdownHookLivesExactlyAsLongAsAChildDoes() throws IOException {
        // The LocalRuntime pattern: register while a child is live, deregister when
        // the last one is gone, so a SIGTERM'd server never orphans a shell.
        ShellRegistry registry = new ShellRegistry();
        assertNull(registry.reaper, "no hook while nothing runs");
        registry.open("only", "abc", FakePty::flood, SILENT);
        assertTrue(registry.reaper != null && registry.reaper.isAlive() == false
                        && registry.reaper.getName().equals("spectro-shell-reaper"),
                "a named reaper hook is registered with the first shell");
        registry.close("only");
        assertNull(registry.reaper, "and deregistered with the last");
    }

    @Test
    void theReaperClosesEveryLiveShell() throws IOException {
        ShellRegistry registry = new ShellRegistry();
        FakePty one = FakePty.flood();
        FakePty two = FakePty.flood();
        registry.open("one", "abc", () -> one, SILENT);
        registry.open("two", "def", () -> two, SILENT);
        Thread reaper = registry.reaper;
        assertTrue(reaper != null);
        reaper.run(); // exactly what the JVM does at shutdown
        assertTrue(one.closed.get(), "shutdown reaps every shell");
        assertTrue(two.closed.get());
        assertEquals(0, registry.live());
    }
}
