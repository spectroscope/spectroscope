package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.PipedReader;
import java.io.PipedWriter;
import java.io.Reader;
import java.io.Writer;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Framing and id-correlation of {@link JsonRpcChannel} driven over in-memory
 * {@link PipedReader}/{@link PipedWriter} pairs and a fake responder thread —
 * no process, no I/O, no binary.
 */
class JsonRpcChannelTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * A wiring of two pipes: what the channel writes lands in {@code toServer},
     * what the responder writes lands in {@code fromServer} which the channel reads.
     */
    private record Wiring(BufferedReader channelIn, BufferedWriter channelOut,
                          BufferedReader serverIn, BufferedWriter serverOut) {}

    private static Wiring pipes() throws IOException {
        // channel -> server
        PipedWriter cOut = new PipedWriter();
        PipedReader sIn = new PipedReader(cOut);
        // server -> channel
        PipedWriter sOut = new PipedWriter();
        PipedReader cIn = new PipedReader(sOut);
        return new Wiring(
                new BufferedReader(cIn),
                new BufferedWriter(cOut),
                new BufferedReader(sIn),
                new BufferedWriter(sOut));
    }

    /** A responder that echoes one canned response per request, correlating on the request id. */
    private static Thread responder(BufferedReader serverIn, BufferedWriter serverOut,
                                    java.util.function.BiFunction<JsonNode, JsonNode, JsonNode> replyFor,
                                    AtomicReference<Throwable> failure) {
        Thread t = new Thread(() -> {
            try {
                String line;
                while ((line = serverIn.readLine()) != null) {
                    JsonNode request = JSON.readTree(line);
                    JsonNode id = request.get("id");
                    if (id == null || id.isNull()) {
                        continue; // a notification: no reply
                    }
                    JsonNode result = replyFor.apply(request.get("method"), request.get("params"));
                    var response = JSON.createObjectNode();
                    response.put("jsonrpc", "2.0");
                    response.set("id", id);
                    response.set("result", result);
                    serverOut.write(JSON.writeValueAsString(response));
                    serverOut.write("\n");
                    serverOut.flush();
                }
            } catch (Throwable e) {
                failure.set(e);
            }
        }, "fake-responder");
        t.setDaemon(true);
        return t;
    }

    @Test
    void requestGetsBackTheResponseCorrelatedById() throws Exception {
        Wiring w = pipes();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        responder(w.serverIn(), w.serverOut(), (method, params) -> {
            var r = JSON.createObjectNode();
            r.put("method", method.asText());
            r.put("echo", params == null ? "" : params.path("q").asText());
            return r;
        }, failure).start();

        try (JsonRpcChannel channel = new JsonRpcChannel(w.channelIn(), w.channelOut(), Duration.ofSeconds(5))) {
            JsonNode result = channel.request("tools/call", JSON.createObjectNode().put("q", "hello"));
            assertEquals("tools/call", result.path("method").asText());
            assertEquals("hello", result.path("echo").asText());
        }
        assertTrue(failure.get() == null, "responder failed: " + failure.get());
    }

    @Test
    void idsIncrementAndEachResponseMatchesItsRequest() throws Exception {
        Wiring w = pipes();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        // Reply carries back the request id so we can prove correlation from the wire.
        Thread t = new Thread(() -> {
            try {
                String line;
                while ((line = w.serverIn().readLine()) != null) {
                    JsonNode req = JSON.readTree(line);
                    var resp = JSON.createObjectNode();
                    resp.put("jsonrpc", "2.0");
                    resp.set("id", req.get("id"));
                    var res = JSON.createObjectNode();
                    res.set("seenId", req.get("id"));
                    resp.set("result", res);
                    w.serverOut().write(JSON.writeValueAsString(resp));
                    w.serverOut().write("\n");
                    w.serverOut().flush();
                }
            } catch (Throwable e) {
                failure.set(e);
            }
        }, "corr-responder");
        t.setDaemon(true);
        t.start();

        try (JsonRpcChannel channel = new JsonRpcChannel(w.channelIn(), w.channelOut(), Duration.ofSeconds(5))) {
            JsonNode a = channel.request("first", null);
            JsonNode b = channel.request("second", null);
            JsonNode c = channel.request("third", null);
            assertEquals(1, a.path("seenId").asInt());
            assertEquals(2, b.path("seenId").asInt());
            assertEquals(3, c.path("seenId").asInt());
        }
        assertTrue(failure.get() == null, "responder failed: " + failure.get());
    }

    @Test
    void notificationWritesAFrameWithNoIdAndDoesNotBlockOnAReply() throws Exception {
        Wiring w = pipes();
        // The server side just captures the raw frame; a notification must not carry an id.
        AtomicReference<String> captured = new AtomicReference<>();
        Thread t = new Thread(() -> {
            try {
                captured.set(w.serverIn().readLine());
            } catch (IOException ignored) {
            }
        }, "notif-reader");
        t.setDaemon(true);
        t.start();

        try (JsonRpcChannel channel = new JsonRpcChannel(w.channelIn(), w.channelOut(), Duration.ofSeconds(5))) {
            channel.notify("notifications/initialized", null);
        }
        t.join(2000);
        JsonNode frame = JSON.readTree(captured.get());
        assertEquals("2.0", frame.path("jsonrpc").asText());
        assertEquals("notifications/initialized", frame.path("method").asText());
        assertFalse(frame.has("id"), "a notification must not carry an id");
    }

    @Test
    void aServerThatNeverAnswersTimesOut() throws Exception {
        Wiring w = pipes();
        // No responder thread — the read side never produces a line.
        try (JsonRpcChannel channel = new JsonRpcChannel(w.channelIn(), w.channelOut(), Duration.ofMillis(300))) {
            assertThrows(RuntimeException.class, () -> channel.request("tools/list", null));
        }
    }

    @Test
    void afterATimeoutTheChannelIsPoisonedAndTheNextRequestFailsFastRatherThanHanging() throws Exception {
        Wiring w = pipes();
        // No responder — the first request times out. Without poisoning, the single
        // reader thread would stay stuck in readLine and every later request would
        // also block for the whole timeout (or forever). The channel must instead be
        // torn down so a subsequent request fails immediately.
        JsonRpcChannel channel = new JsonRpcChannel(w.channelIn(), w.channelOut(), Duration.ofMillis(300));

        assertThrows(RuntimeException.class, () -> channel.request("tools/list", null));
        assertTrue(channel.isPoisoned(), "a timed-out channel must poison itself");

        // The second call must return fast (well under the read timeout), not hang.
        long start = System.nanoTime();
        RuntimeException thrown = assertThrows(RuntimeException.class,
                () -> channel.request("tools/call", null));
        long elapsedMs = (System.nanoTime() - start) / 1_000_000;

        assertTrue(elapsedMs < 200,
                "a poisoned channel must fail fast, took " + elapsedMs + " ms");
        assertTrue(thrown.getMessage().toLowerCase().contains("poison"),
                "the failure should say the channel is poisoned, got: " + thrown.getMessage());
        channel.close();
    }

    @Test
    void closeIsIdempotentAndAClosedChannelRefusesFurtherRequests() throws Exception {
        Wiring w = pipes();
        JsonRpcChannel channel = new JsonRpcChannel(w.channelIn(), w.channelOut(), Duration.ofSeconds(5));
        channel.close();
        channel.close(); // idempotent — must not throw
        assertThrows(RuntimeException.class, () -> channel.request("tools/list", null));
    }

    @Test
    void aJsonRpcErrorResponseIsSurfacedAsAnException() throws Exception {
        Wiring w = pipes();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread t = new Thread(() -> {
            try {
                String line;
                while ((line = w.serverIn().readLine()) != null) {
                    JsonNode req = JSON.readTree(line);
                    var resp = JSON.createObjectNode();
                    resp.put("jsonrpc", "2.0");
                    resp.set("id", req.get("id"));
                    var err = JSON.createObjectNode();
                    err.put("code", -32601);
                    err.put("message", "Method not found");
                    resp.set("error", err);
                    w.serverOut().write(JSON.writeValueAsString(resp));
                    w.serverOut().write("\n");
                    w.serverOut().flush();
                }
            } catch (Throwable e) {
                failure.set(e);
            }
        }, "err-responder");
        t.setDaemon(true);
        t.start();

        try (JsonRpcChannel channel = new JsonRpcChannel(w.channelIn(), w.channelOut(), Duration.ofSeconds(5))) {
            RuntimeException thrown = assertThrows(RuntimeException.class,
                    () -> channel.request("bogus/method", null));
            assertTrue(thrown.getMessage().contains("Method not found"),
                    "expected the JSON-RPC error message, got: " + thrown.getMessage());
        }
        assertTrue(failure.get() == null, "responder failed: " + failure.get());
    }
}
