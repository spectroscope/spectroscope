package dev.spectroscope.core.browser.headless;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

/**
 * One Chrome DevTools Protocol connection: JSON-RPC over a WebSocket, with the
 * two jobs a raw wire does not do — matching replies to calls, and handing
 * events to listeners <b>off the inbound thread</b>.
 *
 * <p>The second job is the one that earns the dedicated dispatcher. A frame
 * listener has to acknowledge every screencast frame
 * ({@code Page.screencastFrameAck}) or Chrome stops sending; an ack is itself a
 * call, and a call blocks for its reply, and the reply arrives on the inbound
 * thread. A listener invoked ON that thread would therefore wait for a message
 * only its own return can deliver. Events queue and dispatch in arrival order on
 * one virtual thread; replies complete their futures directly on the inbound
 * thread, which is what breaks the cycle.
 *
 * <p><b>Never two writers on the socket at once.</b>
 * {@code java.net.http.WebSocket} refuses a second {@code sendText} while one is
 * in flight, so sends serialize on a lock — the same rule
 * {@code BrowserControlSocket} keeps for the desktop channel.
 *
 * <p>Failure is an exception here, not a reply: this class is the transport
 * under {@link HeadlessBrowserFace}, and the face is the layer that owes the
 * tools a sentence. Every {@link CdpException} names the method it was carrying.
 */
public final class CdpConnection implements HeadlessBrowserFace.Cdp, AutoCloseable {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** A CDP command that could not be completed: refused, timed out, or the
     *  connection died under it. */
    public static final class CdpException extends RuntimeException {
        CdpException(String message) {
            super(message);
        }
    }

    /** The transport seam: one send, one close, messages already whole. */
    public interface Wire extends AutoCloseable {
        /** Sends one complete text message.
         *  @param text the JSON text */
        void send(String text);

        /** Closes the transport. */
        @Override
        void close();
    }

    /** How a connection gets its wire — the suite hands in a fake.  */
    @FunctionalInterface
    public interface WireFactory {
        /**
         * Opens the transport, wiring inbound messages to the consumer.
         *
         * @param inbound where every complete inbound message goes
         * @return the open wire
         * @throws IOException when the transport cannot be opened
         */
        Wire open(Consumer<String> inbound) throws IOException;
    }

    private final Wire wire;
    private final Duration deadline;
    private final AtomicLong ids = new AtomicLong();
    private final Map<Long, CompletableFuture<JsonNode>> pending = new ConcurrentHashMap<>();
    private final Map<String, List<Consumer<JsonNode>>> listeners = new ConcurrentHashMap<>();
    private final BlockingQueue<Runnable> dispatch = new LinkedBlockingQueue<>();
    private final Thread dispatcher;
    private final Object sendLock = new Object();
    private volatile boolean closed;

    /**
     * Opens a connection over the given transport.
     *
     * @param factory  how the wire is opened
     * @param deadline how long one call may wait for its reply
     */
    public CdpConnection(WireFactory factory, Duration deadline) {
        this.deadline = deadline;
        this.dispatcher = Thread.ofVirtual().name("spectro-cdp-events").start(this::drain);
        try {
            this.wire = factory.open(this::inbound);
        } catch (IOException cannotOpen) {
            dispatcher.interrupt();
            throw new CdpException("could not open the browser connection: "
                    + cannotOpen.getMessage());
        }
    }

