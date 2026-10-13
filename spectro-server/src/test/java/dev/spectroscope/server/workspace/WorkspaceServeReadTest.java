package dev.spectroscope.server.workspace;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Card 586, straggler M1: the read behind {@code /api/file} and
 * {@code /api/run-document} opens the checked path once, without following a
 * link, and takes at most one byte more than the cap. A link swapped in after
 * the path was resolved fails the open, and a file that grows after its size
 * was read cannot make the read unbounded.
 */
class WorkspaceServeReadTest {

    @TempDir
    Path dir;

    @Test
    void aFileUnderTheCapIsReadWhole() throws IOException {
        Path file = Files.writeString(dir.resolve("plan.md"), "# Plan\n");

        assertThat(new String(WorkspaceController.readBounded(file, 100), StandardCharsets.UTF_8))
                .isEqualTo("# Plan\n");
    }

    @Test
    void aFileOverTheCapYieldsOneByteMoreThanTheCap() throws IOException {
        Path file = Files.writeString(dir.resolve("big.txt"), "x".repeat(1000));

        assertThat(WorkspaceController.readBounded(file, 10)).hasSize(11);
    }

    @Test
    void aLinkIsNotFollowed() throws IOException {
        Path target = Files.writeString(dir.resolve("target.md"), "target");
        Path link = Files.createSymbolicLink(dir.resolve("link.md"), target);

        assertThatThrownBy(() -> WorkspaceController.readBounded(link, 100)).isInstanceOf(IOException.class);
        assertThat(WorkspaceController.readBounded(target, 100)).as("the target itself").hasSize(6);
    }
}
