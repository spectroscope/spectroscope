package dev.spectroscope.core.mcp;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The shipped user guide against the transport it describes. Chapter 18 stated
 * this defect's <i>absence</i> as a feature three times while card 221 was open:
 * a broken entry "never takes the harness down", a dead server "never crashes the
 * harness", a timeout that "poisons the transport and degrades". All three were
 * true of a command that does not exist and false of one that starts and goes
 * mute, which parked every face forever.
 *
 * <p>Same shape as {@code WireDocDriftTest}: the sentence and the constant live in
 * files that cannot import each other, so the only way to keep them together is a
 * test that goes and looks. The number in particular — a bound restated in prose
 * is exactly the kind of remembered number this house has watched drift.
 */
class McpGuideDriftTest {

    private static final Path CHAPTER = Path.of("docs/guide-assets/parts/12-providers-senses.html");

    @Test
    void theMcpChapterPrintsTheBoundTheTransportActuallyEnforces() throws IOException {
        String chapter = mcpChapter();
        assumeTrue(chapter != null, "not running from a source checkout");

        long seconds = StdioTransport.DEFAULT_READ_TIMEOUT.toSeconds();
        long millis = StdioTransport.DEFAULT_READ_TIMEOUT.toMillis();

        assertTrue(chapter.contains(seconds + "-second"),
                "chapter 18 no longer prints the " + seconds + "-second bound the transport enforces");
        assertTrue(chapter.contains(millis + " ms"),
                "chapter 18 shows a failure line that does not carry the " + millis
                        + " ms the transport waits");
    }

    @Test
    void theMcpChapterDoesNotPromiseBoundedFailureWithoutNamingWhatBoundsIt() throws IOException {
        String chapter = mcpChapter();
        assumeTrue(chapter != null, "not running from a source checkout");

        // The promise is only honest because poisoning destroys the child. A chapter
        // that keeps the promise and drops the mechanism is back where card 221 found it.
        assertTrue(chapter.contains("destroys the server process"),
                "chapter 18 promises a dead server degrades without saying that poisoning"
                        + " destroys the child, which is the only reason it does");
        assertTrue(chapter.contains("the read returns"),
                "chapter 18 no longer explains why killing the child is what releases the read");
    }

    @Test
    void theSequenceCaptionSaysThePoisonKillsTheChildFirst() throws IOException {
        String chapter = mcpChapter();
        assumeTrue(chapter != null, "not running from a source checkout");

        String caption = chapter.lines()
                .filter(line -> line.contains("MERMAID:08-mcp-seq"))
                .findFirst().orElseThrow(() ->
                        new AssertionError("the MCP sequence diagram is gone from chapter 18"));

        assertTrue(caption.contains("destroys the child process"),
                "the diagram caption still describes the poison as the place it deadlocked: " + caption);
        assertFalse(caption.contains("poisons the transport and degrades to an ERROR string —"),
                "the caption is verbatim the pre-fix sentence card 221 corrected: " + caption);
    }

    /**
     * Chapter 18 of the guide source — the parts, not a built edition: the parts are
     * what the generator reads and what the next rebuild will publish.
     *
     * @return the chapter text, or {@code null} when not run from a checkout
     */
    private static String mcpChapter() throws IOException {
        Path root = repoRoot();
        if (root == null || !Files.isRegularFile(root.resolve(CHAPTER))) {
            return null;
        }
        String part = Files.readString(root.resolve(CHAPTER));
        int start = part.indexOf("id=\"ch-mcp\"");
        int end = part.indexOf("data-ch=\"19\"");
        if (start < 0) {
            throw new AssertionError("chapter 18 (MCP) is gone from " + CHAPTER);
        }
        return end > start ? part.substring(start, end) : part.substring(start);
    }

    /** Walks up to the directory holding the Gradle settings file. */
    private static Path repoRoot() {
        for (Path candidate = Path.of("").toAbsolutePath();
                candidate != null; candidate = candidate.getParent()) {
            if (Files.isRegularFile(candidate.resolve("settings.gradle.kts"))) {
                return candidate;
            }
        }
        return null;
    }
}
