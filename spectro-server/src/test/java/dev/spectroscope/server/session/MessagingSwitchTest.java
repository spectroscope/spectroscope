package dev.spectroscope.server.session;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 503, criterion 10 at the process: the server takes messages from other
 * sessions unless the user settings switch agentMessaging off. Only an
 * explicit false switches it off; a missing file, a missing key and an
 * unreadable file all leave the shipped on.
 */
class MessagingSwitchTest {

    @Test
    void onlyAnExplicitFalseSwitchesItOff(@TempDir Path dir) throws IOException {
        Path settings = dir.resolve("settings.json");
        assertThat(MessagingSwitch.read(settings)).as("no file").isTrue();
        Files.writeString(settings, "{ \"agentMessaging\": false }");
        assertThat(MessagingSwitch.read(settings)).isFalse();
        Files.writeString(settings, "{ \"agentMessaging\": true }");
        assertThat(MessagingSwitch.read(settings)).isTrue();
        Files.writeString(settings, "{ \"provider\": \"ollama\" }");
        assertThat(MessagingSwitch.read(settings)).as("no key").isTrue();
        Files.writeString(settings, "{ not json");
        assertThat(MessagingSwitch.read(settings)).as("unreadable").isTrue();
        Files.writeString(settings, "{ \"agentMessaging\": \"off\" }");
        assertThat(MessagingSwitch.read(settings)).as("not a boolean").isTrue();
    }
}
