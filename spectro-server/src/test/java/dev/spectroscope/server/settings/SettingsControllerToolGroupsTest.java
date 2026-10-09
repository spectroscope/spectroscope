package dev.spectroscope.server.settings;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SettingsWriter;
import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.server.ResponseStatusException;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 466, criterion 1 at the settings API: {@code toolGroupsOff} is saved at
 * user, project and local scope, and an unknown group name is a 400 at each
 * of them that writes nothing.
 */
class SettingsControllerToolGroupsTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String SESSION = "s-466";

    @AfterEach
    void removeUserSettings() throws Exception {
        Files.deleteIfExists(SettingsWriter.userSettingsFile());
    }

    private static SettingsController controllerFor(Path launchDir, Path ws) {
        return new SettingsController(launchDir, session -> null, session -> ws.toString());
    }

    @Test
    void everyScopeSavesAKnownList(@TempDir Path launchDir, @TempDir Path ws) throws Exception {
        SettingsController controller = controllerFor(launchDir, ws);
        JsonNode patch = JSON.readTree("{ \"toolGroupsOff\": [\"browser\", \"launch\"] }");

        controller.putUser(patch, new MockHttpServletRequest());
        controller.putProject(SESSION, patch, new MockHttpServletRequest());
        JsonNode view = JSON.valueToTree(controller.putLocal(SESSION, patch, new MockHttpServletRequest()));

        for (Path file : new Path[] {SettingsWriter.userSettingsFile(),
                ws.resolve(SpectroConfig.PROJECT_SETTINGS), ws.resolve(SpectroConfig.WS_LOCAL_SETTINGS)}) {
            assertEquals("[\"browser\",\"launch\"]",
                    JSON.readTree(Files.readString(file)).path("toolGroupsOff").toString(), file.toString());
        }
        assertEquals("[\"browser\",\"launch\"]", view.path("effective").path("toolGroupsOff").toString(),
                "the session's view resolves the list");
    }

    @Test
    void anUnknownGroupIs400AtEveryScopeAndWritesNothing(@TempDir Path launchDir, @TempDir Path ws) {
        SettingsController controller = controllerFor(launchDir, ws);
        String body = "{ \"toolGroupsOff\": [\"browser\", \"printer\"] }";

        ResponseStatusException user = assertThrows(ResponseStatusException.class,
                () -> controller.putUser(JSON.readTree(body), new MockHttpServletRequest()));
        ResponseStatusException project = assertThrows(ResponseStatusException.class,
                () -> controller.putProject(SESSION, JSON.readTree(body), new MockHttpServletRequest()));
        ResponseStatusException local = assertThrows(ResponseStatusException.class,
                () -> controller.putLocal(SESSION, JSON.readTree(body), new MockHttpServletRequest()));

        for (ResponseStatusException refused : new ResponseStatusException[] {user, project, local}) {
            assertEquals(400, refused.getStatusCode().value());
            assertTrue(refused.getReason().contains("printer"), refused.getReason());
        }
        assertFalse(Files.exists(SettingsWriter.userSettingsFile()));
        assertFalse(Files.exists(ws.resolve(SpectroConfig.PROJECT_SETTINGS)));
        assertFalse(Files.exists(ws.resolve(SpectroConfig.WS_LOCAL_SETTINGS)));
    }
}
