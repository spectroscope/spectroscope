package dev.spectroscope.server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The fold that reads one Claude Code transcript into the handful of facts the
 * import dialog puts on a row.
 *
 * <p>Every expectation here was measured against the operator's real store
 * before it was written down, because three of the obvious guesses about that
 * format are wrong: {@code isSidechain} is never true, no transcript carries a
 * {@code Task} tool call, and a model the session never used before can first
 * appear on the very last line. The tests that look over-careful are the ones
 * standing on those measurements.</p>
 */
class TranscriptFactsTest {

    @TempDir
    Path store;

    /** One transcript in a project folder, plus whatever sidecars a case needs. */
    private Path transcript(String name, String... lines) throws Exception {
        Path project = Files.createDirectories(store.resolve("-Users-x-repo"));
        Path file = project.resolve(name + ".jsonl");
        Files.writeString(file, String.join("\n", lines) + "\n");
        return file;
    }

    private static String assistant(String model) {
        return "{\"type\":\"assistant\",\"message\":{\"model\":\"" + model
                + "\",\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}}";
    }

    private static String userPrompt(String text) {
        return "{\"type\":\"user\",\"promptSource\":\"user\",\"message\":{\"role\":\"user\","
                + "\"content\":[{\"type\":\"text\",\"text\":\"" + text + "\"}]}}";
    }

    private static String toolCall(String name) {
        return "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-4-8\",\"content\":"
                + "[{\"type\":\"tool_use\",\"name\":\"" + name + "\",\"input\":{}}]}}";
    }

    /** The same call as {@link #toolCall}, carrying the id a real one has. */
    private static String toolCall(String name, String id) {
        return "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-4-8\",\"content\":"
                + "[{\"type\":\"tool_use\",\"id\":\"" + id + "\",\"name\":\"" + name
                + "\",\"input\":{}}]}}";
    }

    @Test
    void theFirstUserPromptTravelsVerbatim() throws Exception {
        Path f = transcript("s", userPrompt("read the card first"), userPrompt("now build it"));

        TranscriptFacts.Facts facts = TranscriptFacts.fold(f);

        assertEquals("read the card first", facts.firstPrompt());
    }

    @Test
    void aTranscriptWithNoUserPromptOffersNoneRatherThanAPlaceholder() throws Exception {
        Path f = transcript("s", assistant("claude-opus-4-8"));

        TranscriptFacts.Facts facts = TranscriptFacts.fold(f);

        assertNull(facts.firstPrompt(), "an unknown fact must produce nothing, never a dash");
        assertNull(facts.language());
    }

    @Test
    void everyModelIsReportedInTheOrderItFirstSpoke() throws Exception {
        Path f = transcript("s",
                assistant("claude-opus-4-8"),
                assistant("claude-opus-4-8"),
                assistant("claude-fable-5"));

        TranscriptFacts.Facts facts = TranscriptFacts.fold(f);

        assertEquals(List.of("claude-opus-4-8", "claude-fable-5"), facts.models());
    }

    /**
     * The measurement that decided the whole stage: across the 60 largest real
     * transcripts the last previously-unseen model appears at a median 27% of
     * the way in, at 94% for the ninetieth, and in one file on the final line.
     * So no prefix answers this question, and a fold that stops early lies.
     */
    @Test
    void aModelThatFirstSpeaksOnTheLastLineIsStillReported() throws Exception {
        String[] lines = new String[400];
        lines[0] = userPrompt("go");
        for (int i = 1; i < 399; i++) {
            lines[i] = assistant("claude-opus-4-8");
        }
        lines[399] = assistant("claude-fable-5");
        Path f = transcript("s", lines);

        TranscriptFacts.Facts facts = TranscriptFacts.fold(f);

        assertEquals(List.of("claude-opus-4-8", "claude-fable-5"), facts.models());
    }

