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
 * <h2>Why the teardown takes an {@code unblockReader} hook</h2>
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
 * going away</b>. That is why teardown here runs {@code unblockReader} first and
 * only then touches the streams: {@link StdioTransport} passes a hook that
 * destroys the child process, whose death closes the pipe, which ends the read,
 * which frees the lock. A different timeout would not have helped — a longer one
 * merely postpones the deadlock and a shorter one arrives at it sooner.
 */
public final class JsonRpcChannel implements AutoCloseable {

    private static final Logger LOG = LoggerFactory.getLogger(JsonRpcChannel.class);

    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * How long teardown waits for the reader thread to leave {@code readLine} after
     * {@code unblockReader} has run. Measured against a real spawned server on both
     * JDKs, the read returns in under a millisecond once the child is destroyed; this
     * is slack for a loaded machine, not an expected cost.
     */
    private static final Duration READER_EXIT_GRACE = Duration.ofSeconds(2);

    private final BufferedReader in;
    private final BufferedWriter out;
    private final Duration readTimeout;
    private final Runnable unblockReader;
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
     * should use {@link #JsonRpcChannel(BufferedReader, BufferedWriter, Duration, Runnable)}
     * and hand over the lever that closes the far end.
     *
     * @param in          stream the responses arrive on, one JSON object per line
     * @param out         stream the requests are written to
     * @param readTimeout upper bound a single {@link #request} waits for its response line
     */
    public JsonRpcChannel(BufferedReader in, BufferedWriter out, Duration readTimeout) {
        this(in, out, readTimeout, () -> { });
    }

    /**
     * Wraps an existing reader/writer pair together with the lever that ends a read
     * nothing else can end.
     *
     * @param in            stream the responses arrive on, one JSON object per line
     * @param out           stream the requests are written to
     * @param readTimeout   upper bound a single {@link #request} waits for its response line
     * @param unblockReader run first on every teardown, before a stream is touched; it must
     *                      make a parked {@code readLine} return — for a spawned server that
     *                      means destroying the process, because closing the reader from here
     *                      would deadlock against the reader thread holding its lock
     */
    public JsonRpcChannel(BufferedReader in, BufferedWriter out, Duration readTimeout,
                          Runnable unblockReader) {
        this.in = in;
        this.out = out;
        this.readTimeout = readTimeout;
        this.unblockReader = unblockReader;
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
     * Release the far end, wait for the reader to leave, then close the streams —
     * shared by {@link #poison()} and {@link #close()}.
     *
     * <p><b>The order is the whole fix.</b> Closing {@code in} while the reader thread
     * is parked inside {@code readLine} parks the caller too, on the same lock, for
     * good. So: run {@code unblockReader} first (destroying the child closes the pipe
     * and the read returns), then wait for the reader thread to actually be gone, and
     * only then close. If the reader has <i>not</i> left within the grace, the streams
     * are deliberately left unclosed: a descriptor on a pipe whose far end is already
     * destroyed is a cheap thing to lose, and closing it here is how a face hangs.
     */
    private void tearDown() {
        runQuietly(unblockReader);
        reader.shutdownNow();
        if (awaitReaderExit()) {
            closeQuietly(in);
        } else {
            LOG.warn("JSON-RPC reader thread did not leave readLine within {} ms after the"
                            + " unblock hook; leaving the stream to the OS rather than parking"
                            + " this thread on its lock",
                    READER_EXIT_GRACE.toMillis());
        }
        // The write side is safe either way — no one holds its lock.
        closeQuietly(out);
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
     * Best-effort run of the caller's unblock hook — a hook that throws must not stop
     * the rest of the teardown.
     *
     * @param hook the lever that ends a parked read; failures are logged, never thrown
     */
    private static void runQuietly(Runnable hook) {
        try {
            hook.run();
        } catch (RuntimeException failed) {
            LOG.warn("the JSON-RPC unblock hook failed: {}", failed.toString());
        }
    }
}
