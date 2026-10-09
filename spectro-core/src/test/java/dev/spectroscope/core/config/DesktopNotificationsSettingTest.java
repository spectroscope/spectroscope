package dev.spectroscope.core.config;

import com.fasterxml.jackson.databind.ObjectMapper;
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
 * Card 476, criterion 2: {@code desktopNotifications} is a settings key with
 * the values {@code on} and {@code off}, it ships on, and it lives at the user
 * scope. The runner reads it in front of the notifier (see
 * {@code HeadlessRunnerNotifierTest}); this file holds the key itself.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class DesktopNotificationsSettingTest {

    @Test
    void theShippedValueIsOn() {
        assertEquals(SpectroConfig.DESKTOP_NOTIFICATIONS_ON,
                SpectroConfig.shippedDefaults().desktopNotifications(),
                "a cron job that fails at night still tells its owner by default");
        assertTrue(SpectroConfig.shippedDefaults().desktopNotificationsOn());
    }

    @Test
    void bothValuesAreKnownAndNothingElseIs() {
        assertEquals(java.util.Set.of("on", "off"),
                SpectroConfig.KNOWN_DESKTOP_NOTIFICATIONS_VALUES);
    }

    @Test
    void theReadingTheRunnerUsesAnswersBothWays() {
        assertFalse(SpectroConfig.shippedDefaults()
                .withDesktopNotifications(SpectroConfig.DESKTOP_NOTIFICATIONS_OFF)
                .desktopNotificationsOn());
        assertTrue(SpectroConfig.shippedDefaults()
                .withDesktopNotifications(SpectroConfig.DESKTOP_NOTIFICATIONS_ON)
                .desktopNotificationsOn());
    }

    @Test
    void offInTheLaunchDirectoryLoadsAndArrives(@TempDir Path projectDir) throws IOException {
        Files.createDirectories(projectDir.resolve(".spectro"));
        Files.writeString(projectDir.resolve(".spectro/settings.json"),
                "{ \"desktopNotifications\": \"off\" }");

        SpectroConfig loaded = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, Map.of());

        assertEquals(SpectroConfig.DESKTOP_NOTIFICATIONS_OFF, loaded.desktopNotifications());
        assertFalse(loaded.desktopNotificationsOn());
    }

    @Test
    void anUnknownValueIsRefusedOnLoadAndTheMessageNamesTheFieldAndTheValues(
            @TempDir Path projectDir) throws IOException {
        Files.createDirectories(projectDir.resolve(".spectro"));
        Files.writeString(projectDir.resolve(".spectro/settings.json"),
                "{ \"desktopNotifications\": \"quiet\" }");

        IllegalArgumentException refused = assertThrows(IllegalArgumentException.class,
                () -> SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, Map.of()));
        assertTrue(refused.getMessage().contains("desktopNotifications"), refused.getMessage());
        assertTrue(refused.getMessage().contains("quiet"), refused.getMessage());
        assertTrue(refused.getMessage().contains("on") && refused.getMessage().contains("off"),
                refused.getMessage());
    }

    @Test
    void aWorkspaceScopeMayNotSetIt(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        Files.createDirectories(ws.resolve(".spectro"));
        Files.writeString(ws.resolve(".spectro/settings.json"),
                "{ \"desktopNotifications\": \"off\" }");

        var report = SpectroConfig.reportFor(projectDir, ws, Map.of());
        assertTrue(report.dropped().contains("desktopNotifications"),
                "a folder the agent writes into must not silence the owner's machine: "
                        + report.dropped());
        assertTrue(SpectroConfig.loadForWorkspace(SpectroConfig.Overrides.none(), projectDir, ws)
                        .desktopNotificationsOn(),
                "the dropped key does not apply");
    }

    @Test
    void provenanceKnowsTheField(@TempDir Path projectDir) throws IOException {
        Files.createDirectories(projectDir.resolve(".spectro"));
        Files.writeString(projectDir.resolve(".spectro/settings.json"),
                "{ \"desktopNotifications\": \"off\" }");
        SpectroConfig.Origin origin = SpectroConfig.loadResolved(
                SpectroConfig.Overrides.none(), projectDir, null).origins().get("desktopNotifications");
        assertTrue(origin != null, "desktopNotifications needs a FieldProbe");
        assertEquals("launch-dir", origin.winner());
    }

    @Test
    void theSettingsApiAcceptsTheKeyInTheUserScopeOnly(@TempDir Path home) throws IOException {
        ObjectMapper json = new ObjectMapper();
        Path file = home.resolve("settings.json");
        Files.writeString(file, "{}\n");
        SettingsWriter.patch(file, SettingsWriter.Scope.USER,
                json.createObjectNode().put("desktopNotifications", "off"));
        assertTrue(Files.readString(file).contains("\"desktopNotifications\" : \"off\""),
                Files.readString(file));

        assertThrows(IllegalArgumentException.class, () -> SettingsWriter.patch(file,
                SettingsWriter.Scope.USER, json.createObjectNode().put("desktopNotifications", "mute")),
                "a value other than on or off is refused before the file is touched");

        Path project = home.resolve("project.json");
        Files.writeString(project, "{}\n");
        assertThrows(IllegalArgumentException.class, () -> SettingsWriter.patch(project,
                SettingsWriter.Scope.PROJECT, json.createObjectNode().put("desktopNotifications", "off")),
                "the project scope may not hold it");
    }

    @Test
    void theKeyIsListedAmongTheWorkspaceForbiddenKeys() {
        assertTrue(SpectroConfig.workspaceScopeForbiddenKeys().contains("desktopNotifications"),
                SpectroConfig.workspaceScopeForbiddenKeys().toString());
    }
}
