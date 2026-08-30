package dev.spectroscope.server.transcripts;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.io.RandomAccessFile;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * Card 318: one request brings a whole recorded run.
 *
 * <p><b>The defect.</b> The merge that loads a workflow run's agents INTO the
 * stream (card 291/297) is reachable only from the folder picker. The store
 * list — the one-click door — fetches {@code /content} for the session file
 * alone, so a session with hundreds of agents beside it opens with none of
 * them. Measured on the owner's own session (13 agent transcripts in run
 * {@code wf_33b5add0-f8f}): the store list gives 3,327 events, 48 work items
 * and a roster of 1; the folder pick over the same session gives 50,907
 * events, 303 work items and a roster of 288.</p>
 *
 * <p>The fix the client needs is a server read: ONE endpoint that hands back
 * the session text plus every sidecar and every run state as TEXTS, so the
 * already-tested {@code importClaudeCodeRun} does the merge unchanged. That
 * endpoint is what this class specifies.</p>
 *
 * <p><b>Its field names are the contract, not decoration.</b> {@code sessionText},
 * {@code sidecars[].jsonlText}, {@code sidecars[].metaJson}, {@code sidecars[].runId},
 * {@code runStates[].runId} and {@code runStates[].json} are exactly the shapes
 * {@code SidecarText} and {@code RunStateText} already take in
 * {@code spectro-web/src/import/claudeCodeRun.ts}. A store load must therefore
 * be able to hand the answer to the importer with no mapping layer in between,
 * which is what keeps the two doors from drifting into two merges.</p>
 *
 * <p><b>Derived, never accepted.</b> The endpoint takes ONE parameter — the
 * session transcript, store-relative — and computes every other path from it,
 * the way {@link SessionFolders} already does for the folder buttons. The
 * escape shapes live in {@link ClaudeTranscriptsControllerFenceTest} beside
 * the fences they belong to.</p>
 *
 * <p>Every fixture here is synthetic; nothing is copied out of the real store.</p>
 */
class ClaudeTranscriptsRunBundleTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /**
     * How many workflow runs the reference fixture writes.
     *
     * <p>The bite card 318 asks for is "add a 48th run directory and demand
     * red". Raising this number is that bite: the fixture grows, the
     * EXPECTATION grows with it — because every expectation below is walked off
     * the fixture rather than typed — and an endpoint that caps, globs one
     * level, or forgets the deeper directories goes red without a literal being
     * touched.</p>
     */
    private static final int RUNS = 5;

    /**
     * The run that has agents and NO state file.
     *
     * <p>Measured on the owner's session: 47 run directories, 46 state files —
     * {@code wf_b6437d8a-34d} carries agents and no {@code workflows/<runId>.json}.
     * A bundle that derives its run states from the AGENT directories would
     * report a state file that is not there, or drop that run's agents with it.
     * Neither is allowed, so the shape is in the fixture.</p>
     */
    private static final int RUN_WITHOUT_STATE = 3;

    @TempDir
    Path home;

    private Path store;
    private MockMvc mvc;

    /** The session under test, store-relative — what the listing hands out. */
    private static final String SESSION = "-Users-x-repo/s1.jsonl";

    @BeforeEach
    void aStoreWithOneRecordedRun() throws Exception {
        store = Files.createDirectories(home.resolve(".claude/projects"));
        Path project = Files.createDirectories(store.resolve("-Users-x-repo"));
        Files.writeString(project.resolve("s1.jsonl"), sessionText());

        Path folder = Files.createDirectories(project.resolve("s1"));
        Path agentRoot = Files.createDirectories(folder.resolve("subagents").resolve("workflows"));
        Path stateRoot = Files.createDirectories(folder.resolve("workflows"));
        for (int r = 0; r < RUNS; r++) {
            String runId = runId(r);
            Path runDir = Files.createDirectories(agentRoot.resolve(runId));
            // Deliberately uneven: a uniform fan-out lets an off-by-one in the
            // walk look right, and the real store is anything but uniform.
            for (int a = 0; a <= r; a++) {
                String agentId = agentId(r, a);
                Files.writeString(runDir.resolve("agent-" + agentId + ".jsonl"), agentText(agentId));
                Files.writeString(runDir.resolve("agent-" + agentId + ".meta.json"), META);
            }
            // The journal a run writes for itself. It is a .jsonl and it is not
            // an agent; a bundle that swept the directory by suffix would carry
            // it and the importer would then try to read it as a transcript.
            Files.writeString(runDir.resolve("journal.jsonl"), "{\"note\":\"run log\"}\n");
            if (r != RUN_WITHOUT_STATE) {
                Files.writeString(stateRoot.resolve(runId + ".json"), stateJson(runId));
            }
        }
        // A neighbour session in the same project, with its own agents. Nothing
        // of it may appear in s1's bundle: the derivation is per session, and a
        // walk that started one directory too high would fold both together.
        Files.writeString(project.resolve("s2.jsonl"), sessionText());
        Path other = Files.createDirectories(
                project.resolve("s2").resolve("subagents").resolve("workflows").resolve("wf_neighbour"));
        Files.writeString(other.resolve("agent-neighbour1.jsonl"), agentText("neighbour1"));
        Files.writeString(other.resolve("agent-neighbour1.meta.json"), META);

        mvc = MockMvcBuilders.standaloneSetup(new ClaudeTranscriptsController(store)).build();
    }

    // ---- what a store row must bring ---------------------------------------

    @Test
    void aLoopbackCallerGetsTheSessionTextItself() throws Exception {
        JsonNode bundle = bundle(SESSION);

        assertThat(bundle.path("path").asText()).isEqualTo(SESSION);
        // Verbatim, because the importer parses it. Not a summary, not a head.
        assertThat(bundle.path("sessionText").asText()).isEqualTo(sessionText());
    }

    /**
     * The file set is WALKED, never typed.
     *
     * <p>The expectation on the right comes from an independent walk of the
     * fixture directory, so raising {@link #RUNS} moves both sides at once and
     * an implementation that misses the new directory is the only thing that
     * can go red. A list of agent ids typed here would be a second copy of the
     * fixture, and two copies of one lie pin nothing.</p>
     */
    @Test
    void theBundleNamesEveryAgentTheSessionFolderHolds() throws Exception {
        Set<String> onDisk = agentIdsOnDisk();
        // Sanity on the fixture itself, so a walk that found nothing cannot
        // pass this test by matching an empty answer.
        assertThat(onDisk).hasSize(RUNS * (RUNS + 1) / 2);

        Set<String> inBundle = new LinkedHashSet<>();
        for (JsonNode sidecar : bundle(SESSION).path("sidecars")) {
            inBundle.add(sidecar.path("agentId").asText());
        }

        assertThat(inBundle).containsExactlyInAnyOrderElementsOf(onDisk);
    }

    @Test
    void everySidecarCarriesTheThreeThingsTheImporterTakes() throws Exception {
        for (JsonNode sidecar : bundle(SESSION).path("sidecars")) {
            String agentId = sidecar.path("agentId").asText();
            // The names are the contract: these three fields ARE `SidecarText`,
            // so the browser hands the array straight to importClaudeCodeRun.
            assertThat(sidecar.path("jsonlText").asText())
                    .as("the body of agent-%s.jsonl", agentId)
                    .isEqualTo(agentText(agentId));
            assertThat(sidecar.path("metaJson").asText())
                    .as("the meta of agent-%s", agentId)
                    .isEqualTo(META);
            // The run directory IS the run id, and a workflow child's meta says
            // nothing else — `{"agentType":"workflow-subagent","spawnDepth":1}`
            // is the WHOLE meta, so the directory is the only attribution there is.
            assertThat(sidecar.path("runId").asText())
                    .as("the run agent-%s sat in", agentId)
                    .isEqualTo(runOf(agentId));
        }
    }

    @Test
    void theBundleCarriesEveryRunStateFileAndInventsNone() throws Exception {
        List<String> onDisk = runStateIdsOnDisk();
        // The measured shape: one run has agents and no state file. A fixture
        // where the two counts agree cannot catch a bundle that derives one
        // from the other.
        assertThat(onDisk).hasSize(RUNS - 1);

        List<String> inBundle = new ArrayList<>();
        for (JsonNode state : bundle(SESSION).path("runStates")) {
            inBundle.add(state.path("runId").asText());
            assertThat(state.path("json").asText())
                    .as("the state text of %s", state.path("runId").asText())
                    .isEqualTo(stateJson(state.path("runId").asText()));
        }

        assertThat(inBundle).containsExactlyInAnyOrderElementsOf(onDisk);
    }

    @Test
    void aRunWithNoStateFileStillBringsItsAgents() throws Exception {
        JsonNode bundle = bundle(SESSION);
        String orphan = runId(RUN_WITHOUT_STATE);

        List<String> agentsOfOrphan = new ArrayList<>();
        for (JsonNode sidecar : bundle.path("sidecars")) {
            if (orphan.equals(sidecar.path("runId").asText())) {
                agentsOfOrphan.add(sidecar.path("agentId").asText());
            }
        }
        List<String> stateIds = new ArrayList<>();
        for (JsonNode state : bundle.path("runStates")) {
            stateIds.add(state.path("runId").asText());
        }

        assertThat(agentsOfOrphan).hasSize(RUN_WITHOUT_STATE + 1);
        assertThat(stateIds).doesNotContain(orphan);
    }

    @Test
    void theRunsJournalIsNotAnAgentAndIsNotInTheBundle() throws Exception {
        for (JsonNode sidecar : bundle(SESSION).path("sidecars")) {
            assertThat(sidecar.path("jsonlText").asText())
                    .as("a journal reached the importer as an agent transcript")
                    .doesNotContain("run log");
        }
    }

    @Test
    void aNeighbourSessionsAgentsAreNotInThisSessionsBundle() throws Exception {
        for (JsonNode sidecar : bundle(SESSION).path("sidecars")) {
            assertThat(sidecar.path("agentId").asText()).isNotEqualTo("neighbour1");
        }
    }

    @Test
    void aSessionWithNothingBesideItBringsItsOwnTextAndNoAgents() throws Exception {
        // The empty answer is a real reading and must not be an error: most
        // transcripts in the store have no workflow folder at all, and the row
        // for one of those must still load.
        Files.writeString(store.resolve("-Users-x-repo/lone.jsonl"), sessionText());

        JsonNode bundle = bundle("-Users-x-repo/lone.jsonl");

        assertThat(bundle.path("sessionText").asText()).isEqualTo(sessionText());
        assertThat(bundle.path("sidecars")).isEmpty();
        assertThat(bundle.path("runStates")).isEmpty();
    }

    // ---- the ceiling -------------------------------------------------------

    @Test
    void theBundleSaysWhatItWeighsAndWhatTheServerAllows() throws Exception {
        JsonNode bundle = bundle(SESSION);

        // Both numbers, in the answer that succeeded, because the dialog has to
        // print them BEFORE it can say what a refusal means.
        assertThat(bundle.path("totalBytes").asLong()).isEqualTo(bundleBytesOnDisk());
        assertThat(bundle.path("limitBytes").asLong()).isGreaterThan(0L);
        assertThat(bundle.path("totalBytes").asLong())
                .isLessThanOrEqualTo(bundle.path("limitBytes").asLong());
    }

    /**
     * Over the ceiling, the refusal carries BOTH numbers.
     *
     * <p>The limit is read out of the server's own successful answer rather
     * than typed here: a literal would be a second copy of the constant and
     * would go quietly wrong the day the ceiling moves.</p>
     *
     * <p>The over-size half is a SPARSE file, and deliberately far bigger than
     * any heap this test could hold. That is the second claim in this case: the
     * refusal is decided from sizes, before a byte is read. An implementation
     * that reads first cannot pass — it would have to materialise two gibibytes
     * as a Java String, which no JVM will do.</p>
     */
    @Test
    void aBundleOverTheCeilingIsRefusedWithItsOwnSizeAndTheLimit() throws Exception {
        long limit = bundle(SESSION).path("limitBytes").asLong();

        Path project = store.resolve("-Users-x-repo");
        Files.writeString(project.resolve("big.jsonl"), sessionText());
        Path runDir = Files.createDirectories(
                project.resolve("big").resolve("subagents").resolve("workflows").resolve("wf_huge"));
        sparse(runDir.resolve("agent-huge.jsonl"), 2L * 1024 * 1024 * 1024);
        Files.writeString(runDir.resolve("agent-huge.meta.json"), META);

        MvcResult res = mvc.perform(get("http://127.0.0.1/api/claude/transcripts/run")
                        .param("path", "-Users-x-repo/big.jsonl"))
                .andReturn();

        long total = Files.size(project.resolve("big.jsonl"))
                + Files.size(runDir.resolve("agent-huge.jsonl"))
                + Files.size(runDir.resolve("agent-huge.meta.json"));
        assertThat(res.getResponse().getStatus()).isEqualTo(413);
        assertThat(res.getResponse().getContentAsString())
                .as("the refusal must name what it weighs and what is allowed")
                .contains(String.valueOf(total))
                .contains(String.valueOf(limit));
    }

    /**
     * The ceiling is about the BUNDLE, and that is the whole point.
     *
     * <p>{@code MAX_CONTENT_BYTES} is 128 MiB and the owner's real bundle is
     * 104 MiB of 527 files, every one of them far under that number. So the
     * per-file ceiling passes the whole thing and protects nothing: a run this
     * size has to be refused on its total or not at all.</p>
     */
    @Test
    void everyFilePassesTheSingleFileCeilingAndTheBundleStillDoesNot() throws Exception {
        long limit = bundle(SESSION).path("limitBytes").asLong();
        long each = limit / 4 + 1; // four of these clear the bundle ceiling; one never does

        Path project = store.resolve("-Users-x-repo");
        Files.writeString(project.resolve("wide.jsonl"), sessionText());
        Path runDir = Files.createDirectories(
                project.resolve("wide").resolve("subagents").resolve("workflows").resolve("wf_wide"));
        for (int i = 0; i < 4; i++) {
            sparse(runDir.resolve("agent-w" + i + ".jsonl"), each);
            Files.writeString(runDir.resolve("agent-w" + i + ".meta.json"), META);
            // Each one on its own is something /content is happy to serve.
            mvc.perform(get("http://127.0.0.1/api/claude/transcripts/content")
                            .param("path", "-Users-x-repo/wide/subagents/workflows/wf_wide/agent-w" + i + ".jsonl"))
                    .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers
                            .status().isOk());
        }

        assertThat(mvc.perform(get("http://127.0.0.1/api/claude/transcripts/run")
                        .param("path", "-Users-x-repo/wide.jsonl"))
                .andReturn().getResponse().getStatus())
                .isEqualTo(413);
    }

    /**
     * The ceiling, bitten on BOTH sides, one byte apart.
     *
     * <p>The card asks for it and the shipped number cannot give it: standing
     * one byte either side of 128 MiB means building 128 MiB of bundle that is
     * really read on the passing side, which no test should cost. So the
     * ceiling is a constructor seam and the bundle stays small — the comparison
     * under test is the same {@code >} either way.</p>
     *
     * <p>The published number is checked against the ENFORCED one in the same
     * breath. Two copies of a limit is how a dialog comes to offer the one file
     * its server refuses, which is the defect {@code MAX_CONTENT_BYTES} was
     * consolidated to end.</p>
     */
    @Test
    void exactlyAtTheCeilingIsServedAndOneByteOverIsRefused() throws Exception {
        long weighs = bundleBytesOnDisk();
        MockMvc atTheLine = MockMvcBuilders
                .standaloneSetup(new ClaudeTranscriptsController(store, weighs)).build();
        MockMvc oneByteOver = MockMvcBuilders
                .standaloneSetup(new ClaudeTranscriptsController(store, weighs - 1)).build();

        MvcResult served = atTheLine
                .perform(get("http://127.0.0.1/api/claude/transcripts/run").param("path", SESSION))
                .andReturn();
        assertThat(served.getResponse().getStatus())
                .as("a bundle of exactly the ceiling is inside it")
                .isEqualTo(200);
        JsonNode body = MAPPER.readTree(served.getResponse().getContentAsString(StandardCharsets.UTF_8));
        assertThat(body.path("limitBytes").asLong())
                .as("the published ceiling must be the one that was enforced")
                .isEqualTo(weighs);

        assertThat(oneByteOver
                .perform(get("http://127.0.0.1/api/claude/transcripts/run").param("path", SESSION))
                .andReturn().getResponse().getStatus())
                .as("one byte over is refused")
                .isEqualTo(413);
    }

    // ---- fixture ------------------------------------------------------------

    /** What every workflow child's meta really carries, in full. */
    private static final String META = "{\"agentType\":\"workflow-subagent\",\"spawnDepth\":1}";

    private static String runId(int r) {
        return String.format("wf_%08x-f8f", r);
    }

    private static String agentId(int r, int a) {
        return String.format("a%02x%02xdeadbeef", r, a);
    }

    /** Which run an agent id belongs to, by the same rule that built it. */
    private static String runOf(String agentId) {
        return runId(Integer.parseInt(agentId.substring(1, 3), 16));
    }

    private static String sessionText() {
        return "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"go\"}}\n";
    }

    private static String agentText(String agentId) {
        return "{\"type\":\"user\",\"isSidechain\":true,\"agentId\":\"" + agentId
                + "\",\"message\":{\"role\":\"user\",\"content\":\"do it\"}}\n";
    }

    private static String stateJson(String runId) {
        return "{\"runId\":\"" + runId + "\",\"status\":\"completed\",\"phases\":[]}";
    }

    /** A file that reports a size without occupying one. */
    private static Path sparse(Path file, long bytes) throws Exception {
        try (RandomAccessFile f = new RandomAccessFile(file.toFile(), "rw")) {
            f.setLength(bytes);
        }
        return file;
    }

    // ---- the independent walk the expectations come from --------------------

    private Path sessionFolder() {
        return store.resolve("-Users-x-repo").resolve("s1");
    }

    private Set<String> agentIdsOnDisk() throws IOException {
        Set<String> ids = new LinkedHashSet<>();
        try (Stream<Path> walk = Files.walk(sessionFolder().resolve("subagents"))) {
            walk.filter(Files::isRegularFile)
                    .map(p -> p.getFileName().toString())
                    .filter(n -> n.startsWith("agent-") && n.endsWith(".jsonl"))
                    .forEach(n -> ids.add(n.substring("agent-".length(), n.length() - ".jsonl".length())));
        }
        return ids;
    }

    private List<String> runStateIdsOnDisk() throws IOException {
        List<String> ids = new ArrayList<>();
        try (Stream<Path> walk = Files.walk(sessionFolder().resolve("workflows"), 1)) {
            walk.filter(Files::isRegularFile)
                    .map(p -> p.getFileName().toString())
                    .filter(n -> n.startsWith("wf_") && n.endsWith(".json"))
                    .forEach(n -> ids.add(n.substring(0, n.length() - ".json".length())));
        }
        return ids;
    }

    /** Session file plus every file the bundle carries, in bytes. */
    private long bundleBytesOnDisk() throws IOException {
        long total = Files.size(store.resolve(SESSION));
        try (Stream<Path> walk = Files.walk(sessionFolder())) {
            for (Path p : (Iterable<Path>) walk::iterator) {
                if (!Files.isRegularFile(p)) {
                    continue;
                }
                String name = p.getFileName().toString();
                boolean agent = name.startsWith("agent-") && (name.endsWith(".jsonl") || name.endsWith(".meta.json"));
                boolean state = name.startsWith("wf_") && name.endsWith(".json")
                        && sessionFolder().resolve("workflows").equals(p.getParent());
                if (agent || state) {
                    total += Files.size(p);
                }
            }
        }
        return total;
    }

    // ---- the call ------------------------------------------------------------

    private JsonNode bundle(String path) throws Exception {
        MvcResult res = mvc.perform(get("http://127.0.0.1/api/claude/transcripts/run").param("path", path))
                .andReturn();
        assertThat(res.getResponse().getStatus())
                .as("GET /api/claude/transcripts/run?path=%s", path)
                .isEqualTo(200);
        return MAPPER.readTree(res.getResponse().getContentAsString(StandardCharsets.UTF_8));
    }
}
