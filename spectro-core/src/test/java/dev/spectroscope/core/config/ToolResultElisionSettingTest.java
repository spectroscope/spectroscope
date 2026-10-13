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

import dev.spectroscope.core.session.ToolResultElision;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 467, criterion 6: {@code toolResultElision} is a settings key with two
 * values. Card 600: it ships off, and since its fix round 1 only the user
 * scope may set it; a workspace's shared file and its local file lose the key
 * the way they lose every key a workspace scope may not hold.
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
    void theShippedValueIsOff() {
        assertEquals(SpectroConfig.TOOL_RESULT_ELISION_OFF,
                SpectroConfig.shippedDefaults().toolResultElision());
    }

    @Test
    void anUnsetSwitchIsOffAndOnlyOnTurnsItOn() {
        assertFalse(ToolResultElision.enabled(null), "card 600: unset is the shipped off");
        assertFalse(ToolResultElision.enabled(SpectroConfig.TOOL_RESULT_ELISION_OFF));
        assertTrue(ToolResultElision.enabled(SpectroConfig.TOOL_RESULT_ELISION_ON));
    }

    @Test
    void bothValuesAreKnownAndNothingElseIs() {
        assertEquals(java.util.Set.of(SpectroConfig.TOOL_RESULT_ELISION_ON,
                SpectroConfig.TOOL_RESULT_ELISION_OFF), SpectroConfig.KNOWN_TOOL_RESULT_ELISION_VALUES);
    }

    @Test
    void anUnknownValueIsRefusedOnLoadAndTheMessageNamesTheFieldAndTheValues() throws IOException {
        Files.createDirectories(SpectroConfig.USER_SETTINGS_PATH.getParent());
        Files.writeString(SpectroConfig.USER_SETTINGS_PATH, "{\"toolResultElision\": \"sometimes\"}");

        IllegalArgumentException refused = assertThrows(IllegalArgumentException.class,
                this::loadHere);
        assertTrue(refused.getMessage().contains("toolResultElision")
                        && refused.getMessage().contains("sometimes")
                        && refused.getMessage().contains("on") && refused.getMessage().contains("off"),
                "the message names field, value and the two choices: " + refused.getMessage());
    }

    @Test
    void theSettingsApiRefusesAnUnknownValueAndWritesNothing() {
        assertThrows(IllegalArgumentException.class, () -> SettingsWriter.patch(
                SpectroConfig.USER_SETTINGS_PATH, SettingsWriter.Scope.USER,
                JSON.createObjectNode().put("toolResultElision", "sometimes")));
        assertTrue(Files.notExists(SpectroConfig.USER_SETTINGS_PATH), "a refused patch wrote the file");
    }

    @Test
    void theUserScopeTurnsItOn() throws IOException {
        assertEquals(SpectroConfig.TOOL_RESULT_ELISION_OFF, loadHere().toolResultElision(),
                "premise: nothing is set");
        SettingsWriter.patch(SpectroConfig.USER_SETTINGS_PATH, SettingsWriter.Scope.USER,
                JSON.createObjectNode().put("toolResultElision", "on"));

        assertEquals(SpectroConfig.TOOL_RESULT_ELISION_ON, loadHere().toolResultElision(),
                "a save at user scope did not reach the loaded config");
    }

    @Test
    void itIsOnTheListOfKeysAWorkspaceScopeMayNotHold() {
        // Card 600, fix round 1: the owner's rule is on everywhere or off
        // everywhere, so the checkbox, which writes the user settings, is the
        // only place the value comes from.
        assertTrue(SpectroConfig.workspaceScopeForbiddenKeys().contains("toolResultElision"),
                SpectroConfig.workspaceScopeForbiddenKeys().toString());
    }

    @Test
    void aFolderFileSayingOnLosesTheKeyAndTheReportNamesIt() throws IOException {
        for (Path file : List.of(ws.resolve(SpectroConfig.PROJECT_SETTINGS),
                ws.resolve(SpectroConfig.WS_LOCAL_SETTINGS))) {
            Files.createDirectories(file.getParent());
            Files.writeString(file, "{\"toolResultElision\": \"on\", \"model\": \"some-model\"}");

            SpectroConfig config = loadHere();
            SpectroConfig.ScopeReport report =
                    SpectroConfig.reportFor(ws.resolve("nowhere"), ws, java.util.Map.of());

            assertEquals(SpectroConfig.TOOL_RESULT_ELISION_OFF, config.toolResultElision(),
                    file.getFileName() + " turned the elision on from a folder");
            assertEquals("some-model", config.model(),
                    "the legal key beside it in " + file.getFileName() + " still applies");
            assertEquals(List.of("toolResultElision"), report.dropped(),
                    "the refusal for " + file.getFileName() + " names the key it dropped");
            Files.delete(file);
        }
    }

    @Test
    void theUserOnWinsOverAFolderFileSayingOff() throws IOException {
        SettingsWriter.patch(SpectroConfig.USER_SETTINGS_PATH, SettingsWriter.Scope.USER,
                JSON.createObjectNode().put("toolResultElision", "on"));
        Path folder = ws.resolve(SpectroConfig.PROJECT_SETTINGS);
        Files.createDirectories(folder.getParent());
        Files.writeString(folder, "{\"toolResultElision\": \"off\"}");

        assertEquals(SpectroConfig.TOOL_RESULT_ELISION_ON, loadHere().toolResultElision(),
                "a folder file saying off overrode the user's on");
    }

    @Test
    void theSettingsApiRefusesItInBothWorkspaceScopesAndWritesNothing() {
        for (SettingsWriter.Scope scope : List.of(SettingsWriter.Scope.PROJECT,
                SettingsWriter.Scope.LOCAL)) {
            Path file = ws.resolve(scope == SettingsWriter.Scope.PROJECT
                    ? SpectroConfig.PROJECT_SETTINGS : SpectroConfig.WS_LOCAL_SETTINGS);
            assertThrows(IllegalArgumentException.class, () -> SettingsWriter.patch(file, scope,
                    JSON.createObjectNode().put("toolResultElision", "on")), scope.toString());
            assertTrue(Files.notExists(file), "a refused patch wrote " + file.getFileName());
        }
    }

    @Test
    void aFileThatSaysOnKeepsItsValueInTheCopiesTheAppDerives() throws IOException {
        // Card 600, criterion 4: a settings file that says on keeps saying on.
        Files.createDirectories(SpectroConfig.USER_SETTINGS_PATH.getParent());
        Files.writeString(SpectroConfig.USER_SETTINGS_PATH, "{\"toolResultElision\": \"on\"}");
        SpectroConfig on = loadHere();
        assertEquals("on", on.toolResultElision(), "a file that says on lost its value on load");

        assertEquals("on", on.withProvider("ollama", "some-model").toolResultElision(),
                "switching the model mid-session turned the switch off");
        assertEquals("on", on.withRtkFilter(SpectroConfig.RTK_FILTER_ON).toolResultElision(),
                "turning rtk on turned the switch off");
    }
}
