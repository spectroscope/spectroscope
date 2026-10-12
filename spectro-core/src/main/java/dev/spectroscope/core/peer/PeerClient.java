package dev.spectroscope.core.peer;

import com.fasterxml.jackson.databind.JsonNode;

import java.io.IOException;
import java.io.OutputStream;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.channels.Channels;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Sends one frame to another process's socket (card 502 criteria 3 and 9).
 *
 * <p>Before writing anything the sender reads the endpoint's {@code hello}
 * and refuses when its pid or start instant differ from the record it
 * resolved. Every failure is one of the error classes, each with a text the
 * model can act on.</p>
 */
public final class PeerClient {

    /** Why a send did not go. */
    public enum Error {
        /** The socket is missing or refused the connection. */
        GONE,
        /** The process is alive but did not answer in time. */
        BUSY,
        /** The frame is longer than the line cap. */
        TOO_LARGE,
        /** No live agent answers to the name. */
        UNKNOWN_NAME,
        /** The socket answered for another process. */
        WRONG_ENDPOINT,
        /** The sender's own pacer held it back. */
        PACED
    }

    /**
     * What one send did.
     *
     * @param sent  true when the frame was written
     * @param error the class of failure, or null
     * @param text  the text for the model, or null when sent
     */
    public record Result(boolean sent, Error error, String text) {

        static Result ok() {
            return new Result(true, null, null);
        }

        static Result failed(Error error, String text) {
            return new Result(false, error, text);
        }
    }

    private final LiveRegistry registry;
    private final ProcessIdentity self;
    private final int timeoutMs;

    /**
     * @param registry where tokens are read
     * @param self     this process, stated in the auth frame
     */
    public PeerClient(LiveRegistry registry, ProcessIdentity self) {
        this(registry, self, PeerLimits.SEND_TIMEOUT_MS);
    }

    /**
     * @param registry  where tokens are read
     * @param self      this process
     * @param timeoutMs the time one send may take, connect to last byte
     */
    public PeerClient(LiveRegistry registry, ProcessIdentity self, int timeoutMs) {
        this.registry = registry;
        this.self = self;
        this.timeoutMs = timeoutMs;
    }

    /**
     * Sends one frame.
     *
     * @param target the receiving process's record
     * @param name   the name the sender used, for the texts
     * @param frame  the frame
     * @return what happened
     */
    public Result send(LiveRecord target, String name, JsonNode frame) {
        String line = PeerFrames.line(frame);
        if (line.length() > PeerLimits.LINE_CAP_CHARS) {
            return Result.failed(Error.TOO_LARGE, tooLarge(line.length()));
        }
        AtomicReference<SocketChannel> open = new AtomicReference<>();
        try (ExecutorService one = Executors.newVirtualThreadPerTaskExecutor()) {
            Future<Result> exchange = one.submit(() -> exchange(target, name, line, open));
            try {
                return exchange.get(timeoutMs, TimeUnit.MILLISECONDS);
            } catch (TimeoutException late) {
                closeQuietly(open.get());
                exchange.cancel(true);
                return Result.failed(Error.BUSY, busy(name));
            } catch (ExecutionException failed) {
                return Result.failed(Error.GONE, gone(name, String.valueOf(failed.getCause())));
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                closeQuietly(open.get());
                return Result.failed(Error.BUSY, busy(name));
            } finally {
                one.shutdownNow();
            }
        }
    }

    private Result exchange(LiveRecord target, String name, String line,
                            AtomicReference<SocketChannel> open) {
        try (SocketChannel channel = SocketChannel.open(StandardProtocolFamily.UNIX)) {
            open.set(channel);
            while (true) {
                try {
                    channel.connect(UnixDomainSocketAddress.of(target.socket()));
                    break;
                } catch (IOException refused) {
                    if (!stillThere(target)) {
                        return Result.failed(Error.GONE, gone(name, refused.getClass().getSimpleName()));
                    }
                    // A full listen backlog refuses a connect to a live process; the
                    // send timeout ends the retries as busy.
                    try {
                        Thread.sleep(PeerLimits.CONNECT_RETRY_MS);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        return Result.failed(Error.BUSY, busy(name));
                    }
                }
            }
            LineReader in = new LineReader(Channels.newInputStream(channel));
            Optional<JsonNode> hello = Optional.ofNullable(in.readLine()).flatMap(PeerFrames::parse)
                    .filter(f -> "hello".equals(f.path("type").asText()));
            if (hello.isEmpty()) {
                return Result.failed(Error.GONE, gone(name, "no hello"));
            }
            if (hello.get().path("pid").asLong(-1) != target.pid()
                    || !hello.get().path("procStart").asText("").equals(target.procStart())) {
                return Result.failed(Error.WRONG_ENDPOINT, wrongEndpoint(name));
            }
            Path key = registry.keyPathFor(target.pid());
            String token;
            try {
                token = Files.readString(key).strip();
            } catch (IOException missing) {
                return Result.failed(Error.GONE, gone(name, "no token"));
            }
            OutputStream out = Channels.newOutputStream(channel);
            String lines = PeerFrames.line(PeerFrames.auth(token, self.pid(), self.procStart())) + "\n" + line + "\n";
            out.write(lines.getBytes(StandardCharsets.UTF_8));
            out.flush();
            channel.shutdownOutput();
            return Result.ok();
        } catch (IOException broken) {
            return Result.failed(Error.GONE, gone(name, broken.getClass().getSimpleName()));
        }
    }

    /** @return true when the socket file exists and the record's process still runs with its start */
    private boolean stillThere(LiveRecord target) {
        return Files.exists(Path.of(target.socket()))
                && registry.liveness().startOf(target.pid()).map(target.procStart()::equals).orElse(false);
    }

    /** @param name the name @param error what failed @return the gone text */
    public static String gone(String name, String error) {
        return "Failed to send to " + name + " (" + error + "): that session may have just exited;"
                + " call list_agents to see who is reachable now.";
    }

    /** @param name the name @return the busy text */
    public static String busy(String name) {
        return name + " is alive but did not answer in time; retry the same name shortly.";
    }

    /** @param chars the frame's length @return the too large text */
    public static String tooLarge(int chars) {
        return "Message too large for delivery: the serialized message is " + chars + " characters and the limit"
                + " is " + PeerLimits.LINE_CAP_CHARS + ". Shorten it: put bulk content in a file the recipient"
                + " can read, or split it into smaller messages.";
    }

    /** @param name the name @return the unknown name text */
    public static String unknownName(String name) {
        return "Not sent: no agent named '" + name + "' is reachable; call list_agents to see who is reachable now.";
    }

    /** @param name the name @return the wrong endpoint text */
    public static String wrongEndpoint(String name) {
        return "Not sent: the socket of " + name + " answered for another process; call list_agents to see who"
                + " is reachable now.";
    }

    private static void closeQuietly(SocketChannel channel) {
        if (channel != null) {
            try {
                channel.close();
            } catch (IOException ignored) {
                // Already gone.
            }
        }
    }
}
