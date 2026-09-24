package dev.spectroscope.core.config;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The one table of floors (card 386, criterion 4) and the report a read makes
 * of what it skipped (criterion 5).
 */
class SettingFloorsTest {

    @AfterEach
    void removeUserConfig() throws IOException {
        Files.deleteIfExists(SpectroConfig.CONFIG_PATH);
        Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
    }

    @Test
    void theTableIsTheCardsTableInTheCardsOrder() {
        assertEquals(List.copyOf(BelowFloorTest.CARD_TABLE.entrySet()),
                List.copyOf(SettingFloors.floors().entrySet()));
    }

    @Test
    void aKeyWhoseZeroIsLegalSaysWhatZeroMeans() {
        for (SettingFloors.Floor floor : SettingFloors.table()) {
            if (floor.floor() == 0) {
                assertTrue(floor.zeroMeans() != null && !floor.zeroMeans().isBlank(),
                        floor.key() + " allows zero and does not say what it means");
            } else {
                assertNull(floor.zeroMeans(), floor.key() + " refuses zero and still describes it");
            }
        }
    }

    @Test
    void everyFlooredKeyIsANumberSettingTheWriterAccepts() throws NoSuchFieldException {
        for (String key : SettingFloors.floors().keySet()) {
            assertTrue(SettingsWriter.knownKeys().contains(key), key + " is not a settings key");
            Field field = SpectroConfig.PartialConfig.class.getField(key);
            assertEquals(Integer.class, field.getType(), key + " is not a whole-number setting");
        }
    }

    @Test
    void aReadNamesTheKeyTheValueTheFloorAndTheFile(@TempDir Path dir) throws IOException {
        Files.createDirectories(dir.resolve(".spectro"));
        Path file = dir.resolve(SpectroConfig.PROJECT_SETTINGS);
        Files.writeString(file, "{ \"commandTimeoutSeconds\": 0, \"maxTurns\": 40 }");

        SpectroConfig.Resolved resolved =
                SpectroConfig.loadResolved(SpectroConfig.Overrides.none(), dir, null, Map.of());

        assertEquals(1, resolved.belowFloor().size(), resolved.belowFloor().toString());
        SettingFloors.Skipped skipped = resolved.belowFloor().get(0);
        assertEquals("commandTimeoutSeconds", skipped.key());
        assertEquals("0", skipped.value());
        assertEquals(1, skipped.floor());
        assertEquals("launch-dir", skipped.layer());
        assertEquals(file.toString(), skipped.file());
        assertTrue(skipped.message().contains("floor of 1"), skipped.message());
    }

    @Test
    void aFileWithEveryValueAtOrAboveItsFloorReportsNothing(@TempDir Path dir) throws IOException {
        Files.createDirectories(dir.resolve(".spectro"));
        Files.writeString(dir.resolve(SpectroConfig.PROJECT_SETTINGS),
                "{ \"commandTimeoutSeconds\": 1, \"questionsPerRun\": 0, \"dockMaxWidth\": 260 }");
        SpectroConfig.Resolved resolved =
                SpectroConfig.loadResolved(SpectroConfig.Overrides.none(), dir, null, Map.of());
        assertTrue(resolved.belowFloor().isEmpty(), resolved.belowFloor().toString());
        assertEquals(1, resolved.config().commandTimeoutSeconds());
    }

    @Test
    void bothWorkspaceScopesAreFlooredAndNamedByLayer(@TempDir Path dir, @TempDir Path ws)
            throws IOException {
        Files.createDirectories(ws.resolve(".spectro"));
        Files.writeString(ws.resolve(SpectroConfig.PROJECT_SETTINGS), "{ \"maxTokens\": 0 }");
        Files.writeString(ws.resolve(".spectro/settings.local.json"), "{ \"dockMaxWidth\": 100 }");
        SpectroConfig.Resolved resolved =
                SpectroConfig.loadResolved(SpectroConfig.Overrides.none(), dir, ws, Map.of());
        assertEquals(List.of("project:maxTokens", "local:dockMaxWidth"),
                resolved.belowFloor().stream().map(s -> s.layer() + ":" + s.key()).toList());
    }
}
