package dev.spectroscope.server;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * The facts endpoint, driven through the real request mapping.
 *
 * <p>It answers with the operator's own prompts, so it wears the same fence as
 * its two neighbours and is tested the same way: the claim is about a request,
 * not about a method.</p>
 */
class ClaudeTranscriptFactsEndpointTest {

    @TempDir
    Path home;

    private Path base;
    private MockMvc mvc;

    @BeforeEach
    void aStoreWithTwoTranscripts() throws Exception {
        base = Files.createDirectories(home.resolve(".claude/projects/-Users-x-repo"));
        Files.writeString(base.resolve("s1.jsonl"),
                "{\"type\":\"user\",\"promptSource\":\"user\",\"message\":{\"role\":\"user\","
                        + "\"content\":[{\"type\":\"text\",\"text\":\"please read the card and say what is missing\"}]}}\n"
                        + "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-4-8\",\"content\":"
                        + "[{\"type\":\"tool_use\",\"name\":\"Workflow\",\"input\":{}}]}}\n"
                        + "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-fable-5\",\"content\":[]}}\n");
        Files.writeString(base.resolve("s2.jsonl"),
                "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-4-8\",\"content\":[]}}\n");
        Path subagents = Files.createDirectories(base.resolve("s1/subagents"));
        Files.writeString(subagents.resolve("agent-aaa.jsonl"), "{}\n");

        mvc = MockMvcBuilders
                .standaloneSetup(new ClaudeTranscriptsController(home.resolve(".claude/projects")))
                .build();
    }

    @Test
    void aReboundHostGetsNoFacts() throws Exception {
        mvc.perform(get("http://evil.example/api/claude/transcripts/facts")
                        .param("path", "-Users-x-repo/s1.jsonl"))
                .andExpect(status().isNotFound());
    }

