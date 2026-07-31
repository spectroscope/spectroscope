package dev.spectroscope.server;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The socket side. Everything that arrives here is browser input, so the rules
 * are the closed-by-default ones: a frame the decoder does not understand ends
 * the connection, a text frame ends the connection (the wire is binary), and any
 * way the connection ends reaps the child.
 */
class ShellSocketHandlerTest {

    private final List<FakePty> spawned = new ArrayList<>();
    private ShellRegistry registry;

    /** A provider that hands out fakes and records what it was asked for. */
    private final class RecordingProvider implements PtyProvider {
        Path cwd;
        int rows;
        int cols;

        @Override
        public boolean available() {
            return true;
        }

        @Override
        public String shellPath() {
            return "/bin/zsh";
        }

        @Override
        public Pty open(Path directory, int r, int c) {
            this.cwd = directory;
            this.rows = r;
            this.cols = c;
            FakePty pty = FakePty.flood();
            spawned.add(pty);
            return pty;
        }
    }

    private final RecordingProvider provider = new RecordingProvider();

    private ShellSocketHandler handler() {
        registry = new ShellRegistry();
        return new ShellSocketHandler(registry, provider, () -> "/tmp/shell-handler-test-ws");
    }

    @AfterEach
    void reap() {
        if (registry != null) {
            registry.closeAll();
        }
    }

    @Test
    void aConnectionWithoutASessionGetsNoShell() throws Exception {
        ShellSocketHandler handler = handler();
        FakeSocket socket = new FakeSocket("s1", "ws://localhost:8302/ws/shell");
        handler.afterConnectionEstablished(socket);
        assertNotNull(socket.closed.get(), "no session id, no shell");
        assertTrue(spawned.isEmpty(), "and no pty was spawned");
    }

    @Test
    void aMalformedSessionIdGetsNoShell() throws Exception {
        ShellSocketHandler handler = handler();
        FakeSocket socket = new FakeSocket("s2", "ws://localhost:8302/ws/shell?session=../../etc");
        handler.afterConnectionEstablished(socket);
        assertNotNull(socket.closed.get());
        assertTrue(spawned.isEmpty());
    }

    @Test
    void aGoodConnectionOpensOneShellInTheSessionsWorkspace() throws Exception {
        ShellSocketHandler handler = handler();
        FakeSocket socket = new FakeSocket("s3",
                "ws://localhost:8302/ws/shell?session=abc123&rows=48&cols=200");
        handler.afterConnectionEstablished(socket);
        assertEquals(1, spawned.size());
        assertEquals(Path.of("/tmp/shell-handler-test-ws"), provider.cwd);
        assertEquals(48, provider.rows);
        assertEquals(200, provider.cols);
        assertTrue(socket.textJoined().contains("shell_ready"), socket.textJoined());
        assertTrue(socket.textJoined().contains("/bin/zsh"), socket.textJoined());
    }

    @Test
    void anAbsurdWindowInTheQueryIsClamped() throws Exception {
        ShellSocketHandler handler = handler();
        handler.afterConnectionEstablished(new FakeSocket("s4",
                "ws://localhost:8302/ws/shell?session=abc123&rows=99999&cols=abc"));
        assertEquals(ShellFrame.MAX_ROWS, provider.rows);
        assertEquals(80, provider.cols, "an unparseable size falls back, it does not throw");
    }

    @Test
    void keystrokesReachThePty() throws Exception {
        ShellSocketHandler handler = handler();
        FakeSocket socket = new FakeSocket("s5", "ws://localhost:8302/ws/shell?session=abc123");
        handler.afterConnectionEstablished(socket);
        handler.handleMessage(socket, new BinaryMessage(frame((byte) 0x00, "pwd\n".getBytes())));
        waitUntil(() -> spawned.get(0).writtenText().contains("pwd"));
    }

