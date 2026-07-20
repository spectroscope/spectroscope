package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.Tool.ToolContext;
import dev.spectroscope.core.CancelSignal;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** MCP client logic against an injected {@link FakeTransport} — no process, no I/O. */
class McpClientTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static McpInitializeResult init() {
        return new McpInitializeResult("2024-11-05", "notes", null);
    }

    private static McpToolDescriptor tool(String name) {
        return new McpToolDescriptor(name, name + " description", JSON.createObjectNode().put("type", "object"));
    }

    private static ToolContext ctx() {
        return new ToolContext(Path.of("."), new CancelSignal());
    }

    @Test
    void initializeAndListToolsAreCachedOnStart() {
        FakeTransport fake = new FakeTransport(init(), List.of(tool("search_notes"), tool("add_note")),
                (name, args) -> "unused");
        McpClient client = new McpClient(new McpServerConfig("notes", "java", null, null, null, null),
                () -> fake);

        client.start();

        assertTrue(client.isStarted());
        assertEquals(1, fake.initializeCalls);
        assertEquals(1, fake.listToolsCalls);
        assertEquals(2, client.tools().size());
        assertEquals("notes", client.initializeResult().serverName());
    }

    @Test
    void wrappedToolsUsePrefixedNameAndAreAlwaysPermissionGated() {
        FakeTransport fake = new FakeTransport(init(), List.of(tool("search_notes"), tool("add_note")),
                (name, args) -> "ok");
        McpClient client = new McpClient(new McpServerConfig("notes", "java", null, null, null, null),
                () -> fake);
        client.start();

        List<Tool> wrapped = client.tools().stream()
                .<Tool>map(d -> new McpTool("notes", client, d))
                .toList();

        assertEquals("mcp__notes__search_notes", wrapped.get(0).name());
        assertEquals("mcp__notes__add_note", wrapped.get(1).name());
        assertTrue(wrapped.get(0).needsPermission());
        assertTrue(wrapped.get(1).needsPermission());
        assertEquals("search_notes description", wrapped.get(0).description());
    }

    @Test
    void callToolRoundTripReturnsTheTextContent() {
        FakeTransport fake = new FakeTransport(init(), List.of(tool("search_notes")),
                (name, args) -> "found: " + args.path("query").asText());
        McpClient client = new McpClient(new McpServerConfig("notes", "java", null, null, null, null),
                () -> fake);
        client.start();

        McpTool searchTool = new McpTool("notes", client, client.tools().get(0));
        JsonNode input = JSON.createObjectNode().put("query", "gradle");

        String result = searchTool.execute(input, ctx());

        assertEquals("found: gradle", result);
        assertEquals(1, fake.callToolCalls);
    }

    @Test
    void aTransportDeadAtCallTimeIsTransparentlyReEstablishedOnTheNextCallAndSucceeds() {
        // The resilience guarantee: a server that died BETWEEN calls is re-established
        // on the next call. The first transport's callTool throws (server died mid-life);
        // that call degrades to ERROR and drops the transport. The SECOND call gets a
        // fresh transport from the supplier and succeeds — with no double call on either.
        AtomicInteger callToolInvocations = new AtomicInteger();
        Supplier<McpTransport> supplier = new Supplier<>() {
            int handed;
            @Override public McpTransport get() {
                handed++;
                boolean firstConnection = handed == 1;
                return new FakeTransport(init(), List.of(tool("search_notes")), (name, args) -> {
                    callToolInvocations.incrementAndGet();
                    if (firstConnection) {
                        throw new RuntimeException("boom");
                    }
                    return "recovered";
                });
            }
        };
        McpClient client = new McpClient(new McpServerConfig("notes", "java", null, null, null, null), supplier);
        client.start();

        String first = client.call("search_notes", JSON.createObjectNode());
        assertTrue(first.startsWith("ERROR:"), "the mid-life failure degrades, got: " + first);
        assertEquals(1, callToolInvocations.get(), "the failed call must NOT be re-issued in place");

        String second = client.call("search_notes", JSON.createObjectNode());
        assertEquals("recovered", second, "the next call re-establishes and succeeds");
        assertEquals(2, callToolInvocations.get()); // exactly one invocation per call()
    }

    @Test
    void aCallBeforeStartLazilyEstablishesTheTransportAndSucceeds() {
        // "Never started" is the other dead-at-call-time case in the design: the
        // first call() must establish the transport itself and succeed.
        Supplier<McpTransport> supplier = () ->
                new FakeTransport(init(), List.of(tool("search_notes")), (name, args) -> "alive");
        McpClient client = new McpClient(new McpServerConfig("notes", "java", null, null, null, null), supplier);
        // no start() — the transport is null at call time

        String result = client.call("search_notes", JSON.createObjectNode());
        assertEquals("alive", result);
    }

    @Test
    void anEstablishedTransportThatFailsReturnsErrorAndDoesNotCallTwice() {
        // A single established transport whose callTool always throws: exactly ONE
        // invocation, then ERROR. This is the double-side-effect guard.
        FakeTransport fake = new FakeTransport(init(), List.of(tool("add_note")),
                (name, args) -> { throw new RuntimeException("mid-call failure"); });
        McpClient client = new McpClient(new McpServerConfig("notes", "java", null, null, null, null),
                new Supplier<>() {
                    int handed;
                    @Override public McpTransport get() {
                        handed++;
                        return handed == 1 ? fake
                                : new FakeTransport(init(), List.of(tool("add_note")), (n, a) -> "second");
                    }
                });
        client.start();

        String result = client.call("add_note", JSON.createObjectNode());

        assertTrue(result.startsWith("ERROR:"), "a mid-call failure degrades, got: " + result);
        assertEquals(1, fake.callToolCalls, "the failing call must be issued exactly once (no double side effect)");
    }

    @Test
    void callThatAlwaysFailsDegradesToAnErrorStringAndDoesNotThrow() {
        Supplier<McpTransport> supplier = () -> new FakeTransport(init(), List.of(tool("search_notes")),
                (name, args) -> { throw new RuntimeException("always down"); });
        McpClient client = new McpClient(new McpServerConfig("notes", "java", null, null, null, null), supplier);
        client.start();

        String result = client.call("search_notes", JSON.createObjectNode());

        assertTrue(result.startsWith("ERROR:"), "expected a readable ERROR string, got: " + result);
        assertTrue(result.contains("always down"));
    }

    @Test
    void emptyResponseIsTreatedAsAFailureAndDegradesToError() {
        // A transport that returns null (malformed/empty result) must not surface as a null tool result.
        Supplier<McpTransport> supplier = () -> new FakeTransport(init(), List.of(tool("search_notes")),
                (name, args) -> null);
        McpClient client = new McpClient(new McpServerConfig("notes", "java", null, null, null, null), supplier);
        client.start();

        String result = client.call("search_notes", JSON.createObjectNode());

        assertTrue(result.startsWith("ERROR:"), "expected an ERROR string for an empty response, got: " + result);
    }

    @Test
    void reEstablishFailureAtCallTimeDegradesToAnUnreachableErrorRatherThanThrowing() {
        // First call fails mid-life (drops the transport); the SECOND call must
        // re-establish, but the supplier now refuses. call() must degrade to an
        // "unreachable" ERROR string, never throw.
        Supplier<McpTransport> supplier = new Supplier<>() {
            int handed;
            @Override public McpTransport get() {
                handed++;
                if (handed == 1) {
                    return new FakeTransport(init(), List.of(tool("search_notes")),
                            (name, args) -> { throw new RuntimeException("server died"); });
                }
                throw new RuntimeException("reconnect refused");
            }
        };
        McpClient client = new McpClient(new McpServerConfig("notes", "java", null, null, null, null), supplier);
        client.start();

        String first = client.call("search_notes", JSON.createObjectNode());
        assertTrue(first.startsWith("ERROR:"), "the mid-life failure degrades, got: " + first);

        String second = client.call("search_notes", JSON.createObjectNode());
        assertTrue(second.startsWith("ERROR:"), "expected an ERROR string, got: " + second);
        assertTrue(second.contains("unreachable"));
        assertTrue(second.contains("reconnect refused"));
    }

    @Test
    void anEstablishedTransportTimeoutDegradesToErrorPoisonsAndDoesNotDoubleCall() throws Exception {
        // Finding 7 + finding 3: a fake whose callTool blocks past the short timeout.
        // call() must (a) return an ERROR mentioning the timeout, (b) invoke callTool
        // exactly once (no in-place retry), (c) drop the transport so the NEXT call
        // re-establishes and succeeds.
        java.util.concurrent.CountDownLatch release = new java.util.concurrent.CountDownLatch(1);
        AtomicInteger firstConnectionCalls = new AtomicInteger();
        Supplier<McpTransport> supplier = new Supplier<>() {
            int handed;
            @Override public McpTransport get() {
                handed++;
                if (handed == 1) {
                    return new FakeTransport(init(), List.of(tool("search_notes")), (name, args) -> {
                        firstConnectionCalls.incrementAndGet();
                        try {
                            release.await(5, java.util.concurrent.TimeUnit.SECONDS); // block past the timeout
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                        return "too late";
                    });
                }
                return new FakeTransport(init(), List.of(tool("search_notes")), (name, args) -> "fresh");
            }
        };
        McpClient client = new McpClient(new McpServerConfig("notes", "java", null, null, null, null),
                supplier, Duration.ofMillis(150));
        client.start();

        String timedOut = client.call("search_notes", JSON.createObjectNode());
        release.countDown(); // let the stuck task unwind

        assertTrue(timedOut.startsWith("ERROR:"), "a timeout must degrade, got: " + timedOut);
        assertTrue(timedOut.toLowerCase().contains("time"),
                "the error should mention the timeout, got: " + timedOut);
        assertEquals(1, firstConnectionCalls.get(), "the timed-out call must be issued exactly once");

        String next = client.call("search_notes", JSON.createObjectNode());
        assertEquals("fresh", next, "the next call must re-establish and succeed");
    }
}
