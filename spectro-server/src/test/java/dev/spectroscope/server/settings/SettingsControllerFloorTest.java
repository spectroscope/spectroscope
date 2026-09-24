package dev.spectroscope.server.settings;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SettingFloors;
import dev.spectroscope.core.config.SettingsWriter;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.server.ResponseStatusException;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The settings API's half of card 386: the view hands the page the floor
 * table and every value a file held below it, and a PUT below a floor is a
 * 400 that names the key, the value and the floor.
 */
class SettingsControllerFloorTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static MockHttpServletRequest local() {
        return new MockHttpServletRequest();
    }

    /** The user-scope PUT writes the real user settings file, which the Gradle
     *  test task keeps under the build directory. */
    @AfterEach
    void removeUserSettings() throws Exception {
        Files.deleteIfExists(SettingsWriter.userSettingsFile());
    }

    @Test
    void theViewCarriesTheFloorOfEveryFlooredKey(@TempDir Path launchDir) {
        SettingsController controller = new SettingsController(launchDir, session -> null);
        JsonNode floors = JSON.valueToTree(controller.settings(null, local())).path("floors");

        List<String> keys = new ArrayList<>();
        floors.fieldNames().forEachRemaining(keys::add);
        assertEquals(List.copyOf(SettingFloors.floors().keySet()), keys);
        for (Map.Entry<String, Integer> row : SettingFloors.floors().entrySet()) {
            assertEquals(row.getValue().intValue(), floors.path(row.getKey()).asInt(-99), row.getKey());
        }
        // Read off the wire, not off the table the assertions above compare to.
        assertEquals(1, floors.path("commandTimeoutSeconds").asInt(-99));
        assertEquals(260, floors.path("dockMaxWidth").asInt(-99));
        assertEquals(0, floors.path("questionsPerRun").asInt(-99));
    }

    @Test
    void theViewNamesAValueSkippedOnDisk(@TempDir Path launchDir) throws Exception {
        Files.createDirectories(launchDir.resolve(".spectro"));
        Path file = launchDir.resolve(".spectro/settings.json");
        Files.writeString(file, "{ \"commandTimeoutSeconds\": 0, \"model\": \"kept\" }");
        SettingsController controller = new SettingsController(launchDir, session -> null);

        JsonNode view = JSON.valueToTree(controller.settings(null, local()));
        JsonNode skipped = view.path("belowFloor");
        assertEquals(1, skipped.size(), skipped.toString());
        assertEquals("commandTimeoutSeconds", skipped.path(0).path("key").asText());
        assertEquals("0", skipped.path(0).path("value").asText());
        assertEquals(1, skipped.path(0).path("floor").asInt(-99));
        assertEquals("launch-dir", skipped.path(0).path("layer").asText());
        assertEquals(file.toString(), skipped.path(0).path("file").asText());
        assertEquals("\"commandTimeoutSeconds\" is 0 in " + file + ", below its floor of 1;"
                        + " that key was skipped and the layer below applies",
                skipped.path(0).path("message").asText());
        assertEquals(900, view.path("effective").path("commandTimeoutSeconds").asInt(-99));
        assertEquals("kept", view.path("effective").path("model").asText());
    }

    @Test
    void aViewWithNothingBelowAFloorSaysSoWithAnEmptyList(@TempDir Path launchDir) {
        SettingsController controller = new SettingsController(launchDir, session -> null);
        JsonNode skipped = JSON.valueToTree(controller.settings(null, local())).path("belowFloor");
        assertTrue(skipped.isArray(), skipped.toString());
        assertEquals(0, skipped.size());
    }

    @Test
    void aPutBelowTheFloorIs400NamingKeyValueAndFloor(@TempDir Path launchDir) {
        SettingsController controller = new SettingsController(launchDir, session -> null);
        ResponseStatusException refused = assertThrows(ResponseStatusException.class,
                () -> controller.putUser(JSON.readTree("{ \"commandTimeoutSeconds\": 0 }"), local()));
        assertEquals(400, refused.getStatusCode().value());
        assertTrue(refused.getReason().contains("\"commandTimeoutSeconds\" is 0, below its floor of 1"),
                refused.getReason());
        assertFalse(Files.exists(SettingsWriter.userSettingsFile()), "a refused PUT wrote the user file");
    }

    @Test
    void aPutOfALegalZeroIsSaved(@TempDir Path launchDir) throws Exception {
        SettingsController controller = new SettingsController(launchDir, session -> null);
        JsonNode view = JSON.valueToTree(
                controller.putUser(JSON.readTree("{ \"questionsPerRun\": 0 }"), local()));
        assertEquals(0, view.path("effective").path("questionsPerRun").asInt(-99));
        assertEquals(0, JSON.readTree(Files.readString(SettingsWriter.userSettingsFile()))
                .path("questionsPerRun").asInt(-99));
    }
}
