package dev.spectroscope.server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.ResponseEntity;

import java.io.RandomAccessFile;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class ClaudeTranscriptsControllerTest {

    @TempDir
    Path home;

    private Path projects() throws Exception {
        Path p = home.resolve(".claude/projects");
        Files.createDirectories(p);
        return p;
    }

    @Test
    void listsJsonlTranscriptsNewestFirstWithProjectAndSize() throws Exception {
        Path base = projects();
        Path projA = Files.createDirectories(base.resolve("-Users-x-repo-a"));
        Path projB = Files.createDirectories(base.resolve("-Users-x-repo-b"));
        Path older = Files.writeString(projA.resolve("s1.jsonl"), "{\"type\":\"run_start\"}\n");
        Path newer = Files.writeString(projB.resolve("s2.jsonl"), "{\"type\":\"run_start\"}\n{\"x\":1}\n");
        Files.writeString(projA.resolve("notes.txt"), "not a transcript");
        Files.setLastModifiedTime(older, FileTime.fromMillis(1_000_000));
        Files.setLastModifiedTime(newer, FileTime.fromMillis(2_000_000));

        List<ClaudeTranscriptsController.TranscriptInfo> list =
                new ClaudeTranscriptsController(base).transcripts();

        assertThat(list).hasSize(2);
        assertThat(list.get(0).file()).isEqualTo("s2.jsonl");
        assertThat(list.get(0).project()).isEqualTo("-Users-x-repo-b");
        assertThat(list.get(0).size()).isGreaterThan(0);
        assertThat(list.get(1).file()).isEqualTo("s1.jsonl");
    }

    @Test
    void listsSubagentTranscriptsInSubfolders() throws Exception {
        Path base = projects();
        Path sub = Files.createDirectories(base.resolve("-proj/subagents"));
        Files.writeString(sub.resolve("agent-1.jsonl"), "{}\n");

        List<ClaudeTranscriptsController.TranscriptInfo> list =
                new ClaudeTranscriptsController(base).transcripts();

        assertThat(list).hasSize(1);
        assertThat(list.get(0).path()).isEqualTo("-proj/subagents/agent-1.jsonl");
    }

    @Test
    void missingBaseDirectoryYieldsEmptyList() {
        ClaudeTranscriptsController c =
                new ClaudeTranscriptsController(home.resolve("does-not-exist"));
        assertThat(c.transcripts()).isEmpty();
    }

    @Test
    void servesContentForAListedTranscript() throws Exception {
        Path base = projects();
        Path proj = Files.createDirectories(base.resolve("-proj"));
        Files.writeString(proj.resolve("s.jsonl"), "{\"type\":\"run_start\"}\n");

        ResponseEntity<String> res =
                new ClaudeTranscriptsController(base).content("-proj/s.jsonl");

        assertThat(res.getStatusCode().value()).isEqualTo(200);
        assertThat(res.getBody()).contains("run_start");
    }

    @Test
    void rejectsTraversalOutsideTheBase() throws Exception {
        Path base = projects();
        Files.writeString(home.resolve("secret.jsonl"), "top secret");

        ResponseEntity<String> res =
                new ClaudeTranscriptsController(base).content("../../secret.jsonl");

        assertThat(res.getStatusCode().value()).isEqualTo(404);
    }

    @Test
    void rejectsNonJsonlPaths() throws Exception {
        Path base = projects();
        Path proj = Files.createDirectories(base.resolve("-proj"));
        Files.writeString(proj.resolve("notes.txt"), "plain");

        ResponseEntity<String> res =
                new ClaudeTranscriptsController(base).content("-proj/notes.txt");

        assertThat(res.getStatusCode().value()).isEqualTo(400);
    }

    @Test
    void missingFileIs404() throws Exception {
        ResponseEntity<String> res =
                new ClaudeTranscriptsController(projects()).content("-proj/missing.jsonl");
        assertThat(res.getStatusCode().value()).isEqualTo(404);
    }

    /**
     * The size cap is the only thing bounding this server's transient heap.
     * {@code content()} answers with {@link Files#readString}, so one request
     * holds the WHOLE file as a String and the response copy on top of it. The
     * cap is therefore not a politeness limit, it is the heap budget.
     *
     * <p>Measured 2026-08-03 against the 0.5.0 jar, importing a real 47 MB
     * transcript: a single import needs between 256 MB and 384 MB of heap
     * (256 MB answers 500 with OutOfMemoryError), and three concurrent imports
     * need between 768 MB and 1 GB. The JVM's default max heap is a quarter of
     * physical RAM, so a 4 GB machine gets 1 GB and clears that bar; nothing
     * smaller does.
     *
     * <p>Raising this constant moves that floor proportionally and silently.
     * This test exists so the number cannot move without someone reading the
     * paragraph above and redoing the arithmetic.
     */
    @Test
    void contentSizeCapStaysAt64MbBecauseTheWholeFileIsHeldInHeap() throws Exception {
        long cap = 64L * 1024 * 1024;
        Path base = projects();
        Path proj = Files.createDirectories(base.resolve("-proj"));

        // Sparse files: setLength reserves the size without writing bytes, and
        // Files.size (what the guard reads) reports it. Two 64 MB temp files
        // would otherwise make this test cost more than the thing it guards.
        Path atCap = proj.resolve("at-cap.jsonl");
        try (RandomAccessFile f = new RandomAccessFile(atCap.toFile(), "rw")) {
            f.setLength(cap);
        }
        Path overCap = proj.resolve("over-cap.jsonl");
        try (RandomAccessFile f = new RandomAccessFile(overCap.toFile(), "rw")) {
            f.setLength(cap + 1);
        }

        ClaudeTranscriptsController c = new ClaudeTranscriptsController(base);

        // One byte over the cap is refused, which is what keeps the heap demand
        // bounded. 413 rather than a stack trace: the dialog can say why.
        assertThat(c.content("-proj/over-cap.jsonl").getStatusCode().value())
                .as("a file one byte over the cap must be refused with 413")
                .isEqualTo(413);

        // Exactly at the cap is still allowed, pinning the boundary from both
        // sides so the comparison cannot drift from > to >= unnoticed.
        assertThat(c.content("-proj/at-cap.jsonl").getStatusCode().value())
                .as("a file exactly at the cap must still be served")
                .isNotEqualTo(413);
    }
}
