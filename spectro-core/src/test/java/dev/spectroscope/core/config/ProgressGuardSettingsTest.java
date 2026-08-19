package dev.spectroscope.core.config;

import dev.spectroscope.core.progress.ProgressSettings;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 262, criterion 6: the guard's numbers are configurable, and its defaults
 * are stated rather than discovered.
 *
 * <p>Two sources of truth had to be kept from drifting: the config record's
 * defaults and {@link ProgressSettings}'s own. They are the same three numbers
 * seen from two sides — the settings file and the object the loop runs on — and
 * the day they disagree, an operator's file says one thing while the guard does
 * another, with nothing red anywhere.</p>
 */
class ProgressGuardSettingsTest {

    @Test
    void theShippedDefaultsAreTheOnesTheCardStates(@TempDir Path dir) {
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), dir);
        assertEquals(3, config.progressGuardWrites(),
                "the same bytes under a THIRD new name is where a second copy stops"
                        + " explaining it");
        assertEquals(3, config.progressGuardFailures(),
                "above the two failures a flaky test is allowed (criterion 5)");
        assertEquals(0, config.progressGuardPlanTurns(),
                "the plan net ships OFF: it needs a plan that exists and is maintained,"
                        + " and the weak local models this guard was cut for keep none");
    }

    @Test
    void theConfigAndTheGuardsOwnDefaultsAreTheSameThreeNumbers(@TempDir Path dir) {
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), dir);
        ProgressSettings shipped = ProgressSettings.defaults();
        assertEquals(shipped.identicalWrites(), config.progressGuardWrites());
        assertEquals(shipped.repeatedFailures(), config.progressGuardFailures());
        assertEquals(shipped.stalledPlanTurns(), config.progressGuardPlanTurns());
    }

    @Test
    void aSettingsFileMovesEveryOneOfThem(@TempDir Path dir) throws Exception {
        Files.createDirectories(dir.resolve(".spectro"));
        Files.writeString(dir.resolve(SpectroConfig.PROJECT_SETTINGS), """
                { "progressGuardWrites": 7,
                  "progressGuardFailures": 0,
                  "progressGuardPlanTurns": 4 }
                """);
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), dir);
        assertEquals(7, config.progressGuardWrites());
        assertEquals(0, config.progressGuardFailures(),
                "zero is the off switch, and it has to survive the layer fold —"
                        + " an Optional.orElse over a primitive default would swallow it");
        assertEquals(4, config.progressGuardPlanTurns());
        assertEquals(0, new ProgressSettings(config.progressGuardWrites(),
                config.progressGuardFailures(), config.progressGuardPlanTurns())
                .repeatedFailures());
    }

    @Test
    void theSettingsApiAcceptsTheKeysRatherThanRefusingThem() {
        // The card-203-F2 class of defect: a key the record knows and the writer
        // does not is a silent refusal on the one working save path.
        assertTrue(SettingsWriter.knownKeys().contains("progressGuardWrites"));
        assertTrue(SettingsWriter.knownKeys().contains("progressGuardFailures"));
        assertTrue(SettingsWriter.knownKeys().contains("progressGuardPlanTurns"));
        assertThrows(UnsupportedOperationException.class,
                () -> SettingsWriter.knownKeys().add("progressGuardMood"),
                "the key list is the contract, not a suggestion");
    }
}
