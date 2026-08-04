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

    @Test
    void askingForNothingIsNotAnError() throws Exception {
        mvc.perform(get("http://127.0.0.1/api/claude/transcripts/facts"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.facts.length()").value(0));
    }
}
