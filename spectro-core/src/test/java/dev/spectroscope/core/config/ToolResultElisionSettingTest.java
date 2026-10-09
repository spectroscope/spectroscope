package dev.spectroscope.core.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 467, criterion 6: {@code toolResultElision} is a settings key with two
 * values, ships on, and can be set at each of the three scopes the settings
 * API writes: the user file, a workspace's shared file and its local file.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class ToolResultElisionSettingTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir
    Path ws;

    @AfterEach
    void removeUserSettings() throws IOException {
        Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
    }

    private SpectroConfig loadHere() {
        return SpectroConfig.loadForWorkspace(SpectroConfig.Overrides.none(),
                ws.resolve("nowhere"), ws);
    }

    @Test
    void theShippedValueIsOn() {
        assertEquals(SpectroConfig.TOOL_RESULT_ELISION_ON,
                SpectroConfig.shippedDefaults().toolResultElision());
    }

    @Test
    void bothValuesAreKnownAndNothingElseIs() {
        assertEquals(java.util.Set.of(SpectroConfig.TOOL_RESULT_ELISION_ON,
                SpectroConfig.TOOL_RESULT_ELISION_OFF), SpectroConfig.KNOWN_TOOL_RESULT_ELISION_VALUES);
    }

    @Test
    void anUnknownValueIsRefusedOnLoadAndTheMessageNamesTheFieldAndTheValues() throws IOException {
        Path settings = ws.resolve(SpectroConfig.PROJECT_SETTINGS);
        Files.createDirectories(settings.getParent());
        Files.writeString(settings, "{\"toolResultElision\": \"sometimes\"}");

        IllegalArgumentException refused = assertThrows(IllegalArgumentException.class,
                this::loadHere);
        assertTrue(refused.getMessage().contains("toolResultElision")
                        && refused.getMessage().contains("sometimes")
                        && refused.getMessage().contains("on") && refused.getMessage().contains("off"),
                "the message names field, value and the two choices: " + refused.getMessage());
    }

    @Test
    void theSettingsApiRefusesAnUnknownValueAndWritesNothing() {
        Path file = ws.resolve(SpectroConfig.PROJECT_SETTINGS);
        assertThrows(IllegalArgumentException.class, () -> SettingsWriter.patch(file,
                SettingsWriter.Scope.PROJECT,
                JSON.createObjectNode().put("toolResultElision", "sometimes")));
        assertTrue(Files.notExists(file), "a refused patch wrote the file");
    }

    @Test
    void eachOfTheThreeScopesTurnsItOff() throws IOException {
        List<Path> files = List.of(
                SpectroConfig.USER_SETTINGS_PATH,
                ws.resolve(SpectroConfig.PROJECT_SETTINGS),
                ws.resolve(SpectroConfig.WS_LOCAL_SETTINGS));
        List<SettingsWriter.Scope> scopes = List.of(SettingsWriter.Scope.USER,
                SettingsWriter.Scope.PROJECT, SettingsWriter.Scope.LOCAL);
        for (int i = 0; i < 3; i++) {
            assertEquals(SpectroConfig.TOOL_RESULT_ELISION_ON, loadHere().toolResultElision(),
                    "premise: nothing is set before scope " + scopes.get(i));
            SettingsWriter.patch(files.get(i), scopes.get(i),
                    JSON.createObjectNode().put("toolResultElision", "off"));

            assertEquals(SpectroConfig.TOOL_RESULT_ELISION_OFF, loadHere().toolResultElision(),
                    "a save at scope " + scopes.get(i) + " did not reach the loaded config");
            Files.delete(files.get(i));
        }
    }

    @Test
    void theCopiesTheAppDerivesKeepTheSwitch() throws IOException {
        Path settings = ws.resolve(SpectroConfig.PROJECT_SETTINGS);
        Files.createDirectories(settings.getParent());
        Files.writeString(settings, "{\"toolResultElision\": \"off\"}");
        SpectroConfig off = loadHere();
        assertEquals("off", off.toolResultElision(), "premise");

        assertEquals("off", off.withProvider("ollama", "some-model").toolResultElision(),
                "switching the model mid-session turned the elision back on");
        assertEquals("off", off.withRtkFilter(SpectroConfig.RTK_FILTER_ON).toolResultElision(),
                "turning rtk on turned the elision back on");
    }
}
