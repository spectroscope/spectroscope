package dev.spectroscope.core.launch;

import dev.spectroscope.core.config.SpectroDir;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 350: one parser, two locations, and a precedence that is stated rather
 * than inherited from whichever {@code if} happened to be written first.
 *
 * <p>The owner's ruling on 2026-08-31 was two sentences long — read
 * {@code .claude}, write {@code .spectro} — and it does not reverse card 202.
 * A repository carrying only Claude Code's file still just works; that is the
 * first test here and it is the one that must never go red.
 *
 * <p>The precedence is <b>ours wins whole</b>, not a merge. Two files that each
 * carry a {@code dev} entry are two different answers to the same question, and
 * a merge would have to pick one of them per key while looking like it had
 * picked neither. Picking one FILE is a rule an operator can hold in his head,
 * and {@link LaunchFile#shadowed()} exists so the choice is announced instead of
 * being silent — the silence is the failure this card was cut to prevent.
 */
class LaunchLocationsTest {

    private static final String ONE_ENTRY = """
            { "version": "0.0.1", "configurations": [
              { "name": "%s", "runtimeExecutable": "python3",
                "runtimeArgs": ["-m", "http.server", "8000"], "port": 8000 } ] }
            """;

    /** Card 202 is not reversed: their file alone is still a working project. */
    @Test
    void aClaudeCodeProjectStillJustWorks(@TempDir Path project) throws Exception {
        writeAt(project, ".claude/launch.json", ONE_ENTRY.formatted("docs"));

        LaunchFile file = LaunchFile.readFrom(project).orElseThrow();

        assertEquals(List.of("docs"), file.names());
        assertEquals(".claude/launch.json", file.location());
        assertEquals(List.of(), file.shadowed(),
                "nothing was passed over — there is only one file");
    }

    /** Ours is read, and it is the one the product would have written. */
    @Test
    void spectroscopesOwnFileIsReadOnItsOwn(@TempDir Path project) throws Exception {
        writeAt(project, SpectroDir.NAME + "/launch.json", ONE_ENTRY.formatted("dev"));

        LaunchFile file = LaunchFile.readFrom(project).orElseThrow();

        assertEquals(List.of("dev"), file.names());
        assertEquals(".spectro/launch.json", file.location());
    }

    /** The stated precedence: ours wins WHOLE, and says what it shadowed. */
    @Test
    void whenBothExistOursWinsWholeAndSaysSo(@TempDir Path project) throws Exception {
        writeAt(project, SpectroDir.NAME + "/launch.json", ONE_ENTRY.formatted("ours"));
        writeAt(project, ".claude/launch.json", ONE_ENTRY.formatted("theirs"));

        LaunchFile file = LaunchFile.readFrom(project).orElseThrow();

        assertEquals(List.of("ours"), file.names(),
                "the entries come from ours only — a merge would carry both names");
        assertEquals(".spectro/launch.json", file.location());
        assertEquals(List.of(".claude/launch.json"), file.shadowed(),
                "the file that lost has to be named, or the disagreement is silent");
    }

    /** The order is the rule. A list whose first element changed changes the product. */
    @Test
    void theOrderIsOursThenTheirs() {
        assertEquals(List.of(".spectro/launch.json", ".claude/launch.json"),
                LaunchFile.LOCATIONS);
        assertEquals(".spectro/launch.json", LaunchFile.OURS);
        assertEquals(LaunchFile.LOCATIONS.get(0), LaunchFile.OURS,
                "the only location this product writes is the first one it reads");
    }

    /** A sentence for a reader who has neither file has to name both. */
    @Test
    void theSentenceForAnEmptyProjectNamesBothLocations() {
        String said = LaunchFile.LOCATIONS_SENTENCE;

        assertTrue(said.contains(".spectro/launch.json"), said);
        assertTrue(said.contains(".claude/launch.json"), said);
        assertTrue(said.indexOf(".spectro/launch.json") < said.indexOf(".claude/launch.json"),
                "the sentence has to read in the same order the reader looks: " + said);
    }

    /**
     * A sentence that says "neither" has to say "nor".
     *
     * <p>{@link LaunchFile#LOCATIONS_SENTENCE} folds the list with {@code " or "},
     * which reads correctly on its own ("carries no configuration in A or B") and
     * ungrammatically the moment a caller puts "neither" in front of it. This
     * pins the pair rather than the wording of either half: change the joiner to
     * {@code " nor "} and the callers may say "neither", but they cannot say one
     * without the other.
     */
    @Test
    void everySentenceBuiltOnTheLocationListAgreesWithItsJoiner() {
        for (String said : List.of(LaunchTools.NO_FILE, LaunchFile.LOCATIONS_SENTENCE)) {
            assertEquals(said.contains("neither "), said.contains(" nor "),
                    "\"neither\" needs \"nor\" and \"nor\" needs \"neither\": " + said);
        }
    }

    /** A project with neither file is still empty rather than an error. */
    @Test
    void neitherFileIsStillEmpty(@TempDir Path project) {
        assertEquals(Optional.empty(), LaunchFile.readFrom(project));
    }

    /**
     * An unreadable file of ours does NOT fall through to theirs.
     *
     * <p>Falling through would be the friendly-looking behaviour and the wrong
     * one: an operator who broke his own file would silently get somebody
     * else's configurations, and the launch he then plays is not the one he
     * edited. The first location that EXISTS is the one that answers, whether
     * it parses or not.
     */
    @Test
    void abrokenFileOfOursIsAnErrorRatherThanAFallThrough(@TempDir Path project)
            throws Exception {
        writeAt(project, SpectroDir.NAME + "/launch.json", "{ not json at all");
        writeAt(project, ".claude/launch.json", ONE_ENTRY.formatted("theirs"));

        IllegalArgumentException refused = org.junit.jupiter.api.Assertions.assertThrows(
                IllegalArgumentException.class, () -> LaunchFile.readFrom(project));

        assertTrue(refused.getMessage().contains(".spectro"), refused.getMessage());
        assertFalse(refused.getMessage().contains("theirs"), refused.getMessage());
    }

    /** Writes one file under the project, creating its folder. */
    private static void writeAt(Path project, String relative, String json) throws Exception {
        Path file = project.resolve(relative);
        Files.createDirectories(file.getParent());
        Files.writeString(file, json);
    }
}
