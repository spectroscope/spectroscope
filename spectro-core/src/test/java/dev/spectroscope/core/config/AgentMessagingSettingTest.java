package dev.spectroscope.core.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.lang.reflect.RecordComponent;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 503, criterion 10: {@code agentMessaging} is one boolean key, ships
 * true, is appended last in {@link SpectroConfig}, and every scope of the
 * settings API can switch it off.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class AgentMessagingSettingTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir
    Path ws;

    @AfterEach
    void removeUserSettings() throws IOException {
        Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
    }

    private SpectroConfig loadHere() {
        return SpectroConfig.loadForWorkspace(SpectroConfig.Overrides.none(), ws.resolve("nowhere"), ws);
    }

    @Test
    void theShippedValueIsOn() {
        assertTrue(SpectroConfig.shippedDefaults().agentMessaging());
        assertTrue(SpectroConfig.DEFAULT_AGENT_MESSAGING);
    }

    @Test
    void theKeyIsTheLastComponentAndABoolean() {
        RecordComponent[] components = SpectroConfig.class.getRecordComponents();
        RecordComponent last = components[components.length - 1];
        assertEquals("agentMessaging", last.getName());
        assertEquals(boolean.class, last.getType());
        // Integration 0.15.2: card 528 appended sttRunner before this key.
        assertEquals("sttRunner", components[components.length - 2].getName(),
                "appended after the last key before it");
    }

    @Test
    void theV0151ArityStillBuildsAndShipsItOn() {
        SpectroConfig compat = new SpectroConfig(
                "anthropic", "claude-opus-4-8", "http://localhost:11434", 100_000, "ask",
                List.of(), "gemini", true, List.of(), 2, true,
                List.of(), null, "info", null, null, "auto", "auto", null, null, null, null, null,
                null, false, false);
        assertTrue(compat.agentMessaging());
    }

    @Test
    void eachOfTheThreeScopesSwitchesItOff() throws IOException {
        List<Path> files = List.of(
                SpectroConfig.USER_SETTINGS_PATH,
                ws.resolve(SpectroConfig.PROJECT_SETTINGS),
                ws.resolve(SpectroConfig.WS_LOCAL_SETTINGS));
        List<SettingsWriter.Scope> scopes = List.of(SettingsWriter.Scope.USER,
                SettingsWriter.Scope.PROJECT, SettingsWriter.Scope.LOCAL);
        for (int i = 0; i < 3; i++) {
            assertTrue(loadHere().agentMessaging(), "premise: nothing is set before scope " + scopes.get(i));
            SettingsWriter.patch(files.get(i), scopes.get(i), JSON.createObjectNode().put("agentMessaging", false));
            assertFalse(loadHere().agentMessaging(), "a save at scope " + scopes.get(i) + " did not reach the config");
            Files.delete(files.get(i));
        }
    }

    @Test
    void aValueThatIsNotABooleanIsRefusedAndWritesNothing() {
        Path file = ws.resolve(SpectroConfig.PROJECT_SETTINGS);
        assertThrows(IllegalArgumentException.class, () -> SettingsWriter.patch(file,
                SettingsWriter.Scope.PROJECT, JSON.createObjectNode().put("agentMessaging", "off")));
        assertTrue(Files.notExists(file), "a refused patch wrote the file");
    }

    @Test
    void aSettingsFileSwitchesItOffAndTheDerivedCopiesKeepIt() throws IOException {
        Path settings = ws.resolve(SpectroConfig.PROJECT_SETTINGS);
        Files.createDirectories(settings.getParent());
        Files.writeString(settings, "{\"agentMessaging\": false}");
        SpectroConfig loaded = loadHere();
        assertFalse(loaded.agentMessaging());
        assertFalse(loaded.withProvider("ollama", "qwen2.5:7b").agentMessaging());
    }
}