    /**
     * The production transport: {@code java.net.http.WebSocket} to a DevTools
     * endpoint, with partial text frames reassembled before parsing.
     *
     * @param wsUrl    the page target's {@code webSocketDebuggerUrl}
     * @param deadline how long one call may wait for its reply
     * @return the open connection
     */
    public static CdpConnection connect(String wsUrl, Duration deadline) {
        return new CdpConnection(inbound -> {
            HttpClient client = HttpClient.newHttpClient();
            Reassembly listener = new Reassembly(inbound);
            WebSocket socket;
            try {
                socket = client.newWebSocketBuilder()
                        .connectTimeout(Duration.ofSeconds(10))
                        .buildAsync(URI.create(wsUrl), new WebSocket.Listener() {
                            @Override
                            public CompletionStage<?> onText(WebSocket ws, CharSequence data,
                                    boolean last) {
                                listener.onText(data, last);
                                ws.request(1);
                                return null;
                            }
                        })
                        .get(15, TimeUnit.SECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IOException("interrupted while dialling " + wsUrl);
            } catch (ExecutionException | TimeoutException failed) {
                throw new IOException("could not dial " + wsUrl + ": " + failed.getMessage());
            }
            return new Wire() {
                @Override
                public void send(String text) {
                    try {
                        socket.sendText(text, true).get(10, TimeUnit.SECONDS);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        throw new CdpException("interrupted while sending to the browser");
                    } catch (ExecutionException | TimeoutException failed) {
                        throw new CdpException("could not send to the browser: "
                                + failed.getMessage());
                    }
                }

                @Override
                public void close() {
                    socket.abort();
                }
            };
        }, deadline);
    }

    /**
     * The frame reassembler the real WebSocket needs: {@code onText} may deliver
     * a message in pieces, and a parser fed a piece would see broken JSON.
     * Package-visible as a type so the suite can drive it without a socket.
     */
    public static final class Reassembly {
        private final Consumer<String> whole;
        private final StringBuilder buffer = new StringBuilder();

        /** @param whole where every complete message goes */
        public Reassembly(Consumer<String> whole) {
            this.whole = whole;
        }

        /**
         * One frame off the socket.
         *
         * @param data the frame's characters
         * @param last whether this frame completes the message
         */
        public void onText(CharSequence data, boolean last) {
            buffer.append(data);
            if (last) {
                String message = buffer.toString();
                buffer.setLength(0);
                whole.accept(message);
            }
        }
    }

    /**
     * Sends one command and blocks until its reply, the deadline, or close.
     *
     * @param method the CDP method
     * @param params the parameters, or null for none
     * @return the reply's {@code result} object
     */
    public JsonNode call(String method, JsonNode params) {
        return call(method, params, deadline);
    }

    /**
     * Sends one command with its own deadline — a navigation's load wait has a
     * budget the default would cut short or stretch.
     *
     * @param method the CDP method
     * @param params the parameters, or null for none
     * @param within how long to wait for this reply
     * @return the reply's {@code result} object
     */
    public JsonNode call(String method, JsonNode params, Duration within) {
        if (closed) {
            throw new CdpException(method + " refused: the browser connection is closed");
        }
        long id = ids.incrementAndGet();
        ObjectNode frame = JSON.createObjectNode();
        frame.put("id", id);
        frame.put("method", method);
        if (params != null) {
            frame.set("params", params);
        }
        CompletableFuture<JsonNode> waiting = new CompletableFuture<>();
        pending.put(id, waiting);
        try {
            synchronized (sendLock) {
                wire.send(frame.toString());
            }
        } catch (RuntimeException notSent) {
            pending.remove(id);
            throw new CdpException(method + " could not be sent: " + notSent.getMessage());
        }
        JsonNode reply;
        try {
            reply = waiting.get(within.toMillis(), TimeUnit.MILLISECONDS);
        } catch (TimeoutException tooSlow) {
            pending.remove(id);
            throw new CdpException(method + " got no answer from the browser within "
                    + within.toMillis() + " ms");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            pending.remove(id);
            throw new CdpException(method + " was interrupted while waiting for the browser");
        } catch (ExecutionException failed) {
            pending.remove(id);
            throw new CdpException(method + " failed: " + failed.getCause().getMessage());
        }
        if (reply == null) {
            throw new CdpException(method + " got no answer: the browser connection closed");
        }
        if (reply.has("error")) {
            throw new CdpException(method + " refused by the browser: "
                    + reply.path("error").path("message").asText("(no message)"));
        }
        return reply.path("result");
    }

    /**
     * Registers a listener for one event method. Listeners run in arrival
     * order, on the dispatcher thread, never on the inbound thread.
     *
     * @param method   the CDP event method
     * @param listener receives the event's {@code params}
     */
    public void on(String method, Consumer<JsonNode> listener) {
        listeners.computeIfAbsent(method, unused -> new CopyOnWriteArrayList<>()).add(listener);
    }

    /** Closes the wire and fails every waiter now rather than at its deadline. */
    @Override
    public void close() {
        closed = true;
        pending.values().forEach(future -> future.complete(null));
        pending.clear();
        dispatcher.interrupt();
        try {
            wire.close();
        } catch (RuntimeException alreadyGone) {
            // A transport that is already gone needs no second closing.
        }
    }

    private void inbound(String text) {
        JsonNode frame;
        try {
            frame = JSON.readTree(text);
        } catch (IOException notJson) {
            return; // Chrome speaks JSON; anything else is not a reply we owe
        }
        if (frame.has("id")) {
            CompletableFuture<JsonNode> waiting = pending.remove(frame.path("id").asLong());
            if (waiting != null) {
                waiting.complete(frame);
            }
            return;
        }
        String method = frame.path("method").asText(null);
        if (method == null) {
            return;
        }
        List<Consumer<JsonNode>> interested = listeners.get(method);
        if (interested == null || interested.isEmpty()) {
            return;
        }
        JsonNode params = frame.path("params");
        dispatch.add(() -> interested.forEach(listener -> {
            try {
                listener.accept(params);
            } catch (RuntimeException listenerFailed) {
                // One listener's failure must not cost the rest their events.
            }
        }));
    }

    private void drain() {
        try {
            while (!Thread.currentThread().isInterrupted()) {
                dispatch.take().run();
            }
        } catch (InterruptedException stopped) {
            Thread.currentThread().interrupt();
        }
    }
}
