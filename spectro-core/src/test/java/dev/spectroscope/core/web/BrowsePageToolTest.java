package dev.spectroscope.core.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.Tool.ToolContext;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * browse_page against a scripted Chrome seam — no browser, no network. Proves
 * the argv shape (headless dump-dom, URL last, never through a shell), the
 * DOM→text reduction, the honest missing-Chrome hint, the bad-scheme guard
 * (file:// must never reach a browser), the timeout / non-zero-exit / spawn-
 * failure ERROR paths, the SPECTRO_CHROME override, and the permission flag.
 */
class BrowsePageToolTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static ToolContext context() {
        return new ToolContext(Path.of("."), new CancelSignal());
    }

    private static JsonNode urlInput(String url) {
        return JSON.createObjectNode().put("url", url);
    }

    /** A scripted runner: records the argv, answers the canned result. */
    private static BrowsePageTool.ChromeRunner scripted(
            BrowsePageTool.ChromeRunner.Result result, AtomicReference<List<String>> seenArgv) {
        return (argv, timeoutSeconds, signal) -> {
            seenArgv.set(argv);
            return result;
        };
    }

    private static BrowsePageTool.ChromeRunner.Result ok(String dom) {
        return new BrowsePageTool.ChromeRunner.Result(0, dom, "", false, null);
    }

    @Test
    void rendersTheDumpedDomAsReadableTextWithHeadlessArgv() {
        AtomicReference<List<String>> argv = new AtomicReference<>();
        Tool tool = new BrowsePageTool(() -> Optional.of(Path.of("/fake/chrome")),
                scripted(ok("<html><script>spa()</script><p>Rendered <b>content</b></p></html>"), argv));

        String result = tool.execute(urlInput("https://spa.example/app"), context());

        assertEquals("Rendered content", result);
        List<String> seen = argv.get();
        assertEquals("/fake/chrome", seen.get(0), "the located binary leads the argv");
        assertTrue(seen.contains("--headless"), "headless mode, got: " + seen);
        assertTrue(seen.contains("--dump-dom"), "dump-dom, got: " + seen);
        assertEquals("https://spa.example/app", seen.get(seen.size() - 1), "URL is the last arg");
    }

    @Test
    void missingChromeIsAReadableErrorNamingTheOverride() {
        Tool tool = new BrowsePageTool(Optional::empty,
                scripted(ok("unused"), new AtomicReference<>()));

        String result = tool.execute(urlInput("https://x.example"), context());

        assertTrue(result.startsWith("ERROR: "), "got: " + result);
        assertTrue(result.contains("SPECTRO_CHROME"), "names the override, got: " + result);
    }

    @Test
    void rejectsNonHttpSchemesWithoutTouchingChrome() {
        AtomicReference<List<String>> argv = new AtomicReference<>();
        Tool tool = new BrowsePageTool(() -> Optional.of(Path.of("/fake/chrome")),
                scripted(ok("unused"), argv));

        String result = tool.execute(urlInput("file:///etc/passwd"), context());

        assertEquals("ERROR: browse_page only supports http and https URLs.", result);
        assertNull(argv.get(), "chrome must never be invoked for a non-http scheme");
    }

    @Test
    void timeoutBecomesAReadableError() {
        Tool tool = new BrowsePageTool(() -> Optional.of(Path.of("/fake/chrome")),
                scripted(new BrowsePageTool.ChromeRunner.Result(-1, "", "", true, null),
                        new AtomicReference<>()));

        String result = tool.execute(urlInput("https://slow.example"), context());

        assertTrue(result.startsWith("ERROR: browse_page timed out"), "got: " + result);
    }

    @Test
    void nonZeroExitSurfacesTheStderrTail() {
        Tool tool = new BrowsePageTool(() -> Optional.of(Path.of("/fake/chrome")),
                scripted(new BrowsePageTool.ChromeRunner.Result(1, "",
                        "[ERROR] something bad happened", false, null), new AtomicReference<>()));

        String result = tool.execute(urlInput("https://x.example"), context());

        assertTrue(result.contains("exit code 1"), "got: " + result);
        assertTrue(result.contains("something bad happened"), "got: " + result);
    }

    @Test
    void aSpawnFailureBecomesAnErrorStringNeverAnException() {
        Tool tool = new BrowsePageTool(() -> Optional.of(Path.of("/fake/chrome")),
                scripted(new BrowsePageTool.ChromeRunner.Result(-1, "", "", false,
                        "Cannot run program"), new AtomicReference<>()));

        String result = tool.execute(urlInput("https://x.example"), context());

        assertTrue(result.startsWith("ERROR: browse_page failed: Cannot run program"),
                "got: " + result);
    }

    @Test
    void aBlankDomBecomesNoReadableText() {
        Tool tool = new BrowsePageTool(() -> Optional.of(Path.of("/fake/chrome")),
                scripted(ok("<html><body><script>only()</script></body></html>"),
                        new AtomicReference<>()));

        assertEquals("(no readable text)", tool.execute(urlInput("https://x.example"), context()));
    }

    @Test
    void networkEgressNeedsPermission() {
        assertTrue(new BrowsePageTool(Optional::empty,
                scripted(ok(""), new AtomicReference<>())).needsPermission());
    }

    @Test
    void findChromeHonorsTheSpectroChromeOverride(@TempDir Path dir) throws IOException {
        Path fakeBinary = dir.resolve("my-chrome");
        Files.writeString(fakeBinary, "#!/bin/sh\n");
        Files.setPosixFilePermissions(fakeBinary, Set.of(
                PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_EXECUTE));

        Optional<Path> found = BrowsePageTool.findChrome(
                Map.of("SPECTRO_CHROME", fakeBinary.toString()));

        assertEquals(Optional.of(fakeBinary), found);
    }

    @Test
    void aNonExecutableOverrideIsIgnored(@TempDir Path dir) throws IOException {
        Path notExecutable = dir.resolve("chrome.txt");
        Files.writeString(notExecutable, "not a binary");

        // The override must not win when it cannot run; whatever the machine
        // otherwise finds (a real Chrome or nothing) must not be THIS path.
        Optional<Path> found = BrowsePageTool.findChrome(
                Map.of("SPECTRO_CHROME", notExecutable.toString()));

        assertTrue(found.isEmpty() || !found.get().equals(notExecutable),
                "a non-executable override must be ignored, got: " + found);
    }
}
