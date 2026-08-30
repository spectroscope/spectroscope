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

    /**
     * A readable transcript that is NOT in the store, carrying a word nothing
     * inside the store says. Every escape shape below aims at it, and every
     * refusal is checked against its content as well as its status: a 404 is
     * only half the claim, and the half that matters is that the bytes did not
     * come back.
     */
    private Path outside;

    private static final String SECRET = "outside-the-store-marker";

    @BeforeEach
    void aStoreWithOneTranscript() throws Exception {
        Path base = Files.createDirectories(home.resolve(".claude/projects/-Users-x-repo"));
        Files.writeString(base.resolve("s1.jsonl"), "{\"type\":\"run_start\"}\n");
        outside = home.resolve("elsewhere");
        Files.createDirectories(outside);
        outside = outside.resolve("secret.jsonl");
        Files.writeString(outside, "{\"type\":\"user\",\"text\":\"" + SECRET + "\"}\n");
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

    // ---- card 318: the run bundle wears the same fence ----------------------

    /**
     * The positive control, and the reason the four refusals below are worth
     * anything.
     *
     * <p>A refusal test against an endpoint that does not exist is green for
     * the wrong reason — everything 404s when nothing is mapped. This case
     * fails until the bundle endpoint is really there, so the class as a whole
     * cannot go green on a missing route.</p>
     */
    @Test
    void aLoopbackCallerGetsTheRunBundle() throws Exception {
        mvc.perform(get("http://127.0.0.1/api/claude/transcripts/run")
                        .param("path", "-Users-x-repo/s1.jsonl"))
                .andExpect(status().isOk())
                .andExpect(content().string(org.hamcrest.Matchers.containsString("sessionText")));
    }

    /**
     * The bundle is the biggest read on this surface: a whole session plus
     * every word its agents said. A rebound page reaches loopback like the real
     * UI does, so the Host check is the only thing keeping it out.
     */
    @Test
    void aReboundHostGetsNoRunBundle() throws Exception {
        mvc.perform(get("http://evil.example/api/claude/transcripts/run")
                        .param("path", "-Users-x-repo/s1.jsonl"))
                .andExpect(status().isNotFound());
    }

    /**
     * The climb has to REACH something, or it is not a test of the fence.
     *
     * <p>Two segments up from {@code -Users-x-repo} lands in {@code .claude},
     * where nothing is — so the same 404 comes back whether the fence is there
     * or not. Measured 2026-08-30 by removing the fence from the run endpoint:
     * the symlink and absolute-path cases went red and this one stayed green.
     * Three segments up is the store's own parent, where the outside file
     * really sits, and now only the canonical check refuses it.</p>
     */
    @Test
    void noRunBundleForAPathThatClimbsOutOfTheStore() throws Exception {
        mvc.perform(get("http://127.0.0.1/api/claude/transcripts/run")
                        .param("path", "-Users-x-repo/../../../elsewhere/secret.jsonl"))
                .andExpect(status().isNotFound())
                .andExpect(content().string(org.hamcrest.Matchers.not(
                        org.hamcrest.Matchers.containsString(SECRET))));
    }

    /**
     * An ABSOLUTE path, which {@code base.resolve} hands back unchanged. The
     * suffix check cannot refuse this one — the target really is a readable
     * {@code .jsonl} — so only the canonical base check can.
     */
    @Test
    void noRunBundleForAnAbsolutePathOffTheWire() throws Exception {
        mvc.perform(get("http://127.0.0.1/api/claude/transcripts/run")
                        .param("path", outside.toAbsolutePath().toString()))
                .andExpect(status().isNotFound())
                .andExpect(content().string(org.hamcrest.Matchers.not(
                        org.hamcrest.Matchers.containsString(SECRET))));
    }

    /**
     * A symlink INSIDE the store pointing out of it. Normalising the requested
     * path is not enough here: the name never leaves the base, and only
     * {@code toRealPath} sees where it lands.
     */
    @Test
    void noRunBundleForASymlinkPointingOutOfTheStore() throws Exception {
        Path link = home.resolve(".claude/projects/-Users-x-repo/link.jsonl");
        Files.createSymbolicLink(link, outside);

        mvc.perform(get("http://127.0.0.1/api/claude/transcripts/run")
                        .param("path", "-Users-x-repo/link.jsonl"))
                .andExpect(status().isNotFound())
                .andExpect(content().string(org.hamcrest.Matchers.not(
                        org.hamcrest.Matchers.containsString(SECRET))));
    }

    /**
     * A directory, and a name that is not a transcript at all. The bundle
     * derives a session FOLDER from the path it is given, so a caller naming
     * the folder directly must get the same nothing as a caller naming a file
     * outside the store.
     */
    @Test
    void noRunBundleForANameThatIsNotATranscript() throws Exception {
        Files.createDirectories(home.resolve(".claude/projects/-Users-x-repo/s1/subagents"));

        mvc.perform(get("http://127.0.0.1/api/claude/transcripts/run")
                        .param("path", "-Users-x-repo/s1"))
                .andExpect(status().isNotFound());
        mvc.perform(get("http://127.0.0.1/api/claude/transcripts/run")
                        .param("path", "-Users-x-repo/s1/subagents"))
                .andExpect(status().isNotFound());
    }
}
