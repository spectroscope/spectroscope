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

    /** The same marker under a {@code .json} name, for the meta and the run
     *  state — two derived files whose suffix is not {@code .jsonl}. */
    private Path outsideJson;

    private static final String SECRET = "outside-the-store-marker";

    @BeforeEach
    void aStoreWithOneTranscript() throws Exception {
        Path base = Files.createDirectories(home.resolve(".claude/projects/-Users-x-repo"));
        Files.writeString(base.resolve("s1.jsonl"), "{\"type\":\"run_start\"}\n");
        outside = home.resolve("elsewhere");
        Files.createDirectories(outside);
        outside = outside.resolve("secret.jsonl");
        Files.writeString(outside, "{\"type\":\"user\",\"text\":\"" + SECRET + "\"}\n");
        outsideJson = outside.resolveSibling("secret.json");
        Files.writeString(outsideJson, "{\"text\":\"" + SECRET + "\"}");
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

    // ---- card 318: the fence covers what the bundle DERIVES ----------------

    /**
     * The store, as one session with a run beside it. Everything the bundle
     * reads besides the transcript itself hangs off this shape, and every case
     * below replaces exactly one of those files with a symlink out.
     *
     * @return the session folder, {@code <store>/-Users-x-repo/s1}
     */
    private Path aSessionWithARunBesideIt() throws Exception {
        Path project = home.resolve(".claude/projects/-Users-x-repo");
        Path runDir = Files.createDirectories(
                project.resolve("s1/subagents/workflows/wf_one"));
        Files.writeString(runDir.resolve("agent-aaa.jsonl"), "{\"type\":\"user\"}\n");
        Files.writeString(runDir.resolve("agent-aaa.meta.json"), META);
        Path states = Files.createDirectories(project.resolve("s1/workflows"));
        Files.writeString(states.resolve("wf_one.json"), "{\"runId\":\"wf_one\"}");
        return project.resolve("s1");
    }

    /** What a workflow child's meta really carries, in full. */
    private static final String META = "{\"agentType\":\"workflow-subagent\",\"spawnDepth\":1}";

    /** The bundle for the one session, as a string. */
    private String runBundleBody() throws Exception {
        return mvc.perform(get("http://127.0.0.1/api/claude/transcripts/run")
                        .param("path", "-Users-x-repo/s1.jsonl"))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString();
    }

    /**
     * An agent transcript that is a symlink out of the store.
     *
     * <p>The name is the only thing the walk checks, and {@code isRegularFile}
     * follows the link — so the file is admitted as an agent and its target is
     * read. {@code /content} refuses this same file by canonicalising it; the
     * bundle must not be the one door on this surface that does not.</p>
     *
     * <p>Not theoretical: {@code ~/.claude/projects/<project>/<session>/subagents}
     * is an ordinary directory the operator's own agents can write into.</p>
     */
    @Test
    void aPoisonedAgentTranscriptIsNotReadIntoTheBundle() throws Exception {
        Path session = aSessionWithARunBesideIt();
        Files.createSymbolicLink(
                session.resolve("subagents/workflows/wf_one/agent-evil.jsonl"), outside);

        org.assertj.core.api.Assertions.assertThat(runBundleBody())
                .as("a symlinked agent transcript handed its target to the importer")
                .doesNotContain(SECRET);
    }

    /**
     * The meta beside an agent, the same shape one file over. It is derived by
     * NAME from the transcript, so a link here is reached even when the
     * transcript itself is honest.
     */
    @Test
    void aPoisonedAgentMetaIsNotReadIntoTheBundle() throws Exception {
        Path session = aSessionWithARunBesideIt();
        Path runDir = session.resolve("subagents/workflows/wf_one");
        Files.writeString(runDir.resolve("agent-bbb.jsonl"), "{\"type\":\"user\"}\n");
        Files.createSymbolicLink(runDir.resolve("agent-bbb.meta.json"), outsideJson);

        org.assertj.core.api.Assertions.assertThat(runBundleBody())
                .as("a symlinked meta handed its target to the importer")
                .doesNotContain(SECRET);
    }

    /** A run state file that is a symlink out. Its own walk, its own bite. */
    @Test
    void aPoisonedRunStateIsNotReadIntoTheBundle() throws Exception {
        Path session = aSessionWithARunBesideIt();
        Files.createSymbolicLink(session.resolve("workflows/wf_evil.json"), outsideJson);

        org.assertj.core.api.Assertions.assertThat(runBundleBody())
                .as("a symlinked run state handed its target to the importer")
                .doesNotContain(SECRET);
    }

    /**
     * The {@code workflows} DIRECTORY as a symlink out: the listing walks
     * through the link and every file behind it is a run state.
     */
    @Test
    void aWorkflowsFolderPointingOutOfTheStoreBringsNoRunStates() throws Exception {
        Path session = aSessionWithARunBesideIt();
        Path elsewhere = Files.createDirectories(home.resolve("elsewhere/states"));
        Files.writeString(elsewhere.resolve("wf_elsewhere.json"), "{\"secret\":\"" + SECRET + "\"}");
        Path states = session.resolve("workflows");
        Files.delete(states.resolve("wf_one.json"));
        Files.delete(states);
        Files.createSymbolicLink(states, elsewhere);

        org.assertj.core.api.Assertions.assertThat(runBundleBody())
                .as("a symlinked workflows folder handed its contents to the importer")
                .doesNotContain(SECRET);
    }

    /**
     * The whole session FOLDER as a symlink out — one link, and both walks
     * start outside the store.
     */
    @Test
    void aSessionFolderPointingOutOfTheStoreBringsNothingBesideTheFile() throws Exception {
        Path project = home.resolve(".claude/projects/-Users-x-repo");
        Path elsewhere = Files.createDirectories(home.resolve("elsewhere/planted/subagents/workflows/wf_x"));
        Files.writeString(elsewhere.resolve("agent-ccc.jsonl"), "{\"secret\":\"" + SECRET + "\"}");
        Files.createSymbolicLink(project.resolve("s1"), home.resolve("elsewhere/planted"));

        org.assertj.core.api.Assertions.assertThat(runBundleBody())
                .as("a symlinked session folder handed its contents to the importer")
                .doesNotContain(SECRET);
    }
}
