package dev.spectroscope.core.wire;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.image.GeminiImageOptions;
import dev.spectroscope.core.image.GeminiImageProvider;
import dev.spectroscope.core.image.GenerateImageTool;
import dev.spectroscope.core.image.ImageProvider;
import dev.spectroscope.core.image.ImageStore;
import dev.spectroscope.core.image.OpenAiImageOptions;
import dev.spectroscope.core.image.OpenAiImageProvider;
import dev.spectroscope.core.tools.Tool;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The image half of the llm-wire record (card 184): generate_image calls land
 * on the sidecar as kind "image", the request body is the exact string posted
 * (fidelity "bytes"), and the response JSON rides verbatim, b64_json and
 * inlineData INCLUDED — that is the point of the file. Credential header
 * values never reach the disk; the recorder redacts them.
 */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class ImageWireTapTest {

    /** A real 1x1 PNG — the smallest honest payload for a byte round-trip. */
    private static final byte[] TINY_PNG = Base64.getDecoder().decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==");

    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir
    Path dir;

    private HttpServer server;
    private String baseUrl;
    private final AtomicReference<String> lastBody = new AtomicReference<>();
    private volatile int scriptedStatus = 200;
    private volatile String scriptedJson = "{}";

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        // One handler for both providers; the path decides nothing here.
        server.createContext("/", exchange -> {
            lastBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] body = scriptedJson.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(scriptedStatus, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        server.start();
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void stopServer() {
        server.stop(0);
    }

    private LlmWireRecorder recorder() {
        return new LlmWireRecorder(dir.resolve("session.llm.jsonl"),
                LlmWireRecorder.DEFAULT_CEILING_BYTES);
    }

    /** Reads the sidecar back as parsed JSON lines. */
    private List<JsonNode> fileLines() throws IOException {
        List<JsonNode> lines = new ArrayList<>();
        for (String line : Files.readAllLines(dir.resolve("session.llm.jsonl"))) {
            lines.add(JSON.readTree(line));
        }
        return lines;
    }

    @Test
    void generateImageRecordsTheExchangeAsKindImage() throws IOException {
        scriptedJson = "{\"data\":[{\"b64_json\":\""
                + Base64.getEncoder().encodeToString(TINY_PNG) + "\"}]}";
        ImageProvider provider = new OpenAiImageProvider(
                new OpenAiImageOptions(baseUrl, "test-key", "gpt-image-1"));
        List<RunEvent> events = new ArrayList<>();
        Tool tool = new GenerateImageTool(() -> provider,
                new ImageStore(dir.resolve("images")), recorder());

        String result = tool.execute(JSON.createObjectNode().put("prompt", "a coral diamond"),
                new Tool.ToolContext(dir, new CancelSignal(), "a7", "c42", events::add));

        assertTrue(result.startsWith("Image generated with openai"), "unexpected result: " + result);
        List<JsonNode> lines = fileLines();
        assertEquals(2, lines.size(), "one llm_request line plus one llm_response line");

        JsonNode request = lines.get(0);
        assertEquals("llm_request", request.get("type").asText());
        assertEquals("image", request.get("kind").asText());
        assertEquals("a7", request.get("agentId").asText());
        assertNull(request.get("turn"), "the tool context carries no turn number");
        assertEquals("openai", request.get("provider").asText());
        assertEquals("gpt-image-1", request.get("model").asText());
        assertEquals("http", request.get("transport").asText());
        assertEquals("bytes", request.get("fidelity").asText());
        assertEquals(baseUrl + "/v1/images/generations", request.get("url").asText());
        assertEquals(lastBody.get(), request.get("body").asText(),
                "the recorded body must be the exact string that went over the socket");
        assertTrue(request.get("headers").get("Authorization").asText().startsWith("REDACTED("),
                "the recorder must redact the credential value");

        JsonNode response = lines.get(1);
        assertEquals("llm_response", response.get("type").asText());
        assertEquals(request.get("xid").asText(), response.get("xid").asText());
        assertEquals(200, response.get("status").asInt());
        assertEquals("bytes", response.get("fidelity").asText());
        assertEquals(scriptedJson, response.get("body").asText(),
                "the response JSON rides verbatim, b64_json included");
    }

    @Test
    void geminiRecordsVerbatimInlineDataThroughABoundTap() throws IOException {
        scriptedJson = "{\"candidates\":[{\"content\":{\"parts\":[{\"inlineData\":"
                + "{\"mimeType\":\"image/png\",\"data\":\""
                + Base64.getEncoder().encodeToString(TINY_PNG) + "\"}}]}}]}";
        GeminiImageProvider provider = new GeminiImageProvider(
                new GeminiImageOptions(baseUrl, "test-key", "gemini-2.5-flash-image"));
        LlmWireRecorder recorder = recorder();

        ImageProvider.Generated generated =
                provider.generate("an ebony prism", recorder.bound("main", null, "image"));

        assertArrayEquals(TINY_PNG, generated.bytes());
        List<JsonNode> lines = fileLines();
        assertEquals(2, lines.size());

        JsonNode request = lines.get(0);
        assertEquals("image", request.get("kind").asText());
        assertEquals("gemini", request.get("provider").asText());
        assertEquals(baseUrl + "/v1beta/models/gemini-2.5-flash-image:generateContent",
                request.get("url").asText());
        assertEquals(lastBody.get(), request.get("body").asText());
        assertEquals("an ebony prism", JSON.readTree(request.get("body").asText())
                .get("contents").get(0).get("parts").get(0).get("text").asText());
        assertTrue(request.get("headers").get("x-goog-api-key").asText().startsWith("REDACTED("));

        assertEquals(scriptedJson, lines.get(1).get("body").asText(),
                "the inlineData payload rides verbatim");
    }

    @Test
    void anHttpErrorStillClosesTheExchangeOnTheRecord() throws IOException {
        scriptedStatus = 500;
        scriptedJson = "{\"error\":{\"message\":\"boom\"}}";
        OpenAiImageProvider provider = new OpenAiImageProvider(
                new OpenAiImageOptions(baseUrl, "test-key", "gpt-image-1"));
        LlmWireRecorder recorder = recorder();

        RuntimeException failure = assertThrows(RuntimeException.class,
                () -> provider.generate("anything", recorder.bound("main", null, "image")));

        assertTrue(failure.getMessage().contains("500"),
                "the readable error stays intact, got: " + failure.getMessage());
        List<JsonNode> lines = fileLines();
        assertEquals(2, lines.size(), "a failed call still records request and response");
        JsonNode response = lines.get(1);
        assertEquals(500, response.get("status").asInt());
        assertTrue(response.get("error").asText().contains("500"));
    }
}