    @Test
    void workflowCallsAreCountedAndOtherToolsAreNot() throws Exception {
        Path f = transcript("s",
                toolCall("Workflow"), toolCall("Bash"), toolCall("Workflow"), toolCall("Read"));

        TranscriptFacts.Facts facts = TranscriptFacts.fold(f);

        assertEquals(2, facts.workflowCalls());
    }

    /**
     * A transcript can hold the SAME record twice — same uuid, same message id,
     * byte-identical content, the second copy differing only by an added
     * `slug` key. Measured over the store: 322 repeated records across 11 of
     * the 171 session transcripts, and in two of them the repeated record holds
     * a Workflow block, so the row rendered one workflow more than the session
     * ran. One tool_use id is one call, however many lines carry it.
     */
    @Test
    void oneCallCountedOnceHoweverManyLinesTheFileRepeatsItOn() throws Exception {
        Path f = transcript("s",
                toolCall("Workflow", "toolu_01A"),
                toolCall("Bash", "toolu_01B"),
                toolCall("Workflow", "toolu_01A"), // the same call, written again
                toolCall("Workflow", "toolu_01C"));

        TranscriptFacts.Facts facts = TranscriptFacts.fold(f);

        assertEquals(2, facts.workflowCalls());
    }

    /**
     * And a block with no id cannot be PROVEN a duplicate of anything, so it
     * still counts. Undercounting a real call would be the worse error of the
     * two, and the de-duplication must not reach further than its evidence.
     */
    @Test
    void anIdlessCallStillCounts() throws Exception {
        Path f = transcript("s",
                toolCall("Workflow"),
                toolCall("Workflow"),
                toolCall("Workflow", "toolu_01A"),
                toolCall("Workflow", "toolu_01A"));

        TranscriptFacts.Facts facts = TranscriptFacts.fold(f);

        assertEquals(3, facts.workflowCalls());
    }

    /**
     * Subagents are not in the transcript at all. They are sibling files under
     * {@code <session>/subagents/}, which is why this count costs a directory
     * listing and no bytes of transcript.
     */
    @Test
    void subagentsAreCountedFromTheSidecarFolderNotTheTranscript() throws Exception {
        Path f = transcript("s", userPrompt("go"));
        Path subagents = Files.createDirectories(store.resolve("-Users-x-repo/s/subagents"));
        Files.writeString(subagents.resolve("agent-aaa.jsonl"), "{}\n");
        Files.writeString(subagents.resolve("agent-bbb.jsonl"), "{}\n");
        Files.writeString(subagents.resolve("agent-bbb.meta.json"), "{}\n");

        TranscriptFacts.Sidecars sidecars = TranscriptFacts.sidecarsBeside(f);

        assertEquals(2, sidecars.subagents(), "the .meta.json sidecar is not an agent");
    }

    @Test
    void aTranscriptWithoutASidecarFolderReportsNoSubagents() throws Exception {
        Path f = transcript("s", userPrompt("go"));

        assertEquals(0, TranscriptFacts.sidecarsBeside(f).subagents());
        assertEquals(0, TranscriptFacts.sidecarsBeside(f).workflowAgents());
    }

    /**
     * The stage-1 defect: on the real store 85% of all agent transcripts live
     * under {@code subagents/workflows/<runId>/}, and a counter that only sees
     * the direct files reports "no fan-out" on exactly the sessions with the
     * most fan-out. The two populations are different facts — a direct subagent
     * is a Task the session spawned, a workflow agent belongs to a Workflow run
     * — so they travel under different names rather than one number that means
     * neither.
     */
    @Test
    void workflowAgentsAreADifferentCountThanDirectSubagents() throws Exception {
        Path f = transcript("s", userPrompt("go"));
        Path subagents = Files.createDirectories(store.resolve("-Users-x-repo/s/subagents"));
        Files.writeString(subagents.resolve("agent-direct.jsonl"), "{}\n");
        Path runA = Files.createDirectories(subagents.resolve("workflows/wf_run-a"));
        Files.writeString(runA.resolve("agent-001.jsonl"), "{}\n");
        Files.writeString(runA.resolve("agent-001.meta.json"), "{}\n");
        Files.writeString(runA.resolve("agent-002.jsonl"), "{}\n");
        Files.writeString(runA.resolve("journal.jsonl"), "{}\n");
        Path runB = Files.createDirectories(subagents.resolve("workflows/wf_run-b"));
        Files.writeString(runB.resolve("agent-003.jsonl"), "{}\n");

        TranscriptFacts.Sidecars sidecars = TranscriptFacts.sidecarsBeside(f);

        assertEquals(1, sidecars.subagents(), "direct agents only");
        assertEquals(3, sidecars.workflowAgents(),
                "every agent below the direct level, wherever its run dir sits");
    }

