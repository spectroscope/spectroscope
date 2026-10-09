package dev.spectroscope.cli;

import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 476, criterion 2: doctor prints whether a finished cron job shows a
 * desktop notification, and which key decides it. The owner asked "can this
 * be switched off somewhere"; doctor is where the answer can be read.
 */
class DoctorDesktopNotificationsLineTest {

    @AfterEach
    void cleanHome() throws IOException {
        Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
        Files.deleteIfExists(SpectroConfig.CONFIG_PATH);
    }

    private static SpectroConfig defaults(Path dir) {
        return SpectroConfig.load(SpectroConfig.Overrides.none(), dir);
    }

    @Test
    void theLineSaysOnAndNamesTheKey(@TempDir Path dir) {
        DoctorCommand.Line line = DoctorCommand.desktopNotificationsLine(defaults(dir));
        assertEquals(DoctorCommand.Kind.INFO, line.kind(), "a preference is never a verdict");
        assertTrue(line.message().startsWith("desktop notifications: on"), line.message());
        assertTrue(line.message().contains("desktopNotifications"), line.message());
    }

    @Test
    void theLineSaysOffWhenTheKeyIsOff(@TempDir Path dir) {
        DoctorCommand.Line line = DoctorCommand.desktopNotificationsLine(
                defaults(dir).withDesktopNotifications(SpectroConfig.DESKTOP_NOTIFICATIONS_OFF));
        assertEquals(DoctorCommand.Kind.INFO, line.kind());
        assertTrue(line.message().startsWith("desktop notifications: off"), line.message());
    }

    @Test
    void doctorPrintsTheUserScopeValue() throws IOException {
        Files.createDirectories(SpectroConfig.USER_SETTINGS_PATH.getParent());
        Files.writeString(SpectroConfig.USER_SETTINGS_PATH, "{ \"desktopNotifications\": \"off\" }");

        String output = captureDoctorOutput();

        assertTrue(output.contains("desktop notifications: off"),
                "doctor does not print the state the user scope set:\n" + output);
    }

    private static String captureDoctorOutput() {
        PrintStream original = System.out;
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        System.setOut(new PrintStream(buffer, true, StandardCharsets.UTF_8));
        try {
            new DoctorCommand().call();
        } finally {
            System.setOut(original);
        }
        return buffer.toString(StandardCharsets.UTF_8);
    }
}
