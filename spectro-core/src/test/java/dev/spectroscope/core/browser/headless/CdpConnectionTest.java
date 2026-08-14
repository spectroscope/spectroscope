package dev.spectroscope.core.browser.headless;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The CDP wire logic, driven through the wire seam so no Chrome and no socket
 * is needed: id correlation, error mapping, event dispatch off the inbound
 * thread, deadlines, and the frame reassembly the real WebSocket needs.
 *
 * <p>Timeout-guarded on SEPARATE_THREAD (the house rule from 2026-08-13): these
 * tests block on futures, and a default-mode interrupt on a swallowed wait
 * spins forever instead of failing.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class CdpConnectionTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** A wire whose far end is this test. */
    private static final class FakeWire implements CdpConnection.Wire {
        final ConcurrentLinkedQueue<JsonNode> sent = new ConcurrentLinkedQueue<>();
        volatile java.util.function.Consumer<String> inbound;
        volatile boolean closed;

        @Override
        public void send(String text) {
            try {
                sent.add(JSON.readTree(text));
            } catch (Exception impossible) {
                throw new IllegalStateException(impossible);
            }
        }

        @Override
        public void close() {
            closed = true;
        }

        void reply(long id, String resultJson) throws Exception {
            inbound.accept("{\"id\":" + id + ",\"result\":" + resultJson + "}");
        }

        void event(String method, String paramsJson) {
            inbound.accept("{\"method\":\"" + method + "\",\"params\":" + paramsJson + "}");
        }
    }

    private static FakeWire wire;

    private static CdpConnection open(Duration deadline) {
        wire = new FakeWire();
        FakeWire opened = wire;
        return new CdpConnection(inbound -> {
            opened.inbound = inbound;
            return opened;
        }, deadline);
    }

    @Test
    void aCallCarriesAnIdAndBlocksUntilItsOwnReply() throws Exception {
        try (CdpConnection cdp = open(Duration.ofSeconds(5))) {
            AtomicReference<JsonNode> answer = new AtomicReference<>();
            Thread caller = Thread.startVirtualThread(() ->
                    answer.set(cdp.call("Browser.getVersion", null)));
            waitForSent(1);
            JsonNode frame = wire.sent.peek();
            assertEquals("Browser.getVersion", frame.path("method").asText());
            long id = frame.path("id").asLong();
            assertTrue(id > 0, "every call needs an id to correlate its reply");
            wire.reply(id, "{\"product\":\"HeadlessChrome/151\"}");
            caller.join(5_000);
            assertEquals("HeadlessChrome/151", answer.get().path("product").asText());
        }
    }

    @Test
    void twoCallsGetTheirOwnRepliesEvenArrivingReversed() throws Exception {
        try (CdpConnection cdp = open(Duration.ofSeconds(5))) {
            AtomicReference<JsonNode> first = new AtomicReference<>();
            AtomicReference<JsonNode> second = new AtomicReference<>();
            Thread a = Thread.startVirtualThread(() -> first.set(cdp.call("One", null)));
            waitForSent(1);
            Thread b = Thread.startVirtualThread(() -> second.set(cdp.call("Two", null)));
            waitForSent(2);
            List<JsonNode> frames = List.copyOf(wire.sent);
            long idOne = frames.get(0).path("id").asLong();
            long idTwo = frames.get(1).path("id").asLong();
            wire.reply(idTwo, "{\"which\":\"two\"}");
            wire.reply(idOne, "{\"which\":\"one\"}");
            a.join(5_000);
            b.join(5_000);
            assertEquals("one", first.get().path("which").asText());
            assertEquals("two", second.get().path("which").asText());
        }
    }

    @Test
    void aProtocolErrorBecomesAnExceptionNamingTheMethodAndTheMessage() throws Exception {
        try (CdpConnection cdp = open(Duration.ofSeconds(5))) {
            AtomicReference<Exception> failure = new AtomicReference<>();
            Thread caller = Thread.startVirtualThread(() -> {
                try {
                    cdp.call("Page.navigate", JSON.createObjectNode().put("url", "x"));
                } catch (CdpConnection.CdpException error) {
                    failure.set(error);
                }
            });
            waitForSent(1);
            long id = wire.sent.peek().path("id").asLong();
            wire.inbound.accept("{\"id\":" + id + ",\"error\":{\"code\":-32000,"
                    + "\"message\":\"Cannot navigate to invalid URL\"}}");
            caller.join(5_000);
            assertTrue(failure.get().getMessage().contains("Page.navigate"));
            assertTrue(failure.get().getMessage().contains("Cannot navigate to invalid URL"));
        }
    }

    @Test
    void aCallPastItsDeadlineFailsNamingTheMethod() {
        try (CdpConnection cdp = open(Duration.ofMillis(80))) {
            CdpConnection.CdpException late = assertThrows(CdpConnection.CdpException.class,
                    () -> cdp.call("Page.navigate", null));
            assertTrue(late.getMessage().contains("Page.navigate"),
                    "the deadline sentence must name the verb that hung: " + late.getMessage());
        }
    }

    @Test
    void eventsReachTheirListenerInOrderAndOffTheInboundThread() throws Exception {
        try (CdpConnection cdp = open(Duration.ofSeconds(5))) {
            List<String> seen = new CopyOnWriteArrayList<>();
            List<Thread> on = new CopyOnWriteArrayList<>();
            CountDownLatch three = new CountDownLatch(3);
            cdp.on("Runtime.consoleAPICalled", params -> {
                seen.add(params.path("n").asText());
                on.add(Thread.currentThread());
                three.countDown();
            });
            Thread pusher = Thread.currentThread();
            wire.event("Runtime.consoleAPICalled", "{\"n\":\"1\"}");
            wire.event("Runtime.consoleAPICalled", "{\"n\":\"2\"}");
            wire.event("Runtime.consoleAPICalled", "{\"n\":\"3\"}");
            assertTrue(three.await(5, TimeUnit.SECONDS), "events must be dispatched");
            assertEquals(List.of("1", "2", "3"), seen, "dispatch must preserve arrival order");
            assertTrue(on.stream().noneMatch(t -> t == pusher),
                    "a listener must never run on the inbound thread — a listener that "
                            + "calls back into the protocol would deadlock against it");
        }
    }

    @Test
    void anEventListenerMayItselfCallWithoutDeadlock() throws Exception {
        try (CdpConnection cdp = open(Duration.ofSeconds(5))) {
            AtomicReference<JsonNode> acked = new AtomicReference<>();
            CountDownLatch done = new CountDownLatch(1);
            cdp.on("Page.screencastFrame", params -> {
                acked.set(cdp.call("Page.screencastFrameAck",
                        JSON.createObjectNode().put("sessionId", params.path("sessionId").asInt())));
                done.countDown();
            });
            wire.event("Page.screencastFrame", "{\"sessionId\":7}");
            waitForSent(1);
            long id = wire.sent.peek().path("id").asLong();
            wire.reply(id, "{}");
            assertTrue(done.await(5, TimeUnit.SECONDS),
                    "the ack pattern must work from inside a frame listener");
            assertEquals(0, acked.get().size());
        }
    }

    @Test
    void closingFailsEveryPendingCallImmediately() throws Exception {
        CdpConnection cdp = open(Duration.ofSeconds(30));
        AtomicReference<Exception> failure = new AtomicReference<>();
        CountDownLatch failed = new CountDownLatch(1);
        Thread.startVirtualThread(() -> {
            try {
                cdp.call("Page.navigate", null);
            } catch (CdpConnection.CdpException error) {
                failure.set(error);
                failed.countDown();
            }
        });
        waitForSent(1);
        cdp.close();
        assertTrue(failed.await(5, TimeUnit.SECONDS),
                "close must fail the waiter now, not at its 30 s deadline");
        assertTrue(wire.closed, "closing the connection closes the wire under it");
    }

    @Test
    void partialTextFramesAreReassembledBeforeParsing() {
        List<String> delivered = new CopyOnWriteArrayList<>();
        CdpConnection.Reassembly listener = new CdpConnection.Reassembly(delivered::add);
        listener.onText("{\"id\":1,\"resu", false);
        listener.onText("lt\":{}}", true);
        listener.onText("{\"method\":\"Page.loadEventFired\",\"params\":{}}", true);
        assertEquals(2, delivered.size(), "two messages from three frames");
        assertEquals("{\"id\":1,\"result\":{}}", delivered.get(0));
    }

    private static void waitForSent(int count) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 5_000;
        while (wire.sent.size() < count && System.currentTimeMillis() < deadline) {
            Thread.sleep(5);
        }
        assertTrue(wire.sent.size() >= count, "expected " + count + " sent frame(s)");
    }
}