    @Test
    void aLoopbackCallerGetsOneRowPerAskedPath() throws Exception {
        mvc.perform(get("http://127.0.0.1/api/claude/transcripts/facts")
                        .param("path", "-Users-x-repo/s1.jsonl")
                        .param("path", "-Users-x-repo/s2.jsonl"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.facts.length()").value(2))
                .andExpect(jsonPath("$.facts[0].path").value("-Users-x-repo/s1.jsonl"))
                .andExpect(jsonPath("$.facts[0].models[0]").value("claude-opus-4-8"))
                .andExpect(jsonPath("$.facts[0].models[1]").value("claude-fable-5"))
                .andExpect(jsonPath("$.facts[0].workflowCalls").value(1))
                .andExpect(jsonPath("$.facts[0].subagents").value(1))
                .andExpect(jsonPath("$.facts[0].language").value("en"))
                .andExpect(jsonPath("$.facts[0].firstPrompt")
                        .value("please read the card and say what is missing"));
    }

    /**
     * The stage-1 defect the adversarial check proved live: agents accrue in
     * the sidecar folder while a workflow runs, but the parent transcript may
     * not move until the tool result lands. A count cached under the
     * transcript's stamp answered yesterday's number for as long as the
     * transcript sat still. Sidecar counts are therefore taken at ask time,
     * every time — they cost a directory listing, not a read.
     */
    @Test
    void sidecarCountsAreFreshEvenWhenTheTranscriptDidNotMove() throws Exception {
        mvc.perform(get("http://127.0.0.1/api/claude/transcripts/facts")
                        .param("path", "-Users-x-repo/s1.jsonl"))
                .andExpect(jsonPath("$.facts[0].subagents").value(1))
                .andExpect(jsonPath("$.facts[0].workflowAgents").value(0));

        // The sidecar moves; the transcript does not.
        Files.writeString(base.resolve("s1/subagents/agent-bbb.jsonl"), "{}\n");
        Path run = Files.createDirectories(base.resolve("s1/subagents/workflows/wf_1"));
        Files.writeString(run.resolve("agent-001.jsonl"), "{}\n");

        mvc.perform(get("http://127.0.0.1/api/claude/transcripts/facts")
                        .param("path", "-Users-x-repo/s1.jsonl"))
                .andExpect(jsonPath("$.facts[0].subagents").value(2))
                .andExpect(jsonPath("$.facts[0].workflowAgents").value(1));
    }

    /** An unknown fact produces nothing at all, so the row can stay blank. */
    @Test
    void aTranscriptWithoutAPromptOmitsTheFieldEntirely() throws Exception {
        mvc.perform(get("http://127.0.0.1/api/claude/transcripts/facts")
                        .param("path", "-Users-x-repo/s2.jsonl"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.facts[0].firstPrompt").doesNotExist())
                .andExpect(jsonPath("$.facts[0].language").doesNotExist());
    }

    @Test
    void thePublishedBatchCapIsTheOneTheEndpointEnforces() throws Exception {
        String[] many = new String[ClaudeTranscriptsController.MAX_FACT_BATCH + 10];
        for (int i = 0; i < many.length; i++) {
            Files.writeString(base.resolve("m" + i + ".jsonl"), "{}\n");
            many[i] = "-Users-x-repo/m" + i + ".jsonl";
        }
        var request = get("http://127.0.0.1/api/claude/transcripts/facts");
        for (String p : many) {
            request = request.param("path", p);
        }

        mvc.perform(request)
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.maxBatch").value(ClaudeTranscriptsController.MAX_FACT_BATCH))
                .andExpect(jsonPath("$.facts.length()").value(ClaudeTranscriptsController.MAX_FACT_BATCH));
    }

    /**
     * The same sandbox the content endpoint keeps: a path is a request
     * parameter, so it is untrusted, and a traversal answers nothing rather
     * than confirming what is out there.
     */
    @Test
    void aPathOutsideTheStoreYieldsNoRowAtAll() throws Exception {
        Files.writeString(home.resolve("secret.jsonl"), "{}\n");

        mvc.perform(get("http://127.0.0.1/api/claude/transcripts/facts")
                        .param("path", "../../secret.jsonl")
                        .param("path", "-Users-x-repo/s2.jsonl"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.facts.length()").value(1))
                .andExpect(jsonPath("$.facts[0].path").value("-Users-x-repo/s2.jsonl"));
    }

    @Test
    void aNonJsonlNameIsRefusedTheSameWay() throws Exception {
        mvc.perform(get("http://127.0.0.1/api/claude/transcripts/facts")
                        .param("path", "-Users-x-repo/notes.txt"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.facts.length()").value(0));
    }

    // A path a java.nio.file.Path cannot hold at all. The endpoint's javadoc
    // promises one answer for everything untrusted — "a path outside the store,
    // a non-.jsonl name and a file that is not there are all the same answer —
    // nothing — because a request parameter is untrusted input and a refusal
    // that distinguishes them tells a prober what exists". A 500 distinguishes,
    // and Spring's default error body hands the prober their own string back.
    @Test
    void aPathTheFilesystemCannotEvenSpellIsTheSameNothing() throws Exception {
        mvc.perform(get("http://127.0.0.1/api/claude/transcripts/facts")
                        .param("path", "-Users-x-repo/s\u0000.jsonl"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.facts.length()").value(0));
    }

    @Test
    void oneUnspellablePathDoesNotTakeTheRestOfTheBatchWithIt() throws Exception {
        // The batch is a loop: an exception out of one row abandons every row
        // after it, so a single bad parameter blanks a whole screen of them.
        mvc.perform(get("http://127.0.0.1/api/claude/transcripts/facts")
                        .param("path", "-Users-x-repo/s\u0000.jsonl")
                        .param("path", "-Users-x-repo/s2.jsonl"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.facts.length()").value(1))
                .andExpect(jsonPath("$.facts[0].path").value("-Users-x-repo/s2.jsonl"));
    }

    @Test
    void theContentEndpointSpellsItTheSameWay() throws Exception {
        // Same resolution, same catch, one endpoint over: content() answers 404
        // for everything it cannot reach, and must not answer 500 for this.
        mvc.perform(get("http://127.0.0.1/api/claude/transcripts/content")
                        .param("path", "-Users-x-repo/s\u0000.jsonl"))
                .andExpect(status().isNotFound());
    }

    @Test
    void askingForNothingIsNotAnError() throws Exception {
        mvc.perform(get("http://127.0.0.1/api/claude/transcripts/facts"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.facts.length()").value(0));
    }
}
