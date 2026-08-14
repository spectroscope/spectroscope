package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.time.Duration;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Owns the JSON-RPC 2.0 framing over a reader/writer pair: one JSON object per
 * line (newline-delimited), requests correlated to responses by an incrementing
 * numeric id, with a bounded read timeout per call. It takes the two streams as
 * constructor arguments so a test can drive it over in-memory {@code Piped}
 * streams — there is no process in this class; {@link StdioTransport} owns that.
 *
 * <p>This channel is <b>synchronous and single-threaded</b> from the caller's
 * point of view: each {@link #request} writes a frame then blocks reading the
 * next line as its response, which is exactly the MCP stdio interaction pattern
 * (one outstanding request at a time). The blocking read is bounded by running it
 * on a daemon virtual thread and {@code Future.get(timeout)}, so a server that
 * goes silent surfaces a timeout rather than hanging forever.
 *
 * <h2>Why the teardown takes a {@link FarEnd} rather than a close</h2>
 *
 * <p>A blocking read is bounded, but it cannot be <b>abandoned</b>. The reader
 * thread parked inside {@code readLine} holds the {@link BufferedReader}'s own
 * lock, and {@code BufferedReader.close()} wants that same lock — so a teardown
 * that reaches for {@code close()} first parks forever against the read it is
 * trying to abandon. It is not interruptible either: a pipe read ignores
 * {@code Thread.interrupt}. Card 221 measured this on Temurin 21.0.12 (parked on
 * an {@code InternalLock}) and on OpenJDK 25.0.2 (blocked on the
 * {@code InputStreamReader} monitor), same frames beneath, so no runtime upgrade
 * carries it away.
 *
 * <p>The only thing that makes such a read return is <b>the other end of the pipe
 * going away</b>. So the far end has to be dealt with before the reader's stream is
 * touched — but "dealt with" is not "killed". The MCP stdio shutdown sequence is
 * <b>close the client's stdin, wait, {@code SIGTERM}, {@code SIGKILL}</b>, and a
 * teardown that jumps to step three takes away the flush of every server that ends
 * on end-of-stream and turns every clean disconnect into an abnormal one in its log.
 * {@link #tearDown()} therefore runs four steps in an order that is itself the
 * decision — see there.
 */
public final class JsonRpcChannel implements AutoCloseable {

    private static final Logger LOG = LoggerFactory.getLogger(JsonRpcChannel.class);

    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * How long teardown waits for the reader thread to leave {@code readLine} after the
     * far end has been released. Measured against a real spawned server on both JDKs,
     * the read returns in under a millisecond once the child is gone; this is slack for
     * a loaded machine, not an expected cost. Public because it is one of the four
     * terms in the write-off budget the user guide prints — see
     * {@link StdioTransport#WRITE_OFF_BUDGET}.
     */
    public static final Duration READER_EXIT_GRACE = Duration.ofSeconds(2);

    /**
     * The far end of the pipe, in the two steps a stdio shutdown needs it in. Split in
     * two because the order is load-bearing: the tree has to be counted while the thing
     * that owns it is still alive, and the goodbye has to be said before anything is
     * killed. One method could not be in both places.
     */
    public interface FarEnd {

        /** A far end nothing can reach — in-memory pipes, whose read gives up on its own. */
        FarEnd NONE = new FarEnd() {
            @Override
            public void census() {
                // nothing to count: there is no process on the other side.
            }

            @Override
            public void release() {
                // nothing to release: the reader is not parked on a file descriptor.
            }
        };

        /**
         * Write down what is over there <b>while it can still be asked</b>. A launcher
         * that exits when its stdin ends takes the answer with it, and the operating
         * system re-parents its children to init where nothing connects them to this
         * channel any more.
         */
        void census();

        /**
         * End the far end, so a parked {@code readLine} returns: wait out a short grace
         * for it to leave on the end-of-stream it has just been given, then signal, then
         * force. Must return within a bounded time — a face is waiting behind it.
         */
        void release();
    }

    private final BufferedReader in;
    private final BufferedWriter out;
    private final Duration readTimeout;
    private final FarEnd farEnd;
    private final AtomicLong nextId = new AtomicLong(1);
    private final ExecutorService reader =
            Executors.newSingleThreadExecutor(Thread.ofVirtual().name("jsonrpc-read-", 0).factory());
    // Poisoned once a read times out (the single reader thread is stuck in an
    // uninterruptible readLine): the channel is torn down and must never be reused.
    private final AtomicBoolean poisoned = new AtomicBoolean(false);
    // The thread currently inside readLine, captured when the read starts. A virtual
    // thread is invisible to Thread.getAllStackTraces(), so this reference is the
    // only way a test can watch the reader leave instead of trusting that it did.
    private volatile Thread readerThread;

    /**
     * Wraps an existing reader/writer pair with <b>no way to abandon a stuck read</b>.
     * Safe for in-memory pipes, whose read gives up on its own and honours an
     * interrupt. Anything backed by a real file descriptor — a process, a socket —
     * should use {@link #JsonRpcChannel(BufferedReader, BufferedWriter, Duration, FarEnd)}
     * and hand over the far end.
     *
     * @param in          stream the responses arrive on, one JSON object per line
     * @param out         stream the requests are written to
     * @param readTimeout upper bound a single {@link #request} waits for its response line
     */
    public JsonRpcChannel(BufferedReader in, BufferedWriter out, Duration readTimeout) {
        this(in, out, readTimeout, FarEnd.NONE);
    }

    /**
     * Wraps an existing reader/writer pair together with the far end that can end a
     * read nothing else can end.
     *
     * @param in          stream the responses arrive on, one JSON object per line
     * @param out         stream the requests are written to
     * @param readTimeout upper bound a single {@link #request} waits for its response line
     * @param farEnd      the other side of the pipe: counted, then given end-of-stream,
     *                    then released, in that order — see {@link #tearDown()}
     */
    public JsonRpcChannel(BufferedReader in, BufferedWriter out, Duration readTimeout,
                          FarEnd farEnd) {
        this.in = in;
        this.out = out;
        this.readTimeout = readTimeout;
        this.farEnd = farEnd;
    }

    /**
     * Send a request and block for its response, returning the {@code result}
     * member. A JSON-RPC {@code error} response, a malformed frame, an id
     * mismatch, a timeout, or an I/O failure all surface as a {@link RuntimeException}.
     *
     * @param method JSON-RPC method name, e.g. {@code tools/call}
     * @param params parameters object, or {@code null} to omit the member
     * @return the {@code result} node — a JSON null node when the member is absent
     */
    public synchronized JsonNode request(String method, JsonNode params) {
        if (poisoned.get()) {
            throw new IllegalStateException("JSON-RPC channel is poisoned (a prior read timed out); "
                    + "reconnect before calling '" + method + "'");
        }
        long id = nextId.getAndIncrement();
        writeFrame(new JsonRpcRequest(id, method, params));

        String line = readLineWithTimeout(method);
        if (line == null) {
            throw new RuntimeException("MCP server closed the stream before answering '" + method + "'");
        }
        JsonRpcResponse response;
        try {
            response = JSON.readValue(line, JsonRpcResponse.class);
        } catch (IOException malformed) {
            throw new RuntimeException("malformed JSON-RPC response to '" + method + "': " + line, malformed);
        }
        if (response.error() != null) {
            JsonRpcError error = response.error();
            throw new RuntimeException("MCP error " + error.code() + " on '" + method + "': " + error.message());
        }
        if (response.id() == null || !response.id().isNumber() || response.id().asLong() != id) {
            throw new RuntimeException("JSON-RPC id mismatch on '" + method + "': expected " + id
                    + ", got " + (response.id() == null ? "null" : response.id()));
        }
        return response.result() != null ? response.result() : JSON.nullNode();
    }

    /**
     * Send a notification: a frame with no id, and therefore no reply is awaited.
     *
     * @param method JSON-RPC method name, e.g. {@code notifications/initialized}
     * @param params parameters object, or {@code null} to omit the member
     */
    public synchronized void notify(String method, JsonNode params) {
        // id == null so @JsonInclude(NON_NULL) drops it — a notification has no id per JSON-RPC.
        writeFrame(new JsonRpcRequest(null, method, params));
    }

    /**
     * Serialize one frame as a single line and flush immediately — newline-delimited
     * JSON is the framing, so a frame must never contain a raw newline.
     *
     * @param frame request or notification to put on the wire
     */
    private void writeFrame(JsonRpcRequest frame) {
        try {
            out.write(JSON.writeValueAsString(frame));
            out.write('\n');
            out.flush();
        } catch (IOException io) {
            throw new UncheckedIOException("failed to write JSON-RPC frame", io);
        }
    }

    /**
     * Block for the next response line on the dedicated reader thread, bounded by the
     * configured timeout. A timeout poisons the channel, which tears it down through
     * {@link #tearDown()} — see there for why the order matters.
     *
     * @param method the method whose reply is awaited, so the failure can name it
     * @return the next line, or {@code null} if the server closed the stream
     */
    private String readLineWithTimeout(String method) {
        Future<String> future = reader.submit(() -> {
            readerThread = Thread.currentThread();
            return in.readLine();
        });
        try {
            return future.get(readTimeout.toMillis(), TimeUnit.MILLISECONDS);
        } catch (TimeoutException timeout) {
            // cancel(true) is a formality: a pipe read ignores interrupt, so the reader
            // thread only leaves when the far end goes away. tearDown() arranges exactly
            // that before it touches a stream.
            future.cancel(true);
            poison();
            throw new RuntimeException("no answer to '" + method + "' within "
                    + readTimeout.toMillis() + " ms", timeout);
        } catch (ExecutionException execution) {
            throw new RuntimeException("failed to read a JSON-RPC response", execution.getCause());
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new RuntimeException("interrupted waiting for a JSON-RPC response", interrupted);
        }
    }

    /**
     * Poison the channel: mark it unusable, then tear it down. Idempotent via the flag.
     */
    private void poison() {
        poisoned.set(true);
        tearDown();
    }

    /** True once a read has timed out and the channel has been torn down. */
    public boolean isPoisoned() {
        return poisoned.get();
    }

    /**
     * The thread that runs the blocking read, captured when a read starts.
     * Package-visible on purpose: a virtual thread cannot be found through
     * {@code Thread.getAllStackTraces()}, so holding the reference is the only way a
     * test can <i>watch</i> the reader leave after a timeout instead of reading the
     * teardown code and believing it.
     *
     * @return the reader thread, or {@code null} before the first request
     */
    Thread readerThread() {
        return readerThread;
    }

    /** Close both streams and the reader executor. Idempotent; never throws. */
    @Override
    public void close() {
        // A close is a permanent teardown too — refuse further requests afterwards.
        poisoned.set(true);
        tearDown();
    }

    /**
     * Count the far end, say goodbye to it, release it, and only then close the read
     * side — shared by {@link #poison()} and {@link #close()}.
     *
     * <p><b>The order is the whole thing, and each step is there for a different
     * defect.</b>
     *
     * <ol>
     *   <li><b>Census first.</b> A launcher — {@code npx}, {@code uvx}, {@code sh -c} —
     *       is what the config names, and the real server is its child. Some launchers
     *       exit the moment their stdin ends, and a process that has exited cannot name
     *       its children any more: the census has to happen before the goodbye, or the
     *       grandchild is reparented to init and runs until the machine does not.</li>
     *   <li><b>Close {@code out} second</b> — the client's stdin, and step one of the MCP
     *       stdio shutdown sequence. This is the only end-of-stream a server ever gets;
     *       skipping it takes the flush away from every server that ends on EOF and
     *       writes an abnormal termination into the log of every server that notes one.
     *       Closing the write side is safe while the read is parked: nobody holds its
     *       lock.</li>
     *   <li><b>Release third:</b> wait a short grace for the server to leave on that
     *       end-of-stream, then signal, then force. This is what actually ends a parked
     *       {@code readLine} when the server did not go on its own.</li>
     *   <li><b>Close {@code in} last, and only if the reader really left.</b> Closing it
     *       while the reader is still inside {@code readLine} parks this thread on the
     *       same lock for good — card 221's original hang. If the reader has not left
     *       within the grace, the stream is deliberately abandoned: a descriptor on a
     *       pipe whose far end is already dead is the cheaper loss.</li>
     * </ol>
     */
    private void tearDown() {
        runQuietly(farEnd::census);
        // Step one of the shutdown sequence, and the reason it comes before the kill.
        closeQuietly(out);
        runQuietly(farEnd::release);
        reader.shutdownNow();
        if (awaitReaderExit()) {
            closeQuietly(in);
        } else {
            LOG.warn("JSON-RPC reader thread did not leave readLine within {} ms after the"
                            + " far end was released; leaving the stream to the OS rather than"
                            + " parking this thread on its lock",
                    READER_EXIT_GRACE.toMillis());
        }
    }

    /**
     * Wait out {@link #READER_EXIT_GRACE} for the reader thread to finish.
     *
     * @return true when the reader is gone and {@code in} is safe to close
     */
    private boolean awaitReaderExit() {
        try {
            return reader.awaitTermination(READER_EXIT_GRACE.toMillis(), TimeUnit.MILLISECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    /**
     * Best-effort close — teardown must never throw.
     *
     * @param c the stream to close; failures are swallowed
     */
    private static void closeQuietly(AutoCloseable c) {
        try {
            c.close();
        } catch (Exception ignored) {
            // best effort — the process is being torn down anyway.
        }
    }

    /**
     * Best-effort run of one far-end step — a step that throws must not stop the rest of
     * the teardown, least of all the ones that end the process.
     *
     * @param step census or release; failures are logged, never thrown
     */
    private static void runQuietly(Runnable step) {
        try {
            step.run();
        } catch (RuntimeException failed) {
            LOG.warn("a JSON-RPC far-end teardown step failed: {}", failed.toString());
        }
    }
}
