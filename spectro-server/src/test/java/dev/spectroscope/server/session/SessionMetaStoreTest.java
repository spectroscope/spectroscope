package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Card 445, criterion 5: title and pin live in a small store beside the
 * sessions, never in a session's JSONL.
 *
 * <p>Every test builds a SECOND store on the same file before it reads, which
 * is what a server restart does: nothing here may pass on memory alone.</p>
 */
class SessionMetaStoreTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir
    Path home;

    private Path file() {
        return home.resolve("session-meta.json");
    }

    private SessionMetaStore store() {
        return new SessionMetaStore(file());
    }

    @Test
    void aManualTitleIsStoredAndSurvivesARestart() {
        store().rename("s1", "Release 0.14.0");

        SessionMetaStore.Entry entry = store().get("s1").orElseThrow();
        assertThat(entry.title()).isEqualTo("Release 0.14.0");
        assertThat(entry.titleSource()).isEqualTo(SessionMetaStore.MANUAL);
        assertThat(entry.pinned()).isFalse();
    }

    @Test
    void aSuggestionIsStoredAsSuggested() {
        store().suggest("s1", "Subagenten und Workflows Review");

        SessionMetaStore.Entry entry = store().get("s1").orElseThrow();
        assertThat(entry.title()).isEqualTo("Subagenten und Workflows Review");
        assertThat(entry.titleSource()).isEqualTo(SessionMetaStore.SUGGESTED);
    }

    @Test
    void aSuggestionNeverOverwritesATitleTheOperatorSetByHand() {
        store().rename("s1", "Release 0.14.0");
        store().suggest("s1", "Subagenten und Workflows Review");

        SessionMetaStore.Entry entry = store().get("s1").orElseThrow();
        assertThat(entry.title()).isEqualTo("Release 0.14.0");
        assertThat(entry.titleSource()).isEqualTo(SessionMetaStore.MANUAL);
    }

    @Test
    void aSuggestionReplacesAnEarlierSuggestion() {
        store().suggest("s1", "First guess");
        store().suggest("s1", "Second guess");

        assertThat(store().get("s1").orElseThrow().title()).isEqualTo("Second guess");
    }

    @Test
    void anEmptyRenameRestoresTheSuggestedTitle() {
        store().suggest("s1", "Subagenten und Workflows Review");
        store().rename("s1", "Release 0.14.0");
        store().rename("s1", "   ");

        SessionMetaStore.Entry entry = store().get("s1").orElseThrow();
        assertThat(entry.title()).isEqualTo("Subagenten und Workflows Review");
        assertThat(entry.titleSource()).isEqualTo(SessionMetaStore.SUGGESTED);
    }

    @Test
    void anEmptyRenameWithoutASuggestionLeavesNoTitleSoTheRowFallsBackToTheFirstPrompt() {
        store().rename("s1", "Release 0.14.0");
        store().rename("s1", "");

        assertThat(store().get("s1")).isEmpty();
    }

    @Test
    void aManualTitleIsOneLineAndCutAtTheNamedLength() {
        String longTitle = "word ".repeat(40);
        store().rename("s1", "  two\nlines\tand   gaps  ");
        store().rename("s2", longTitle);

        assertThat(store().get("s1").orElseThrow().title()).isEqualTo("two lines and gaps");
        String cut = store().get("s2").orElseThrow().title();
        assertThat(cut.length()).isLessThanOrEqualTo(SessionMetaStore.TITLE_MAX_CHARS);
        assertThat(cut).startsWith("word word").doesNotEndWith(" ");
    }

    @Test
    void pinAndUnpinSurviveARestart() {
        store().pin("s1", true);
        assertThat(store().get("s1").orElseThrow().pinned()).isTrue();

        store().pin("s1", false);
        assertThat(store().get("s1")).as("an entry with nothing left in it is dropped").isEmpty();
    }

    @Test
    void pinKeepsTheTitleAndRenameKeepsThePin() {
        store().rename("s1", "Release 0.14.0");
        store().pin("s1", true);
        store().rename("s1", "Release 0.14.1");

        SessionMetaStore.Entry entry = store().get("s1").orElseThrow();
        assertThat(entry.title()).isEqualTo("Release 0.14.1");
        assertThat(entry.pinned()).isTrue();
    }

    @Test
    void removeDropsTitleAndPinTogether() {
        store().rename("s1", "Release 0.14.0");
        store().pin("s1", true);
        store().rename("s2", "Keep me");

        assertThat(store().remove("s1")).isTrue();
        assertThat(store().remove("s1")).as("nothing left to remove").isFalse();

        assertThat(store().get("s1")).isEmpty();
        assertThat(store().get("s2")).isPresent();
    }

    @Test
    void allReturnsEveryEntryKeyedById() {
        store().rename("s1", "One");
        store().pin("s2", true);

        assertThat(store().all()).containsOnlyKeys("s1", "s2");
    }

    @Test
    void theFileIsKeyedBySessionIdWithTitleTitleSourceAndPinned() throws IOException {
        store().suggest("s1", "Subagenten und Workflows Review");
        store().pin("s1", true);

        JsonNode root = JSON.readTree(Files.readString(file()));
        assertThat(root.path("s1").path("title").asText()).isEqualTo("Subagenten und Workflows Review");
        assertThat(root.path("s1").path("titleSource").asText()).isEqualTo("suggested");
        assertThat(root.path("s1").path("pinned").asBoolean()).isTrue();
    }

    @Test
    void aWriteLeavesNoTemporaryFileBehind() throws IOException {
        store().rename("s1", "One");
        store().pin("s1", true);

        try (Stream<Path> entries = Files.list(home)) {
            assertThat(entries.map(path -> path.getFileName().toString()).toList())
                    .containsExactly("session-meta.json");
        }
    }

    @Test
    void aWriteThatDiesHalfWayLeavesTheOldFileWhole() throws IOException {
        store().rename("s1", "Before the crash");
        String before = Files.readString(file());

        SessionMetaStore dying = new SessionMetaStore(file(), (target, bytes) -> {
            // Half the bytes reach the disk, then the process dies.
            Files.write(target, java.util.Arrays.copyOf(bytes, bytes.length / 2));
            throw new IOException("the machine lost power");
        });
        assertThatThrownBy(() -> dying.rename("s1", "After the crash"))
                .isInstanceOf(java.io.UncheckedIOException.class);

        assertThat(Files.readString(file())).isEqualTo(before);
        assertThat(store().get("s1").orElseThrow().title()).isEqualTo("Before the crash");
        try (Stream<Path> entries = Files.list(home)) {
            assertThat(entries.map(path -> path.getFileName().toString()).toList())
                    .as("the half-written temporary file is cleaned up")
                    .containsExactly("session-meta.json");
        }
    }

    @Test
    void anUnreadableFileReadsAsEmptyInsteadOfBreakingTheList() throws IOException {
        Files.writeString(file(), "{ not json", StandardCharsets.UTF_8);

        assertThat(store().all()).isEmpty();
        assertThat(store().get("s1")).isEmpty();
    }

    @Test
    void aMissingFileReadsAsEmpty() {
        assertThat(store().all()).isEmpty();
        assertThat(List.copyOf(store().all().keySet())).isEmpty();
    }
}
