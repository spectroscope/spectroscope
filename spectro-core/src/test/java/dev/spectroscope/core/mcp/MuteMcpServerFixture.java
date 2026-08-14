package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
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
 *       to walk away from a transport it had already established;</li>
 *   <li>{@code polite} — a server that does not misbehave at all. It answers the
 *       handshake, then reads stdin until end of stream, and it writes <b>both</b>
 *       ways out into {@code <pidfile>.exit} with the moment each arrived:
 *       {@code STDIN-EOF} when the client closed its stdin, {@code SIGNAL} when a
 *       signal reached it first. The MCP stdio shutdown sequence is close stdin,
 *       wait, {@code SIGTERM}, {@code SIGKILL}, and a teardown that starts at step
 *       three cannot be told from a correct one by exit codes or by wall time.</li>
 * </ul>
 *
 * <p><b>Why the file carries timestamps and not a single word.</b> On Unix the JDK's
 * {@code Process.destroy()} sends the signal and <i>then</i> closes the three streams,
 * so a killed child does eventually see end-of-stream too — a few milliseconds late and
 * with the axe already falling. Which of the two the child notices first is a race
 * between its own threads, so "what ended it" is not a decidable question. "How long
 * did it have after end-of-stream, before anything signalled it" is, and that gap is
 * the actual promise: a server that flushes on EOF needs a window, not a word.
 */
public final class MuteMcpServerFixture {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Static main only — never instantiated. */
    private MuteMcpServerFixture() {
    }

    /**
     * Announce the pid, misbehave in the configured way, then block forever.
     *
     * @param args {@code args[0]} the pid file to write; {@code args[1]} {@code mute},
     *             {@code gibberish} or {@code polite}
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
            Files.move(staging, target, StandardCopyOption.REPLACE_EXISTING);
        }
        String mode = args.length > 1 ? args[1] : "mute";
        if (mode.equals("gibberish")) {
            System.out.println("this is not JSON-RPC and never will be");
            System.out.flush();
        }
        if (mode.equals("polite")) {
            servePoliteAndRecordHowItEnded(Path.of(args[0] + ".exit"));
            return;
        }
        // Not a sleep with a deadline: the point is a pipe that will never carry another
        // line and a process that will never end by itself. Only a signal ends this.
        new CountDownLatch(1).await();
    }

    /**
     * Answer the handshake, then sit on stdin until it ends — recording the moment each
     * way out arrived.
     *
     * <p>The shutdown hook is the {@code SIGNAL} half. It also runs on a clean exit,
     * which is why it keeps quiet once the end-of-stream path has taken over: a server
     * that left because its stdin ended did not receive a signal, and saying so would
     * make every run look identical.
     *
     * @param log where to record what arrived, and when
     * @throws IOException if stdin cannot be read
     */
    private static void servePoliteAndRecordHowItEnded(Path log) throws IOException {
        Runtime.getRuntime().addShutdownHook(new Thread(() -> record(log, "SIGNAL")));

        BufferedReader in = new BufferedReader(
                new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            answer(line);
        }
        record(log, "STDIN-EOF");
        // The flush a real server does on end-of-stream, standing in for whatever it is:
        // writing a cache, closing a database, saying goodbye to an upstream. Half a
        // second is what the promise is worth; a client that signals in that window has
        // taken it away. Then halt() rather than return, so the shutdown hook can only
        // ever mean "a signal arrived" and never "this process left tidily".
        sleepQuietly(500);
        Runtime.getRuntime().halt(0);
    }

    /**
     * Sleep without the checked exception; an interrupt just shortens the flush.
     *
     * @param millis how long to pretend to be flushing
     */
    private static void sleepQuietly(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    /**
     * Reply to one JSON-RPC frame with the least a handshake needs. A frame without an
     * id is a notification and is answered with silence, per JSON-RPC.
     *
     * @param line one request frame, newline-delimited JSON
     */
    private static void answer(String line) {
        try {
            JsonNode frame = JSON.readTree(line);
            JsonNode id = frame.get("id");
            if (id == null || id.isNull()) {
                return;
            }
            String method = frame.path("method").asText("");
            String result = switch (method) {
                case "initialize" -> "{\"protocolVersion\":\"2024-11-05\","
                        + "\"serverInfo\":{\"name\":\"polite\"},\"capabilities\":{}}";
                case "tools/list" -> "{\"tools\":[]}";
                default -> "{}";
            };
            System.out.println("{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"result\":" + result + "}");
            System.out.flush();
        } catch (IOException malformed) {
            // A fixture that cannot parse the client's frame simply says nothing back.
        }
    }

    /**
     * Append one event with the moment it arrived. Both events can happen, and the
     * order and the distance between them is the measurement — so nothing here
     * overwrites anything.
     *
     * @param log where the events are collected
     * @param what {@code STDIN-EOF} or {@code SIGNAL}
     */
    private static void record(Path log, String what) {
        try {
            Files.writeString(log, what + " " + System.nanoTime() + "\n", StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException ignored) {
            // Nothing useful to do from a dying fixture; the test sees a missing line.
        }
    }
}