    @Test
    void germanAndEnglishPromptsAreToldApartLocally() throws Exception {
        Path de = transcript("de", userPrompt("bitte lies die Karte und sag mir was noch fehlt"));
        Path en = transcript("en", userPrompt("please read the card and tell me what is missing"));

        assertEquals("de", TranscriptFacts.fold(de).language());
        assertEquals("en", TranscriptFacts.fold(en).language());
    }

    @Test
    void aPromptTooShortToJudgeGetsNoLanguageRatherThanAGuess() throws Exception {
        Path f = transcript("s", userPrompt("ok"));

        assertNull(TranscriptFacts.fold(f).language());
    }

    @Test
    void aVeryLongFirstPromptIsBoundedBeforeItTravels() throws Exception {
        Path f = transcript("s", userPrompt("x".repeat(9000)));

        String prompt = TranscriptFacts.fold(f).firstPrompt();

        assertTrue(prompt.length() <= TranscriptFacts.MAX_PROMPT_CHARS,
                "the row shows a prompt, not a transcript");
    }

    @Test
    void aBrokenLineIsSkippedAndTheRestStillFolds() throws Exception {
        Path f = transcript("s", "{not json", userPrompt("still here"), assistant("claude-fable-5"));

        TranscriptFacts.Facts facts = TranscriptFacts.fold(f);

        assertEquals("still here", facts.firstPrompt());
        assertEquals(List.of("claude-fable-5"), facts.models());
    }

    @Test
    void aMissingFileFoldsToNothingRatherThanThrowing() {
        TranscriptFacts.Facts facts = TranscriptFacts.fold(store.resolve("-Users-x-repo/gone.jsonl"));

        assertNull(facts.firstPrompt());
        assertEquals(List.of(), facts.models());
        assertEquals(0, facts.workflowCalls());
    }

    @Test
    void countsPicturesWhereverTheyAre(@TempDir Path dir) throws Exception {
        // Card 179. Two pasted on the opening prompt and one a tool handed back:
        // a reader looking for "the session with the screenshots" means all three.
        Path file = dir.resolve("s.jsonl");
        Files.writeString(file, String.join("\n",
                """
                {"type":"user","message":{"role":"user","content":[                {"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAA"}},                {"type":"image","source":{"type":"base64","media_type":"image/png","data":"BBB"}},                {"type":"text","text":"look at these"}]}}""",
                """
                {"type":"user","message":{"role":"user","content":[                {"type":"tool_result","content":[                {"type":"image","source":{"type":"base64","media_type":"image/png","data":"CCC"}}]}]}}""",
                """
                {"type":"user","message":{"role":"user","content":[                {"type":"image","source":{"type":"base64","media_type":"image/png","data":""}}]}}"""));

        assertEquals(3, TranscriptFacts.fold(file).images());
    }

    @Test
    void aTranscriptWithoutPicturesSaysZero(@TempDir Path dir) throws Exception {
        Path file = dir.resolve("s.jsonl");
        Files.writeString(file,
                """
                {"type":"user","message":{"role":"user","content":"just words"}}""");

        assertEquals(0, TranscriptFacts.fold(file).images());
    }
}
