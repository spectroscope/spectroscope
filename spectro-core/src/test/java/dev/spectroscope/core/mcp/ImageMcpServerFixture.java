package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.ByteArrayOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * A real, standalone MCP server that answers with a real image — the far end of
 * {@link McpImageRealProcessTest}. It is a {@code main} of its own: the test
 * spawns it with {@code java -cp …}, so the harness talks to a separate operating
 * system process over real pipes, exactly as it talks to any server a user
 * configures. Nothing here imports the harness.
 *
 * <p>It speaks MCP 2024-11-05 over stdio: {@code initialize},
 * {@code notifications/initialized} (no reply), {@code tools/list} and
 * {@code tools/call}. It writes a line to <b>stderr</b> on every request on
 * purpose — a server's chatter must never corrupt the JSON-RPC stdout.
 *
 * <p>{@code args[0]} picks what {@code screenshot} answers with:
 * <ul>
 *   <li>{@code shot} (default) — text, a real PNG, text</li>
 *   <li>{@code oversize} — one image far past the harness's cap</li>
 *   <li>{@code text} — text only, the shape that must not have changed</li>
 * </ul>
 */
public final class ImageMcpServerFixture {

    private static final ObjectMapper JSON = new ObjectMapper();

    private ImageMcpServerFixture() {
    }

    /**
     * Serves the stdio loop until stdin closes.
     *
     * @param args {@code args[0]} selects the reply mode; missing means {@code shot}
     * @throws Exception when stdio itself fails — the process then dies, which is the honest signal
     */
    public static void main(String[] args) throws Exception {
        String mode = args.length > 0 ? args[0] : "shot";
        BufferedReader in = new BufferedReader(
                new InputStreamReader(System.in, StandardCharsets.UTF_8));
        BufferedWriter out = new BufferedWriter(
                new OutputStreamWriter(System.out, StandardCharsets.UTF_8));

        String line;
        while ((line = in.readLine()) != null) {
            JsonNode request = JSON.readTree(line);
            String method = request.path("method").asText();
            // Deliberate stderr noise: it must not reach the protocol stream.
            System.err.println("fixture saw " + method);
            JsonNode id = request.get("id");
            if (id == null || id.isNull()) {
                continue; // a notification takes no reply
            }
            ObjectNode response = JSON.createObjectNode();
            response.put("jsonrpc", "2.0");
            response.set("id", id);
            response.set("result", resultFor(method, mode));
            out.write(JSON.writeValueAsString(response));
            out.write("\n");
            out.flush();
        }
    }

    /**
     * The result member for one method.
     *
     * @param method the JSON-RPC method asked for
     * @param mode   what {@code tools/call} should answer with
     * @return the result node, empty for anything unknown
     */
    private static JsonNode resultFor(String method, String mode) throws Exception {
        return switch (method) {
            case "initialize" -> {
                ObjectNode result = JSON.createObjectNode();
                result.put("protocolVersion", "2024-11-05");
                result.set("serverInfo", JSON.createObjectNode()
                        .put("name", "shots").put("version", "1.0"));
                result.set("capabilities", JSON.createObjectNode()
                        .set("tools", JSON.createObjectNode()));
                yield result;
            }
            case "tools/list" -> {
                ObjectNode tool = JSON.createObjectNode();
                tool.put("name", "screenshot");
                tool.put("description", "Takes a screenshot and returns it as an image.");
                tool.set("inputSchema", JSON.createObjectNode().put("type", "object"));
                ObjectNode result = JSON.createObjectNode();
                result.set("tools", JSON.createArrayNode().add(tool));
                yield result;
            }
            case "tools/call" -> {
                ObjectNode result = JSON.createObjectNode();
                result.set("content", contentFor(mode));
                yield result;
            }
            default -> JSON.createObjectNode();
        };
    }

    /**
     * The content array of a {@code tools/call} reply.
     *
     * @param mode the reply mode chosen on the command line
     * @return text/image blocks in the order a server would send them
     */
    private static ArrayNode contentFor(String mode) throws Exception {
        ArrayNode content = JSON.createArrayNode();
        switch (mode) {
            case "text" -> content.add(text("the page title is Spectroscope"));
            case "oversize" -> {
                // 6 MB of zero bytes, encoded: past any sane per-image cap.
                String big = Base64.getEncoder().encodeToString(new byte[6 * 1024 * 1024]);
                content.add(image(big));
            }
            default -> {
                content.add(text("the page title is Spectroscope"));
                content.add(image(Base64.getEncoder().encodeToString(realPng())));
                content.add(text("the screenshot is 8x8 and red"));
            }
        }
        return content;
    }

    /** A {@code text} block. */
    private static ObjectNode text(String value) {
        return JSON.createObjectNode().put("type", "text").put("text", value);
    }

    /** An {@code image} block in the 2024-11-05 shape. */
    private static ObjectNode image(String dataBase64) {
        return JSON.createObjectNode()
                .put("type", "image").put("data", dataBase64).put("mimeType", "image/png");
    }

    /** A genuine 8x8 red PNG, encoded by the JDK's own writer. */
    private static byte[] realPng() throws Exception {
        BufferedImage image = new BufferedImage(8, 8, BufferedImage.TYPE_INT_RGB);
        for (int x = 0; x < 8; x++) {
            for (int y = 0; y < 8; y++) {
                image.setRGB(x, y, 0xFF0000);
            }
        }
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        ImageIO.write(image, "png", bytes);
        return bytes.toByteArray();
    }
}
