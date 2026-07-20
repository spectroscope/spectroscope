package dev.spectroscope.core.image;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.Tool.ToolContext;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.function.Supplier;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The generate_image tool against a fake provider — no HTTP at all. Proves the
 * happy path (result string, stored file, exactly one image_generated event with
 * the loop-injected ids), the never-throw error paths, and that failed calls emit
 * no event.
 */
class GenerateImageToolTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final byte[] FAKE_BYTES = "fake image bytes".getBytes(StandardCharsets.UTF_8);

    @TempDir
    Path dir;

    private final List<RunEvent> events = new ArrayList<>();

    /** A provider that answers instantly from memory — the image API is not under test here. */
    private record FakeImageProvider(byte[] bytes, String mediaType) implements ImageProvider {
        @Override
        public Generated generate(String prompt) {
            return new Generated(bytes, mediaType);
        }

        @Override
        public String providerName() {
            return "gemini";
        }

        @Override
        public String model() {
            return "gemini-2.5-flash-image";
        }
    }

    private ToolContext context() {
        return new ToolContext(dir, new CancelSignal(), "a7", "c42", events::add);
    }

    private Tool tool(Supplier<ImageProvider> provider) {
        return new GenerateImageTool(provider, new ImageStore(dir.resolve("images")));
    }

    private static JsonNode promptInput(String prompt) {
        return JSON.createObjectNode().put("prompt", prompt);
    }

    private static String sha256Of(byte[] bytes) throws NoSuchAlgorithmException {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    @Test
    void generatesStoresAndEmitsExactlyOneEvent() throws Exception {
        Tool tool = tool(() -> new FakeImageProvider(FAKE_BYTES, "image/png"));
        String expectedSha = sha256Of(FAKE_BYTES);

        String result = tool.execute(promptInput("a coral diamond"), context());

        assertTrue(result.startsWith("Image generated with gemini (gemini-2.5-flash-image): "),
                "unexpected result: " + result);
        assertTrue(result.contains("images/" + expectedSha + ".png"));
        assertTrue(result.contains("The user sees it in the gallery panel."));
        assertTrue(Files.exists(dir.resolve("images").resolve(expectedSha + ".png")),
                "the bytes must land in the content-addressed store");

        assertEquals(1, events.size(), "exactly one image_generated event");
        RunEvent.ImageGenerated event = assertInstanceOf(RunEvent.ImageGenerated.class, events.getFirst());
        assertEquals("a7", event.agentId(), "the loop-injected agent id travels into the event");
        assertEquals("c42", event.callId(), "the loop-injected call id travels into the event");
        assertEquals("a coral diamond", event.prompt());
        assertEquals("gemini", event.provider());
        assertEquals("gemini-2.5-flash-image", event.model());
        assertEquals("image/png", event.mediaType());
        assertEquals(expectedSha, event.sha256());
        assertEquals("images/" + expectedSha + ".png", event.blobPath());
    }

    @Test
    void aBlankPromptIsRejectedWithoutAnEvent() {
        Tool tool = tool(() -> new FakeImageProvider(FAKE_BYTES, "image/png"));

        assertEquals("ERROR: generate_image needs a non-empty prompt.",
                tool.execute(promptInput("   "), context()));
        assertEquals("ERROR: generate_image needs a non-empty prompt.",
                tool.execute(JSON.createObjectNode(), context()), "a missing prompt counts as blank");
        assertTrue(events.isEmpty(), "failed calls emit no event");
    }

    @Test
    void aFailingProviderBecomesAnErrorStringWithoutAnEvent() {
        Tool tool = tool(() -> new ImageProvider() {
            @Override
            public Generated generate(String prompt) {
                throw new RuntimeException("Gemini HTTP 400");
            }

            @Override
            public String providerName() {
                return "gemini";
            }

            @Override
            public String model() {
                return "gemini-2.5-flash-image";
            }
        });

        assertEquals("ERROR: image generation failed: Gemini HTTP 400",
                tool.execute(promptInput("anything"), context()));
        assertTrue(events.isEmpty(), "failed calls emit no event");
    }

    @Test
    void aMissingKeyFromTheSupplierNamesTheVariable() {
        Tool tool = tool(() -> {
            throw new IllegalStateException(
                    "GEMINI_API_KEY is not set — the gemini image provider needs it (./.env is the usual place).");
        });

        String result = tool.execute(promptInput("anything"), context());

        assertTrue(result.startsWith("ERROR: "), "never throw out of a tool");
        assertTrue(result.contains("GEMINI_API_KEY"),
                "the model-visible error must name the env variable, got: " + result);
        assertTrue(events.isEmpty(), "failed calls emit no event");
    }
}
