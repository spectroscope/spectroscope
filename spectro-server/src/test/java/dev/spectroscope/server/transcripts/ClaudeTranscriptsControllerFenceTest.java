package dev.spectroscope.server.transcripts;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * The read fence on the transcript endpoints (card 74). These two answer with
 * the operator's own Claude Code history: every prompt they ever typed and
 * every tool result that came back. A rebound page reaches loopback, so only
 * the Host check keeps it out.
 *
 * <p>Driven through the real request mapping for the same reason as
 * {@link dev.spectroscope.server.workspace.WorkspaceControllerFenceTest}: the claim is about a request, not about
 * a method.</p>
 */
class ClaudeTranscriptsControllerFenceTest {

    @TempDir
    Path home;

    private MockMvc mvc;

    @BeforeEach
    void aStoreWithOneTranscript() throws Exception {
        Path base = Files.createDirectories(home.resolve(".claude/projects/-Users-x-repo"));
        Files.writeString(base.resolve("s1.jsonl"), "{\"type\":\"run_start\"}\n");
        mvc = MockMvcBuilders
                .standaloneSetup(new ClaudeTranscriptsController(home.resolve(".claude/projects")))
                .build();
    }

    @Test
    void aReboundHostGetsNeitherTheListingNorATranscript() throws Exception {
        mvc.perform(get("http://evil.example/api/claude/transcripts"))
                .andExpect(status().isNotFound());
        mvc.perform(get("http://evil.example/api/claude/transcripts/content")
                        .param("path", "-Users-x-repo/s1.jsonl"))
                .andExpect(status().isNotFound());
    }

    @Test
    void aLoopbackCallerStillGetsBoth() throws Exception {
        mvc.perform(get("http://127.0.0.1/api/claude/transcripts"))
                .andExpect(status().isOk())
                .andExpect(content().string(org.hamcrest.Matchers.containsString("s1.jsonl")));
        mvc.perform(get("http://localhost/api/claude/transcripts/content")
                        .param("path", "-Users-x-repo/s1.jsonl"))
                .andExpect(status().isOk())
                .andExpect(content().string("{\"type\":\"run_start\"}\n"));
    }

    /**
     * The folder endpoints, which are the two that matter most here: one names
     * absolute paths on the operator's disk, and the other starts a program.
     */
    @Test
    void aReboundHostGetsNeitherTheFolderListingNorAnOpen() throws Exception {
        mvc.perform(get("http://evil.example/api/claude/transcripts/folders")
                        .param("path", "-Users-x-repo/s1.jsonl"))
                .andExpect(status().isNotFound());
        mvc.perform(post("http://evil.example/api/claude/transcripts/folders/open")
                        .contentType("application/json")
                        .content("{\"path\":\"-Users-x-repo/s1.jsonl\",\"what\":\"transcript\"}"))
                .andExpect(status().isNotFound());
    }

    @Test
    void aLoopbackCallerIsToldWhichFoldersExist() throws Exception {
        mvc.perform(get("http://127.0.0.1/api/claude/transcripts/folders")
                        .param("path", "-Users-x-repo/s1.jsonl"))
                .andExpect(status().isOk())
                // The project folder is there because the transcript is in it;
                // the workflows folder is not, and is not offered.
                .andExpect(content().string(org.hamcrest.Matchers.containsString("transcript")))
                .andExpect(content().string(org.hamcrest.Matchers.not(
                        org.hamcrest.Matchers.containsString("workflows"))));
    }

    /**
     * The path is never the caller's. A body naming a file outside the store —
     * or naming no known kind — opens nothing, and says so rather than 500ing.
     */
    @Test
    void nothingOutsideTheStoreCanBeOpened() throws Exception {
        mvc.perform(post("http://127.0.0.1/api/claude/transcripts/folders/open")
                        .contentType("application/json")
                        .content("{\"path\":\"../../../../etc/s1.jsonl\",\"what\":\"transcript\"}"))
                .andExpect(status().isOk())
                .andExpect(content().string(org.hamcrest.Matchers.containsString("missing")));
        mvc.perform(post("http://127.0.0.1/api/claude/transcripts/folders/open")
                        .contentType("application/json")
                        .content("{\"path\":\"-Users-x-repo/s1.jsonl\",\"what\":\"/etc\"}"))
                .andExpect(status().isOk())
                .andExpect(content().string(org.hamcrest.Matchers.containsString("missing")));
    }
}
