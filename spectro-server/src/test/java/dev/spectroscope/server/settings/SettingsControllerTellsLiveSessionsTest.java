package dev.spectroscope.server.settings;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SettingsWriter;
import dev.spectroscope.server.session.LiveSessions;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.server.ResponseStatusException;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * Card 580: every settings write through the API tells the live sessions, so
 * a chat that has not run takes the settings as they are now. A refused patch
 * wrote nothing and tells nobody.
 */
class SettingsControllerTellsLiveSessionsTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String SESSION = "s-580";

    private byte[] userBefore;

    @BeforeEach
    void keepUserSettings() throws Exception {
        Path user = SettingsWriter.userSettingsFile();
        userBefore = Files.exists(user) ? Files.readAllBytes(user) : null;
    }

    @AfterEach
    void restoreUserSettings() throws Exception {
        Path user = SettingsWriter.userSettingsFile();
        if (userBefore == null) {
            Files.deleteIfExists(user);
        } else {
            Files.write(user, userBefore);
        }
    }

    @Test
    void eachScopeTellsTheLiveSessionsOnceAndARefusedPatchDoesNot(@TempDir Path launchDir, @TempDir Path ws)
            throws Exception {
        SettingsController controller = new SettingsController(launchDir, session -> null, session -> ws.toString());
        LiveSessions live = new LiveSessions();
        AtomicInteger told = new AtomicInteger();
        live.addSettingsListener(told::incrementAndGet);
        controller.useLiveSessions(live);

        controller.putUser(JSON.readTree("{ \"model\": \"m-580\" }"), new MockHttpServletRequest());
        assertEquals(1, told.get(), "the user scope tells");
        controller.putProject(SESSION, JSON.readTree("{ \"model\": \"m-580\" }"), new MockHttpServletRequest());
        assertEquals(2, told.get(), "the project scope tells");
        controller.putLocal(SESSION, JSON.readTree("{ \"model\": \"m-580\" }"), new MockHttpServletRequest());
        assertEquals(3, told.get(), "the local scope tells");

        assertThrows(ResponseStatusException.class,
                () -> controller.putUser(JSON.readTree("{ \"providr\": \"x\" }"), new MockHttpServletRequest()));
        assertEquals(3, told.get(), "a refused patch wrote nothing and tells nobody");
    }
}
