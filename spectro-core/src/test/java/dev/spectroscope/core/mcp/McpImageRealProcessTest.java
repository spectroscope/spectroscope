package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.annotation.JsonInclude;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.image.ImageStore;
import dev.spectroscope.core.tools.Tool;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.File;
import java.net.URISyntaxException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The integration proof card 198 asked for: a <b>real image-returning MCP
 * server</b>, spawned as its own operating system process, answering over real
 * pipes — no fake transport, no in-JVM shortcut. The server is
 * {@link ImageMcpServerFixture}, launched with {@code java -cp …} the way
 * {@code StdioTransport} launches any configured server.
 *
 * <p>What this covers that the piped tests cannot: {@link ProcessBuilder} spawn,
 * the stderr redirect (the fixture writes to stderr on every request and must not
 * corrupt stdout), a real handshake, and a real base64 image crossing a real pipe
 * into the image store.
 */
class McpImageRealProcessTest {

    @Test
    void aRealServerProcessHandsAScreenshotToTheModelAsAnImage(@TempDir Path storeDir)
            throws Exception {
        List<String> command = fixtureCommand("shot");
        assumeTrue(command != null, "cannot locate the fixture classpath; skipping");

        Called called = callThrough(command, storeDir);

        List<Tool.AttachedImage> images = called.attachments().stream()
                .filter(Tool.AttachedImage.class::isInstance)
                .map(Tool.AttachedImage.class::cast).toList();
        assertEquals(1, images.size(), "the screenshot rides the attach path, got: " + called.output());
        assertEquals("image/png", images.getFirst().mediaType());

        // The order the server sent: text, image, text.
        int first = called.output().indexOf("the page title is Spectroscope");
        int marker = called.output().indexOf("image 1");
        int last = called.output().indexOf("the screenshot is 8x8 and red");
        assertTrue(first >= 0 && marker >= 0 && last >= 0, called.output());
        assertTrue(first < marker && marker < last, "in order, got: " + called.output());
        assertFalse(called.output().contains(images.getFirst().dataBase64()),
                "the payload never enters the text the model reads");

        List<RunEvent.ImageGenerated> generated = called.events().stream()
                .filter(RunEvent.ImageGenerated.class::isInstance)
                .map(RunEvent.ImageGenerated.class::cast).toList();
        assertEquals(1, generated.size());
        String sha = generated.getFirst().sha256();
        Path blob = storeDir.resolve(sha + ".png");
        assertTrue(Files.exists(blob), "the bytes are in the store at " + blob);
        assertEquals("images/" + sha + ".png", generated.getFirst().blobPath(),
                "this is the path /api/images/{file} serves");

        // The stored blob is a PNG the JDK can read back — a real image, not a blob of hope.
        byte[] stored = Files.readAllBytes(blob);
        assertArrayEquals(new byte[] {(byte) 0x89, 'P', 'N', 'G'},
                java.util.Arrays.copyOf(stored, 4), "the store holds PNG bytes");
        assertEquals(8, javax.imageio.ImageIO.read(blob.toFile()).getWidth(),
                "the stored image is the 8x8 the server rendered");
    }

    @Test
    void aRealServerCannotBallonTheContextWithAnOversizedImage(@TempDir Path storeDir)
            throws Exception {
        List<String> command = fixtureCommand("oversize");
        assumeTrue(command != null, "cannot locate the fixture classpath; skipping");

        Called called = callThrough(command, storeDir);

        assertTrue(called.attachments().isEmpty(), "6 MB is past the cap; nothing is attached");
        assertTrue(called.events().isEmpty(), "nothing was stored, so nothing is announced");
        assertTrue(called.output().contains(String.valueOf(McpTool.MAX_IMAGE_BYTES)),
                "the refusal names the cap, got: " + called.output());
        assertEquals(6L * 1024 * 1024, sizeInNotice(called.output()),
                "the refusal names the actual size, got: " + called.output());
    }

    @Test
    void aRealServersTextOnlyReplyIsStillJustText(@TempDir Path storeDir) throws Exception {
        List<String> command = fixtureCommand("text");
        assumeTrue(command != null, "cannot locate the fixture classpath; skipping");

        Called called = callThrough(command, storeDir);

        assertEquals("the page title is Spectroscope", called.output());
        assertTrue(called.attachments().isEmpty());
        assertTrue(called.events().isEmpty());
    }

    // ---- the harness ---------------------------------------------------------------

    /** One call's three outputs. */
    private record Called(String output, List<Tool.Attachment> attachments, List<RunEvent> events) {}

    /**
     * Spawns the server, runs one {@code screenshot} call through the production
     * transport, client and tool, then tears the process down.
     *
     * @param command  the fixture's command line
     * @param storeDir where the tool's image store writes
     * @return what the model reads, what rides along, what the run recorded
     */
    private static Called callThrough(List<String> command, Path storeDir) {
        McpServerConfig config = new McpServerConfig(
                "shots", command.getFirst(), command.subList(1, command.size()),
                null, null, null);
        McpClient client = new McpClient(config,
                () -> new StdioTransport(config, null, Duration.ofSeconds(20)),
                Duration.ofSeconds(30));
        List<Tool.Attachment> attachments = new ArrayList<>();
        List<RunEvent> events = new ArrayList<>();
        try {
            client.start();
            assertEquals("screenshot", client.tools().getFirst().name(),
                    "the real server advertised its tool over the real pipe");
            McpTool tool = new McpTool("shots", client, client.tools().getFirst(),
                    new ImageStore(storeDir));
            Tool.ToolContext context = new Tool.ToolContext(
                    Path.of("."), new CancelSignal(), "main", "call-1",
                    events::add, attachments::add);
            String output = tool.execute(new ObjectMapper().createObjectNode(), context);
            return new Called(output, attachments, events);
        } finally {
            client.close();
        }
    }

    /**
     * The command that launches the fixture in its own JVM: this JDK's {@code java},
     * a classpath built from the code sources actually in use (so it works whatever
     * the build hands the test worker), and the fixture's main class.
     *
     * @param mode the reply mode passed to the fixture
     * @return the command line, or {@code null} when a code source cannot be located
     */
    private static List<String> fixtureCommand(String mode) throws URISyntaxException {
        Set<String> classpath = new LinkedHashSet<>();
        for (Class<?> anchor : List.of(ImageMcpServerFixture.class, ObjectMapper.class,
                JsonFactory.class, JsonInclude.class)) {
            var source = anchor.getProtectionDomain().getCodeSource();
            if (source == null || source.getLocation() == null) {
                return null;
            }
            classpath.add(Path.of(source.getLocation().toURI()).toString());
        }
        String java = System.getProperty("java.home") + File.separator + "bin" + File.separator + "java";
        if (!Files.isExecutable(Path.of(java))) {
            return null;
        }
        return List.of(java, "-cp", String.join(File.pathSeparator, classpath),
                ImageMcpServerFixture.class.getName(), mode);
    }

    /** Pulls the byte count out of a refusal notice, or -1 when it names none. */
    private static long sizeInNotice(String notice) {
        var matcher = java.util.regex.Pattern.compile("(\\d+) bytes exceeds").matcher(notice);
        return matcher.find() ? Long.parseLong(matcher.group(1)) : -1;
    }
}
