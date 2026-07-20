package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.databind.JsonNode;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Supplier;

/**
 * Owns one connection to an MCP server through an injectable {@link McpTransport}.
 * On {@link #start()} it performs {@code initialize} then {@code tools/list} and
 * caches the descriptors.
 *
 * <p>{@link #call} gives <b>at-most-once</b> execution while staying resilient to a
 * server that died <i>between</i> calls: if the transport is not currently alive
 * (never started, or previously poisoned/closed) it is re-established once — the
 * supplier hands back a fresh transport and it is re-initialized — and then the
 * {@code tools/call} is issued <b>exactly once</b>. A call that fails or times out
 * on an already-established transport is <b>not</b> re-issued (that would double a
 * slow-but-successful side effect like {@code add_note}); instead the transport is
 * poisoned/closed so the <i>next</i> call re-establishes lazily, and this call
 * degrades to a readable {@code "ERROR: ..."} string. It never throws out of
 * {@link #call}. The house rule: a dead or slow server degrades, it does not
 * crash the harness.
 */
public final class McpClient {

    private static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(20);

    private final McpServerConfig config;
    private final Supplier<McpTransport> transportSupplier;
    private final Duration callTimeout;
    private final ExecutorService executor;

    private McpTransport transport;
    private McpInitializeResult initializeResult;
    private List<McpToolDescriptor> descriptors = List.of();
    private volatile boolean started;

    /**
     * Client with the default call timeout.
     *
     * @param config            the server entry this client owns
     * @param transportSupplier hands back a fresh transport per (re-)establish
     */
    public McpClient(McpServerConfig config, Supplier<McpTransport> transportSupplier) {
        this(config, transportSupplier, DEFAULT_TIMEOUT);
    }

    /**
     * Fully parameterized variant — tests shorten the timeout to keep dead-server cases fast.
     *
     * @param config            the server entry this client owns
     * @param transportSupplier hands back a fresh transport per (re-)establish
     * @param callTimeout       upper bound for a single {@code tools/call}
     */
    public McpClient(McpServerConfig config, Supplier<McpTransport> transportSupplier, Duration callTimeout) {
        this.config = config;
        this.transportSupplier = transportSupplier;
        this.callTimeout = callTimeout;
        // A daemon virtual-thread executor: it bounds each call without keeping the JVM alive.
        this.executor = Executors.newThreadPerTaskExecutor(Thread.ofVirtual().name("mcp-" + config.name() + "-", 0).factory());
    }

    /** The configured server name — the middle segment of every {@code mcp__<server>__<tool>}. */
    public String name() {
        return config.name();
    }

    /**
     * Connect and cache tools. Propagates the underlying failure so
     * {@link McpServerRegistry} can log-and-skip a server that will not start —
     * unlike {@link #call}, which must degrade rather than throw.
     */
    public void start() {
        this.transport = transportSupplier.get();
        this.initializeResult = transport.initialize();
        this.descriptors = List.copyOf(transport.listTools());
        this.started = true;
    }

    /** True after a successful {@link #start()}, false again after {@link #close()}. */
    public boolean isStarted() {
        return started;
    }

    /** The handshake result of the most recent (re-)establish — {@code null} before the first one. */
    public McpInitializeResult initializeResult() {
        return initializeResult;
    }

    /** The tools this server advertised at {@link #start()}. */
    public List<McpToolDescriptor> tools() {
        return descriptors;
    }

    /**
     * Invoke a remote tool with at-most-once semantics. If the transport is not
     * currently alive, re-establish it once (this absorbs a server that died since
     * the last call); an establish failure degrades to {@code "ERROR: ..."}. Then
     * the {@code tools/call} runs exactly once — a failure or timeout poisons the
     * transport (so the next call re-establishes) and returns {@code "ERROR: ..."};
     * it is never re-issued in place, so a slow-but-successful side effect is not
     * doubled. Never throws.
     *
     * @param remoteToolName the server-side tool name, unqualified as advertised
     * @param arguments      JSON arguments object from the model, passed through
     * @return the tool's text output, or an {@code ERROR: ...} string on any failure
     */
    public synchronized String call(String remoteToolName, JsonNode arguments) {
        if (transport == null) {
            String establishFailure = establish();
            if (establishFailure != null) {
                return "ERROR: MCP server '" + config.name() + "' unreachable: " + establishFailure;
            }
        }
        try {
            return invokeWithTimeout(remoteToolName, arguments);
        } catch (Exception failed) {
            // The connection is now suspect. Drop it so the NEXT call re-establishes,
            // but do NOT re-issue this call — that could double a side effect.
            closeQuietly(transport);
            transport = null;
            return "ERROR: MCP tool '" + remoteToolName + "' on server '"
                    + config.name() + "' failed: " + rootMessage(failed);
        }
    }

    /** Close the transport. Idempotent; never throws. */
    public void close() {
        started = false;
        closeQuietly(transport);
        transport = null;
        executor.shutdownNow();
    }

    // ---- internals -----------------------------------------------------------------------

    /**
     * Run the {@code tools/call} on the bounded executor: a timeout cancels the task
     * and propagates, an {@link ExecutionException} is unwrapped to its cause.
     *
     * @param remoteToolName the server-side tool name
     * @param arguments      JSON arguments object, passed through
     * @return the tool's text output, never {@code null}
     * @throws Exception the timeout, the unwrapped call failure, or a missing transport
     */
    private String invokeWithTimeout(String remoteToolName, JsonNode arguments) throws Exception {
        McpTransport current = transport;
        if (current == null) {
            throw new IllegalStateException("no transport");
        }
        Callable<String> task = () -> current.callTool(remoteToolName, arguments);
        Future<String> future = executor.submit(task);
        try {
            String result = future.get(callTimeout.toMillis(), TimeUnit.MILLISECONDS);
            if (result == null) {
                throw new IllegalStateException("empty response");
            }
            return result;
        } catch (TimeoutException timeout) {
            future.cancel(true);
            throw timeout;
        } catch (ExecutionException execution) {
            Throwable cause = execution.getCause();
            if (cause instanceof Exception e) {
                throw e;
            }
            throw execution;
        }
    }

    /**
     * (Re-)establish the transport: ask the supplier for a fresh one and initialize
     * it. Returns null on success, an error message on failure (leaving no transport).
     */
    private String establish() {
        closeQuietly(transport);
        transport = null;
        try {
            McpTransport fresh = transportSupplier.get();
            this.initializeResult = fresh.initialize();
            this.transport = fresh;
            return null;
        } catch (Exception establishFailure) {
            transport = null;
            return rootMessage(establishFailure);
        }
    }

    /**
     * Close if present, swallowing anything a misbehaving fake might throw.
     *
     * @param transport the transport to close, may be {@code null}
     */
    private static void closeQuietly(McpTransport transport) {
        if (transport != null) {
            try {
                transport.close();
            } catch (RuntimeException ignored) {
                // close() is contractually quiet, but a fake may misbehave — swallow it.
            }
        }
    }

    /**
     * A never-null failure description for the {@code ERROR:} strings.
     *
     * @param t the failure to describe
     * @return its message, or the class name when the message is {@code null}
     */
    private static String rootMessage(Throwable t) {
        String message = t.getMessage();
        return message != null ? message : t.getClass().getSimpleName();
    }
}
