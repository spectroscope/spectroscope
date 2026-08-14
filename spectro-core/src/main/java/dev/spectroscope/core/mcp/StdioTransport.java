package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * The primary MCP transport: spawn the server as a child process and speak
 * JSON-RPC 2.0 over its stdin/stdout. MCP stdio reserves <b>stdout for the
 * protocol</b> and <b>stderr for logs</b>, so the process's stderr is redirected
 * to a per-server log file — never mixed into the JSON stream — and only stdout
 * is wrapped by the {@link JsonRpcChannel}.
 *
 * <p>The handshake is {@code initialize} → {@code notifications/initialized} →
 * (later) {@code tools/list} / {@code tools/call}. Spawning follows the process
 * patterns of {@code StandardTools.runCommand} ({@link ProcessBuilder}); the shutdown
 * follows MCP's stdio sequence instead — close the client's stdin, wait, {@code SIGTERM}
 * the tree, {@code SIGKILL} what is left — because a server here is a peer that may have
 * something to flush, not a command whose output has already been collected.
 */
public final class StdioTransport implements McpTransport {

    private static final Logger LOG = LoggerFactory.getLogger(StdioTransport.class);

    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * The bound a single request waits for its reply — the number the user guide
     * prints. Public because it is a documented promise, not an implementation
     * detail: a test pins it so the sentence in the guide and the value here cannot
     * drift apart the way a remembered number always does.
     */
    public static final Duration DEFAULT_READ_TIMEOUT = Duration.ofSeconds(20);

    /**
     * How long a server may take to leave on the end-of-stream it was just given, before
     * a signal follows. Step two of the MCP stdio shutdown sequence (close stdin, wait,
     * {@code SIGTERM}, {@code SIGKILL}); a server that exits on EOF is normally gone in
     * milliseconds and never sees the rest.
     */
    public static final Duration EXIT_AFTER_EOF_GRACE = Duration.ofSeconds(1);

    /**
     * How long the polite signal has before the forcible one — the same escalation
     * {@code StandardTools.runCommand} uses. Bounded for the tree as a whole, not per
     * process.
     */
    public static final Duration DESTROY_ESCALATION_GRACE = Duration.ofSeconds(2);

    /**
     * What a teardown may cost after the read has already given up:
     * {@link #EXIT_AFTER_EOF_GRACE} + {@link #DESTROY_ESCALATION_GRACE} +
     * {@link JsonRpcChannel#READER_EXIT_GRACE}. Against a real mute server it measures
     * under a millisecond, because the child dies on the first signal and the read
     * returns with it; this is what a <i>pathological</i> server can spend — one that
     * ignores end-of-stream and {@code SIGTERM} both.
     */
    public static final Duration TEARDOWN_TAIL =
            EXIT_AFTER_EOF_GRACE.plus(DESTROY_ESCALATION_GRACE).plus(JsonRpcChannel.READER_EXIT_GRACE);

    /**
     * The whole write-off: the read bound plus the teardown tail. This — not
     * {@link #DEFAULT_READ_TIMEOUT} on its own — is the number a person waits for when a
     * server spawns and never speaks, and it is the number chapter 18 of the user guide
     * prints. Card 221 shipped a guide that promised the read bound alone and a
     * TERM-ignoring server measured 22.4 s against it; a documented bound that the code
     * can exceed is the exact failure that card exists to stop.
     */
    public static final Duration WRITE_OFF_BUDGET = DEFAULT_READ_TIMEOUT.plus(TEARDOWN_TAIL);

    private static final String PROTOCOL_VERSION = "2024-11-05";

    private final JsonRpcChannel channel;
    private final Runnable onClose;

    /**
     * Package-visible seam for tests: drive the MCP method mapping over an
     * arbitrary channel (in-memory pipes) with no process. {@code onClose} lets a
     * test observe teardown; production wraps process destruction here.
     *
     * @param channel the JSON-RPC framing to speak over
     * @param onClose teardown hook, run after the channel is closed
     */
    StdioTransport(JsonRpcChannel channel, Runnable onClose) {
        this.channel = channel;
        this.onClose = onClose;
    }

