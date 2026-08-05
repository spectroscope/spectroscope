package dev.spectroscope.server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 177: the agents beside a session, named rather than counted.
 *
 * <p>A Claude Code session transcript holds only its own start. Measured over
 * the 25 largest in this store: 71,329 records, ZERO carrying
 * {@code isSidechain}. Every word the agents said sits in sibling files the
 * importer never opened — 718 direct and 4,069 under
 * {@code subagents/workflows/<runId>/}. This is the read that finds them.</p>
 */
class SidecarAgentsTest {

    @TempDir
    Path store;

    /** A session transcript with a sidecar folder beside it, as the store lays it out. */
    private Path session(String id) throws Exception {
        Path project = Files.createDirectories(store.resolve("-Users-x-repo"));
        Path file = project.resolve(id + ".jsonl");
        Files.writeString(file, "{\"type\":\"user\",\"message\":{\"content\":\"go\"}}\n");
        return file;
    }

    private Path agents(Path session) throws Exception {
        String name = session.getFileName().toString();
        return Files.createDirectories(
                session.getParent().resolve(name.substring(0, name.length() - 6)).resolve("subagents"));
    }

    @Test
    void aSessionWithNoSidecarFolderNamesNoAgents() throws Exception {
        assertEquals(List.of(), TranscriptFacts.sidecarAgentsBeside(session("s1"), store));
    }

    @Test
    void aDirectSpawnIsNamedByItsFileAndCarriesNoRun() throws Exception {
        Path s = session("s2");
        Path dir = agents(s);
        Files.writeString(dir.resolve("agent-a1b2c3.jsonl"), "{}\n");

        List<TranscriptFacts.SidecarAgent> found = TranscriptFacts.sidecarAgentsBeside(s, store);

        assertEquals(1, found.size());
        // The id in the filename IS the id the parent's spawn row carries. The
        // docking point is read, never invented.
        assertEquals("a1b2c3", found.get(0).agentId());
        assertNull(found.get(0).runId());
        assertEquals("-Users-x-repo/s2/subagents/agent-a1b2c3.jsonl", found.get(0).path());
        assertTrue(found.get(0).bytes() > 0);
    }

    @Test
    void aWorkflowAgentCarriesTheRunItBelongedTo() throws Exception {
        // The run directory IS the run id. 85% of all agent transcripts in this
        // store live one level down here, and the counter that only globbed the
        // top level called those sessions "subagents: 0".
        Path s = session("s3");
        Path run = Files.createDirectories(agents(s).resolve("workflows").resolve("wf_a50345ce-eb8"));
        Files.writeString(run.resolve("agent-aaa.jsonl"), "{}\n");
        Files.writeString(run.resolve("agent-bbb.jsonl"), "{}\n");

        List<TranscriptFacts.SidecarAgent> found = TranscriptFacts.sidecarAgentsBeside(s, store);

        assertEquals(2, found.size());
        assertEquals(List.of("wf_a50345ce-eb8", "wf_a50345ce-eb8"),
                found.stream().map(TranscriptFacts.SidecarAgent::runId).toList());
        assertEquals(List.of("aaa", "bbb"),
                found.stream().map(TranscriptFacts.SidecarAgent::agentId).toList());
    }

    @Test
    void directSpawnsComeFirst_andRunsStayTogether() throws Exception {
        Path s = session("s4");
        Path dir = agents(s);
        Files.writeString(dir.resolve("agent-zzz.jsonl"), "{}\n");
        Path r1 = Files.createDirectories(dir.resolve("workflows").resolve("wf_b"));
        Path r2 = Files.createDirectories(dir.resolve("workflows").resolve("wf_a"));
        Files.writeString(r1.resolve("agent-1.jsonl"), "{}\n");
        Files.writeString(r2.resolve("agent-2.jsonl"), "{}\n");

        List<TranscriptFacts.SidecarAgent> found = TranscriptFacts.sidecarAgentsBeside(s, store);

        assertEquals(List.of("zzz", "2", "1"),
                found.stream().map(TranscriptFacts.SidecarAgent::agentId).toList());
        assertEquals(Arrays.asList(null, "wf_a", "wf_b"),
                found.stream().map(TranscriptFacts.SidecarAgent::runId).toList());
    }

    @Test
    void theSiblingsThatAreNotAgentsAreNotCounted() throws Exception {
        // Every agent also writes a .meta.json, and a run keeps a journal.jsonl.
        // Counting either inflates every number the panel will print.
        Path s = session("s5");
        Path dir = agents(s);
        Files.writeString(dir.resolve("agent-real.jsonl"), "{}\n");
        Files.writeString(dir.resolve("agent-real.meta.json"), "{}\n");
        Path run = Files.createDirectories(dir.resolve("workflows").resolve("wf_x"));
        Files.writeString(run.resolve("journal.jsonl"), "{}\n");
        Files.writeString(run.resolve("agent-child.meta.json"), "{}\n");

        List<TranscriptFacts.SidecarAgent> found = TranscriptFacts.sidecarAgentsBeside(s, store);

        assertEquals(List.of("real"), found.stream().map(TranscriptFacts.SidecarAgent::agentId).toList());
    }

    @Test
    void theListingAgreesWithTheCountTheImportDialogShows() throws Exception {
        // Card 177 question 4: a second counter that disagreed with the dialog's
        // on the same session would be worse than none. One fold, two readings.
        Path s = session("s6");
        Path dir = agents(s);
        Files.writeString(dir.resolve("agent-one.jsonl"), "{}\n");
        Files.writeString(dir.resolve("agent-two.jsonl"), "{}\n");
        Path run = Files.createDirectories(dir.resolve("workflows").resolve("wf_r"));
        for (String id : List.of("c1", "c2", "c3")) Files.writeString(run.resolve("agent-" + id + ".jsonl"), "{}\n");

        List<TranscriptFacts.SidecarAgent> named = TranscriptFacts.sidecarAgentsBeside(s, store);
        TranscriptFacts.Sidecars counted = TranscriptFacts.sidecarsBeside(s);

        assertEquals(counted.subagents(), named.stream().filter(a -> a.runId() == null).count());
        assertEquals(counted.workflowAgents(), named.stream().filter(a -> a.runId() != null).count());
    }
}