    @Test
    void aResizeFrameReachesThePty() throws Exception {
        ShellSocketHandler handler = handler();
        FakeSocket socket = new FakeSocket("s6", "ws://localhost:8302/ws/shell?session=abc123");
        handler.afterConnectionEstablished(socket);
        handler.handleMessage(socket,
                new BinaryMessage(new byte[] {0x01, 0x00, 30, 0x00, 100}));
        waitUntil(() -> !spawned.get(0).resizes.isEmpty());
        assertEquals(30, spawned.get(0).resizes.get(0)[0]);
        assertEquals(100, spawned.get(0).resizes.get(0)[1]);
    }

    @Test
    void anUnknownOpcodeEndsTheConnection() throws Exception {
        ShellSocketHandler handler = handler();
        FakeSocket socket = new FakeSocket("s7", "ws://localhost:8302/ws/shell?session=abc123");
        handler.afterConnectionEstablished(socket);
        handler.handleMessage(socket, new BinaryMessage(frame((byte) 0x42, "junk".getBytes())));
        assertNotNull(socket.closed.get(), "an unparseable frame is not tolerated");
        assertTrue(spawned.get(0).closed.get(), "and the child goes with it");
    }

    @Test
    void aTextFrameEndsTheConnection() throws Exception {
        // The shell wire is binary in both directions; a text frame means either a
        // confused client or somebody probing. Neither gets a second try.
        ShellSocketHandler handler = handler();
        FakeSocket socket = new FakeSocket("s8", "ws://localhost:8302/ws/shell?session=abc123");
        handler.afterConnectionEstablished(socket);
        handler.handleMessage(socket, new TextMessage("{\"type\":\"resize\"}"));
        assertNotNull(socket.closed.get());
        assertTrue(spawned.get(0).closed.get());
    }

    @Test
    void closingTheConnectionReapsTheChild() throws Exception {
        ShellSocketHandler handler = handler();
        FakeSocket socket = new FakeSocket("s9", "ws://localhost:8302/ws/shell?session=abc123");
        handler.afterConnectionEstablished(socket);
        assertEquals(1, registry.live());
        handler.afterConnectionClosed(socket, CloseStatus.NORMAL);
        assertTrue(spawned.get(0).closed.get(), "the browser tab closed — the shell dies");
        assertEquals(0, registry.live());
    }

    @Test
    void aTabBeyondTheCapIsRefusedWithoutSpawning() throws Exception {
        ShellSocketHandler handler = handler();
        for (int i = 0; i < ShellRegistry.MAX_PER_SESSION; i++) {
            handler.afterConnectionEstablished(
                    new FakeSocket("cap-" + i, "ws://localhost:8302/ws/shell?session=abc123"));
        }
        int spawnedBefore = spawned.size();
        FakeSocket over = new FakeSocket("cap-over", "ws://localhost:8302/ws/shell?session=abc123");
        handler.afterConnectionEstablished(over);
        assertNotNull(over.closed.get(), "over the cap the socket closes");
        assertEquals(spawnedBefore, spawned.size(), "and no extra pty was spawned");
    }

    @Test
    void messagesAfterTheShellIsGoneAreIgnored() throws Exception {
        ShellSocketHandler handler = handler();
        FakeSocket socket = new FakeSocket("s10", "ws://localhost:8302/ws/shell?session=abc123");
        handler.afterConnectionEstablished(socket);
        handler.afterConnectionClosed(socket, CloseStatus.NORMAL);
        handler.handleMessage(socket, new BinaryMessage(frame((byte) 0x00, "rm -rf /\n".getBytes())));
        Thread.sleep(100);
        assertTrue(!spawned.get(0).writtenText().contains("rm -rf"));
    }

    private static byte[] frame(byte opcode, byte[] payload) {
        byte[] out = new byte[payload.length + 1];
        out[0] = opcode;
        System.arraycopy(payload, 0, out, 1, payload.length);
        return out;
    }

    private static void waitUntil(java.util.function.BooleanSupplier condition) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            if (condition.getAsBoolean()) {
                return;
            }
            Thread.sleep(20);
        }
        throw new AssertionError("condition never became true within 5s");
    }
}
