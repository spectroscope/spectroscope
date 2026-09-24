package dev.spectroscope.server.session;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.locks.LockSupport;

/**
 * Card 395: a scripted Ollama on loopback that streams one long thinking
 * response the way a fast model does, one NDJSON line per piece of reasoning.
 *
 * <p>The shape is a burst followed by a steady rate. The burst stands for a
 * backlog that a real stream built up over the preceding seconds; the steady
 * part is the rate the model keeps up while the operator reaches for stop. A
 * line counts as streamed once it was written and flushed to the socket. The
 * stream ends when the provider hangs up (the cancel closes the connection) or
 * after {@code maxLines}, whichever comes first.</p>
 *
 * <p>With children, the parent's first request is answered with one
 * {@code spawn_agents} call for that many explore children, and each child's
 * request gets its own stream of the given shape. A child's lines start with
 * its own letter ({@link #piece(char, int)}), so the joined text of each child
 * shows a lost, doubled or swapped line of that child.</p>
 */
final class ThinkingFloodBackend implements AutoCloseable {

    /**
     * How the response is paced.
     *
     * @param burst          lines written at once before the steady part
     * @param linesPerSecond the steady rate after the burst
     * @param maxLines       the whole response, burst included, when nobody hangs up
     */
    record Shape(int burst, double linesPerSecond, int maxLines) {}

    /** Marks a child's task, so a request from a child is told apart from the parent's. */
    static final String CHILD_TASK = "card-395-flood-child ";

    private final HttpServer server;
    private final Shape shape;
    private final int children;
    private final AtomicInteger streamed = new AtomicInteger();
    private final CountDownLatch burstFlushed;
    private volatile long burstFlushedAt;

    /**
     * Starts the backend on a free loopback port.
     *
     * @param shape how the one thinking response is paced
     */
    ThinkingFloodBackend(Shape shape) throws IOException {
        this(shape, 0);
    }

    /**
     * Starts the backend on a free loopback port.
     *
     * @param shape    how each thinking response is paced
     * @param children zero for one thinking response to the parent; otherwise
     *                 the parent spawns this many explore children and each of
     *                 them streams (at most 26)
     */
    ThinkingFloodBackend(Shape shape, int children) throws IOException {
        this.shape = shape;
        this.children = children;
        this.burstFlushed = new CountDownLatch(Math.max(1, children));
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/api/chat", this::answer);
        server.start();
    }

    /** @return the base url a provider points at */
    String baseUrl() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    /**
     * The thinking text of line {@code i}: six characters, unique per line, so a
     * lost, doubled or swapped line shows in the joined text.
     *
     * @param i the zero-based line number
     * @return the piece of reasoning that line carries
     */
    static String piece(int i) {
        return String.format("%05d|", i);
    }

    /**
     * The joined thinking text of the first {@code lines} lines.
     *
     * @param lines how many lines
     * @return what those lines say together
     */
    static String textOf(int lines) {
        StringBuilder text = new StringBuilder(lines * 6);
        for (int i = 0; i < lines; i++) {
            text.append(piece(i));
        }
        return text.toString();
    }

    /**
     * The thinking text of line {@code i} of one child's stream: six characters,
     * the child's letter first.
     *
     * @param child the child's letter, 'a' for the first
     * @param i     the zero-based line number, below 10,000
     * @return the piece of reasoning that line carries
     */
    static String piece(char child, int i) {
        return child + String.format("%04d|", i);
    }

    /**
     * The joined thinking text of the first {@code lines} lines of one child's stream.
     *
     * @param child the child's letter
     * @param lines how many lines
     * @return what those lines say together
     */
    static String textOf(char child, int lines) {
        StringBuilder text = new StringBuilder(lines * 6);
        for (int i = 0; i < lines; i++) {
            text.append(piece(child, i));
        }
        return text.toString();
    }

    /** @return how many lines have been written and flushed so far, all streams together */
    int streamed() {
        return streamed.get();
    }

    /**
     * Waits until the burst has been written and flushed, by every stream.
     *
     * @param seconds how long to wait at most
     * @return System.nanoTime() when a stream last flushed its burst
     */
    long awaitBurst(long seconds) throws InterruptedException {
        if (!burstFlushed.await(seconds, TimeUnit.SECONDS)) {
            throw new AssertionError("the backend never flushed its burst; lines so far: "
                    + streamed.get());
        }
        return burstFlushedAt;
    }

