package dev.spectroscope.core.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.lang.reflect.Constructor;
import java.lang.reflect.RecordComponent;
import java.util.Arrays;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 490, criterion 1: the session count of one chat is a settings key.
 *
 * <p>It ships unset, so a chat that names no count runs as v0.14.4 did. The
 * proposed count is 3, the main agent and two helpers. The floor is 2: the
 * writer refuses a lower value, the loader skips it, and the settings API
 * sends the floor from {@link SettingFloors} to the page. Code built against
 * the v0.14.4 constructor still compiles and gets no count. What a chat does
 * with the count is {@code SessionSlotPoolTest}'s.</p>
 */
class SessionsPerChatSettingTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @AfterEach
    void removeUserConfig() throws IOException {
        Files.deleteIfExists(SpectroConfig.CONFIG_PATH);
        Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
    }

    private static void writeProject(Path dir, String json) throws IOException {
        Files.createDirectories(dir.resolve(".spectro"));
        Files.writeString(dir.resolve(SpectroConfig.PROJECT_SETTINGS), json);
    }

    @Test
    void theKeyShipsUnsetSoAChatRunsAsInV0144(@TempDir Path dir) {
        assertNull(SpectroConfig.load(SpectroConfig.Overrides.none(), dir).sessionsPerChat(),
                "a config with nothing set carries a session count, so every chat is limited");
    }

    /**
     * The v0.14.4 record ended at {@code toolGroupsOff}; this card appended
     * {@code sessionsPerChat}. spectro-core is on Maven Central, so a caller
     * that built a config positionally against v0.14.4 must keep compiling,
     * as every release before kept a constructor for the arity of the one
     * before it.
     */
    @Test
    void codeBuiltAgainstTheV0144ConstructorStillCompilesAndGetsNoCount(@TempDir Path dir)
            throws ReflectiveOperationException {
        RecordComponent[] components = SpectroConfig.class.getRecordComponents();
        int v0144 = 0;
        while (!components[v0144].getName().equals("toolGroupsOff")) {
            v0144++;
        }
        v0144++;
        assertEquals("sessionsPerChat", components[v0144].getName(),
                "premise: card 490 appended its key right after toolGroupsOff");
        Class<?>[] types = Arrays.stream(components, 0, v0144)
                .map(RecordComponent::getType).toArray(Class<?>[]::new);
        Constructor<SpectroConfig> compat = SpectroConfig.class.getConstructor(types);

        SpectroConfig loaded = SpectroConfig.load(SpectroConfig.Overrides.none(), dir);
        Object[] values = new Object[v0144];
        for (int i = 0; i < v0144; i++) {
            values[i] = components[i].getAccessor().invoke(loaded);
        }
        SpectroConfig built = compat.newInstance(values);
        assertNull(built.sessionsPerChat(), "the v0.14.4 constructor set a session count");
        for (int i = 0; i < v0144; i++) {
            assertEquals(values[i], components[i].getAccessor().invoke(built),
                    components[i].getName() + " did not pass through the v0.14.4 constructor");
        }
    }

    @Test
    void theProposedCountForAChatIsThree() {
        assertEquals(3, SpectroConfig.DEFAULT_SESSIONS_PER_CHAT,
                "card 490: the main agent and two helpers, the owner's figure");
    }

    @Test
    void aSettingsFileSetsIt(@TempDir Path dir) throws IOException {
        writeProject(dir, """
                { "sessionsPerChat": 3 }
                """);
        assertEquals(3, SpectroConfig.load(SpectroConfig.Overrides.none(), dir).sessionsPerChat());
    }

    @Test
    void itsFloorIsTwo() {
        assertEquals(2, SettingFloors.floors().get("sessionsPerChat"),
                "the floor is the main agent and one helper; no helpers is the agents group");
    }

    @Test
    void theWriterRefusesACountOfOne(@TempDir Path dir) {
        Path file = dir.resolve("settings.json");
        IllegalArgumentException refused = assertThrows(IllegalArgumentException.class,
                () -> SettingsWriter.patch(file, SettingsWriter.Scope.LOCAL,
                        JSON.readTree("{\"sessionsPerChat\":1}")));
        assertTrue(refused.getMessage().contains("sessionsPerChat"), refused.getMessage());
        assertTrue(!Files.exists(file) || !readQuietly(file).contains("sessionsPerChat"),
                "the refused value landed in the file anyway");
    }

    @Test
    void theWriterTakesTheFloorItself(@TempDir Path dir) throws IOException {
        Path file = dir.resolve("settings.json");
        SettingsWriter.patch(file, SettingsWriter.Scope.LOCAL, JSON.readTree("{\"sessionsPerChat\":2}"));
        assertEquals(2, JSON.readTree(Files.readString(file)).path("sessionsPerChat").asInt());
    }

    @Test
    void theLoaderSkipsACountOfOneAndTheLayerBelowApplies(@TempDir Path dir) throws IOException {
        writeProject(dir, """
                { "sessionsPerChat": 1 }
                """);
        SpectroConfig.Resolved read = SpectroConfig.loadForWorkspaceWithReport(
                SpectroConfig.Overrides.none(), dir, dir);
        assertNull(read.config().sessionsPerChat(),
                "a count below the floor reached the chat instead of being skipped");
    }

    @Test
    void provenanceKnowsTheField(@TempDir Path dir) throws IOException {
        writeProject(dir, """
                { "sessionsPerChat": 4 }
                """);
        var resolved = SpectroConfig.loadResolved(SpectroConfig.Overrides.none(), dir, null,
                java.util.Map.of());
        assertEquals("launch-dir", resolved.origins().get("sessionsPerChat").winner(),
                "the field has no probe, so its origin is invented");
    }

    private static String readQuietly(Path file) {
        try {
            return Files.readString(file);
        } catch (IOException e) {
            return "";
        }
    }
}
