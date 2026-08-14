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
 * test that goes and looks. The numbers in particular — a bound restated in prose
 * is exactly the kind of remembered number this house has watched drift.
 *
 * <p><b>The bound the guide prints is the whole write-off, not the read.</b> The
 * first round of this card pinned the prose to {@link StdioTransport#DEFAULT_READ_TIMEOUT}
 * alone, which held the sentence to the wrong number: what a person waits for is the
 * read <i>plus</i> the shutdown that follows it, and a server ignoring every step of
 * that shutdown was measured at 22.4 s against a printed "20-second budget". A guard
 * that pins prose to a bound narrower than the user-visible one is how a document ends
 * up promising something the code does not keep — which is the defect this card exists
 * to close, one level up.
 *
 * <p>Every assertion runs against whitespace-collapsed text, because the guide source
 * is hand-wrapped and a sentence that happens to break across two lines is not a
 * different sentence.
 */
class McpGuideDriftTest {

    private static final Path CHAPTER = Path.of("docs/guide-assets/parts/12-providers-senses.html");

    private static final Path SEQUENCE_SOURCE = Path.of("docs/guide-assets/mermaid-src/08-mcp-seq.mmd");

    private static final Path WEB_TABS = Path.of("docs/guide-assets/parts/05-web-tabs.html");

    @Test
    void theMcpChapterPrintsTheWholeWriteOffAndNotOnlyTheReadBound() throws IOException {
        String chapter = mcpChapter();
        assumeTrue(chapter != null, "not running from a source checkout");

        long readSeconds = StdioTransport.DEFAULT_READ_TIMEOUT.toSeconds();
        long readMillis = StdioTransport.DEFAULT_READ_TIMEOUT.toMillis();
        long tailSeconds = StdioTransport.TEARDOWN_TAIL.toSeconds();
        long budgetSeconds = StdioTransport.WRITE_OFF_BUDGET.toSeconds();

        assertTrue(chapter.contains(readSeconds + "-second"),
                "chapter 18 no longer prints the " + readSeconds + "-second read bound the"
                        + " transport enforces");
        assertTrue(chapter.contains(readMillis + " ms"),
                "chapter 18 shows a failure line that does not carry the " + readMillis
                        + " ms the transport waits");
        assertTrue(chapter.contains(tailSeconds + " more seconds"),
                "chapter 18 prints the read bound without the " + tailSeconds + "-second"
                        + " shutdown tail that follows it — which is how the guide came to promise"
                        + " a bound a TERM-ignoring server measured 22.4 s against");
        assertTrue(chapter.contains(budgetSeconds + " seconds"),
                "chapter 18 no longer names " + budgetSeconds + " seconds as the worst a silent"
                        + " server can cost, which is the only number a person actually waits");
    }

    @Test
    void theMcpChapterSaysTheServerGetsEndOfStreamBeforeAnythingSignalsIt() throws IOException {
        String chapter = mcpChapter();
        assumeTrue(chapter != null, "not running from a source checkout");

        // The polite half of the MCP stdio shutdown sequence. It went missing once
        // already, under a fix that was right about everything else: the destroy ran
        // first and the child was dead before its stdin was ever closed, so a server
        // that flushes on end-of-stream never got to, and one that logs SIGTERM as
        // abnormal logged every clean disconnect that way.
        int stdin = chapter.indexOf("closes the server's stdin");
        int destroy = chapter.indexOf("destroy the server process");
        assertTrue(stdin >= 0,
                "chapter 18 no longer says the server's stdin is closed, which is the only"
                        + " end-of-stream an MCP server ever gets");
        assertTrue(destroy >= 0,
                "chapter 18 no longer says the server process is destroyed");
        assertTrue(stdin < destroy,
                "chapter 18 puts the destroy ahead of the goodbye; the stdio shutdown sequence"
                        + " is close stdin, wait, signal, force, and the order is the promise");
    }

    @Test
    void theMcpChapterDoesNotPromiseBoundedFailureWithoutNamingWhatBoundsIt() throws IOException {
        String chapter = mcpChapter();
        assumeTrue(chapter != null, "not running from a source checkout");

        // The promise is only honest because the teardown ends the far end. A chapter
        // that keeps the promise and drops the mechanism is back where card 221 found it.
        assertTrue(chapter.contains("destroy the server process"),
                "chapter 18 promises a dead server degrades without saying that the teardown"
                        + " destroys the child, which is the only reason it does");
        assertTrue(chapter.contains("the read returns"),
                "chapter 18 no longer explains why ending the far end is what releases the read");
    }

    @Test
    void theMcpChapterSaysTheWholeTreeGoesAndOwnsUpToWhatItCannotReach() throws IOException {
        String chapter = mcpChapter();
        assumeTrue(chapter != null, "not running from a source checkout");

        // The sentence this replaced promised "the child process is destroyed", which was
        // true only for a server configured without a launcher. Almost nobody configures
        // one: npx, uvx and shell wrappers put the real server one level down, and the
        // teardown that shipped killed the wrapper and left the server under init.
        assertTrue(chapter.contains("whole tree"),
                "chapter 18 no longer says the teardown reaches past the process it spawned");
        assertTrue(chapter.contains("grandchild"),
                "chapter 18 promises a clean teardown without saying that a launcher puts the"
                        + " real server a level down, which is where the promise used to fail");
        assertFalse(chapter.contains("the child process is destroyed"),
                "chapter 18 is back to the sentence that was true only without a wrapper");
        // "The whole tree" is an absolute and the code is not: a census can only be taken
        // while somebody is alive to answer it. The chapter says so rather than leaving the
        // next person to find the two cases the hard way.
        assertTrue(chapter.contains("can name either"),
                "chapter 18 promises the whole tree without naming the two processes no"
                        + " census can reach — a launcher that had already exited, and a fork"
                        + " that came after the count");
    }

    @Test
    void theSequenceDiagramShowsTheTeardownItsCaptionClaims() throws IOException {
        String chapter = mcpChapter();
        assumeTrue(chapter != null, "not running from a source checkout");
        String diagram = sequenceSource();
        assumeTrue(diagram != null, "not running from a source checkout");

        String caption = chapter.lines()
                .filter(line -> line.contains("MERMAID:08-mcp-seq"))
                .findFirst().orElseThrow(() ->
                        new AssertionError("the MCP sequence diagram is gone from chapter 18"));

        assertTrue(caption.contains("close stdin") && caption.contains("count the tree"),
                "the caption no longer describes the teardown it illustrates: " + caption);
        // The caption was pinned on its own once, and the diagram beside it went on showing
        // "poison transport · degrade to ERROR string" — a picture of the version that
        // deadlocked, under a caption describing the fix. A guard on the words alone leaves
        // the picture free to disagree with them.
        assertTrue(diagram.contains("count the process tree"),
                "the sequence diagram does not show the census the caption claims");
        assertTrue(diagram.contains("close stdin"),
                "the sequence diagram does not show the end-of-stream the caption claims");
        assertTrue(diagram.contains("SIGTERM"),
                "the sequence diagram does not show that the signal comes after the goodbye");
        assertFalse(diagram.contains("poison transport · degrade to ERROR string"),
                "the sequence diagram is back to one step where there are four, which is the"
                        + " picture of the teardown that deadlocked");
    }

    @Test
    void theSystemContextClauseDoesNotClaimTheWebFaceKnowsWhoAnswered() throws IOException {
        String chapter = mcpChapter();
        assumeTrue(chapter != null, "not running from a source checkout");

        // Measured on this branch: McpServerRegistry.servers() has two callers, both in
        // spectro-cli, and none in spectro-server. The web session's panel is built from
        // config.mcpServers() — the CONFIGURED names — so it lists a dead server exactly
        // like a live one. The clause used to read "the System-context panel names the
        // servers" in a sentence whose other two clauses are about reachability, which
        // reads as a third reachability claim.
        assertTrue(chapter.contains("names the servers <em>you configured</em>"),
                "chapter 18 lists the System-context panel next to two reachability claims"
                        + " without saying it is built from the settings file");
        assertFalse(chapter.contains("System-context panel names the servers."),
                "chapter 18 is back to the unqualified clause: the web panel names configured"
                        + " servers, answered or not");

        // And one level up, where the panel has its own chapter: "what the panel shows is
        // what the model gets" is true of every row except this one. ContextDescriber
        // builds the MCP list from config.mcpServers() and the tool list from
        // StandardTools.all(), so a dead server is named there while none of its tools are.
        String panelChapter = whitespaceCollapsed(WEB_TABS);
        assumeTrue(panelChapter != null, "not running from a source checkout");
        assertTrue(panelChapter.contains("MCP servers are the ones your settings file declares"),
                "the System-context chapter says the panel is what the model gets without"
                        + " excepting the one row that is a config list rather than a state");
    }

    /**
     * Chapter 18 of the guide source — the parts, not a built edition: the parts are
     * what the generator reads and what the next rebuild will publish. Whitespace is
     * collapsed, because the source is hand-wrapped and a sentence is a sentence
     * whether or not it fits on one line.
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
        String chapter = end > start ? part.substring(start, end) : part.substring(start);
        return chapter.replaceAll("\\s+", " ");
    }

    /**
     * One guide part, whitespace-collapsed, for the chapters outside 18 that make a
     * claim about MCP.
     *
     * @param part repo-relative path of the part file
     * @return its text with runs of whitespace collapsed, or {@code null} outside a checkout
     */
    private static String whitespaceCollapsed(Path part) throws IOException {
        Path root = repoRoot();
        if (root == null || !Files.isRegularFile(root.resolve(part))) {
            return null;
        }
        return Files.readString(root.resolve(part)).replaceAll("\\s+", " ");
    }

    /**
     * The mermaid source of the MCP sequence diagram — the file the renderer reads, so
     * a picture cannot drift away from the caption above it.
     *
     * @return the diagram source, or {@code null} when not run from a checkout
     */
    private static String sequenceSource() throws IOException {
        Path root = repoRoot();
        if (root == null || !Files.isRegularFile(root.resolve(SEQUENCE_SOURCE))) {
            return null;
        }
        return Files.readString(root.resolve(SEQUENCE_SOURCE));
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
