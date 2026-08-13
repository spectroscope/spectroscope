package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.image.ImageStore;
import dev.spectroscope.core.tools.Tool;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PipedReader;
import java.io.PipedWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
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
    void anEmptyLeadingTextBlockKeepsTodaysQuirkyJoin() throws Exception {
        // Today's joiner only inserts a separator once something is in the buffer,
        // so a leading empty block leaves no blank line. Small, but it is behaviour
        // a text-only result has today and must still have tomorrow.
        ArrayNode content = JSON.createArrayNode();
        content.add(textBlock(""));
        content.add(textBlock("alpha"));

        assertEquals("alpha", call(content).output());
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

    // ---- the image path (card 198, written red first) --------------------------------

    @Test
    void anImageBlockReachesTheModelAsAnAttachedImageAndAStoredBlob(@TempDir Path storeDir)
            throws Exception {
        byte[] png = onePixelPng();
        String base64 = Base64.getEncoder().encodeToString(png);
        ArrayNode content = JSON.createArrayNode();
        content.add(imageBlock("image/png", base64));

        Called called = call(content, storeDir);

        List<Tool.AttachedImage> images = called.attachments().stream()
                .filter(Tool.AttachedImage.class::isInstance)
                .map(Tool.AttachedImage.class::cast).toList();
        assertEquals(1, images.size(), "the image rides the attach path, got: " + called.output());
        assertEquals("image/png", images.getFirst().mediaType());
        assertEquals(base64, images.getFirst().dataBase64());

        assertFalse(called.output().contains(base64),
                "the payload must never sit in the text the model reads");

        List<RunEvent.ImageGenerated> generated = called.events().stream()
                .filter(RunEvent.ImageGenerated.class::isInstance)
                .map(RunEvent.ImageGenerated.class::cast).toList();
        assertEquals(1, generated.size(), "the run carries one image_generated reference event");
        assertEquals("mcp", generated.getFirst().provider());
        assertEquals("shots", generated.getFirst().model());
        assertEquals("mcp__shots__screenshot", generated.getFirst().prompt());
        assertEquals("call-1", generated.getFirst().callId());
        assertEquals("image/png", generated.getFirst().mediaType());

        String sha = generated.getFirst().sha256();
        assertEquals("images/" + sha + ".png", generated.getFirst().blobPath(),
                "the event carries the reference, not the bytes");
        Path blob = storeDir.resolve(sha + ".png");
        assertTrue(Files.exists(blob), "the bytes land in the image store at " + blob);
        assertArrayEquals(png, Files.readAllBytes(blob), "the stored blob is the server's image");
    }

    @Test
    void mixedContentKeepsTheOrderTheServerSent(@TempDir Path storeDir) throws Exception {
        String base64 = Base64.getEncoder().encodeToString(onePixelPng());
        ArrayNode content = JSON.createArrayNode();
        content.add(textBlock("before the shot"));
        content.add(imageBlock("image/png", base64));
        content.add(textBlock("after the shot"));

        Called called = call(content, storeDir);
        String output = called.output();

        int before = output.indexOf("before the shot");
        int marker = output.indexOf("image 1");
        int after = output.indexOf("after the shot");
        assertTrue(before >= 0 && marker >= 0 && after >= 0,
                "all three blocks are represented, got: " + output);
        assertTrue(before < marker && marker < after,
                "text, image, text arrives in that order, got: " + output);
        assertEquals(1, called.attachments().size(), "exactly one image rides along");
    }

    @Test
    void anImageOverTheCapIsRefusedNamingTheSizeAndTheCap(@TempDir Path storeDir) throws Exception {
        // One byte over the cap, as plain 'A's: valid base64 characters, so the
        // refusal cannot be an accident of undecodable input.
        long oversize = McpTool.MAX_IMAGE_BYTES + 1;
        ArrayNode content = JSON.createArrayNode();
        content.add(imageBlock("image/png", "A".repeat((int) ((oversize + 2) / 3 * 4))));

        Called called = call(content, storeDir);

        assertTrue(called.attachments().isEmpty(), "an oversized image is not attached");
        assertTrue(called.events().isEmpty(), "an unattached image is not announced");
        assertTrue(isEmptyDirectory(storeDir), "an oversized image never reaches the store");
        assertTrue(called.output().contains(String.valueOf(McpTool.MAX_IMAGE_BYTES)),
                "the notice names the cap, got: " + called.output());
        assertTrue(called.output().contains(String.valueOf(oversize)),
                "the notice names the actual size, got: " + called.output());
        assertEquals(1, called.output().lines().count(),
                "the notice is one line, got: " + called.output());
    }

    @Test
    void theCapIsCheckedBeforeTheBase64IsDecoded(@TempDir Path storeDir) throws Exception {
        // '%' is not a base64 character: any implementation that decoded first
        // would fail here instead of refusing on size.
        long oversize = McpTool.MAX_IMAGE_BYTES + 1;
        ArrayNode content = JSON.createArrayNode();
        content.add(imageBlock("image/png", "%".repeat((int) ((oversize + 2) / 3 * 4))));

        Called called = call(content, storeDir);

        assertTrue(called.output().contains(String.valueOf(McpTool.MAX_IMAGE_BYTES)),
                "size is decided on the encoded length, before any decode, got: " + called.output());
        assertTrue(called.attachments().isEmpty());
        assertTrue(isEmptyDirectory(storeDir));
    }

    @Test
    void twoImagesInOneReplyBothLandAndKeepTheirNumbering(@TempDir Path storeDir) throws Exception {
        String first = Base64.getEncoder().encodeToString(onePixelPng());
        String second = Base64.getEncoder().encodeToString(twoPixelPng());
        ArrayNode content = JSON.createArrayNode();
        content.add(imageBlock("image/png", first));
        content.add(textBlock("between the shots"));
        content.add(imageBlock("image/png", second));

        Called called = call(content, storeDir);

        assertEquals(2, called.attachments().size(), "both images ride along");
        assertEquals(2, called.events().size(), "both are announced");
        assertTrue(called.output().indexOf("image 1") < called.output().indexOf("between the shots"),
                "the first marker sits where the first image sat, got: " + called.output());
        assertTrue(called.output().indexOf("between the shots") < called.output().indexOf("image 2"),
                "the second marker sits where the second image sat, got: " + called.output());
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
        return call(content, null);
    }

    /**
     * As {@link #call(ArrayNode)}, with an explicit image store directory so a test
     * can watch the blobs land.
     *
     * @param content  the {@code content} array the server answers {@code tools/call} with
     * @param storeDir directory the tool's image store writes to, {@code null} for the default
     * @return the model-facing output, the attachments, and the emitted events
     */
    private static Called call(ArrayNode content, Path storeDir) throws Exception {
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
            McpToolDescriptor descriptor = client.tools().getFirst();
            McpTool tool = storeDir == null
                    ? new McpTool("shots", client, descriptor)
                    : new McpTool("shots", client, descriptor, new ImageStore(storeDir));
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

    /** A real one-pixel PNG, encoded by the JDK — the servers send real bytes, so do we. */
    private static byte[] onePixelPng() throws IOException {
        return pngOf(1, 1);
    }

    /** A second, different real PNG so two images in one reply cannot be confused. */
    private static byte[] twoPixelPng() throws IOException {
        return pngOf(2, 1);
    }

    private static byte[] pngOf(int width, int height) throws IOException {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        image.setRGB(0, 0, 0xFF0000);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        ImageIO.write(image, "png", bytes);
        return bytes.toByteArray();
    }

    /** True when the directory holds no files — it may not exist at all. */
    private static boolean isEmptyDirectory(Path dir) throws IOException {
        if (!Files.isDirectory(dir)) {
            return true;
        }
        try (var entries = Files.list(dir)) {
            return entries.findAny().isEmpty();
        }
    }

    /** An {@code image} content block, the MCP 2024-11-05 shape. */
    private static ObjectNode imageBlock(String mimeType, String dataBase64) {
        ObjectNode block = JSON.createObjectNode();
        block.put("type", "image");
        block.put("data", dataBase64);
        block.put("mimeType", mimeType);
        return block;
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
