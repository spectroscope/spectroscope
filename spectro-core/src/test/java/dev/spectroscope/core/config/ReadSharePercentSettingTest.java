package dev.spectroscope.core.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.subagents.SubagentConfig;
import dev.spectroscope.core.tools.ReadBudget;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 493, criterion 3: the share of the context window one whole-file read
 * may take is a settings key. It ships at 25, the value of the constant
 * {@link ReadBudget#WINDOW_SHARE_PERCENT} it replaces, and its floor is 1.
 */
class ReadSharePercentSettingTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @AfterEach
    void removeUserConfig() throws IOException {
        Files.deleteIfExists(SpectroConfig.CONFIG_PATH);
        Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
    }

    private static void writeProject(Path dir, String json) throws IOException {
        Files.createDirectories(dir.resolve(".spectro"));
        Files.writeString(dir.resolve(SpectroConfig.PROJECT_SETTINGS), json);
    }

    @Test
    void theKeyShipsAtTheConstantItReplaces(@TempDir Path dir) {
        assertEquals(25, ReadBudget.WINDOW_SHARE_PERCENT, "premise: the share v0.14.4 shipped");
        assertEquals(ReadBudget.WINDOW_SHARE_PERCENT,
                SpectroConfig.load(SpectroConfig.Overrides.none(), dir).readSharePercent(),
                "a config with nothing set reads with another share than v0.14.4 did");
    }

    @Test
    void aSettingsFileSetsIt(@TempDir Path dir) throws IOException {
        writeProject(dir, """
                { "readSharePercent": 10 }
                """);
        assertEquals(10, SpectroConfig.load(SpectroConfig.Overrides.none(), dir).readSharePercent());
    }

    @Test
    void itsFloorIsOne() {
        assertEquals(1, SettingFloors.floors().get("readSharePercent"));
    }

    @Test
    void theWriterRefusesZero(@TempDir Path dir) {
        Path file = dir.resolve("settings.json");
        IllegalArgumentException refused = assertThrows(IllegalArgumentException.class,
                () -> SettingsWriter.patch(file, SettingsWriter.Scope.LOCAL,
                        JSON.readTree("{\"readSharePercent\":0}")));
        assertTrue(refused.getMessage().contains("readSharePercent"), refused.getMessage());
    }

    @Test
    void theWriterTakesTheFloorItself(@TempDir Path dir) throws IOException {
        Path file = dir.resolve("settings.json");
        SettingsWriter.patch(file, SettingsWriter.Scope.LOCAL, JSON.readTree("{\"readSharePercent\":1}"));
        assertEquals(1, JSON.readTree(Files.readString(file)).path("readSharePercent").asInt());
    }

    @Test
    void theLoaderSkipsZeroAndTheLayerBelowApplies(@TempDir Path dir) throws IOException {
        writeProject(dir, """
                { "readSharePercent": 0 }
                """);
        SpectroConfig.Resolved read = SpectroConfig.loadForWorkspaceWithReport(
                SpectroConfig.Overrides.none(), dir, dir);
        assertEquals(ReadBudget.WINDOW_SHARE_PERCENT, read.config().readSharePercent(),
                "a share below the floor reached the reads instead of being skipped");
    }

    @Test
    void provenanceKnowsTheField(@TempDir Path dir) throws IOException {
        writeProject(dir, """
                { "readSharePercent": 12 }
                """);
        var resolved = SpectroConfig.loadResolved(SpectroConfig.Overrides.none(), dir, null,
                java.util.Map.of());
        assertEquals("launch-dir", resolved.origins().get("readSharePercent").winner());
    }

    /** Criterion 3 with the reach rule of {@code AgentBuildReachDriftTest}: a
     *  field of the same name and boxed type in both records an agent is built
     *  from, so the guard asks every face for it. */
    @Test
    void bothAgentRecordsCarryAFieldOfTheSameName() {
        assertTrue(Arrays.stream(AgentOptions.class.getRecordComponents())
                .anyMatch(c -> c.getName().equals("readSharePercent") && c.getType() == Integer.class));
        assertTrue(Arrays.stream(SubagentConfig.class.getRecordComponents())
                .anyMatch(c -> c.getName().equals("readSharePercent") && c.getType() == Integer.class));
    }
}