    private void answer(HttpExchange exchange) throws IOException {
        String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/x-ndjson");
        exchange.sendResponseHeaders(200, 0); // chunked: the length is not known up front
        if (children > 0) {
            int at = body.indexOf(CHILD_TASK);
            if (body.contains("\"role\":\"tool\"") || at < 0) {
                // The parent: its first request spawns the children, a later one
                // (after the children's results) closes the run.
                answerParent(exchange, body.contains("\"role\":\"tool\""));
                return;
            }
            char child = body.charAt(at + CHILD_TASK.length());
            stream(exchange, i -> childLine(child, i), Math.min(shape.maxLines(), 9_999));
            return;
        }
        stream(exchange, ThinkingFloodBackend::line, shape.maxLines());
    }

    /**
     * The parent's side when children stream: one spawn_agents call, or the closing answer.
     *
     * @param exchange the parent's request
     * @param closing  true once the children's results came back
     */
    private void answerParent(HttpExchange exchange, boolean closing) throws IOException {
        StringBuilder agents = new StringBuilder();
        for (int c = 0; c < children; c++) {
            agents.append(c == 0 ? "" : ",").append("{\"type\":\"explore\",\"task\":\"")
                    .append(CHILD_TASK).append((char) ('a' + c)).append("\"}");
        }
        String first = closing
                ? "{\"message\":{\"role\":\"assistant\",\"content\":\"done\"},\"done\":false}\n"
                : "{\"message\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":[{\"function\":"
                        + "{\"name\":\"spawn_agents\",\"arguments\":{\"agents\":[" + agents + "]}}}]},"
                        + "\"done\":false}\n";
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(first.getBytes(StandardCharsets.UTF_8));
            out.write(("{\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,"
                    + "\"done_reason\":\"stop\",\"prompt_eval_count\":9,\"eval_count\":3}\n")
                    .getBytes(StandardCharsets.UTF_8));
        } catch (IOException hungUp) {
            // cancelled before the answer was out
        } finally {
            exchange.close();
        }
    }

    /**
     * Streams one thinking response of this backend's shape.
     *
     * @param exchange the request to answer
     * @param lineOf   the NDJSON line for each line number
     * @param maxLines the whole response, burst included, when nobody hangs up
     */
    private void stream(HttpExchange exchange, java.util.function.IntFunction<byte[]> lineOf,
                        int maxLines) {
        try (OutputStream out = exchange.getResponseBody()) {
            int i = 0;
            for (; i < Math.min(shape.burst(), maxLines); i++) {
                out.write(lineOf.apply(i));
                if (i % 256 == 255) {
                    out.flush();
                    streamed.addAndGet(256);
                }
            }
            out.flush();
            streamed.addAndGet(i % 256); // the lines since the last flush of 256
            burstFlushedAt = System.nanoTime();
            burstFlushed.countDown();
            long period = (long) (TimeUnit.SECONDS.toNanos(1) / shape.linesPerSecond());
            long next = System.nanoTime();
            for (; i < maxLines; i++) {
                next += period;
                long wait = next - System.nanoTime();
                if (wait > 0) {
                    LockSupport.parkNanos(wait);
                }
                out.write(lineOf.apply(i));
                out.flush();
                streamed.incrementAndGet();
            }
            out.write(("{\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,"
                    + "\"done_reason\":\"stop\",\"prompt_eval_count\":9,\"eval_count\":" + i + "}\n")
                    .getBytes(StandardCharsets.UTF_8));
        } catch (IOException hungUp) {
            // The provider closed the connection: that is how a cancel ends a stream.
        } finally {
            exchange.close();
        }
    }

    private static byte[] line(int i) {
        return thinkingLine(piece(i));
    }

    private static byte[] childLine(char child, int i) {
        return thinkingLine(piece(child, i));
    }

    private static byte[] thinkingLine(String piece) {
        return ("{\"message\":{\"role\":\"assistant\",\"content\":\"\",\"thinking\":\""
                + piece + "\"},\"done\":false}\n").getBytes(StandardCharsets.UTF_8);
    }

    @Override
    public void close() {
        server.stop(0);
    }
}
