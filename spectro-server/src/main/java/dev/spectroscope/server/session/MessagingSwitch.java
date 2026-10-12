package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.function.LongSupplier;

/**
 * Card 503: whether this server process takes messages from other sessions,
 * read from the user settings file, where {@code agentMessaging} is a
 * machine wide answer. The read is cached for a second, because the inbox
 * asks on every arriving message and the record asks on every rewrite.
 */
final class MessagingSwitch {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final long CACHE_MS = 1_000;

    /** The switch of this process: the user settings file, on the wall clock. */
    static final MessagingSwitch USER = new MessagingSwitch(SpectroConfig.USER_SETTINGS_PATH,
            System::currentTimeMillis);

    private final Path settings;
    private final LongSupplier clock;
    private volatile boolean fresh;
    private volatile long readAt;
    private volatile boolean cached = SpectroConfig.DEFAULT_AGENT_MESSAGING;

    /**
     * @param settings the settings file the key is read from
     * @param clock    the clock the one second cache counts on
     */
    MessagingSwitch(Path settings, LongSupplier clock) {
        this.settings = settings;
        this.clock = clock;
    }

    /** @return the settings file this switch reads */
    Path settings() {
        return settings;
    }

    /** @return false when the settings file switches agent messaging off */
    boolean isOn() {
        long now = clock.getAsLong();
        if (fresh && now - readAt < CACHE_MS) {
            return cached;
        }
        cached = read(settings);
        readAt = now;
        fresh = true;
        return cached;
    }

    /**
     * @param settings a settings file
     * @return its {@code agentMessaging}, or the shipped on when the file or the key is absent or unreadable
     */
    static boolean read(Path settings) {
        try {
            if (!Files.isRegularFile(settings)) {
                return SpectroConfig.DEFAULT_AGENT_MESSAGING;
            }
            JsonNode value = JSON.readTree(settings.toFile()).path("agentMessaging");
            return value.isBoolean() ? value.asBoolean() : SpectroConfig.DEFAULT_AGENT_MESSAGING;
        } catch (Exception unreadable) {
            return SpectroConfig.DEFAULT_AGENT_MESSAGING;
        }
    }
}
