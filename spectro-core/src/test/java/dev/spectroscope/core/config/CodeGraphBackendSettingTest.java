package dev.spectroscope.core.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.codegraph.CodeGraphBackend;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 587, criterion 6: {@code codeGraphBackend} names the program behind the
 * code graph. Its legal values are the backends the app knows, graphify ships
 * and is the only one, and a folder may name it like any project key.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class CodeGraphBackendSettingTest {

    @Test
    void theShippedValueIsGraphifyAndTheLegalValuesAreTheBackends() {
        assertEquals("graphify", SpectroConfig.shippedDefaults().codeGraphBackend());
        assertEquals(CodeGraphBackend.DEFAULT, SpectroConfig.DEFAULT_CODE_GRAPH_BACKEND);
        assertEquals(CodeGraphBackend.names(), SpectroConfig.KNOWN_CODE_GRAPH_BACKENDS);
    }

    @Test
    void theKeyIsTheLastComponentAndAString() {
        java.lang.reflect.RecordComponent[] components = SpectroConfig.class.getRecordComponents();
        assertEquals("codeGraphBackend", components[components.length - 1].getName());
        assertEquals(String.class, components[components.length - 1].getType());
        assertEquals("agentMessaging", components[components.length - 2].getName(),
                "appended after the last key before it");
    }

    @Test
    void graphifyInTheLaunchDirectoryLoadsAndArrives(@TempDir Path projectDir) throws IOException {
        Files.createDirectories(projectDir.resolve(".spectro"));
        Files.writeString(projectDir.resolve(".spectro/settings.json"), "{ \"codeGraphBackend\": \"graphify\" }");
        SpectroConfig loaded = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, Map.of());
        assertEquals("graphify", loaded.codeGraphBackend());
    }

    @Test
    void anUnknownBackendIsRefusedOnLoadAndTheMessageNamesTheKeyAndTheBackends(@TempDir Path projectDir)
            throws IOException {
        Files.createDirectories(projectDir.resolve(".spectro"));
        Files.writeString(projectDir.resolve(".spectro/settings.json"), "{ \"codeGraphBackend\": \"othergraph\" }");
        IllegalArgumentException refused = assertThrows(IllegalArgumentException.class,
                () -> SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, Map.of()));
        assertTrue(refused.getMessage().contains("codeGraphBackend"), refused.getMessage());
        assertTrue(refused.getMessage().contains("othergraph"), refused.getMessage());
        assertTrue(refused.getMessage().contains("graphify"), refused.getMessage());
    }

    @Test
    void provenanceKnowsTheField(@TempDir Path projectDir) throws IOException {
        Files.createDirectories(projectDir.resolve(".spectro"));
        Files.writeString(projectDir.resolve(".spectro/settings.json"), "{ \"codeGraphBackend\": \"graphify\" }");
        SpectroConfig.Origin origin = SpectroConfig.loadResolved(
                SpectroConfig.Overrides.none(), projectDir, null).origins().get("codeGraphBackend");
        assertTrue(origin != null, "codeGraphBackend needs a FieldProbe");
        assertEquals("launch-dir", origin.winner());
    }

    @Test
    void theSettingsApiAcceptsABackendAndRefusesAnythingElse(@TempDir Path home) throws IOException {
        ObjectMapper json = new ObjectMapper();
        Path file = home.resolve("settings.json");
        Files.writeString(file, "{}\n");
        SettingsWriter.patch(file, SettingsWriter.Scope.USER, json.createObjectNode().put("codeGraphBackend", "graphify"));
        assertTrue(Files.readString(file).contains("\"codeGraphBackend\" : \"graphify\""), Files.readString(file));
        assertThrows(IllegalArgumentException.class, () -> SettingsWriter.patch(file, SettingsWriter.Scope.USER,
                json.createObjectNode().put("codeGraphBackend", "othergraph")),
                "an unknown backend is refused before the file is touched");
    }

    @Test
    void aFolderMayNameItsBackend(@TempDir Path projectDir, @TempDir Path ws) throws IOException {
        assertFalse(SpectroConfig.workspaceScopeForbiddenKeys().contains("codeGraphBackend"),
                "the backends are the app's own programs, so a project may pin one");
        Files.createDirectories(ws.resolve(".spectro"));
        Files.writeString(ws.resolve(".spectro/settings.json"), "{ \"codeGraphBackend\": \"graphify\" }");
        assertEquals("graphify", SpectroConfig.loadForWorkspace(SpectroConfig.Overrides.none(), projectDir, ws)
                .codeGraphBackend());
    }
}
