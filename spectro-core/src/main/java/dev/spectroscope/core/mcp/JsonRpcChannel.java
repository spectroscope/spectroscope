package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

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
 */
public final class JsonRpcChannel implements AutoCloseable {

    private static final ObjectMapper JSON = new ObjectMapper();

    private final BufferedReader in;
    private final BufferedWriter out;
    private final Duration readTimeout;
    private final AtomicLong nextId = new AtomicLong(1);
    private final ExecutorService reader =
            Executors.newSingleThreadExecutor(Thread.ofVirtual().name("jsonrpc-read-", 0).factory());
    // Poisoned once a read times out (the single reader thread is stuck in an
    // uninterruptible readLine): the channel is torn down and must never be reused.
    private final AtomicBoolean poisoned = new AtomicBoolean(false);

    /**
     * Wraps an existing reader/writer pair — whatever produced the streams (a process,
     * an in-memory pipe) stays outside this class.
     *
     * @param in          stream the responses arrive on, one JSON object per line
     * @param out         stream the requests are written to
     * @param readTimeout upper bound a single {@link #request} waits for its response line
     */
    public JsonRpcChannel(BufferedReader in, BufferedWriter out, Duration readTimeout) {
        this.in = in;
        this.out = out;
        this.readTimeout = readTimeout;
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

        String line = readLineWithTimeout();
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
     * configured timeout. A timeout poisons the channel — the stuck reader cannot be
     * interrupted, so the streams are closed instead.
     *
     * @return the next line, or {@code null} if the server closed the stream
     */
    private String readLineWithTimeout() {
        Future<String> future = reader.submit(in::readLine);
        try {
            return future.get(readTimeout.toMillis(), TimeUnit.MILLISECONDS);
        } catch (TimeoutException timeout) {
            // BufferedReader.readLine does not respond to interrupt, so cancel(true)
            // would leave the single reader thread permanently stuck and every later
            // request() would time out forever. Poison the channel instead: close the
            // streams (which unblocks readLine) and shut the reader down so the channel
            // fails fast on reuse rather than silently hanging.
            future.cancel(true);
            poison();
            throw new RuntimeException("timed out after " + readTimeout.toMillis()
                    + " ms waiting for a JSON-RPC response", timeout);
        } catch (ExecutionException execution) {
            throw new RuntimeException("failed to read a JSON-RPC response", execution.getCause());
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new RuntimeException("interrupted waiting for a JSON-RPC response", interrupted);
        }
    }

    /**
     * Poison the channel: mark it unusable, then tear it down. Closing the streams
     * unblocks a reader thread stuck in {@code readLine}. Idempotent via the flag.
     */
    private void poison() {
        poisoned.set(true);
        tearDown();
    }

    /** True once a read has timed out and the channel has been torn down. */
    public boolean isPoisoned() {
        return poisoned.get();
    }

    /** Close both streams and the reader executor. Idempotent; never throws. */
    @Override
    public void close() {
        // A close is a permanent teardown too — refuse further requests afterwards.
        poisoned.set(true);
        tearDown();
    }

    /** Stop the reader executor and close both streams — shared by {@link #poison()} and {@link #close()}. */
    private void tearDown() {
        reader.shutdownNow();
        closeQuietly(in);
        closeQuietly(out);
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
}
