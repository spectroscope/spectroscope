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
 * Card 492, criterion 1: {@code careParagraph} is an ordinary on/off settings
 * key, ships off, and can be set at each of the three scopes the settings API
 * writes.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class CareParagraphSettingTest {

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
    void theShippedValueIsOff() {
        assertEquals("off", SpectroConfig.shippedDefaults().careParagraph());
        assertEquals("off", SpectroConfig.DEFAULT_CARE_PARAGRAPH);
    }

    @Test
    void bothValuesAreKnownAndNothingElseIs() {
        assertEquals(java.util.Set.of("on", "off"), SpectroConfig.KNOWN_CARE_PARAGRAPH_VALUES);
    }

    @Test
    void theCompatConstructorBuildsTheConfigMainBuiltWithTheKeyOff() {
        SpectroConfig compat = new SpectroConfig(
                "anthropic", "claude-opus-4-8", "http://localhost:11434", 100_000, "ask",
                List.of(), "gemini", true, List.of(), 2, true,
                List.of(), null, "info", null, null, "auto", "auto", null, null, null, null, null,
                null, false, false);
        assertEquals("off", compat.careParagraph());
    }

    @Test
    void anUnknownValueIsRefusedOnLoadAndTheMessageNamesTheFieldAndTheValues() throws IOException {
        Path settings = ws.resolve(SpectroConfig.PROJECT_SETTINGS);
        Files.createDirectories(settings.getParent());
        Files.writeString(settings, "{\"careParagraph\": \"gently\"}");

        IllegalArgumentException refused = assertThrows(IllegalArgumentException.class, this::loadHere);
        assertTrue(refused.getMessage().contains("careParagraph")
                        && refused.getMessage().contains("gently")
                        && refused.getMessage().contains("on") && refused.getMessage().contains("off"),
                "the message names field, value and the two choices: " + refused.getMessage());
    }

    @Test
    void theSettingsApiRefusesAnUnknownValueAndWritesNothing() {
        Path file = ws.resolve(SpectroConfig.PROJECT_SETTINGS);
        assertThrows(IllegalArgumentException.class, () -> SettingsWriter.patch(file,
                SettingsWriter.Scope.PROJECT,
                JSON.createObjectNode().put("careParagraph", "gently")));
        assertTrue(Files.notExists(file), "a refused patch wrote the file");
    }

    @Test
    void eachOfTheThreeScopesTurnsItOn() throws IOException {
        List<Path> files = List.of(
                SpectroConfig.USER_SETTINGS_PATH,
                ws.resolve(SpectroConfig.PROJECT_SETTINGS),
                ws.resolve(SpectroConfig.WS_LOCAL_SETTINGS));
        List<SettingsWriter.Scope> scopes = List.of(SettingsWriter.Scope.USER,
                SettingsWriter.Scope.PROJECT, SettingsWriter.Scope.LOCAL);
        for (int i = 0; i < 3; i++) {
            assertEquals("off", loadHere().careParagraph(),
                    "premise: nothing is set before scope " + scopes.get(i));
            SettingsWriter.patch(files.get(i), scopes.get(i),
                    JSON.createObjectNode().put("careParagraph", "on"));

            assertEquals("on", loadHere().careParagraph(),
                    "a save at scope " + scopes.get(i) + " did not reach the loaded config");
            Files.delete(files.get(i));
        }
    }

    @Test
    void theCopiesTheAppDerivesKeepTheSwitch() throws IOException {
        Path settings = ws.resolve(SpectroConfig.PROJECT_SETTINGS);
        Files.createDirectories(settings.getParent());
        Files.writeString(settings, "{\"careParagraph\": \"on\"}");
        SpectroConfig on = loadHere();
        assertEquals("on", on.careParagraph(), "premise");

        assertEquals("on", on.withProvider("ollama", "some-model").careParagraph());
        assertEquals("on", on.withRtkFilter(SpectroConfig.RTK_FILTER_ON).careParagraph());
        assertEquals("on", on.withDesktopNotifications("off").careParagraph());
        assertEquals("on", on.withToolGroupsOff(List.of("browser")).careParagraph());
    }
}
