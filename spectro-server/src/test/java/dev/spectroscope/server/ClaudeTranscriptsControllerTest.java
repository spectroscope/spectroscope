package dev.spectroscope.server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.ResponseEntity;

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
}
