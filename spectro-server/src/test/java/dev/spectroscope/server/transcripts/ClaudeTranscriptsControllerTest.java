package dev.spectroscope.server.transcripts;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.io.Resource;
import org.springframework.http.ResponseEntity;

import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class ClaudeTranscriptsControllerTest {

    /** A loopback request with a localhost Host, i.e. what the real UI sends. */
    private static MockHttpServletRequest local() {
        return new MockHttpServletRequest();
    }

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
                new ClaudeTranscriptsController(base).transcripts(local()).getBody().transcripts();

        assertThat(list).hasSize(2);
        assertThat(list.get(0).file()).isEqualTo("s2.jsonl");
        assertThat(list.get(0).project()).isEqualTo("-Users-x-repo-b");
        assertThat(list.get(0).size()).isGreaterThan(0);
        assertThat(list.get(1).file()).isEqualTo("s1.jsonl");
    }

    @Test
    void aCappedListingSaysSo() throws Exception {
        // The walk reaches subagent files too, so the row cap fires long before
        // a store looks large: counted on this machine on 2026-08-03 it hid 553
        // of 853 files, 36 of them ordinary session transcripts. The envelope
        // published the byte ceiling and stayed silent about this one.
        Path proj = Files.createDirectories(projects().resolve("-proj"));
        for (int i = 0; i < 301; i++) {
            Files.writeString(proj.resolve("s" + i + ".jsonl"), "{}\n");
        }
        var listing = new ClaudeTranscriptsController(projects()).transcripts(local()).getBody();

        assertThat(listing.transcripts()).hasSize(300);
        assertThat(listing.truncated()).isTrue();
    }

    @Test
    void anUncappedListingSaysSoToo() throws Exception {
        Path proj = Files.createDirectories(projects().resolve("-proj"));
        Files.writeString(proj.resolve("only.jsonl"), "{}\n");

        var listing = new ClaudeTranscriptsController(projects()).transcripts(local()).getBody();

        assertThat(listing.transcripts()).hasSize(1);
        assertThat(listing.truncated()).isFalse();
    }

    @Test
    void listsSubagentTranscriptsInSubfolders() throws Exception {
        Path base = projects();
        Path sub = Files.createDirectories(base.resolve("-proj/subagents"));
        Files.writeString(sub.resolve("agent-1.jsonl"), "{}\n");

        List<ClaudeTranscriptsController.TranscriptInfo> list =
                new ClaudeTranscriptsController(base).transcripts(local()).getBody().transcripts();

        assertThat(list).hasSize(1);
        assertThat(list.get(0).path()).isEqualTo("-proj/subagents/agent-1.jsonl");
    }

    @Test
    void missingBaseDirectoryYieldsEmptyList() {
        ClaudeTranscriptsController c =
                new ClaudeTranscriptsController(home.resolve("does-not-exist"));
        assertThat(c.transcripts(local()).getBody().transcripts()).isEmpty();
    }

    @Test
    void servesContentForAListedTranscript() throws Exception {
        Path base = projects();
        Path proj = Files.createDirectories(base.resolve("-proj"));
        Files.writeString(proj.resolve("s.jsonl"), "{\"type\":\"run_start\"}\n");

        ResponseEntity<Resource> res =
                new ClaudeTranscriptsController(base).content("-proj/s.jsonl", local());

        assertThat(res.getStatusCode().value()).isEqualTo(200);
        assertThat(bodyOf(res)).contains("run_start");
    }

    @Test
    void rejectsTraversalOutsideTheBase() throws Exception {
        Path base = projects();
        Files.writeString(home.resolve("secret.jsonl"), "top secret");

        ResponseEntity<Resource> res =
                new ClaudeTranscriptsController(base).content("../../secret.jsonl", local());

        assertThat(res.getStatusCode().value()).isEqualTo(404);
    }

    @Test
    void rejectsNonJsonlPaths() throws Exception {
        Path base = projects();
        Path proj = Files.createDirectories(base.resolve("-proj"));
        Files.writeString(proj.resolve("notes.txt"), "plain");

        ResponseEntity<Resource> res =
                new ClaudeTranscriptsController(base).content("-proj/notes.txt", local());

        assertThat(res.getStatusCode().value()).isEqualTo(400);
    }

    @Test
    void missingFileIs404() throws Exception {
        ResponseEntity<Resource> res =
                new ClaudeTranscriptsController(projects()).content("-proj/missing.jsonl", local());
        assertThat(res.getStatusCode().value()).isEqualTo(404);
    }

    /**
     * The cap is pinned so it cannot move without someone redoing the arithmetic.
     * What changed is which arithmetic.
     *
     * <p>The previous pin held this number at 64 MB and said so because
     * {@code content()} answered with {@link Files#readString}: one request held
     * the whole file as a UTF-16 String plus the response copy, so the cap was
     * the server's heap budget. That premise is now false, and it was not
     * loosened, it was measured out of existence:
     * {@code contentDoesNotHoldTheWholeFileAsAString} shows the old read
     * allocating 50,334,944 bytes for a 25,165,818 byte file, exactly 2.00x, and
     * the streamed read allocating a buffer. A server that streams has no
     * file-sized heap demand to budget for.
     *
     * <p>So the ceiling is now a statement about the CLIENT, which still holds
     * the response text and the folded rows. Measured on the real store: the
     * 82.9 MiB transcript folds to 9931 trace rows in 332 ms of compute and
     * about 278 MB retained in the tab, with render, not parse, dominating.
     * 128 MiB clears the largest file in the store with headroom and still
     * refuses the runaway case a browser cannot survive.
     *
     * <p>There is deliberately no middle band warning that a file will be slow.
     * Measured across the 20 largest transcripts in the store, line density runs
     * from 42.8 to 257.6 lines per MiB, a six-fold spread, so bytes do not
     * predict row count and a byte-sized warning would fire on the wrong files
     * in both directions. Bytes govern the ceiling, where they are the actual
     * fact, and govern nothing else.
     */
    @Test
    void theContentCapIs128MbBecauseTheCostIsNowTheBrowsersNotTheServers() throws Exception {
        long cap = 128L * 1024 * 1024;
        Path base = projects();
        Path proj = Files.createDirectories(base.resolve("-proj"));
        sparse(proj.resolve("at-cap.jsonl"), cap);
        sparse(proj.resolve("over-cap.jsonl"), cap + 1);

        ClaudeTranscriptsController c = new ClaudeTranscriptsController(base);

        assertThat(c.transcripts(local()).getBody().limitBytes())
                .as("the published ceiling is 128 MiB")
                .isEqualTo(cap);
        assertThat(c.content("-proj/over-cap.jsonl", local()).getStatusCode().value())
                .as("a file one byte over the cap must be refused with 413")
                .isEqualTo(413);
        assertThat(c.content("-proj/at-cap.jsonl", local()).getStatusCode().value())
                .as("a file exactly at the cap must still be served")
                .isNotEqualTo(413);
    }

    /**
     * Reserves a size without writing the bytes. {@code Files.size}, which every
     * guard here reads, reports the reserved length, so a boundary test costs an
     * inode rather than the 128 MB it is about.
     *
     * @param file where to put it
     * @param bytes the size to reserve
     * @return the same path, for inlining
     */
    private static String bodyOf(ResponseEntity<Resource> res) throws Exception {
        if (res.getBody() == null) {
            return "";
        }
        return new String(res.getBody().getInputStream().readAllBytes(), StandardCharsets.UTF_8);
    }

    private static Path sparse(Path file, long bytes) throws Exception {
        try (RandomAccessFile f = new RandomAccessFile(file.toFile(), "rw")) {
            f.setLength(bytes);
        }
        return file;
    }

    /**
     * The owner clicked a 72.1 MB transcript that the dialog had listed like any
     * other and got a bare status code back. The dialog could not have known:
     * the row carried a size and nothing else, so every row rendered clickable
     * and the verdict arrived only after the click.
     *
     * <p>The server decides. A client that re-derives {@code size <= cap} is how
     * a {@code >} drifts into a {@code >=} and the dialog starts offering the one
     * file the server refuses.
     */
    @Test
    void theListingSaysWhetherEachTranscriptCanBeLoaded() throws Exception {
        Path base = projects();
        Path proj = Files.createDirectories(base.resolve("-proj"));
        Files.writeString(proj.resolve("small.jsonl"), "{\"type\":\"run_start\"}\n");
        sparse(proj.resolve("huge.jsonl"), 512L * 1024 * 1024);

        var listing = new ClaudeTranscriptsController(base).transcripts(local()).getBody();

        var small = listing.transcripts().stream()
                .filter(t -> t.file().equals("small.jsonl")).findFirst().orElseThrow();
        var huge = listing.transcripts().stream()
                .filter(t -> t.file().equals("huge.jsonl")).findFirst().orElseThrow();

        assertThat(small.loadable())
                .as("a small transcript must be offered")
                .isTrue();
        assertThat(huge.loadable())
                .as("the row the server will refuse must say so before it is clicked")
                .isFalse();
    }

    /**
     * The drift guard. Two numbers that must agree are not asserted against each
     * other as literals here: the listing's published limit is READ, and then the
     * content endpoint is PROBED at exactly that size and one byte past it. A
     * literal comparison would still pass if both sides moved to the same wrong
     * place; this fails unless the number the dialog is told is the number the
     * server actually enforces.
     */
    @Test
    void theLimitTheListingReportsIsTheLimitTheContentEndpointEnforces() throws Exception {
        Path base = projects();
        Path proj = Files.createDirectories(base.resolve("-proj"));
        ClaudeTranscriptsController c = new ClaudeTranscriptsController(base);

        long published = c.transcripts(local()).getBody().limitBytes();
        assertThat(published).as("the listing must publish a limit at all").isPositive();

        sparse(proj.resolve("at.jsonl"), published);
        sparse(proj.resolve("over.jsonl"), published + 1);

        assertThat(c.content("-proj/at.jsonl", local()).getStatusCode().value())
                .as("the published limit must actually be served, not refused")
                .isNotEqualTo(413);
        assertThat(c.content("-proj/over.jsonl", local()).getStatusCode().value())
                .as("one byte past the published limit must be refused")
                .isEqualTo(413);
    }

    /**
     * {@code ResponseEntity.status(413).build()} told the client nothing, which
     * is why the dialog could only print a bare status. The refusal names both
     * numbers so the reason survives the trip to the UI.
     *
     * <p>Reachable even with the rows disabled: the store is live. The owner's
     * transcript grew by 1.5 MB during this session, so a listing can go stale
     * between the render and the click.
     */
    @Test
    void aRefusalNamesTheSizeAndTheLimit() throws Exception {
        Path base = projects();
        Path proj = Files.createDirectories(base.resolve("-proj"));
        ClaudeTranscriptsController c = new ClaudeTranscriptsController(base);
        long over = c.transcripts(local()).getBody().limitBytes() + 4096;
        sparse(proj.resolve("over.jsonl"), over);

        ResponseEntity<Resource> res = c.content("-proj/over.jsonl", local());
        String body = bodyOf(res);

        assertThat(res.getStatusCode().value()).isEqualTo(413);
        assertThat(body)
                .as("the refusal must name the file's size")
                .contains(String.valueOf(over));
        assertThat(body)
                .as("the refusal must name the limit it was measured against")
                .contains(String.valueOf(c.transcripts(local()).getBody().limitBytes()));
    }

    /**
     * The read must not materialise the file.
     *
     * <p>{@code Files.readString} produced a UTF-16 String at twice the file's
     * size and then Spring encoded it back to UTF-8 for the wire. That expansion
     * is the whole reason the cap had to sit low, and it is what made the cap the
     * server's heap budget rather than a statement about what a browser can take.
     *
     * <p>Measured as thread allocation rather than heap usage, because allocation
     * is deterministic where {@code usedMemory} depends on when G1 felt like
     * running. Reading 24 MB via readString allocates at least the 48 MB of the
     * String alone; handing back a stream allocates a path and a handle.
     */
    @Test
    void contentDoesNotHoldTheWholeFileAsAString() throws Exception {
        Path base = projects();
        Path proj = Files.createDirectories(base.resolve("-proj"));
        Path big = proj.resolve("big.jsonl");
        byte[] line = "{\"type\":\"assistant\",\"pad\":\"0123456789abcdef\"}\n".getBytes(StandardCharsets.UTF_8);
        try (var out = Files.newOutputStream(big)) {
            for (int i = 0; i < 24 * 1024 * 1024 / line.length; i++) {
                out.write(line);
            }
        }
        long fileSize = Files.size(big);
        var threads = (com.sun.management.ThreadMXBean) java.lang.management.ManagementFactory.getThreadMXBean();
        long id = Thread.currentThread().threadId();

        long before = threads.getThreadAllocatedBytes(id);
        ResponseEntity<Resource> res = new ClaudeTranscriptsController(base).content("-proj/big.jsonl", local());
        long allocated = threads.getThreadAllocatedBytes(id) - before;

        assertThat(res.getStatusCode().value()).isEqualTo(200);
        assertThat(allocated)
                .as("serving a %d byte transcript allocated %d bytes, so it was read into heap",
                        fileSize, allocated)
                .isLessThan(fileSize / 4);
    }

    /**
     * The two endpoints told the same story about the same file. Stated as the
     * bug: the owner's transcript was listed and then refused, so the listing's
     * verdict and the content endpoint's behaviour must be probed as one round
     * trip, at the boundary, from both sides.
     */
    @Test
    void aFileTheListingCallsLoadableIsActuallyServed() throws Exception {
        Path base = projects();
        Path proj = Files.createDirectories(base.resolve("-proj"));
        ClaudeTranscriptsController c = new ClaudeTranscriptsController(base);
        long limit = c.transcripts(local()).getBody().limitBytes();
        sparse(proj.resolve("at.jsonl"), limit);
        sparse(proj.resolve("over.jsonl"), limit + 1);

        for (var row : c.transcripts(local()).getBody().transcripts()) {
            int status = c.content(row.path(), local()).getStatusCode().value();
            if (row.loadable()) {
                assertThat(status)
                        .as("%s was listed as loadable and then refused", row.file())
                        .isNotEqualTo(413);
            } else {
                assertThat(status)
                        .as("%s was listed as refused and then served", row.file())
                        .isEqualTo(413);
            }
        }
    }
}
