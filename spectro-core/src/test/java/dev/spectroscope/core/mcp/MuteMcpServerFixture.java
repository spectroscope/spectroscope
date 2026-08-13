package dev.spectroscope.core.mcp;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.CountDownLatch;

/**
 * A server that spawns and then says nothing — the far end of
 * {@link McpMuteServerRealProcessTest} and the exact shape card 221 was found on.
 * It is a {@code main} of its own, launched with {@code java -cp …} the way
 * {@link StdioTransport} launches any configured server, so the harness is talking
 * to a real operating system process over a real pipe.
 *
 * <p>What makes it the right fixture and not merely a slow one: it never writes a
 * byte to stdout and it never exits on its own. A {@code readLine} on that pipe
 * cannot return and cannot be interrupted, which is the condition the deadlock
 * needs. An {@code initialize} arrives on stdin and is dropped on the floor.
 *
 * <p>{@code args[0]} is a file the fixture writes its own pid into before going
 * quiet. The test reads it to answer criterion 3 by <b>looking for the process</b>
 * afterwards rather than by trusting that something called {@code destroy()}.
 *
 * <p>{@code args[1]} picks how it misbehaves:
 * <ul>
 *   <li>{@code mute} (default) — never writes a byte; the read times out;</li>
 *   <li>{@code gibberish} — answers the handshake with one line that is not JSON,
 *       so {@code initialize} fails <b>without</b> a timeout. That is the second
 *       way to orphan a child: no timeout means no poison, and the skip path used
 *       to walk away from a transport it had already established.</li>
 * </ul>
 */
public final class MuteMcpServerFixture {

    /** Static main only — never instantiated. */
    private MuteMcpServerFixture() {
    }

    /**
     * Announce the pid, misbehave in the configured way, then block forever.
     *
     * @param args {@code args[0]} the pid file to write; {@code args[1]} {@code mute} or {@code gibberish}
     * @throws IOException          when the pid file cannot be written — the process then dies, which the test sees
     * @throws InterruptedException never in practice; the latch is never counted down
     */
    public static void main(String[] args) throws IOException, InterruptedException {
        if (args.length > 0) {
            // Write-then-move so the test never reads a half-written pid.
            Path target = Path.of(args[0]);
            Path staging = Path.of(args[0] + ".tmp");
            Files.writeString(staging, Long.toString(ProcessHandle.current().pid()),
                    StandardCharsets.UTF_8);
            Files.move(staging, target, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        }
        if (args.length > 1 && args[1].equals("gibberish")) {
            System.out.println("this is not JSON-RPC and never will be");
            System.out.flush();
        }
        // Not a sleep with a deadline: the point is a pipe that will never carry another
        // line and a process that will never end by itself. Only a signal ends this.
        new CountDownLatch(1).await();
    }
}
