package dev.spectroscope.core.subagents;

import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 470: the paragraph that tells a parent when to read and when to send a
 * child, and the spawn description that tells it what to ask the child for.
 *
 * <p>Whether a model follows the paragraph is not a gate. The gate is that the
 * paragraph says what the card says, stays short, and that the three faces send
 * it (pinned beside each face: {@code HeadlessDiscoveryGuidanceTest} here in
 * core, {@code SessionDiscoveryGuidanceTest} in the server and
 * {@code SpectroCliDiscoveryGuidanceTest} in the CLI).</p>
 */
class DiscoveryGuidanceTest {

    /** A sentence ends at a full stop, question or exclamation mark followed by
     *  whitespace or the end of the text. */
    private static final Pattern SENTENCE_END = Pattern.compile("[.!?](\\s|$)");

    static int sentences(String text) {
        Matcher matcher = SENTENCE_END.matcher(text.strip());
        int count = 0;
        while (matcher.find()) {
            count++;
        }
        return count;
    }

    @Test
    void theSentenceCounterCountsWhatItIsShown() {
        // The counter is the instrument; it has to see a sentence before its
        // verdict on the paragraph means anything.
        assertEquals(3, sentences("One. Two? Three!"), "three sentences counted as three");
        assertEquals(1, sentences("Read with offset and limit."), "one sentence counted as one");
    }

    @Test
    void theParagraphRoutesDiscoveryToAnExploreChildAndWorksFromItsDigest() {
        String paragraph = RoleCatalog.DISCOVERY_GUIDANCE;
        assertTrue(paragraph.contains("spawn_agent"), "names the tool that makes a child: " + paragraph);
        assertTrue(paragraph.contains("discovery across many files or folders"),
                "names what goes to a child: " + paragraph);
        assertTrue(paragraph.contains("explore child"), "names the explore type: " + paragraph);
        assertTrue(paragraph.contains("work from its digest"), "the parent works from the digest: " + paragraph);
    }

    @Test
    void theParagraphReadsAKnownFileDirectlyWithOffsetAndLimit() {
        String paragraph = RoleCatalog.DISCOVERY_GUIDANCE;
        assertTrue(paragraph.contains("already know you need directly"),
                "a known file is read directly: " + paragraph);
        assertTrue(paragraph.contains("offset") && paragraph.contains("limit"),
                "large files are read in windows, with the read_file parameter names: " + paragraph);
    }

    @Test
    void theParagraphSendsASelfContainedEditToAWorkerChild() {
        String paragraph = RoleCatalog.DISCOVERY_GUIDANCE;
        assertTrue(paragraph.contains("self-contained subtask") && paragraph.contains("worker child"),
                "a self-contained edit goes to a worker: " + paragraph);
    }

    @Test
    void theParagraphAsksForACompleteAssignmentAndADigestNotFileContents() {
        String paragraph = RoleCatalog.DISCOVERY_GUIDANCE;
        assertTrue(paragraph.contains("complete assignment"), "the task text is complete: " + paragraph);
        assertTrue(paragraph.contains("short digest with path and line, not for file contents"),
                "the task asks for a digest and not for contents: " + paragraph);
    }

    @Test
    void theParagraphIsAtMostFiveSentences() {
        int count = sentences(RoleCatalog.DISCOVERY_GUIDANCE);
        assertTrue(count >= 1, "the paragraph has at least one sentence, got " + count);
        assertTrue(count <= 5, "card 470 allows at most five sentences, got " + count);
    }

    @Test
    void spawnAgentAsksTheChildForADigestNotForFileContents() {
        assertTrue(RoleCatalog.SPAWN_AGENT_DESC.contains(
                        "ask the child for a short digest with path and line, not for file contents"),
                "spawn_agent names the digest expectation: " + RoleCatalog.SPAWN_AGENT_DESC);
    }

    @Test
    void spawnAgentsKeepsItsInterpolatedWidth() {
        assertTrue(RoleCatalog.SPAWN_AGENTS_DESC.contains(
                        "Starts up to " + SubagentManager.MAX_PARALLEL_CHILDREN + " subagents IN PARALLEL"),
                "spawn_agents names the width the manager enforces: " + RoleCatalog.SPAWN_AGENTS_DESC);
    }

    /** The paragraph cut at the same sentence ends {@link #sentences} counts. */
    static List<String> sentenceList(String text) {
        return Arrays.stream(text.strip().split("(?<=[.!?])\\s+"))
                .filter(sentence -> !sentence.isBlank())
                .toList();
    }

    @Test
    void everySentenceThatMentionsAChildNamesSpawnAgent() {
        // The headless face registers no spawn tools, so a sentence about a
        // child that does not name spawn_agent is an order it cannot follow.
        List<String> all = sentenceList(RoleCatalog.DISCOVERY_GUIDANCE);
        assertEquals(sentences(RoleCatalog.DISCOVERY_GUIDANCE), all.size(),
                "the splitter cuts where the counter counts: " + all);
        List<String> aboutChildren = all.stream().filter(sentence -> sentence.contains("child")).toList();
        assertTrue(aboutChildren.size() >= 3,
                "the explore, worker and task sentences all talk about a child: " + all);
        for (String sentence : aboutChildren) {
            assertTrue(sentence.contains("spawn_agent"),
                    "a sentence about a child is conditioned on spawn_agent: " + sentence);
        }
    }

    @Test
    void spawnAgentsAsksEachChildForADigestNotForFileContents() {
        assertTrue(RoleCatalog.SPAWN_AGENTS_DESC.contains(
                        "ask each child for a short digest with path and line, not for file contents"),
                "spawn_agents names the digest expectation: " + RoleCatalog.SPAWN_AGENTS_DESC);
    }

    @Test
    void theInteractiveBasePromptIsOneSourceThatCarriesTheParagraph() {
        String base = RoleCatalog.BASE_SYSTEM_PROMPT;
        assertTrue(base.startsWith("You are spectroscope, a coding agent in the terminal. "),
                "the browser session and the REPL open with the same sentence: " + base);
        assertTrue(base.contains(" " + RoleCatalog.DISCOVERY_GUIDANCE + " "),
                "the base prompt carries the paragraph: " + base);
        assertTrue(base.endsWith("Working directory: "),
                "the caller appends the working directory right after the label: " + base);
    }

    @Test
    void everyNameWithAnUnderscoreIsAnInlineCodeSpan() {
        // The System context panel renders the prompt as markdown, and its inline
        // parser reads a bare underscore inside a word as emphasis: two bare
        // spawn_agent mentions turned the text between them italic and ate both
        // underscores (plate 13, captured 2026-10-09). A code span is kept verbatim.
        String paragraph = RoleCatalog.DISCOVERY_GUIDANCE;
        long spans = Pattern.compile("`spawn_agent`").matcher(paragraph).results().count();
        assertTrue(spans >= 3, "the three child sentences name `spawn_agent` as code, got " + spans
                + ": " + paragraph);
        String outsideCode = paragraph.replaceAll("`[^`]*`", "");
        assertTrue(!outsideCode.contains("_"),
                "no underscore stands outside a code span: " + outsideCode);
    }
}