    /**
     * Spawn the configured command and wire a channel to its stdio.
     *
     * @param config command, args, and env of the server to spawn
     * @param cwd    working directory for the child process, or {@code null} to inherit
     */
    public StdioTransport(McpServerConfig config, Path cwd) {
        this(config, cwd, DEFAULT_READ_TIMEOUT);
    }

    /**
     * Spawn with an explicit per-request read timeout — tests shorten it to keep
     * dead-server cases fast.
     *
     * @param config      command, args, and env of the server to spawn
     * @param cwd         working directory for the child process, or {@code null} to inherit
     * @param readTimeout upper bound a single request waits for its response line
     */
    public StdioTransport(McpServerConfig config, Path cwd, Duration readTimeout) {
        Process process = spawn(config, cwd);
        BufferedReader in = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));
        BufferedWriter out = new BufferedWriter(
                new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8));
        // The channel is handed the child's process tree as its far end, and this is the
        // load-bearing line of card 221. A server that spawns and then says nothing leaves
        // the reader thread parked in readLine on a pipe that will never carry a byte;
        // that read ignores interrupt, and the lock it holds is the one close() needs. The
        // far end going away is the only thing that ends such a read — the same reason a
        // terminal Ctrl-C escaped in 1 s while a SIGINT to the JVM alone did not: Ctrl-C
        // signals the process GROUP and takes the server with it. What the channel does
        // with the far end, and in what order, is JsonRpcChannel.tearDown().
        ChildProcessTree tree = new ChildProcessTree(process);
        this.channel = new JsonRpcChannel(in, out, readTimeout, tree);
        this.onClose = tree::release;
    }

    /**
     * Start the child process with stdout reserved for JSON-RPC — stderr is redirected
     * away so server logs can never pollute the protocol stream.
     *
     * @param config command, args, and env to launch with
     * @param cwd    working directory, or {@code null} to inherit the parent's
     * @return the running process
     */
    private static Process spawn(McpServerConfig config, Path cwd) {
        List<String> command = new ArrayList<>();
        command.add(config.command());
        command.addAll(config.argsOrEmpty());

        ProcessBuilder builder = new ProcessBuilder(command);
        if (cwd != null) {
            builder.directory(cwd.toFile());
        }
        builder.environment().putAll(config.envOrEmpty());
        // stdout is the JSON-RPC channel; stderr is server logs, kept out of the protocol stream.
        builder.redirectError(stderrLogFor(config));
        try {
            return builder.start();
        } catch (IOException failed) {
            throw new UncheckedIOException("failed to spawn MCP server '" + config.name()
                    + "' (" + config.command() + ")", failed);
        }
    }

    /**
     * Per-server stderr log under the temp dir; keeps server chatter out of the JSON-RPC stdout.
     *
     * @param config names the log file, one per server
     * @return an append redirect to the log, or the null device if it cannot be opened
     */
    private static ProcessBuilder.Redirect stderrLogFor(McpServerConfig config) {
        try {
            Path log = Path.of(System.getProperty("java.io.tmpdir"),
                    "spectroscope-mcp-" + config.name() + ".log");
            return ProcessBuilder.Redirect.appendTo(log.toFile());
        } catch (RuntimeException ignored) {
            // If we cannot open a log file, discard stderr rather than risk it polluting stdout.
            return ProcessBuilder.Redirect.to(new File(nullDevice()));
        }
    }

    /** The platform's discard device: {@code NUL} on Windows, {@code /dev/null} elsewhere. */
    private static String nullDevice() {
        return File.separatorChar == '\\' ? "NUL" : "/dev/null";
    }

    /**
     * The channel this transport speaks over. Package-visible so a test can watch the
     * reader thread of the <b>production</b> wiring, not of one it built itself.
     *
     * @return the JSON-RPC framing wrapped around the child's stdio
     */
    JsonRpcChannel channel() {
        return channel;
    }

    /**
     * The stdio handshake: sends {@code initialize}, follows up with the mandatory
     * {@code notifications/initialized}, and pulls out the fields spectroscope keeps.
     *
     * @return the negotiated protocol version, server name, and raw capabilities
     */
    @Override
    public McpInitializeResult initialize() {
        ObjectNode params = JSON.createObjectNode();
        params.put("protocolVersion", PROTOCOL_VERSION);
        params.set("capabilities", JSON.createObjectNode());
        ObjectNode clientInfo = JSON.createObjectNode();
        clientInfo.put("name", "spectroscope");
        clientInfo.put("version", "1.0");
        params.set("clientInfo", clientInfo);

        JsonNode result = channel.request("initialize", params);
        // Per MCP, the client must send an 'initialized' notification after the handshake.
        channel.notify("notifications/initialized", null);

        String protocol = result.path("protocolVersion").asText(PROTOCOL_VERSION);
        String serverName = result.path("serverInfo").path("name").asText(null);
        JsonNode capabilities = result.get("capabilities");
        return new McpInitializeResult(protocol, serverName, capabilities);
    }

    /**
     * Fetches {@code tools/list}; a single malformed descriptor is skipped with a
     * stderr note rather than failing the whole list.
     *
     * @return the advertised tools, in server order
     */
    @Override
    public List<McpToolDescriptor> listTools() {
        JsonNode result = channel.request("tools/list", null);
        JsonNode tools = result.path("tools");
        List<McpToolDescriptor> descriptors = new ArrayList<>();
        if (tools.isArray()) {
            for (JsonNode tool : tools) {
                try {
                    descriptors.add(JSON.treeToValue(tool, McpToolDescriptor.class));
                } catch (IOException malformed) {
                    // Skip a single malformed descriptor rather than fail the whole list.
                    LOG.warn("skipping malformed MCP tool descriptor: {}", malformed.getMessage());
                }
            }
        }
        return descriptors;
    }

    /**
     * Issues {@code tools/call} and hands the reply's content blocks back untouched.
     *
     * @param toolName  remote tool name as advertised by {@code tools/list}
     * @param arguments JSON arguments object; {@code null} becomes an empty object
     * @return the reply's content blocks in server order
     */
    @Override
    public McpCallResult callTool(String toolName, JsonNode arguments) {
        ObjectNode params = JSON.createObjectNode();
        params.put("name", toolName);
        params.set("arguments", arguments != null ? arguments : JSON.createObjectNode());

        JsonNode result = channel.request("tools/call", params);
        // The mapping lives in ONE place for both transports — see McpCallResult.
        return McpCallResult.fromToolsCall(result);
    }

    /**
     * Close the channel — which is what runs the whole shutdown sequence, stdin first —
     * and then the process teardown a second time, defensively: it is idempotent, and
     * {@code close()} must never throw whatever either of them does.
     */
    @Override
    public void close() {
        try {
            channel.close();
        } catch (RuntimeException ignored) {
            // channel.close is contractually quiet; be defensive anyway.
        }
        try {
            onClose.run();
        } catch (RuntimeException ignored) {
            // teardown must never throw out of close().
        }
    }

    /**
     * The spawned server and everything it started, as the two steps
     * {@link JsonRpcChannel.FarEnd} asks for.
     *
     * <p><b>Why a census at all.</b> Almost nobody configures the server itself.
     * {@code npx}, {@code uvx}, {@code sh -c}, a {@code .sh} launcher: what the config
     * names is a wrapper, and the real server is a <b>grandchild</b>. Destroying only the
     * direct child kills the wrapper and leaves the server reparented to init — measured
     * on the teardown that shipped before this, two runs, two orphans at {@code ppid 1},
     * and they accumulate for as long as the machine is up.
     *
     * <p><b>Why the census is a separate step from the kill.</b> {@link Process#descendants()}
     * walks the operating system's process table, so it only answers while the parent is
     * still there to be asked. The kill is no longer the first thing that happens — the
     * client's stdin is closed first, and a launcher that ends on end-of-stream is gone
     * milliseconds later, taking the answer with it. So the count happens before the
     * goodbye, and the record is kept.
     *
     * <p>What this does <b>not</b> catch: a grandchild forked after the census, and a
     * server whose launcher had already exited by the time the teardown began. Both are
     * beyond what {@code java.lang.Process} can name at all, and both are far smaller
     * windows than the one this closes.
     */
    private static final class ChildProcessTree implements JsonRpcChannel.FarEnd {

        private final Process process;
        // Written by census(), read by release(); teardown can run on either the caller's
        // thread or a later close, so it is not confined to one.
        private volatile List<ProcessHandle> descendants = List.of();

        ChildProcessTree(Process process) {
            this.process = process;
        }

        /**
         * Ask the parent to name its children while it still can. A later census that
         * finds nothing never overwrites an earlier one that found something: this runs
         * three times over a teardown — before the goodbye, after the grace, and again on
         * {@code close()} — and by the later ones the parent is often reaped, where the
         * honest answer to "what are your children" is silence rather than "none".
         *
         * <p><b>The two guards below overlap on purpose, and each looks removable.</b>
         * Measured: a reaped launcher reports {@code isAlive() = false} <i>and</i> zero
         * descendants, so either guard alone blocks the clobber and deleting either one on
         * its own leaves the whole suite green. Deleting <b>both</b> loses the wrapper that
         * exits on end-of-stream — {@code theProcessTreeIsCountedBeforeStdinIsClosedAndNotAfter}
         * goes red with the grandchild reparented to init. Cheap, and the pair is what is
         * pinned.
         */
        @Override
        public void census() {
            if (!process.isAlive()) {
                return;
            }
            List<ProcessHandle> seen = process.descendants().toList();
            if (!seen.isEmpty()) {
                descendants = seen;
            }
        }

        /**
         * Steps two through four of the stdio shutdown: wait out
         * {@link StdioTransport#EXIT_AFTER_EOF_GRACE} for the server to leave on the end-of-stream it
         * has just been given, then {@code SIGTERM} the tree, then {@code SIGKILL}
         * whatever ignored that. Bounded by
         * {@code EXIT_AFTER_EOF_GRACE + DESTROY_ESCALATION_GRACE} whatever the child does.
         *
         * <p>The tree is counted again here, as late as the parent allows. The goodbye is
         * an invitation to do cleanup work, and cleanup work has children: whatever the
         * grace bought the server, a list taken before the goodbye cannot name it. Counting
         * once more costs a process-table walk and closes a window a second wide.
         */
        @Override
        public void release() {
            boolean left = leftOnItsOwn();
            census();
            // Even a server that took the polite exit gets its tree destroyed: a launcher
            // leaves on end-of-stream and its server does not.
            destroyTree(!left);
        }

        /**
         * Wait for the process to end on the end-of-stream it was just given.
         *
         * @return true when it left on its own inside the grace
         */
        private boolean leftOnItsOwn() {
            try {
                return process.waitFor(EXIT_AFTER_EOF_GRACE.toMillis(), TimeUnit.MILLISECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return !process.isAlive();
            }
        }

        /**
         * Signal, wait, force — over the parent and the census together, against one
         * shared deadline so the tree as a whole costs at most
         * {@link StdioTransport#DESTROY_ESCALATION_GRACE}.
         *
         * @param parentAlive whether the parent still needs signalling
         */
        private void destroyTree(boolean parentAlive) {
            if (parentAlive) {
                process.destroy();
            }
            descendants.forEach(ProcessHandle::destroy);
            awaitTreeExit();
            if (process.isAlive()) {
                process.destroyForcibly();
            }
            descendants.stream().filter(ProcessHandle::isAlive)
                    .forEach(ProcessHandle::destroyForcibly);
        }

        /** Give the whole tree {@link StdioTransport#DESTROY_ESCALATION_GRACE} to act on the signal. */
        private void awaitTreeExit() {
            long deadline = System.nanoTime() + DESTROY_ESCALATION_GRACE.toNanos();
            try {
                while (System.nanoTime() < deadline && stillStanding()) {
                    Thread.sleep(20);
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }

        /** True while anything in the tree is still running. */
        private boolean stillStanding() {
            return process.isAlive() || descendants.stream().anyMatch(ProcessHandle::isAlive);
        }
    }
}
