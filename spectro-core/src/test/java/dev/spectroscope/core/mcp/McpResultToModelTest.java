package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.tools.Tool;
import org.junit.jupiter.api.Test;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.PipedReader;
import java.io.PipedWriter;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * What an MCP {@code tools/call} reply becomes on its way to the model, driven
 * through the whole seam the model actually sits behind: a scripted MCP server
 * over in-memory pipes, the real {@link StdioTransport}, the real
 * {@link McpClient}, and the real {@link McpTool} with its tool context.
 *
 * <p>This class was written <b>before</b> the image work of card 198 to pin the
 * behaviour that must not move: a text-only reply, and the raw-JSON fallback for
 * a content shape spectroscope does not understand. Those two tests are the
 * regression net; the image tests were added afterwards, red first.
 */
class McpResultToModelTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    // ---- the pinned behaviour (written before the change) ---------------------------

    @Test
    void aTextOnlyReplyReachesTheModelAsTheJoinedTextAndNothingElse() throws Exception {
        ArrayNode content = JSON.createArrayNode();
        content.add(textBlock("alpha"));
        content.add(textBlock("beta"));

        Called called = call(content);

        assertEquals("alpha\nbeta", called.output(),
                "text blocks join with a newline, exactly as before card 198");
        assertTrue(called.attachments().isEmpty(), "a text-only reply attaches nothing");
        assertTrue(called.events().isEmpty(), "a text-only reply emits no event");
    }

    @Test
    void aContentShapeSpectroscopeDoesNotUnderstandStillFallsBackToTheRawJson() throws Exception {
        ArrayNode content = JSON.createArrayNode();
        ObjectNode resource = JSON.createObjectNode();
        resource.put("type", "resource");
        resource.set("resource", JSON.createObjectNode().put("uri", "file:///notes.txt"));
        content.add(resource);

        Called called = call(content);

        assertTrue(called.output().contains("\"type\":\"resource\""),
                "an unknown block still hands back the raw result JSON, got: " + called.output());
        assertTrue(called.attachments().isEmpty());
        assertTrue(called.events().isEmpty());
    }

    // ---- the harness ---------------------------------------------------------------

    /** One call's three outputs: what the model reads, what rides along, what the run recorded. */
    record Called(String output, List<Tool.Attachment> attachments, List<RunEvent> events) {}

    /**
     * Runs one {@code tools/call} against a scripted server that replies with the
     * given content array, through transport, client and tool.
     *
     * @param content the {@code content} array the server answers {@code tools/call} with
     * @return the model-facing output, the attachments, and the emitted events
     */
    private static Called call(ArrayNode content) throws Exception {
        Wiring wiring = pipes();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread server = scriptedServer(wiring, content, failure);
        server.start();

        JsonRpcChannel channel = new JsonRpcChannel(
                wiring.channelIn(), wiring.channelOut(), Duration.ofSeconds(5));
        StdioTransport transport = new StdioTransport(channel, () -> { });
        McpServerConfig config = new McpServerConfig("shots", "irrelevant", null, null, null, null);
        McpClient client = new McpClient(config, () -> transport, Duration.ofSeconds(5));

        List<Tool.Attachment> attachments = new ArrayList<>();
        List<RunEvent> events = new ArrayList<>();
        try {
            client.start();
            McpTool tool = new McpTool("shots", client, client.tools().getFirst());
            Tool.ToolContext context = new Tool.ToolContext(
                    Path.of("."), new CancelSignal(), "main", "call-1",
                    events::add, attachments::add);
            String output = tool.execute(JSON.createObjectNode(), context);
            assertTrue(failure.get() == null, "scripted server failed: " + failure.get());
            return new Called(output, attachments, events);
        } finally {
            client.close();
        }
    }

    /** A {@code text} content block. */
    private static ObjectNode textBlock(String text) {
        ObjectNode block = JSON.createObjectNode();
        block.put("type", "text");
        block.put("text", text);
        return block;
    }

    private record Wiring(BufferedReader channelIn, BufferedWriter channelOut,
                          BufferedReader serverIn, BufferedWriter serverOut) {}

    private static Wiring pipes() throws IOException {
        PipedWriter clientOut = new PipedWriter();
        PipedReader serverIn = new PipedReader(clientOut);
        PipedWriter serverOut = new PipedWriter();
        PipedReader clientIn = new PipedReader(serverOut);
        return new Wiring(new BufferedReader(clientIn), new BufferedWriter(clientOut),
                new BufferedReader(serverIn), new BufferedWriter(serverOut));
    }

    /**
     * A minimal MCP server on the far end of the pipes: handshake, one advertised
     * tool, and a {@code tools/call} that always answers with the scripted content.
     *
     * @param wiring  the pipe pair to speak over
     * @param content the content array every {@code tools/call} answers with
     * @param failure where an exception on the server thread is parked for the test to see
     * @return the (unstarted) daemon thread running the server
     */
    private static Thread scriptedServer(Wiring wiring, ArrayNode content,
                                         AtomicReference<Throwable> failure) {
        Thread thread = new Thread(() -> {
            try {
                String line;
                while ((line = wiring.serverIn().readLine()) != null) {
                    JsonNode request = JSON.readTree(line);
                    JsonNode id = request.get("id");
                    if (id == null || id.isNull()) {
                        continue; // a notification takes no reply
                    }
                    JsonNode result = switch (request.path("method").asText()) {
                        case "initialize" -> {
                            ObjectNode init = JSON.createObjectNode();
                            init.put("protocolVersion", "2024-11-05");
                            init.set("serverInfo", JSON.createObjectNode().put("name", "shots"));
                            init.set("capabilities", JSON.createObjectNode());
                            yield init;
                        }
                        case "tools/list" -> {
                            ObjectNode tool = JSON.createObjectNode();
                            tool.put("name", "screenshot");
                            tool.put("description", "takes a screenshot");
                            tool.set("inputSchema", JSON.createObjectNode().put("type", "object"));
                            ObjectNode list = JSON.createObjectNode();
                            list.set("tools", JSON.createArrayNode().add(tool));
                            yield list;
                        }
                        case "tools/call" -> {
                            ObjectNode reply = JSON.createObjectNode();
                            reply.set("content", content);
                            yield reply;
                        }
                        default -> JSON.createObjectNode();
                    };
                    ObjectNode response = JSON.createObjectNode();
                    response.put("jsonrpc", "2.0");
                    response.set("id", id);
                    response.set("result", result);
                    wiring.serverOut().write(JSON.writeValueAsString(response));
                    wiring.serverOut().write("\n");
                    wiring.serverOut().flush();
                }
            } catch (Throwable thrown) {
                failure.set(thrown);
            }
        }, "scripted-mcp-server");
        thread.setDaemon(true);
        return thread;
    }
}
