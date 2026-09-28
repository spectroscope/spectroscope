package dev.spectroscope.cli;

import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Card 448, criterion 4: spectro doctor says what the transcript says when it
 * probes a SearXNG instance that serves HTML only.
 *
 * <p>The probe is {@code GET /search?format=json} without a query. Measured on
 * 2026-09-26 against the public image: a stock instance (json not listed under
 * {@code search.formats}) answers it 403 on releases 2025.3.19, 2026.8.12 and
 * 2026.9.25; the same 2026.8.12 container with json added answers 400 ("No
 * query"). Without a query the instance searches nothing, so the probe costs
 * no engine a request.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class DoctorSearxngProbeTest {

    private static final String DICT = "spectro-web/src/i18n/i18n.ts";

    private HttpServer server;
    private final List<String> seen = new CopyOnWriteArrayList<>();

    @AfterEach
    void stop() throws IOException {
        if (server != null) {
            server.stop(0);
        }
        Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
    }

    /** An instance that answers every request with one status. */
    private String instance(int status) throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            seen.add(exchange.getRequestURI().getPath() + "?" + exchange.getRequestURI().getQuery());
            byte[] body = "<html></html>".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(status, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        server.start();
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private static String doctorWith(String searxngUrl) throws IOException {
        // The environment layer outranks the settings file; a shell that
        // exports its own instance would make this test about that one.
        assumeTrue(System.getenv("SPECTRO_SEARXNG_URL") == null, "SPECTRO_SEARXNG_URL is exported");
        Files.createDirectories(SpectroConfig.USER_SETTINGS_PATH.getParent());
        Files.writeString(SpectroConfig.USER_SETTINGS_PATH, "{\"searxngUrl\":\"" + searxngUrl + "\"}");
        PrintStream original = System.out;
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        System.setOut(new PrintStream(buffer, true, StandardCharsets.UTF_8));
        try {
            new DoctorCommand().call();
        } finally {
            System.setOut(original);
        }
        return buffer.toString(StandardCharsets.UTF_8);
    }

    /** The transcript's English line, as the web app's dictionary holds it. */
    private static String transcriptLine() throws IOException {
        String dict = Files.readString(repoRoot().resolve(DICT), StandardCharsets.UTF_8);
        Matcher m = Pattern.compile("\"info\\.searxngHtmlOnly\":\\s*\\{\\s*"
                        + "de:\\s*\"((?:[^\"\\\\]|\\\\.)*)\",\\s*en:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"",
                Pattern.DOTALL).matcher(dict);
        assertTrue(m.find(), "no info.searxngHtmlOnly entry with a de/en pair in " + DICT);
        return m.group(2).replace("\\\"", "\"").replace("\\\\", "\\");
    }

    @Test
    void aStockInstanceGetsTheTranscriptsLineFromTheDoctor() throws IOException {
        String address = instance(403);

        String out = doctorWith(address);

        String expected = "web search: " + transcriptLine().replace("{addr}", address);
        assertTrue(out.contains(expected), "expected\n  " + expected + "\nin\n" + out);
        assertTrue(seen.contains("/search?format=json"),
                "the probe asks for JSON and no query, got: " + seen);
    }

    @Test
    void anInstanceThatServesJsonGetsNoSuchLine() throws IOException {
        String address = instance(400);

        String out = doctorWith(address);

        assertTrue(out.contains("web search: searxng"), "the tier line is still there, got:\n" + out);
        assertTrue(seen.contains("/search?format=json"), "the instance was probed, got: " + seen);
        assertFalse(out.contains("serves HTML only"), "got:\n" + out);
    }

    @Test
    void onlyARefusalOfJsonAddsTheLine() {
        assertEquals(List.of(new DoctorCommand.Line(DoctorCommand.Kind.INFO,
                        "web search: " + DoctorCommand.SEARXNG_HTML_ONLY.replace("{addr}", "http://box.local:8888"))),
                DoctorCommand.searxngProbeLines("http://box.local:8888", 403));
        for (int status : new int[] {0, 200, 400, 429, 500}) {
            assertEquals(List.of(), DoctorCommand.searxngProbeLines("http://box.local:8888", status),
                    "status " + status);
        }
    }

    @Test
    void theDoctorSentenceIsTheTranscriptsEnglishLine() throws IOException {
        assertEquals(transcriptLine(), DoctorCommand.SEARXNG_HTML_ONLY,
                "spectro doctor and the transcript say the same, in the same words. "
                        + "Change " + DICT + " (info.searxngHtmlOnly, en) and DoctorCommand together.");
    }

    @Test
    void theProbeAddressDropsATrailingSlash() {
        assertEquals("http://box.local:8888/search?format=json",
                DoctorCommand.searxngProbeUrl("http://box.local:8888/"));
    }

    private static Path repoRoot() {
        Path here = Path.of("").toAbsolutePath();
        while (here != null && !Files.exists(here.resolve("settings.gradle.kts"))) {
            here = here.getParent();
        }
        return here == null ? Path.of("").toAbsolutePath() : here;
    }
}
